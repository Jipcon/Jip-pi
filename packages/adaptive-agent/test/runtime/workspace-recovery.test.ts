import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it as vitestIt } from "vitest";
import {
	GitWorktreeWorkspaceManager,
	JsonlManifestStore,
	JsonlPromotionJournal,
	sha256Hex,
	TempDirectoryWorkspaceManager,
	WorkspaceOrphanedError,
	workspaceLeaseId,
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
	const root = await mkdtemp(join(tmpdir(), "pi-s7-rec-src-"));
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-rec-state-"));
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

/** Registers an open promotion in the runtime manifest (crash-window setup). */
async function registerPromotion(stateRoot: string, promotionId: string, leaseId: string): Promise<void> {
	const manifest = new JsonlManifestStore({ filePath: join(stateRoot, "manifest.jsonl") });
	await manifest.append({ type: "promotion", promotionId, leaseId, status: "open" });
	await manifest.close();
}

describe("workspace recovery", () => {
	it("a promotion journal with zero applied paths is discarded on recover()", async () => {
		const { root, stateRoot, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const promotionId = workspaceLeaseId(lease.id, "x");
		await registerPromotion(stateRoot, promotionId, lease.id);
		const journal = new JsonlPromotionJournal({
			filePath: join(stateRoot, "promotions", `${promotionId}.jsonl`),
		});
		await journal.append({ type: "open", promotionId });
		const report = await manager.recover();
		expect(report.promotions.discarded).toContain(promotionId);
		await expect(readFile(join(stateRoot, "promotions", `${promotionId}.jsonl`))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await lease.release();
	});

	it("an open promotion journal with applied paths rolls back on recover()", async () => {
		const { root, stateRoot, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		// Crash simulation: journal + manifest records for an applied path,
		// foreground still at the post-apply state.
		await writeFile(join(lease.root, "u.txt"), "u candidate v2\n");
		const promotionId = workspaceLeaseId(lease.id, "x");
		const preHash = sha256Hex("u\n");
		const postHash = sha256Hex("u candidate v2\n");
		await registerPromotion(stateRoot, promotionId, lease.id);
		const journal = new JsonlPromotionJournal({
			filePath: join(stateRoot, "promotions", `${promotionId}.jsonl`),
		});
		await journal.append({ type: "open", promotionId, capturedIndexTree: null });
		await journal.append({
			type: "prepared",
			promotionId,
			path: "u.txt",
			op: "untracked_modify",
			preimageKind: "file",
			preimageHash: preHash,
			targetHash: postHash,
			recoveryCopy: "0-u",
		});
		await journal.append({
			type: "applied",
			promotionId,
			path: "u.txt",
			op: "untracked_modify",
			preimageKind: "file",
			preimageHash: preHash,
			targetHash: postHash,
			recoveryCopy: "0-u",
			postKind: "file",
			postHash,
		});
		await mkdir(join(stateRoot, "promotions", promotionId, "recovery"), { recursive: true });
		await writeFile(join(stateRoot, "promotions", promotionId, "recovery", "0-u"), "u\n");
		await writeFile(join(root, "u.txt"), "u candidate v2\n");
		const report = await manager.recover();
		expect(report.promotions.rolledBack).toContain(promotionId);
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u\n");
		await lease.release();
	});

	it("an open promotion journal with drifted paths is reported as needs-attention", async () => {
		const { root, stateRoot, manager } = await newRepo();
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const promotionId = workspaceLeaseId(lease.id, "x");
		await registerPromotion(stateRoot, promotionId, lease.id);
		const journal = new JsonlPromotionJournal({
			filePath: join(stateRoot, "promotions", `${promotionId}.jsonl`),
		});
		await journal.append({ type: "open", promotionId, capturedIndexTree: null });
		await journal.append({
			type: "prepared",
			promotionId,
			path: "u.txt",
			op: "untracked_modify",
			preimageKind: "file",
			preimageHash: sha256Hex("u\n"),
			targetHash: sha256Hex("candidate\n"),
			recoveryCopy: "0-u",
		});
		await journal.append({
			type: "applied",
			promotionId,
			path: "u.txt",
			op: "untracked_modify",
			preimageKind: "file",
			preimageHash: sha256Hex("u\n"),
			targetHash: sha256Hex("candidate\n"),
			recoveryCopy: "0-u",
			postKind: "file",
			postHash: sha256Hex("candidate\n"),
		});
		await mkdir(join(stateRoot, "promotions", promotionId, "recovery"), { recursive: true });
		await writeFile(join(stateRoot, "promotions", promotionId, "recovery", "0-u"), "u\n");
		await writeFile(join(root, "u.txt"), "USER DRIFT\n");
		const report = await manager.recover();
		expect(report.promotions.needsAttention).toContain(promotionId);
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("USER DRIFT\n");
		await lease.release();
	});

	it("recover() is idempotent across two consecutive runs with orphans present", async () => {
		const { root, manager } = await newRepo();
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const first = await manager.recover();
		const second = await manager.recover();
		expect(second.leases.ready).toBe(first.leases.ready);
		expect(second.remainingOrphans).toEqual(first.remainingOrphans);
		expect(second.worktreesRemoved).toEqual([]);
		await lease.release();
	});

	it("the temp-copy backend recovers stray directories without touching live leases", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-s7-rec-temp-src-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-rec-temp-state-"));
		cleanups.push({ root, stateRoot });
		await writeFile(join(root, "a.txt"), "one\n");
		const manager = new TempDirectoryWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const stray = join(stateRoot, "worktrees", "zzz", "gone");
		await mkdir(stray, { recursive: true });
		const report = await manager.recover();
		expect(report.worktreesRemoved.some((path) => path.includes("zzz"))).toBe(true);
		expect(await readFile(join(lease.root, "a.txt"), "utf8")).toBe("one\n");
		await lease.release();
	});

	it("releasing an already-released lease stays a no-op and never orphans", async () => {
		const { root, manager } = await newRepo();
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await lease.release();
		await lease.release();
		await expect(manager.fork(snapshot, "c1")).rejects.toBeInstanceOf(Error);
		const report = await manager.recover();
		expect(report.remainingOrphans).toEqual([]);
	});

	it("a locked orphan blocks release with WorkspaceOrphaned but recover settles it after the lock clears", async () => {
		const { root, manager } = await newRepo();
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			cwd: lease.root,
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		await expect(lease.release()).rejects.toBeInstanceOf(WorkspaceOrphanedError);
		const whileLocked = await manager.recover();
		expect(whileLocked.remainingOrphans).toContain(lease.id);
		holder.kill();
		await new Promise((resolve) => setTimeout(resolve, 600));
		const settled = await manager.recover();
		expect(settled.remainingOrphans).toEqual([]);
	});
});
