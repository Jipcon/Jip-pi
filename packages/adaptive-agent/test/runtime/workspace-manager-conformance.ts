import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it as vitestIt } from "vitest";

// Git worktree operations are slow on Windows; give every conformance case a
// generous ceiling while keeping regressions detectable.
const it = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => vitestIt(name, fn, timeout);

import {
	assertNoCaseCollision,
	ForegroundChangedError,
	PromotionConflictError,
	resolveWorkspacePolicy,
	SourceWorkspaceChangedError,
	UnsupportedWorkspaceError,
	validateWorkspaceRelativePath,
	WorkspaceCaseCollisionError,
	type WorkspaceLease,
	WorkspaceLeaseConflictError,
	type WorkspaceManager,
	WorkspaceManagerContinuationAdapter,
	WorkspaceOrphanedError,
	WorkspacePathEscapeError,
	type WorkspacePolicy,
	WorkspaceSnapshotNotFoundError,
	type WorkspaceSnapshotRef,
} from "../../src/index.ts";

/**
 * One WorkspaceManager conformance suite runs against both backends with
 * identical assertions (DESIGN §13.5). Backend-specific extras live in each
 * backend's own test file.
 */

export interface ConformanceBackend {
	backend: "git-worktree" | "temp-copy";
	createManager(stateRoot: string, options?: { policy?: WorkspacePolicy }): WorkspaceManager;
	/** Initialize the source root (git backends init + autocrlf off + commit). */
	prepareSource(root: string): Promise<void>;
	/** Record all current content as the committed baseline. */
	commitAll(root: string, message?: string): Promise<void>;
	stageAll(root: string): Promise<void>;
	/** Private refs under refs/pi-adaptive (git backend). */
	listPrivateRefs(root: string): Promise<string[]>;
	listWorktrees(root: string): Promise<string>;
	currentBranch(root: string): Promise<string>;
	indexTree(root: string): Promise<string>;
	stagedNames(root: string): Promise<string[]>;
	statusPorcelain(root: string): Promise<string>;
}

export interface ConformanceSession {
	root: string;
	stateRoot: string;
	manager: WorkspaceManager;
	backend: ConformanceBackend;
	lease: WorkspaceLease | undefined;
	leases: WorkspaceLease[];
	processes: Array<{ kill(): void }>;
}

export interface ConformanceSuiteOptions {
	backend: ConformanceBackend;
	/** Skip cases that only apply to the git backend. */
	gitOnly?: boolean;
}

