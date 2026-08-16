import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	ForegroundChangedError,
	GitWorktreeWorkspaceManager,
	JsonlManifestStore,
	TempDirectoryWorkspaceManager,
	type WorkspaceLease,
	type WorkspaceManager,
	WorkspaceSnapshotNotFoundError,
	type WorkspaceSnapshotRef,
} from "../../src/index.ts";

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

interface LineageBackend {
	name: string;
	createForeground(): Promise<string>;
	createManager(stateRoot: string): WorkspaceManager;
}

const backends: LineageBackend[] = [
	{
		name: "temp-copy",
		createForeground: async () => {
			const foreground = await mkdtemp(join(tmpdir(), "pi-s8-lineage-fg-"));
			await writeFile(join(foreground, "readme.md"), "original" + "\n");
			return foreground;
		},
		createManager: (stateRoot) => new TempDirectoryWorkspaceManager({ stateRoot }),
	},
	{
		name: "git-worktree",
		createForeground: async () => {
			const foreground = await mkdtemp(join(tmpdir(), "pi-s8-lineage-fg-"));
			await git(foreground, ["init", "-b", "main", "."]);
			await git(foreground, ["config", "user.email", "s8@test"]);
			await git(foreground, ["config", "user.name", "s8"]);
			await git(foreground, ["config", "core.autocrlf", "false"]);
			await writeFile(join(foreground, "readme.md"), "original" + "\n");
			await git(foreground, ["add", "-A"]);
			await git(foreground, ["commit", "-m", "c"]);
			return foreground;
		},
		createManager: (stateRoot) => new GitWorktreeWorkspaceManager({ stateRoot }),
	},
];

interface LineageCase {
	foreground: string;
	stateRoot: string;
	manager: WorkspaceManager;
	snapshot0: WorkspaceSnapshotRef;
	rootLease: WorkspaceLease;
	snapshot1: WorkspaceSnapshotRef;
	childLease: WorkspaceLease;
}

/**
 * The blocking repro: S0 foreground -> root writes ancestor.txt (S1) ->
 * snapshot(root) -> child writes winner.txt (S2) -> promote(child).
 */
async function createLineageCase(backend: LineageBackend): Promise<LineageCase> {
	const foreground = await backend.createForeground();
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s8-lineage-st-"));
	cleanups.push(foreground, stateRoot);
	const manager = backend.createManager(stateRoot);
	const snapshot0 = await manager.capture({ sourceRoot: foreground, logicalRoot: "/w" });
	const rootLease = await manager.fork(snapshot0, "root");
	await writeFile(join(rootLease.root, "ancestor.txt"), "ancestor" + "\n");
	const snapshot1 = await manager.snapshot(rootLease);
	const childLease = await manager.fork(snapshot1, "child");
	await writeFile(join(childLease.root, "winner.txt"), "winner" + "\n");
	return { foreground, stateRoot, manager, snapshot0, rootLease, snapshot1, childLease };
}

for (const backend of backends) {
	describe(`promotion lineage (${backend.name})`, () => {
		it("promotes the full origin-to-winner patch after a dirty-source branch", async () => {
			const c = await createLineageCase(backend);
			const result = await c.manager.promote({ lease: c.childLease });
			expect(result).toMatchObject({ status: "promoted", touchedPaths: ["ancestor.txt", "winner.txt"] });
			if (result.status !== "promoted") throw new Error("expected promotion");
			expect(await readFile(join(c.foreground, "ancestor.txt"), "utf8")).toBe("ancestor" + "\n");
			expect(await readFile(join(c.foreground, "winner.txt"), "utf8")).toBe("winner" + "\n");
			expect(await readFile(join(c.foreground, "readme.md"), "utf8")).toBe("original" + "\n");
			// The receipt carries the durable origin lineage.
			expect(result.receipt).toMatchObject({
				snapshotId: c.snapshot1.id,
				promotionOriginSnapshotId: c.snapshot0.id,
				promotionOriginFingerprint: c.snapshot0.fingerprint,
			});
			// The lineage is durable in the manifest.
			const manifest = new JsonlManifestStore({ filePath: join(c.stateRoot, "manifest.jsonl") });
			const record = (await manifest.fold()).snapshots.get(c.snapshot1.id);
			expect(record).toMatchObject({
				promotionOriginSnapshotId: c.snapshot0.id,
				promotionOriginFingerprint: c.snapshot0.fingerprint,
			});
			await c.childLease.release();
			await c.rootLease.release();
		}, 30_000);

		it("foreground drift stops the promotion with zero writes", async () => {
			const c = await createLineageCase(backend);
			// External drift: the foreground is still at S0; touching it must
			// fail the origin gate before any write.
			await writeFile(join(c.foreground, "drift.txt"), "drift" + "\n");
			await expect(c.manager.promote({ lease: c.childLease })).rejects.toBeInstanceOf(ForegroundChangedError);
			await expect(readFile(join(c.foreground, "ancestor.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(join(c.foreground, "winner.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(join(c.foreground, "readme.md"), "utf8")).toBe("original" + "\n");
			expect(await readFile(join(c.foreground, "drift.txt"), "utf8")).toBe("drift" + "\n");
			await c.childLease.release();
			await c.rootLease.release();
		}, 30_000);

		it("replays the durable lineage receipt across manager reopens", async () => {
			const c = await createLineageCase(backend);
			let finalRuns = 0;
			const first = await c.manager.promote({
				lease: c.childLease,
				finalVerifier: () => {
					finalRuns += 1;
				},
			});
			expect(first.status).toBe("promoted");
			if (first.status !== "promoted") throw new Error("expected promotion");
			// Crash/reopen: a fresh manager over the same state root reattaches
			// the lease and returns the original durable result.
			const reopened = backend.createManager(c.stateRoot);
			const childLease = await reopened.fork(c.snapshot1, "child");
			const second = await reopened.promote({
				lease: childLease,
				finalVerifier: () => {
					finalRuns += 1;
				},
			});
			expect(second).toEqual(first);
			expect(finalRuns).toBe(1);
			expect(await readFile(join(c.foreground, "ancestor.txt"), "utf8")).toBe("ancestor" + "\n");
			expect(await readFile(join(c.foreground, "winner.txt"), "utf8")).toBe("winner" + "\n");
			await childLease.release();
			await c.rootLease.release();
		}, 30_000);

		it("reference-aware retention keeps the origin while a derived snapshot lives", async () => {
			const c = await createLineageCase(backend);
			// Releasing the root lease auto-releases unreferenced snapshots;
			// the origin stays retained because the live derived snapshot
			// still needs it as its promotion baseline.
			await c.rootLease.release();
			await expect(c.manager.findSnapshot(c.snapshot0.id)).resolves.toBeDefined();
			// An explicit origin release is deferred the same way.
			await c.manager.releaseSnapshot(c.snapshot0);
			await expect(c.manager.findSnapshot(c.snapshot0.id)).resolves.toBeDefined();
			// Once the derived snapshot is gone the origin goes too.
			await c.childLease.release();
			await c.manager.releaseSnapshot(c.snapshot0);
			await expect(c.manager.findSnapshot(c.snapshot0.id)).rejects.toBeInstanceOf(WorkspaceSnapshotNotFoundError);
		}, 30_000);
	});
}
