import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it as vitestIt } from "vitest";
import {
	GitWorktreeWorkspaceManager,
	JsonlManifestStore,
	UnsupportedRepositoryStateError,
	UnsupportedWorkspaceError,
	type WorkspaceManager,
	type WorkspacePolicy,
	WorkspaceSnapshotMismatch,
	workspaceLeaseId,
} from "../../src/index.ts";
import { type ConformanceBackend, createWorkspaceManagerConformance } from "./workspace-manager-conformance.ts";

// Git worktree operations are slow on Windows.
const it = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => vitestIt(name, fn, timeout);

const execFileP = promisify(execFile);

async function git(dir: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
	try {
		const result = await execFileP("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
		return { stdout: result.stdout, stderr: result.stderr, ok: true };
	} catch (error) {
		return {
			stdout: (error as { stdout?: string }).stdout ?? "",
			stderr: (error as { stderr?: string }).stderr ?? "",
			ok: false,
		};
	}
}

const gitBackend: ConformanceBackend = {
	backend: "git-worktree",
	createManager(stateRoot, options): WorkspaceManager {
		return new GitWorktreeWorkspaceManager({
			stateRoot,
			policy: options?.policy,
			retry: { maxAttempts: 3, delayMs: 40 },
		});
	},
	async prepareSource(root) {
		await git(root, ["init", "-b", "main", "."]);
		await git(root, ["config", "user.email", "s7@test"]);
		await git(root, ["config", "user.name", "s7"]);
		await git(root, ["config", "core.autocrlf", "false"]);
	},
	async commitAll(root, message = "commit") {
		await git(root, ["commit", "-m", message]);
	},
	async stageAll(root) {
		await git(root, ["add", "-A"]);
	},
	async listPrivateRefs(root) {
		const result = await git(root, ["for-each-ref", "--format=%(refname)", "refs/pi-adaptive"]);
		return result.stdout.split("\n").filter((line) => line.length > 0);
	},
	async listWorktrees(root) {
		return (await git(root, ["worktree", "list", "--porcelain"])).stdout;
	},
	async currentBranch(root) {
		return (await git(root, ["branch", "--show-current"])).stdout.trim();
	},
	async indexTree(root) {
		return (await git(root, ["write-tree"])).stdout.trim();
	},
	async stagedNames(root) {
		return (await git(root, ["diff", "--cached", "--name-only"])).stdout
			.split("\n")
			.filter((line) => line.length > 0);
	},
	async statusPorcelain(root) {
		return (await git(root, ["status", "--porcelain"])).stdout;
	},
};

const cleanups: Array<{ root: string; stateRoot?: string }> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await rm(cleanup.root, { recursive: true, force: true }).catch(() => undefined);
		if (cleanup.stateRoot !== undefined) {
			await rm(cleanup.stateRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}
});

async function newRepo(files: Record<string, string | Buffer>): Promise<{
	root: string;
	stateRoot: string;
	manager: GitWorktreeWorkspaceManager;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-s7-git-src-"));
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-git-state-"));
	cleanups.push({ root, stateRoot });
	await gitBackend.prepareSource(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), content);
	}
	await gitBackend.stageAll(root);
	await gitBackend.commitAll(root);
	return { root, stateRoot, manager: new GitWorktreeWorkspaceManager({ stateRoot }) };
}

