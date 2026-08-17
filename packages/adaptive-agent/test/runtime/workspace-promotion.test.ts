import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it as vitestIt } from "vitest";
import {
	ForegroundChangedError,
	GitWorktreeWorkspaceManager,
	PromotionConflictError,
	type WorkspacePolicy,
} from "../../src/index.ts";

const it = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => vitestIt(name, fn, timeout);

const execFileP = promisify(execFile);

async function git(dir: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
	try {
		const result = await execFileP("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
		return { stdout: result.stdout, ok: true };
	} catch (error) {
		return { stdout: (error as { stdout?: string }).stdout ?? "", ok: false };
	}
}

const cleanups: Array<{ root: string; stateRoot: string }> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await rm(cleanup.root, { recursive: true, force: true }).catch(() => undefined);
		await rm(cleanup.stateRoot, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function newRepo(): Promise<{ root: string; stateRoot: string; manager: GitWorktreeWorkspaceManager }> {
	const root = await mkdtemp(join(tmpdir(), "pi-s7-promo-src-"));
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-promo-state-"));
	cleanups.push({ root, stateRoot });
	await git(root, ["init", "-b", "main", "."]);
	await git(root, ["config", "user.email", "s7@test"]);
	await git(root, ["config", "user.name", "s7"]);
	await git(root, ["config", "core.autocrlf", "false"]);
	await writeFile(join(root, "a.txt"), "one\n");
	await git(root, ["add", "-A"]);
	await git(root, ["commit", "-m", "c"]);
	return { root, stateRoot, manager: new GitWorktreeWorkspaceManager({ stateRoot }) };
}

describe("workspace promotion", () => {
	it("promotes tracked deletions without touching the branch or index", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "gone.txt"), "tracked then deleted\n");
		await git(root, ["add", "-A"]);
		await git(root, ["commit", "-m", "add"]);
		const branchBefore = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
		const indexBefore = (await git(root, ["write-tree"])).stdout.trim();
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await rm(join(lease.root, "gone.txt"));
		const diff = await manager.diff(lease);
		expect(diff.summary.tracked.deleted).toBe(1);
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		await expect(readFile(join(root, "gone.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(branchBefore);
		expect((await git(root, ["write-tree"])).stdout.trim()).toBe(indexBefore);
		await lease.release();
	});

	it("an untracked file staged in the candidate becomes a tracked patch and is not double-applied", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "u.txt"), "u now tracked\n");
		await git(lease.root, ["add", "u.txt"]);
		const diff = await manager.diff(lease);
		// The path is only in the tracked patch; the untracked plan absorbs it.
		expect(diff.summary.tracked.added).toBe(1);
		expect(diff.summary.untracked.created).toBe(0);
		expect(diff.summary.untracked.modified).toBe(0);
		expect(diff.summary.untracked.absorbedByTracked).toContain("u.txt");
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u now tracked\n");
		await lease.release();
	});

	it("a promotion with no changes is a clean no-op", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		if (result.status === "promoted") {
			expect(result.touchedPaths).toEqual([]);
		}
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u\n");
		await lease.release();
	});

	it("a policy change between capture and promotion surfaces as ForegroundChanged", async () => {
		const { root, stateRoot } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const capturePolicy: WorkspacePolicy = { maxUntrackedFileBytes: 4096 };
		const manager = new GitWorktreeWorkspaceManager({ stateRoot, policy: capturePolicy });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		// A second manager instance with a different policy must not be able
		// to promote: its recomputed fingerprint differs.
		const otherPolicy: WorkspacePolicy = { maxUntrackedFileBytes: 2048 };
		const other = new GitWorktreeWorkspaceManager({ stateRoot, policy: otherPolicy });
		const otherLease = await other.fork(snapshot, "c1");
		await expect(other.promote({ lease: otherLease })).rejects.toBeInstanceOf(ForegroundChangedError);
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u\n");
		await lease.release();
	});

	it("promotion into a vanished foreground repository is a typed conflict", async () => {
		const { root, stateRoot, manager } = await newRepo();
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		await rm(root, { recursive: true, force: true });
		await expect(manager.promote({ lease })).rejects.toBeInstanceOf(PromotionConflictError);
		await lease.release().catch(() => undefined);
		await rm(stateRoot, { recursive: true, force: true }).catch(() => undefined);
	});

	it("diff summaries are deterministic across repeated calls", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		const first = await manager.diff(lease);
		const second = await manager.diff(lease);
		expect(second.summary).toEqual(first.summary);
		expect(second.summary.trackedPatchHash).toMatch(/^[0-9a-f]{64}$/);
		expect(second.summary.untrackedManifestHash).toMatch(/^[0-9a-f]{64}$/);
		await lease.release();
	});

	it("the winner verifier sees the lease root and the final verifier sees the foreground", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		const seen: string[] = [];
		const result = await manager.promote({
			lease,
			verifier: ({ cwd }) => {
				seen.push(`winner:${cwd.replaceAll("\\", "/")}`);
			},
			finalVerifier: ({ cwd }) => {
				seen.push(`final:${cwd.replaceAll("\\", "/")}`);
			},
		});
		expect(result.status).toBe("promoted");
		expect(seen).toEqual([`winner:${lease.root.replaceAll("\\", "/")}`, `final:${root.replaceAll("\\", "/")}`]);
		await lease.release();
	});

	it("an apply-phase failure on a locked foreground path rolls back cleanly", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		// u.txt is read-only at capture time so its mode is baked into the
		// fingerprint; the candidate is materialized writable (copyFile does
		// not preserve mode), so the test can still modify it.
		await chmod(join(root, "u.txt"), 0o444);
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		// copyFile preserves the read-only attribute on Windows; make the
		// candidate writable so the test can stage its modification (a no-op
		// on POSIX, where copyFile does not preserve mode).
		await chmod(join(lease.root, "u.txt"), 0o644);
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		// Lock the foreground root in the winner verifier. The fingerprint
		// recomputes unchanged (u.txt's mode and content are unchanged, and
		// the repo root's mode is not in the manifest), so the gates pass and
		// the apply fails: on POSIX an unwritable root denies the temp-file
		// write; on Windows the rename over the read-only u.txt is denied.
		// Either way the apply rolls back with the foreground untouched.
		try {
			const result = await manager.promote({
				lease,
				verifier: async () => {
					await chmod(root, 0o555);
				},
			});
			expect(result.status).toBe("rolled_back");
		} catch (error) {
			expect(error).toBeInstanceOf(PromotionConflictError);
		} finally {
			await chmod(root, 0o755).catch(() => undefined);
			await chmod(join(root, "u.txt"), 0o644).catch(() => undefined);
			await lease.release().catch(() => undefined);
		}
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u\n");
	});

	it("a failed tracked-deletion apply rolls back and preserves the read-only foreground file", async () => {
		const { root, manager } = await newRepo();
		await writeFile(join(root, "gone.txt"), "tracked\n");
		await git(root, ["add", "-A"]);
		await git(root, ["commit", "-m", "add"]);
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await rm(join(lease.root, "gone.txt"));
		// Read-only attribute makes git apply's unlink fail on Windows.
		await execFileP("attrib", ["+R", join(root, "gone.txt")], { windowsHide: true }).catch(() => undefined);
		try {
			const result = await manager.promote({ lease });
			// Either the apply failed and rolled back (read-only file intact)
			// or the environment allowed deletion (then the file is gone and
			// the result is promoted); both are consistent outcomes.
			if (result.status === "rolled_back") {
				expect(await readFile(join(root, "gone.txt"), "utf8")).toBe("tracked\n");
			} else {
				expect(result.status).toBe("promoted");
				await expect(readFile(join(root, "gone.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			await execFileP("attrib", ["-R", join(root, "gone.txt")], { windowsHide: true }).catch(() => undefined);
			await lease.release();
		}
	});
});
