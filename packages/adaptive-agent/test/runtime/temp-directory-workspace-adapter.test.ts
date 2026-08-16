import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TempDirectoryWorkspaceManager, type WorkspaceManager } from "../../src/index.ts";
import { type ConformanceBackend, createWorkspaceManagerConformance } from "./workspace-manager-conformance.ts";

const tempBackend: ConformanceBackend = {
	backend: "temp-copy",
	createManager(stateRoot, options): WorkspaceManager {
		return new TempDirectoryWorkspaceManager({
			stateRoot,
			policy: options?.policy,
			retry: { maxAttempts: 3, delayMs: 40 },
		});
	},
	async prepareSource() {
		// A plain directory; capture walks it directly.
	},
	async commitAll() {
		// No git: the whole tree is the snapshot basis.
	},
	async stageAll() {},
	async listPrivateRefs() {
		return [];
	},
	async listWorktrees() {
		return "";
	},
	async currentBranch() {
		return "";
	},
	async indexTree() {
		return "";
	},
	async stagedNames() {
		return [];
	},
	async statusPorcelain() {
		return "";
	},
};

const cleanups: Array<{ root: string; stateRoot: string }> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await rm(cleanup.root, { recursive: true, force: true }).catch(() => undefined);
		await rm(cleanup.stateRoot, { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("TempDirectoryWorkspaceManager", () => {
	describe("conformance", () => {
		createWorkspaceManagerConformance({ backend: tempBackend });
	});

	it("uses real byte copies, never hardlinks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-s7-temp-src-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-temp-state-"));
		cleanups.push({ root, stateRoot });
		await writeFile(join(root, "a.txt"), "one\n");
		const manager = new TempDirectoryWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		// Mutating the lease must not affect the source.
		await writeFile(join(lease.root, "a.txt"), "changed in candidate\n");
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\n");
		await lease.release();
	});

	it("promotes full-tree content back to the foreground", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-s7-temp-src-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-temp-state-"));
		cleanups.push({ root, stateRoot });
		await writeFile(join(root, "a.txt"), "one\n");
		await writeFile(join(root, "u.txt"), "u\n");
		const manager = new TempDirectoryWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		const lease = await manager.fork(snapshot, "c1");
		await writeFile(join(lease.root, "a.txt"), "one\ncandidate\n");
		await rm(join(lease.root, "u.txt"));
		await writeFile(join(lease.root, "new.txt"), "new\n");
		const result = await manager.promote({ lease });
		expect(result.status).toBe("promoted");
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ncandidate\n");
		await expect(readFile(join(root, "u.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
		await lease.release();
	});
});