describe("GitWorktreeWorkspaceManager", () => {
	describe("conformance", () => {
		createWorkspaceManagerConformance({ backend: gitBackend });
	});

	it("uses git stash create and leaves no stash entries or refs on user branches", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		await writeFile(join(root, "a.txt"), "one\ntwo\n");
		const stashBefore = (await git(root, ["stash", "list"])).stdout.trim();
		await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		expect((await git(root, ["stash", "list"])).stdout.trim()).toBe(stashBefore);
		expect((await git(root, ["branch", "--show-current"])).stdout.trim()).toBe("main");
		expect((await git(root, ["status", "--porcelain"])).stdout).toContain("a.txt");
	});

	it("a candidate commit is included in the full diff relative to the snapshot", async () => {
		const binContent = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 251));
		const binChanged = Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 7) % 251));
		const { root, manager } = await newRepo({ "a.txt": "one\n", "bin.dat": binContent });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncommitted\n");
		await git(lease.root, ["add", "a.txt"]);
		await git(lease.root, ["commit", "-m", "candidate commit", "-c", "user.name=s7", "-c", "user.email=s7@test"]);
		await writeFile(join(lease.root, "a.txt"), "one\ncommitted\nunstaged\n");
		await writeFile(join(lease.root, "bin.dat"), binChanged);
		const diff = await manager.diff(lease);
		expect(diff.summary.tracked.modified).toBe(2);
		expect(diff.summary.tracked.binary).toBe(1);
		const patch = await readFile(diff.trackedPatchPath, "utf8");
		expect(patch).toContain("committed");
		expect(patch).toContain("unstaged");
		expect(patch).toContain("GIT binary patch");
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ncommitted\nunstaged\n");
		expect(Buffer.compare(await readFile(join(root, "bin.dat")), binChanged)).toBe(0);
		await lease.release();
	});

	it("ignored untracked files are excluded via exclude-standard", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		await writeFile(join(root, ".gitignore"), "*.log\n");
		await git(root, ["add", ".gitignore"]);
		await git(root, ["commit", "-m", "ignore"]);
		await writeFile(join(root, "noise.log"), "ignored\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await expect(readFile(join(lease.root, "noise.log"))).rejects.toMatchObject({ code: "ENOENT" });
		await lease.release();
	});

	it("rejects unmerged indexes and in-progress operations with typed errors", async () => {
		const { root, manager } = await newRepo({ "c.txt": "base\n" });
		await writeFile(join(root, "c.txt"), "ours\n");
		await git(root, ["commit", "-am", "ours"]);
		await git(root, ["checkout", "-b", "side", "HEAD~1"]);
		await writeFile(join(root, "c.txt"), "theirs\n");
		await git(root, ["commit", "-am", "theirs"]);
		await git(root, ["checkout", "main"]);
		await git(root, ["merge", "side"]);
		await expect(manager.capture({ sourceRoot: root, logicalRoot: "/w" })).rejects.toBeInstanceOf(
			UnsupportedRepositoryStateError,
		);
	});

	it("rejects unborn repositories", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		await rm(join(root, ".git"), { recursive: true, force: true });
		await git(root, ["init", "-b", "main", "."]);
		await expect(manager.capture({ sourceRoot: root, logicalRoot: "/w" })).rejects.toBeInstanceOf(
			UnsupportedRepositoryStateError,
		);
	});

	it("rejects non-git directories", async () => {
		const { manager } = await newRepo({ "a.txt": "one\n" });
		const plain = await mkdtemp(join(tmpdir(), "pi-s7-plain-"));
		cleanups.push({ root: plain });
		await expect(manager.capture({ sourceRoot: plain, logicalRoot: "/w" })).rejects.toBeInstanceOf(
			UnsupportedWorkspaceError,
		);
	});

	it("detects a snapshot ref that diverged from its manifest record", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		// Move the ref to a newer commit behind the manager's back.
		const refs = await gitBackend.listPrivateRefs(root);
		const targetRef = refs.find((entry) => entry.includes(snapshot.id));
		expect(targetRef).toBeDefined();
		await writeFile(join(root, "a.txt"), "one\nmore\n");
		await git(root, ["add", "-A"]);
		await git(root, ["commit", "-m", "foreground moved"]);
		const newHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
		await git(root, ["update-ref", targetRef!, newHead]);
		await expect(manager.findSnapshot(snapshot.id)).rejects.toBeInstanceOf(WorkspaceSnapshotMismatch);
	});

	it("capture from a candidate worktree produces a snapshot rooted at the same repository", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const parent = await manager.fork(snapshot, "parent");
		await writeFile(join(parent.root, "a.txt"), "one\nparent\n");
		const childSnapshot = await manager.snapshot(parent);
		const child = await manager.fork(childSnapshot, "child");
		expect(await readFile(join(child.root, "a.txt"), "utf8")).toBe("one\nparent\n");
		// Foreground is untouched by the whole chain.
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
		await child.release();
		await parent.release();
	});

	it("promotion with a dirty foreground index preserves the staged state", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		await writeFile(join(root, "a.txt"), "staged version\n");
		await git(root, ["add", "a.txt"]);
		await writeFile(join(root, "a.txt"), "worktree version\n");
		const stagedBefore = await gitBackend.stagedNames(root);
		const indexBefore = await gitBackend.indexTree(root);
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "candidate result\n");
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("candidate result\n");
		expect(await gitBackend.stagedNames(root)).toEqual(stagedBefore);
		expect(await gitBackend.indexTree(root)).toBe(indexBefore);
		await lease.release();
	});

	it("detached candidate commits never move the foreground branch", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const before = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
		await writeFile(join(lease.root, "a.txt"), "candidate commit\n");
		await git(lease.root, ["add", "-A"]);
		await git(lease.root, ["commit", "-m", "candidate", "-c", "user.name=s7", "-c", "user.email=s7@test"]);
		expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
		await lease.release();
	});

	it("recover() deletes unmanifested private refs only under refs/pi-adaptive", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		// The manager must know the repo (a manifest record exists) before it
		// can reconcile refs; this mirrors the crash window between the
		// update-ref and the manifest append.
		await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
		await git(root, ["update-ref", "refs/pi-adaptive/snapshots/ghost/repo/abc", head]);
		await git(root, ["update-ref", "refs/heads/keep-me", head]);
		const report = await manager.recover();
		expect(report.unmanifestedRefsDeleted).toContain("refs/pi-adaptive/snapshots/ghost/repo/abc");
		expect((await git(root, ["rev-parse", "--verify", "refs/heads/keep-me"])).ok).toBe(true);
	});

	it("a half-created worktree from a crashed fork is completed by recover()", async () => {
		const { root, stateRoot, manager } = await newRepo({ "a.txt": "one\n" });
		await writeFile(join(root, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		// Simulate a crash inside fork: durable creating record present, but
		// the worktree add never completed.
		const leaseId = workspaceLeaseId(snapshot.id, "crashy");
		const store = new JsonlManifestStore({ filePath: join(stateRoot, "manifest.jsonl") });
		const candidateRoot = join(stateRoot, "worktrees", "partial", "crashy");
		await store.append({
			type: "lease",
			leaseId,
			snapshotId: snapshot.id,
			candidateId: "crashy",
			root: candidateRoot,
			gitDir: "",
			worktreeName: "",
			status: "creating",
			createdAt: Date.now(),
		});
		await store.close();
		const report = await manager.recover();
		expect(report.leases.completed).toBe(1);
		// fork now reattaches the completed lease deterministically.
		const lease = await manager.fork(snapshot, "crashy");
		expect(lease.root).toBe(candidateRoot);
		expect(await readFile(join(lease.root, "u.txt"), "utf8")).toBe("u\n");
		await lease.release();
	});

	it("release removes the per-worktree metadata under the common dir", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		const commonDir = (await git(lease.root, ["rev-parse", "--git-common-dir"])).stdout.trim();
		const metadataName = (await git(lease.root, ["rev-parse", "--absolute-git-dir"])).stdout
			.trim()
			.split(/[\\/]/)
			.at(-1)!;
		expect(metadataName.length).toBeGreaterThan(0);
		await lease.release();
		const remaining = await readdir(join(commonDir, "worktrees")).catch(() => []);
		expect(remaining).not.toContain(metadataName);
		// Only the `worktree <path>` lines name registered worktrees; the HEAD
		// line carries the foreground commit hash, which can incidentally
		// contain "c1" and would false-positive this check.
		const porcelain = (await git(root, ["worktree", "list", "--porcelain"])).stdout;
		const worktreePaths = porcelain.split("\n").filter((line) => line.startsWith("worktree "));
		expect(worktreePaths.some((line) => line.includes("c1"))).toBe(false);
	});

	it("in-root junctions are captured as links and materialized as links", async () => {
		const { root, manager } = await newRepo({ "real/inner.txt": "inner\n" });
		await symlink(join(root, "real"), join(root, "link-to-real"), "junction");
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		expect((await lstat(join(lease.root, "link-to-real"))).isSymbolicLink()).toBe(true);
		expect(await readFile(join(lease.root, "link-to-real", "inner.txt"), "utf8")).toBe("inner\n");
		await lease.release();
	});

	it("policy hash changes the fingerprint even for identical content", async () => {
		const { root } = await newRepo({ "a.txt": "one\n" });
		const policyA: WorkspacePolicy = { maxUntrackedFileBytes: 100 };
		const policyB: WorkspacePolicy = { maxUntrackedFileBytes: 200 };
		const stateA = await mkdtemp(join(tmpdir(), "pi-s7-a-"));
		const stateB = await mkdtemp(join(tmpdir(), "pi-s7-b-"));
		const managerA = new GitWorktreeWorkspaceManager({ stateRoot: stateA });
		const managerB = new GitWorktreeWorkspaceManager({ stateRoot: stateB });
		const snapA = await managerA.capture({ sourceRoot: root, logicalRoot: "/w", policy: policyA });
		const snapB = await managerB.capture({ sourceRoot: root, logicalRoot: "/w", policy: policyB });
		expect(snapA.fingerprint).not.toBe(snapB.fingerprint);
	});

	it("a stable fingerprint is recomputed identically for identical content", async () => {
		const { root, manager } = await newRepo({ "a.txt": "one\n" });
		await writeFile(join(root, "u.txt"), "u\n");
		const first = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const second = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(second.id).not.toBe(first.id);
	});
});
