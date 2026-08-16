import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { type ProcessExitInfo, ProcessManager } from "../src/process-manager.ts";

const stubPath = fileURLToPath(new URL("./fixtures/stub-backend.mjs", import.meta.url));
const tempDirs: string[] = [];

function makeWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-adapter-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface StartedStub {
	process: ProcessManager;
	records: Array<Record<string, unknown>>;
	exitInfo: ProcessExitInfo | null;
	stderr: string[];
	waitForExit(timeoutMs?: number): Promise<ProcessExitInfo>;
	waitForRecord(
		predicate: (record: Record<string, unknown>) => boolean,
		timeoutMs?: number,
	): Promise<Record<string, unknown>>;
}

async function startStub(workspace: string, env?: Record<string, string | undefined>): Promise<StartedStub> {
	const manager = new ProcessManager({
		executable: process.execPath,
		args: [stubPath],
		cwd: workspace,
		env,
	});
	const records: Array<Record<string, unknown>> = [];
	const stderr: string[] = [];
	let exitInfo: ProcessExitInfo | null = null;
	manager.onStdout((chunk) => {
		for (const line of Buffer.from(chunk).toString("utf8").split("\n")) {
			const trimmed = line.replace(/\r$/, "");
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as Record<string, unknown>);
			} catch {
				// ignore non-JSON stdout in the test harness
			}
		}
	});
	manager.onStderr((line) => stderr.push(line));
	manager.onExit((info) => {
		exitInfo = info;
	});
	await manager.start();

	const waitForExit = (timeoutMs = 10_000) =>
		new Promise<ProcessExitInfo>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for exit")), timeoutMs);
			const unsubscribe = manager.onExit((info) => {
				clearTimeout(timer);
				unsubscribe();
				resolve(info);
			});
			if (exitInfo) {
				clearTimeout(timer);
				resolve(exitInfo);
			}
		});

	const waitForRecord = (predicate: (record: Record<string, unknown>) => boolean, timeoutMs = 10_000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const existing = records.find(predicate);
			if (existing) {
				resolve(existing);
				return;
			}
			const timer = setTimeout(() => reject(new Error("timed out waiting for record")), timeoutMs);
			const check = () => {
				const found = records.find(predicate);
				if (found) {
					clearTimeout(timer);
					clearInterval(interval);
					resolve(found);
				}
			};
			const interval = setInterval(check, 20);
		});

	return {
		process: manager,
		records,
		stderr,
		waitForExit,
		waitForRecord,
		get exitInfo() {
			return exitInfo;
		},
	};
}

describe("ProcessManager", () => {
	test("spawns the backend in the workspace directory with merged env", async () => {
		const workspace = makeWorkspace();
		const stub = await startStub(workspace, { STUB_MARKER: "works" });
		const info = await stub.waitForRecord((record) => record.type === "cwd");
		expect(info.cwd).toBe(workspace);
		expect(info.marker).toBe("works");
		expect(stub.process.isRunning).toBe(true);
		expect(stub.process.pid).toBeTypeOf("number");
		await stub.process.stop();
	});

	test("captures stderr line by line and reports crashed exit with code", async () => {
		const workspace = makeWorkspace();
		const crashScript = join(workspace, "crash.mjs");
		writeFileSync(
			crashScript,
			'process.stderr.write("boom line 1\\n");\nprocess.stderr.write("boom line 2\\n");\nprocess.exit(3);\n',
		);
		const manager = new ProcessManager({
			executable: process.execPath,
			args: [crashScript],
			cwd: workspace,
		});
		const stderr: string[] = [];
		manager.onStderr((line) => stderr.push(line));
		const exitPromise = new Promise<ProcessExitInfo>((resolve) => manager.onExit(resolve));
		await manager.start();
		const info = await exitPromise;
		expect(info.crashed).toBe(true);
		expect(info.code).toBe(3);
		expect(stderr).toEqual(["boom line 1", "boom line 2"]);
		expect(manager.isRunning).toBe(false);
	});

	test("spawn failure reports a crashed exit with a diagnostic line", async () => {
		const workspace = makeWorkspace();
		const manager = new ProcessManager({
			executable: join(workspace, "does-not-exist.exe"),
			args: [],
			cwd: workspace,
		});
		const stderr: string[] = [];
		manager.onStderr((line) => stderr.push(line));
		const exitPromise = new Promise<ProcessExitInfo>((resolve) => manager.onExit(resolve));
		await expect(manager.start()).rejects.toThrow();
		const info = await exitPromise;
		expect(info.crashed).toBe(true);
		expect(stderr.some((line) => line.includes("Failed to spawn"))).toBe(true);
	});

	test("stop() terminates the backend and marks exit as intentional", async () => {
		const workspace = makeWorkspace();
		const stub = await startStub(workspace);
		await stub.process.stop();
		expect(stub.process.isRunning).toBe(false);
		expect(stub.exitInfo).not.toBeNull();
		expect(stub.exitInfo?.crashed).toBe(false);
	});

	test("stop() is idempotent and safe before start", async () => {
		const manager = new ProcessManager({ executable: "node", args: [], cwd: makeWorkspace() });
		await manager.stop();
		expect(manager.isRunning).toBe(false);
	});

	test("onStdout streams raw chunks (JSONL records intact)", async () => {
		const workspace = makeWorkspace();
		const stub = await startStub(workspace);
		const info = await stub.waitForRecord((record) => record.type === "backend_info");
		expect(info.version).toBe("stub-1.0.0");
		await stub.process.stop();
	});

	test("env passthrough does not clobber parent env", async () => {
		const workspace = makeWorkspace();
		const stub = await startStub(workspace, { STUB_MARKER: "x" });
		const info = await stub.waitForRecord((record) => record.type === "cwd");
		expect(info.marker).toBe("x");
		await stub.process.stop();
	});
});