export function createWorkspaceManagerConformance(options: ConformanceSuiteOptions): void {
	const sessions: ConformanceSession[] = [];

	async function newSession(policy?: WorkspacePolicy): Promise<ConformanceSession> {
		const root = await mkdtemp(join(tmpdir(), "pi-s7-src-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-state-"));
		await options.backend.prepareSource(root);
		const manager = options.backend.createManager(stateRoot, policy === undefined ? {} : { policy });
		const session: ConformanceSession = {
			root,
			stateRoot,
			manager,
			backend: options.backend,
			lease: undefined,
			leases: [],
			processes: [],
		};
		sessions.push(session);
		return session;
	}

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			for (const process of session.processes) process.kill();
			for (const lease of session.leases) {
				await lease.release().catch(() => undefined);
			}
			await rm(session.root, { recursive: true, force: true }).catch(() => undefined);
			await rm(session.stateRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	async function tracked(
		session: ConformanceSession,
		files: Record<string, string | Buffer>,
		message = "commit",
	): Promise<void> {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(join(session.root, path.replaceAll("\\", "/").split("/").slice(0, -1).join("/")), {
				recursive: true,
			}).catch(() => undefined);
			await writeFile(join(session.root, path), content);
		}
		await session.backend.stageAll(session.root);
		await session.backend.commitAll(session.root, message);
	}

	async function capture(session: ConformanceSession, logicalRoot = "/workspace"): Promise<WorkspaceSnapshotRef> {
		return session.manager.capture({ sourceRoot: session.root, logicalRoot });
	}

	async function fork(
		session: ConformanceSession,
		snapshot: WorkspaceSnapshotRef,
		candidateId: string,
	): Promise<WorkspaceLease> {
		const lease = await session.manager.fork(snapshot, candidateId);
		session.lease = lease;
		session.leases.push(lease);
		return lease;
	}

	const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

	it("captures a clean source and materializes a byte-exact lease", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "hello\n", "bin.dat": binary, "sub/nested.txt": "nested\n" });
		const snapshot = await capture(session);
		expect(snapshot.backend).toBe(options.backend.backend);
		expect(snapshot.logicalWorkspace.root).toBe("/workspace");
		expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		const lease = await fork(session, snapshot, "c1");
		expect(lease.root.startsWith(session.stateRoot)).toBe(true);
		expect(await readFile(join(lease.root, "a.txt"), "utf8")).toBe("hello\n");
		expect(Buffer.compare(await readFile(join(lease.root, "bin.dat")), binary)).toBe(0);
		expect(await readFile(join(lease.root, "sub", "nested.txt"), "utf8")).toBe("nested\n");
		const refetched = await session.manager.findSnapshot(snapshot.id);
		expect(refetched.fingerprint).toBe(snapshot.fingerprint);
	});

	it("captures dirty, staged, unstaged, deleted, renamed and binary tracked content", async () => {
		const session = await newSession();
		await tracked(session, {
			"a.txt": "one\ntwo\n",
			"bin.dat": binary,
			"gone.txt": "will be deleted\n",
			"old.txt": "rename me\n",
		});
		await writeFile(join(session.root, "a.txt"), "one\nTWO\n"); // unstaged
		await session.backend.stageAll(session.root); // staged
		await writeFile(join(session.root, "a.txt"), "one\nTWO\nTHREE\n"); // unstaged again
		await writeFile(join(session.root, "bin.dat"), Buffer.from([9, 8, 7]));
		await rm(join(session.root, "gone.txt"));
		await writeFile(join(session.root, "new.txt"), "renamed content\n");
		await rm(join(session.root, "old.txt"));
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		expect(await readFile(join(lease.root, "a.txt"), "utf8")).toBe("one\nTWO\nTHREE\n");
		expect(Buffer.compare(await readFile(join(lease.root, "bin.dat")), Buffer.from([9, 8, 7]))).toBe(0);
		await expect(readFile(join(lease.root, "gone.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(lease.root, "new.txt"), "utf8")).toBe("renamed content\n");
		await expect(readFile(join(lease.root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("captures untracked create/modify/delete and promotes them back", async () => {
		const session = await newSession();
		await tracked(session, { "base.txt": "base\n" });
		await writeFile(join(session.root, "untracked.txt"), "untracked bytes\n");
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		expect(await readFile(join(lease.root, "untracked.txt"), "utf8")).toBe("untracked bytes\n");
		await writeFile(join(lease.root, "untracked.txt"), "untracked MODIFIED\n");
		await writeFile(join(lease.root, "brand-new.txt"), "created in candidate\n");
		const diff = await session.manager.diff(lease);
		expect(diff.summary.untracked.created).toBe(1);
		expect(diff.summary.untracked.modified).toBe(1);
		const result = await session.manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(session.root, "untracked.txt"), "utf8")).toBe("untracked MODIFIED\n");
		expect(await readFile(join(session.root, "brand-new.txt"), "utf8")).toBe("created in candidate\n");
	});

	it("captures untracked deletions and promotes them", async () => {
		const session = await newSession();
		await tracked(session, { "base.txt": "base\n" });
		await writeFile(join(session.root, "doomed.txt"), "to be deleted\n");
		await writeFile(join(session.root, "kept.txt"), "kept\n");
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await rm(join(lease.root, "doomed.txt"));
		const diff = await session.manager.diff(lease);
		expect(diff.summary.untracked.deleted).toBe(1);
		const result = await session.manager.promote({ lease });
		expect(result.status).toBe("promoted");
		await expect(readFile(join(session.root, "doomed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(session.root, "kept.txt"), "utf8")).toBe("kept\n");
	});

	it("promotes tracked content changes without staging or committing", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const branchBefore = await session.backend.currentBranch(session.root);
		const indexBefore = await session.backend.indexTree(session.root);
		const stagedBefore = await session.backend.stagedNames(session.root);
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate edit\n");
		const result = await session.manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(session.root, "a.txt"), "utf8")).toBe("one\ncandidate edit\n");
		expect(await session.backend.currentBranch(session.root)).toBe(branchBefore);
		expect(await session.backend.indexTree(session.root)).toBe(indexBefore);
		expect(await session.backend.stagedNames(session.root)).toEqual(stagedBefore);
	});

	it("capture/fork/diff never change the foreground branch, index or files", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "a.txt"), "one\ndirty\n");
		await writeFile(join(session.root, "u.txt"), "untracked\n");
		const statusBefore = await session.backend.statusPorcelain(session.root);
		const branchBefore = await session.backend.currentBranch(session.root);
		const indexBefore = await session.backend.indexTree(session.root);
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await session.manager.diff(lease);
		expect(await session.backend.statusPorcelain(session.root)).toBe(statusBefore);
		expect(await session.backend.currentBranch(session.root)).toBe(branchBefore);
		expect(await session.backend.indexTree(session.root)).toBe(indexBefore);
	});

	it("foreground drift stops promotion with zero writes", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		// User edits the foreground after capture.
		await writeFile(join(session.root, "a.txt"), "one\nuser edit\n");
		await expect(session.manager.promote({ lease })).rejects.toBeInstanceOf(ForegroundChangedError);
		expect(await readFile(join(session.root, "a.txt"), "utf8")).toBe("one\nuser edit\n");
		const status = await session.backend.statusPorcelain(session.root);
		expect(status).not.toContain("candidate");
	});

	it("excludes denied and oversized untracked content with reasons", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, ".env"), "SECRET=1\n");
		await writeFile(join(session.root, "large.bin"), Buffer.alloc(4096, 7));
		// A tighter policy excludes the large file and changes the fingerprint.
		const strict = await newSession({ maxUntrackedFileBytes: 1024 });
		await tracked(strict, { "a.txt": "one\n" });
		await writeFile(join(strict.root, ".env"), "SECRET=1\n");
		await writeFile(join(strict.root, "large.bin"), Buffer.alloc(4096, 7));
		const strictSnapshot = await capture(strict, "/workspace");
		const defaultSnapshot = await capture(session, "/workspace");
		expect(strictSnapshot.fingerprint).not.toBe(defaultSnapshot.fingerprint);
		const lease = await fork(strict, strictSnapshot, "c1");
		await expect(readFile(join(lease.root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(lease.root, "large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects capture when the source drifts between the two passes", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		for (let index = 0; index < 120; index++) {
			await writeFile(join(session.root, `u-${index}.txt`), `content ${index}\n`);
		}
		// Mutate the untracked files from another "process" while capture runs,
		// once the first content-store copy proves the first pass is underway.
		let mutating = true;
		const drift = (async () => {
			const contentDir = join(session.stateRoot, "content");
			for (let attempt = 0; attempt < 2000 && mutating; attempt++) {
				const entries = await readdir(contentDir).catch(() => []);
				if (entries.length > 0) {
					await writeFile(join(session.root, "u-0.txt"), `drifted ${attempt}\n`).catch(() => undefined);
				}
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		})();
		await expect(capture(session)).rejects.toBeInstanceOf(SourceWorkspaceChangedError);
		mutating = false;
		await drift;
	});

	it("deterministic fork reattaches instead of creating twins", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		const first = await fork(session, snapshot, "c1");
		const second = await session.manager.fork(snapshot, "c1");
		expect(second.id).toBe(first.id);
		expect(second.root).toBe(first.root);
		const other = await session.manager.fork(snapshot, "c2");
		expect(other.id).not.toBe(first.id);
		expect(other.root).not.toBe(first.root);
		await other.release();
		await expect(session.manager.fork(snapshot, "c2")).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);
	});

	it("release removes the worktree and the last release removes the snapshot ref", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const snapshot = await capture(session);
		const refsBefore = await session.backend.listPrivateRefs(session.root);
		if (options.backend.backend === "git-worktree") {
			expect(refsBefore.length).toBeGreaterThan(0);
		}
		const a = await fork(session, snapshot, "a");
		const b = await fork(session, snapshot, "b");
		await a.release();
		if (options.backend.backend === "git-worktree") {
			expect((await session.backend.listPrivateRefs(session.root)).length).toBeGreaterThan(0);
		}
		await b.release();
		if (options.backend.backend === "git-worktree") {
			expect(await session.backend.listPrivateRefs(session.root)).toEqual([]);
		}
		const report = await session.manager.recover();
		expect(report.blobsDeleted).toBeGreaterThanOrEqual(0);
		// Second recover is idempotent.
		const second = await session.manager.recover();
		expect(second.worktreesRemoved).toEqual([]);
		expect(second.remainingOrphans).toEqual(report.remainingOrphans);
	});

	it("rejects forks from unknown snapshots and snapshot deletion with live leases", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		await expect(session.manager.findSnapshot("0".repeat(64))).rejects.toBeInstanceOf(WorkspaceSnapshotNotFoundError);
		const lease = await fork(session, snapshot, "c1");
		await expect(session.manager.releaseSnapshot(snapshot)).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);
		await lease.release();
		await session.manager.releaseSnapshot(snapshot);
		await expect(session.manager.findSnapshot(snapshot.id)).rejects.toBeInstanceOf(WorkspaceSnapshotNotFoundError);
	});

	it("verifier failure in the winner workspace writes nothing to the foreground", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		const result = await session.manager.promote({
			lease,
			verifier: () => {
				throw new Error("hard verifier rejected");
			},
		});
		expect(result.status).toBe("verifier_failed");
		expect(await readFile(join(session.root, "a.txt"), "utf8")).toBe("one\n");
	});

	it("final verifier failure rolls back to the snapshot state", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		const result = await session.manager.promote({
			lease,
			finalVerifier: () => {
				throw new Error("foreground verification failed");
			},
		});
		expect(result.status).toBe("rolled_back");
		expect(await readFile(join(session.root, "a.txt"), "utf8")).toBe("one\n");
		expect(await readFile(join(session.root, "u.txt"), "utf8")).toBe("u\n");
	});

	it("concurrent user edits during apply produce PromotionNeedsAttention with recovery copies", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		await writeFile(join(lease.root, "u.txt"), "u candidate\n");
		const result = await session.manager.promote({
			lease,
			finalVerifier: ({ cwd }) => {
				void cwd;
				// Simulate the user editing the touched path before verifier
				// failure: overwrite it with foreign content, then fail.
				return writeFile(join(session.root, "u.txt"), "USER CONTENT\n").then(() => {
					throw new Error("verification failed after a user edit");
				});
			},
		});
		expect(result.status).toBe("needs_attention");
		expect((result as { recoveryCopies: string[] }).recoveryCopies.length).toBeGreaterThan(0);
		await expect(session.manager.promote({ lease })).rejects.toBeInstanceOf(PromotionConflictError);
	});

	it("releases a locked worktree into orphaned state and recover() finishes it", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		// A child process whose cwd is inside the worktree holds the directory.
		const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			cwd: lease.root,
			stdio: "ignore",
			windowsHide: true,
		});
		session.processes.push({ kill: () => holder.kill() });
		await new Promise((resolve) => setTimeout(resolve, 700));
		await expect(lease.release()).rejects.toBeInstanceOf(WorkspaceOrphanedError);
		holder.kill();
		await new Promise((resolve) => setTimeout(resolve, 700));
		const report = await session.manager.recover();
		expect(report.leases.released).toBeGreaterThanOrEqual(1);
		expect(report.remainingOrphans).toEqual([]);
		await expect(readFile(join(lease.root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("recover() removes stray directories and orphaned refs without touching live ones", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const snapshot = await capture(session);
		const lease = await fork(session, snapshot, "c1");
		const stray = join(session.stateRoot, "worktrees", "stray-repo", "stray-candidate");
		await mkdir(stray, { recursive: true });
		await writeFile(join(stray, "junk.txt"), "junk\n");
		const report = await session.manager.recover();
		expect(report.worktreesRemoved.some((path) => path.includes("stray-repo"))).toBe(true);
		expect(await readFile(join(lease.root, "a.txt"), "utf8")).toBe("one\n");
		await lease.release();
	});

	it("never captures content through reparse points that escape the source root", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		const outside = await mkdtemp(join(tmpdir(), "pi-s7-outside-"));
		await writeFile(join(outside, "secret.txt"), "SECRET\n");
		await symlink(outside, join(session.root, "escape"), "junction");
		try {
			if (options.backend.backend === "temp-copy") {
				await expect(capture(session)).rejects.toBeInstanceOf(WorkspacePathEscapeError);
				return;
			}
			// Git sometimes enumerates out-of-root junctions (then capture
			// rejects) and sometimes cannot see them at all (then capture must
			// not leak anything through them). Both outcomes are safe.
			let snapshot: WorkspaceSnapshotRef;
			try {
				snapshot = await capture(session);
			} catch (error) {
				expect(error).toBeInstanceOf(WorkspacePathEscapeError);
				return;
			}
			const lease = await fork(session, snapshot, "c1");
			await expect(readFile(join(lease.root, "escape", "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(snapshot.files.map((file) => file.path)).not.toContain("escape");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("rejects Windows-dangerous and case-colliding manifest paths", () => {
		const policy = resolveWorkspacePolicy();
		for (const path of [
			"../escape.txt",
			"a/../../escape.txt",
			"C:/absolute.txt",
			"/absolute.txt",
			"CON.txt",
			"aux",
			"trailing.",
			"trailing ",
			"bad<name.txt",
			"sub/../up.txt",
		]) {
			expect(() => validateWorkspaceRelativePath(path, policy)).toThrow(WorkspacePathEscapeError);
		}
		expect(() => validateWorkspaceRelativePath(`${"a/".repeat(120)}x.txt`, policy)).toThrow(WorkspacePathEscapeError);
		const seen = new Set<string>();
		assertNoCaseCollision("README.md", seen);
		expect(() => assertNoCaseCollision("readme.md", seen)).toThrow(WorkspaceCaseCollisionError);
		expect(() => validateWorkspaceRelativePath("a.txt", policy)).not.toThrow();
	});

	it("two candidates modifying the same path stay independent", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const snapshot = await capture(session);
		const a = await fork(session, snapshot, "a");
		const b = await fork(session, snapshot, "b");
		await writeFile(join(a.root, "a.txt"), "one\nfrom A\n");
		await writeFile(join(a.root, "u.txt"), "u from A\n");
		await writeFile(join(b.root, "a.txt"), "one\nfrom B\n");
		await writeFile(join(b.root, "u.txt"), "u from B\n");
		expect(await readFile(join(b.root, "a.txt"), "utf8")).toBe("one\nfrom B\n");
		const diffB = await session.manager.diff(b);
		expect(diffB.summary.touchedPaths).toContain("a.txt");
		const result = await session.manager.promote({ lease: b });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(session.root, "a.txt"), "utf8")).toBe("one\nfrom B\n");
		expect(await readFile(join(session.root, "u.txt"), "utf8")).toBe("u from B\n");
		// A's lease is untouched by B's promotion.
		expect(await readFile(join(a.root, "a.txt"), "utf8")).toBe("one\nfrom A\n");
	});

	it("a parent candidate can be re-captured and forked", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const snapshot = await capture(session);
		const parent = await fork(session, snapshot, "parent");
		await writeFile(join(parent.root, "a.txt"), "one\nparent change\n");
		await writeFile(join(parent.root, "u2.txt"), "parent untracked\n");
		const childSnapshot = await session.manager.snapshot(parent);
		expect(childSnapshot.id).not.toBe(snapshot.id);
		const child = await fork(session, childSnapshot, "child");
		expect(await readFile(join(child.root, "a.txt"), "utf8")).toBe("one\nparent change\n");
		expect(await readFile(join(child.root, "u2.txt"), "utf8")).toBe("parent untracked\n");
		expect(await readFile(join(child.root, "u.txt"), "utf8")).toBe("u\n");
	});

	it("the Stage 6 bridge derives everything from the real capture", async () => {
		const session = await newSession();
		await tracked(session, { "a.txt": "one\n" });
		await writeFile(join(session.root, "u.txt"), "u\n");
		const bridge = new WorkspaceManagerContinuationAdapter({
			manager: session.manager,
			sourceRoot: session.root,
		});
		const forged = { files: [{ path: "forged.txt", size: 1, mtimeMs: 0, hash: "f".repeat(64) }] };
		const snapshot = await bridge.snapshot(forged, "/logical");
		expect(snapshot.logical.root).toBe("/logical");
		expect(snapshot.files.map((file) => file.path)).toContain("u.txt");
		expect(snapshot.files.map((file) => file.path)).not.toContain("forged.txt");
		const lease = await bridge.fork(snapshot.id, "bridge-child");
		session.leases.push(lease);
		expect(await readFile(join(lease.environment.physicalRoot, "a.txt"), "utf8")).toBe("one\n");
		expect(lease.environment.toPhysicalPath("/logical/a.txt")).toBe(join(lease.environment.physicalRoot, "a.txt"));
		expect(lease.environment.toPhysicalPath("/logical")).toBe(lease.environment.physicalRoot);
	});

	it("unsupported sources are rejected with typed errors", async () => {
		const session = await newSession();
		await expect(
			session.manager.capture({ sourceRoot: join(session.root, "missing"), logicalRoot: "/w" }),
		).rejects.toBeInstanceOf(UnsupportedWorkspaceError);
	});
}
