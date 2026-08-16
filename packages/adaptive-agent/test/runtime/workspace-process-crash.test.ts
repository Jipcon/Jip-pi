import { type ChildProcess, execFile, spawn } from "node:child_process";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it as vitestIt } from "vitest";

const it = (name: string, fn: () => Promise<void> | void, timeout = 60_000) => vitestIt(name, fn, timeout);

import { GitWorktreeWorkspaceManager, JsonlManifestStore, workspaceLeaseId } from "../../src/index.ts";

const execFileP = promisify(execFile);
const CHILD_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "workspace-crash-child.ts");

interface CrashDriver {
	child: ChildProcess;
	replies: Array<{ t: string; [key: string]: unknown }>;
	waitForReply: (
		predicate?: (reply: { t: string; [key: string]: unknown }) => boolean,
	) => Promise<{ t: string; [key: string]: unknown }>;
	kill(): Promise<void>;
}

async function spawnChild(): Promise<CrashDriver> {
	const child = spawn(process.execPath, ["--no-warnings", CHILD_PATH], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const driver: CrashDriver = {
		child,
		replies: [],
		waitForReply: (predicate) =>
			new Promise((resolve, reject) => {
				const settle = (): void => {
					const index = driver.replies.findIndex((reply) => predicate === undefined || predicate(reply));
					if (index >= 0) {
						const [reply] = driver.replies.splice(index, 1);
						resolve(reply);
						return;
					}
					setTimeout(settle, 20);
				};
				settle();
				child.once("exit", () => reject(new Error("child exited before replying")));
			}),
		kill: async () => {
			if (child.exitCode !== null) return;
			if (process.platform === "win32") {
				await execFileP("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }).catch(
					() => undefined,
				);
			} else {
				child.kill("SIGKILL");
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 3000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
	child.on("message", (message: { t: string; [key: string]: unknown }) => {
		driver.replies.push(message);
	});
	child.stderr?.on("data", () => {});
	return driver;
}

function send(driver: CrashDriver, command: Record<string, unknown>): void {
	driver.child.send(command as Parameters<ChildProcess["send"]>[0]);
}

const cleanups: string[] = [];
afterEach(async () => {
	for (const path of cleanups.splice(0)) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function newSource(): Promise<{ root: string; stateRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-s7-crash-src-"));
	const stateRoot = await mkdtemp(join(tmpdir(), "pi-s7-crash-state-"));
	cleanups.push(root, stateRoot);
	const run = async (args: string[]): Promise<void> => {
		await execFileP("git", args, { cwd: root, windowsHide: true });
	};
	await run(["init", "-b", "main", "."]);
	await run(["config", "user.email", "s7@test"]);
	await run(["config", "user.name", "s7"]);
	await run(["config", "core.autocrlf", "false"]);
	await writeFile(join(root, "a.txt"), "one\n");
	await writeFile(join(root, "u.txt"), "u\n");
	await run(["add", "-A"]);
	await run(["commit", "-m", "c"]);
	return { root, stateRoot };
}

describe("workspace process-crash recovery", () => {
	it("a crash right after capture leaves a reattachable snapshot and no twins", async () => {
		const { root, stateRoot } = await newSource();
		const driver = await spawnChild();
		send(driver, { c: "capture", root, stateRoot });
		const held = await driver.waitForReply((reply) => reply.t === "held");
		const snapshotId = held.snapshotId as string;
		await driver.kill();
		// "Restart": a fresh manager over the same state dir.
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const snapshot = await manager.findSnapshot(snapshotId);
		expect(snapshot.id).toBe(snapshotId);
		const lease = await manager.fork(snapshot, "c1");
		expect(await readFile(join(lease.root, "u.txt"), "utf8")).toBe("u\n");
		const again = await manager.fork(snapshot, "c1");
		expect(again.root).toBe(lease.root);
		await lease.release();
		await manager.releaseSnapshot(snapshot);
		await manager.recover();
		expect(await readdirList(join(stateRoot, "worktrees"))).toEqual([]);
	});

	it("a crash between the creating record and the worktree add is completed by recover()", async () => {
		const { root, stateRoot } = await newSource();
		const driver = await spawnChild();
		send(driver, { c: "capture", root, stateRoot });
		const held = await driver.waitForReply((reply) => reply.t === "held");
		const snapshotId = held.snapshotId as string;
		await driver.kill();
		const driver2 = await spawnChild();
		send(driver2, { c: "fork-creating", root, stateRoot, snapshotId, candidateId: "crashy" });
		const held2 = await driver2.waitForReply((reply) => reply.t === "held");
		expect(held2.leaseId).toBe(workspaceLeaseId(snapshotId, "crashy"));
		await driver2.kill();
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const report = await manager.recover();
		expect(report.leases.completed).toBe(1);
		const snapshot = await manager.findSnapshot(snapshotId);
		const lease = await manager.fork(snapshot, "crashy");
		expect(lease.root).toBe(held2.leaseRoot);
		expect(await readFile(join(lease.root, "u.txt"), "utf8")).toBe("u\n");
		await lease.release();
	});

	it("a crash after fork completes reattaches the same lease instead of creating a twin", async () => {
		const { root, stateRoot } = await newSource();
		const driver = await spawnChild();
		send(driver, { c: "capture", root, stateRoot });
		const held = await driver.waitForReply((reply) => reply.t === "held");
		const snapshotId = held.snapshotId as string;
		await driver.kill();
		const driver2 = await spawnChild();
		send(driver2, { c: "fork-create", root, stateRoot, snapshotId, candidateId: "live" });
		const held2 = await driver2.waitForReply((reply) => reply.t === "held");
		await driver2.kill();
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const snapshot = await manager.findSnapshot(snapshotId);
		const lease = await manager.fork(snapshot, "live");
		expect(lease.id).toBe(held2.leaseId);
		expect(lease.root).toBe(held2.leaseRoot);
		const report = await manager.recover();
		expect(report.leases.ready).toBe(1);
		await lease.release();
	});

	it("a crash after all promotion paths applied rolls the promotion back on recover()", async () => {
		const { root, stateRoot } = await newSource();
		const driver = await spawnChild();
		send(driver, { c: "capture", root, stateRoot });
		const held = await driver.waitForReply((reply) => reply.t === "held");
		const snapshotId = held.snapshotId as string;
		await driver.kill();
		const driver2 = await spawnChild();
		send(driver2, { c: "promote-applied", root, stateRoot, snapshotId, candidateId: "winner" });
		await driver2.waitForReply((reply) => reply.t === "held");
		await driver2.kill();
		// The candidate had applied u.txt = "u candidate\n" and journaled it
		// before the crash; recovery must roll the foreground back.
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u candidate\n");
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const report = await manager.recover();
		expect(report.promotions.rolledBack.length).toBe(1);
		expect(await readFile(join(root, "u.txt"), "utf8")).toBe("u\n");
		// No twin journals or worktrees.
		await manager.recover();
		expect((await manager.recover()).promotions.rolledBack).toEqual([]);
	});

	it("a crash after the releasing record finishes the release on recover()", async () => {
		const { root, stateRoot } = await newSource();
		const driver = await spawnChild();
		send(driver, { c: "capture", root, stateRoot });
		const held = await driver.waitForReply((reply) => reply.t === "held");
		const snapshotId = held.snapshotId as string;
		await driver.kill();
		const driver2 = await spawnChild();
		send(driver2, { c: "release-releasing", root, stateRoot, snapshotId, candidateId: "doomed" });
		const held2 = await driver2.waitForReply((reply) => reply.t === "held");
		await driver2.kill();
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const report = await manager.recover();
		expect(report.leases.released).toBeGreaterThanOrEqual(1);
		expect(report.remainingOrphans).toEqual([]);
		await expect(readFile(join(held2.leaseRoot as string, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("torn manifest tails are dropped and never silently skipped", async () => {
		const { root, stateRoot } = await newSource();
		const manager = new GitWorktreeWorkspaceManager({ stateRoot });
		const snapshot = await manager.capture({ sourceRoot: root, logicalRoot: "/w" });
		// Append a torn line, then reopen through a fresh store.
		await appendFile(join(stateRoot, "manifest.jsonl"), '{"type":"snap', "utf8");
		const reopened = new JsonlManifestStore({ filePath: join(stateRoot, "manifest.jsonl") });
		const records = await reopened.records();
		expect(records.length).toBeGreaterThan(0);
		expect(records[records.length - 1]!.type).toBe("snapshot");
		await reopened.close();
		const after = new GitWorktreeWorkspaceManager({ stateRoot });
		await expect(after.findSnapshot(snapshot.id)).resolves.toMatchObject({ id: snapshot.id });
	});
});

async function readdirList(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).filter((name) => !name.endsWith(".tmp-"));
	} catch {
		return [];
	}
}
