/**
 * ProcessManager: owns the backend subprocess lifecycle.
 *
 * The Pi source directory and the user workspace are strictly separated:
 * the child process is spawned with `cwd` set to the workspace while the
 * executable/scripts live in the Pi source tree (dev) or the packaged
 * resources (release).
 *
 * stdout is piped through to the RPC client (JSONL only). stderr is captured
 * line-by-line for diagnostics and is NEVER fed into the JSON parser.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Writable } from "node:stream";

export interface ProcessManagerOptions {
	/** Fully resolved executable path (or bare command resolved via PATH). */
	executable: string;
	/** Arguments passed to the executable. */
	args: string[];
	/** Working directory of the child process (the user's workspace). */
	cwd: string;
	/** Extra environment variables merged over the parent environment. */
	env?: Record<string, string | undefined>;
}

export interface ProcessExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** True when the process died on its own (not via stop()). */
	crashed: boolean;
}

const GRACEFUL_STOP_TIMEOUT_MS = 2_000;

export class ProcessManager {
	private readonly options: ProcessManagerOptions;
	private child: ChildProcess | undefined;
	private exited = false;
	private stopping = false;
	private readonly exitHandlers = new Set<(info: ProcessExitInfo) => void>();
	private readonly stderrHandlers = new Set<(line: string) => void>();
	private readonly stdoutHandlers = new Set<(chunk: string | Uint8Array) => void>();
	private stderrBuffer = "";

	constructor(options: ProcessManagerOptions) {
		this.options = options;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The child's stdin stream (writable). */
	get stdin(): Writable | null {
		return this.child?.stdin ?? null;
	}

	get isRunning(): boolean {
		return this.child !== undefined && !this.exited;
	}

	onExit(handler: (info: ProcessExitInfo) => void): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	onStderr(handler: (line: string) => void): () => void {
		this.stderrHandlers.add(handler);
		return () => this.stderrHandlers.delete(handler);
	}

	onStdout(handler: (chunk: string | Uint8Array) => void): () => void {
		this.stdoutHandlers.add(handler);
		return () => this.stdoutHandlers.delete(handler);
	}

	/** Spawn the backend process. Resolves once spawned (not when ready). */
	start(): Promise<void> {
		if (this.child) {
			return Promise.reject(new Error("Process already started"));
		}
		this.exited = false;
		this.stopping = false;
		this.stderrBuffer = "";

		const child = spawn(this.options.executable, this.options.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Do not flash a console window on Windows.
			windowsHide: true,
		});
		this.child = child;

		child.stdout?.on("data", (chunk: Buffer) => {
			for (const handler of this.stdoutHandlers) {
				handler(chunk);
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrBuffer += chunk.toString("utf8");
			while (true) {
				const newlineIndex = this.stderrBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stderrBuffer.slice(0, newlineIndex);
				this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
				this.emitStderrLine(line);
			}
		});

		child.on("error", (error) => {
			// Spawn failure (e.g. executable missing): report as a crashed exit.
			if (!this.exited) {
				this.exited = true;
				const info: ProcessExitInfo = { code: null, signal: null, crashed: true };
				this.emitStderrLine(`Failed to spawn backend: ${error.message}`);
				this.emitExit(info);
			}
		});

		child.on("exit", (code, signal) => {
			if (this.stderrBuffer.length > 0) {
				this.emitStderrLine(this.stderrBuffer);
				this.stderrBuffer = "";
			}
			if (!this.exited) {
				this.exited = true;
				this.emitExit({ code, signal, crashed: !this.stopping });
			}
		});

		return new Promise((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", reject);
		});
	}

	/**
	 * Stop the backend process.
	 * Tries a graceful signal first, then force-kills the process tree so no
	 * grandchildren (e.g. shell commands spawned by the agent) survive.
	 */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child || this.exited) {
			this.child = undefined;
			return;
		}
		this.stopping = true;

		const exited = new Promise<void>((resolve) => {
			const onExit = () => {
				child.off("exit", onExit);
				resolve();
			};
			child.on("exit", onExit);
		});

		child.kill("SIGTERM");
		const graceful = await Promise.race([
			exited,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), GRACEFUL_STOP_TIMEOUT_MS)),
		]);

		if (graceful !== "timeout") {
			this.child = undefined;
			return;
		}

		// Force kill the whole tree.
		if (process.platform === "win32") {
			const pid = child.pid;
			if (pid !== undefined) {
				await new Promise<void>((resolve) => {
					const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
						windowsHide: true,
						stdio: "ignore",
					});
					killer.on("exit", () => resolve());
					killer.on("error", () => resolve());
				});
			}
		} else {
			child.kill("SIGKILL");
		}
		await exited;
		this.child = undefined;
	}

	private emitStderrLine(line: string): void {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (trimmed.length === 0) {
			return;
		}
		for (const handler of this.stderrHandlers) {
			handler(trimmed);
		}
	}

	private emitExit(info: ProcessExitInfo): void {
		for (const handler of this.exitHandlers) {
			handler(info);
		}
	}
}
