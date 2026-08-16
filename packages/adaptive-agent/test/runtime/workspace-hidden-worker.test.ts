import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	BoundWorkspaceExecutionEnv,
	GitWorktreeWorkspaceManager,
	releaseBoundWorker,
	WorkspacePathAdapter,
	WorkspacePathEscapeError,
} from "../../src/index.ts";

const execFileP = promisify(execFile);

const cleanups: string[] = [];
afterEach(async () => {
	for (const path of cleanups.splice(0)) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function fixture(): Promise<{
	sourceRoot: string;
	stateRoot: string;
	manager: GitWorktreeWorkspaceManager;
}> {
	const sourceRoot = await mkdtemp(join(tmpdir(), "pi-s7-worker-src-"));
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-worker-state-"));
	cleanups.push(sourceRoot, stateRoot);
	const run = async (args: string[]): Promise<void> => {
		await execFileP("git", args, { cwd: sourceRoot, windowsHide: true });
	};
	await run(["init", "-b", "main", "."]);
	await run(["config", "user.email", "s7@test"]);
	await run(["config", "user.name", "s7"]);
	await run(["config", "core.autocrlf", "false"]);
	await writeFile(join(sourceRoot, "a.txt"), "one\n");
	await run(["add", "-A"]);
	await run(["commit", "-m", "c"]);
	return { sourceRoot, stateRoot, manager: new GitWorktreeWorkspaceManager({ stateRoot }) };
}

describe("hidden worker binding", () => {
	it("the bound environment executes the four fixed tools only inside the lease root", async () => {
		const { sourceRoot, manager } = await fixture();
		const snapshot = await manager.capture({ sourceRoot, logicalRoot: "/workspace" });
		const lease = await manager.fork(snapshot, "c1");
		const env = new BoundWorkspaceExecutionEnv({ lease });
		const context = { env } satisfies ExecutionToolContext;
		const read = createReadTool<ExecutionToolContext>();
		const write = createWriteTool<ExecutionToolContext>();
		const edit = createEditTool<ExecutionToolContext>();
		const bash = createBashTool<ExecutionToolContext>();
		try {
			await write.execute(
				"w1",
				{ path: "out.txt", content: "written by tool\n" },
				undefined,
				() => undefined,
				context,
			);
			await edit.execute(
				"e1",
				{ path: "out.txt", edits: [{ oldText: "written", newText: "edited" }] },
				undefined,
				() => undefined,
				context,
			);
			await read.execute("r1", { path: "out.txt" }, undefined, () => undefined, context);
			await bash.execute("b1", { command: "echo shell-write > shell.txt" }, undefined, () => undefined, context);
			// All four effects landed in the lease root.
			expect(await readFile(join(lease.root, "out.txt"), "utf8")).toBe("edited by tool\n");
			expect(await readFile(join(lease.root, "shell.txt"), "utf8")).toBe("shell-write\n");
			// The foreground source is untouched.
			await expect(readFile(join(sourceRoot, "out.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(readFile(join(sourceRoot, "shell.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(join(sourceRoot, "a.txt"), "utf8")).toBe("one\n");
		} finally {
			await releaseBoundWorker({ env, closeHarness: async () => {}, lease });
		}
	});

	it("the path adapter maps logical paths onto the lease root and back", async () => {
		const { sourceRoot, manager } = await fixture();
		const snapshot = await manager.capture({ sourceRoot, logicalRoot: "/workspace" });
		const lease = await manager.fork(snapshot, "c1");
		const adapter = new WorkspacePathAdapter({
			logicalWorkspace: snapshot.logicalWorkspace,
			physicalRoot: lease.root,
		});
		expect(adapter.toPhysicalPath("/workspace/a.txt")).toBe(join(lease.root, "a.txt"));
		expect(adapter.toPhysicalPath("/workspace")).toBe(lease.root);
		expect(adapter.toLogicalPath(join(lease.root, "a.txt"))).toBe("/workspace/a.txt");
		expect(adapter.toLogicalPath(lease.root)).toBe("/workspace");
		expect(() => adapter.toPhysicalPath("/other/a.txt")).toThrow(WorkspacePathEscapeError);
		expect(() => adapter.toPhysicalPath("/workspace/../escape.txt")).toThrow(WorkspacePathEscapeError);
		expect(() => adapter.toLogicalPath(sourceRoot)).toThrow(WorkspacePathEscapeError);
		// Relative logical paths land inside the lease root.
		expect(adapter.toPhysicalPath("relative.txt")).toBe(join(lease.root, "relative.txt"));
		await lease.release();
	});

	it("the checkpoint logical identity carries no physical root", async () => {
		const { sourceRoot, manager } = await fixture();
		await writeFile(join(sourceRoot, "u.txt"), "u\n");
		const snapshot = await manager.capture({ sourceRoot, logicalRoot: "/logical-root" });
		expect(snapshot.logicalWorkspace.root).toBe("/logical-root");
		expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		const lease = await manager.fork(snapshot, "c1");
		expect(JSON.stringify(lease.environment.logicalWorkspace)).not.toContain(sourceRoot);
		expect(JSON.stringify(snapshot)).not.toContain(lease.root);
		await lease.release();
	});

	it("env.cleanup stops child processes before the lease is released", async () => {
		const { sourceRoot, manager } = await fixture();
		const snapshot = await manager.capture({ sourceRoot, logicalRoot: "/workspace" });
		const lease = await manager.fork(snapshot, "c1");
		const env = new BoundWorkspaceExecutionEnv({ lease });
		const bash = createBashTool<ExecutionToolContext>();
		await bash.execute("b1", { command: "echo started" }, undefined, () => undefined, { env });
		await releaseBoundWorker({ env, closeHarness: async () => {}, lease });
		await expect(readFile(join(lease.root, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
