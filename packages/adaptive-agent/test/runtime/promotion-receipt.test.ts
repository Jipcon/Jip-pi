import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeWorkspaceManager, readPromotionReceipt, TempDirectoryWorkspaceManager } from "../../src/index.ts";

const execFileP = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => {
	for (const directory of cleanups.splice(0)) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function git(dir: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
	try {
		const result = await execFileP("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
		return { stdout: result.stdout, ok: true };
	} catch (error) {
		return { stdout: (error as { stdout?: string }).stdout ?? "", ok: false };
	}
}

describe("promotion receipt (temp backend)", () => {
	it("records a complete receipt and replays the durable result without re-executing", async () => {
		const foreground = await mkdtemp(join(tmpdir(), "pi-s8-receipt-fg-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s8-receipt-st-"));
		cleanups.push(foreground, stateRoot);
		await writeFile(join(foreground, "readme.md"), "original" + "\n");
		const manager = new TempDirectoryWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: foreground, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "out.txt"), "content" + "\n");
		let finalRuns = 0;
		const first = await manager.promote({
			lease,
			finalVerifier: () => {
				finalRuns += 1;
			},
		});
		expect(first).toMatchObject({ status: "promoted", touchedPaths: ["out.txt"] });
		if (first.status !== "promoted") throw new Error("expected promotion");
		expect(first.receipt).toMatchObject({
			promotionId: expect.any(String),
			leaseId: lease.id,
			snapshotId: snapshot.id,
			status: "promoted",
			touchedPaths: ["out.txt"],
			postFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(await readFile(join(foreground, "out.txt"), "utf8")).toBe("content" + "\n");

		// Retry of the same completed attempt returns the original durable
		// result: no re-execution, no duplicate apply, the journal survives.
		const second = await manager.promote({
			lease,
			finalVerifier: () => {
				finalRuns += 1;
			},
		});
		expect(second).toEqual(first);
		expect(finalRuns).toBe(1);
		const journalPath = join(stateRoot, "promotions", `${first.receipt.promotionId}.jsonl`);
		expect(existsSync(journalPath)).toBe(true);
		const receipt = await readPromotionReceipt(journalPath, {
			promotionId: first.receipt.promotionId,
			leaseId: lease.id,
			snapshotId: snapshot.id,
		});
		expect(receipt).toEqual(first.receipt);
		await lease.release();
	});

	it("records a rolled-back receipt and replays it instead of re-applying", async () => {
		const foreground = await mkdtemp(join(tmpdir(), "pi-s8-receipt-fg-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s8-receipt-st-"));
		cleanups.push(foreground, stateRoot);
		await writeFile(join(foreground, "readme.md"), "original" + "\n");
		const manager = new TempDirectoryWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: foreground, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "out.txt"), "content" + "\n");
		let applyRuns = 0;
		const first = await manager.promote({
			lease,
			finalVerifier: () => {
				applyRuns += 1;
				throw new Error("final verifier failed");
			},
		});
		expect(first).toMatchObject({ status: "rolled_back" });
		if (first.status !== "rolled_back") throw new Error("expected rollback");
		expect(first.receipt).toMatchObject({ status: "rolled_back", leaseId: lease.id, snapshotId: snapshot.id });
		await expect(readFile(join(foreground, "out.txt"))).rejects.toMatchObject({ code: "ENOENT" });

		const second = await manager.promote({
			lease,
			finalVerifier: () => {
				applyRuns += 1;
				throw new Error("must not run again");
			},
		});
		expect(second).toEqual(first);
		expect(applyRuns).toBe(1);
		await lease.release();
	});

	it("readPromotionReceipt is undefined for a missing or open journal", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s8-receipt-st-"));
		cleanups.push(stateRoot);
		await expect(
			readPromotionReceipt(join(stateRoot, "missing.jsonl"), { promotionId: "p", leaseId: "l", snapshotId: "s" }),
		).resolves.toBeUndefined();
	});
});

describe("promotion receipt (git backend)", () => {
	it("shares the same receipt semantics", async () => {
		const foreground = await mkdtemp(join(tmpdir(), "pi-s8-receipt-git-fg-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s8-receipt-git-st-"));
		cleanups.push(foreground, stateRoot);
		await git(foreground, ["init", "-b", "main", "."]);
		await git(foreground, ["config", "user.email", "s8@test"]);
		await git(foreground, ["config", "user.name", "s8"]);
		await git(foreground, ["config", "core.autocrlf", "false"]);
		await writeFile(join(foreground, "a.txt"), "one" + "\n");
		await git(foreground, ["add", "-A"]);
		await git(foreground, ["commit", "-m", "c"]);
		await writeFile(join(foreground, "u.txt"), "u" + "\n");
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: foreground, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "u.txt"), "u candidate" + "\n");
		const first = await manager.promote({ lease });
		expect(first).toMatchObject({ status: "promoted", touchedPaths: ["u.txt"] });
		if (first.status !== "promoted") throw new Error("expected promotion");
		expect(first.receipt).toMatchObject({ leaseId: lease.id, snapshotId: snapshot.id, status: "promoted" });
		expect(await readFile(join(foreground, "u.txt"), "utf8")).toBe("u candidate" + "\n");
		const second = await manager.promote({ lease });
		expect(second).toEqual(first);
		const journalPath = join(stateRoot, "promotions", `${first.receipt.promotionId}.jsonl`);
		expect(existsSync(journalPath)).toBe(true);
		await lease.release();
	}, 30_000);
});
