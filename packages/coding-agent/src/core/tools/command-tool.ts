/**
 * Shared execution machinery for the built-in shell tools (bash and pwsh).
 *
 * Internal implementation module: the shell-facing prompts, schemas, call
 * titles, and executable resolution stay in the shell-specific adapters
 * (bash.ts / pwsh.ts), which re-export these primitives under their own
 * public Bash- and Pwsh-prefixed names.
 */

import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { ExtensionContext, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

export function resolveCommandTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/** Executable plus argv layout for spawning a shell command. */
export interface CommandSpawnConfig {
	executable: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
	/** Hide the console window on Windows. Defaults to true. */
	windowsHide?: boolean;
}

/** Internal pluggable operations shared by the bash and pwsh tools. */
export interface CommandOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Local command execution backend with streaming output, abort support, and
 * process-tree termination. Executable resolution is delegated to
 * `resolveSpawnConfig`, which is invoked inside `exec()` so tool creation and
 * catalog construction never touch the filesystem or launch a shell.
 */
export function createLocalCommandOperations(options: {
	toolName: string;
	resolveSpawnConfig: () => CommandSpawnConfig;
}): CommandOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveCommandTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const spawnConfig = options.resolveSpawnConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${options.toolName} commands.`);
			}

			const commandFromStdin = spawnConfig.commandTransport === "stdin";
			const child = spawn(
				spawnConfig.executable,
				commandFromStdin ? spawnConfig.args : [...spawnConfig.args, command],
				{
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: spawnConfig.windowsHide ?? true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface CommandSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type CommandSpawnHook = (context: CommandSpawnContext) => CommandSpawnContext;

export function resolveCommandSpawnContext(
	command: string,
	cwd: string,
	spawnHook: CommandSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): CommandSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: CommandSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface CommandToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface CommandToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: CommandToolDetails | undefined;
}

const COMMAND_UPDATE_THROTTLE_MS = 100;

/**
 * Run a shell command through the shared lifecycle: streaming output with
 * throttled onUpdate callbacks, truncation with temp-file persistence, and
 * unified abort/timeout/exit-code error rendering.
 */
export async function executeCommandTool(options: {
	timeout?: number;
	ops: CommandOperations;
	spawnContext: CommandSpawnContext;
	tempFilePrefix: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<CommandToolDetails | undefined>;
}): Promise<CommandToolResult> {
	const { timeout, ops, spawnContext, tempFilePrefix, signal, onUpdate } = options;
	const output = new OutputAccumulator({ tempFilePrefix });
	let acceptingOutput = true;
	let updateTimer: NodeJS.Timeout | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const emitOutputUpdate = () => {
		if (!onUpdate || !updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		onUpdate({
			content: [{ type: "text", text: snapshot.content || "" }],
			details: {
				truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
				fullOutputPath: snapshot.fullOutputPath,
			},
		});
	};

	const clearUpdateTimer = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};

	const scheduleOutputUpdate = () => {
		if (!onUpdate) return;
		updateDirty = true;
		const delay = COMMAND_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitOutputUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitOutputUpdate();
		}, delay);
	};

	if (onUpdate) {
		onUpdate({ content: [], details: undefined });
	}

	const handleData = (data: Buffer) => {
		if (!acceptingOutput) return;
		output.append(data);
		scheduleOutputUpdate();
	};

	const finishOutput = async () => {
		acceptingOutput = false;
		output.finish();
		clearUpdateTimer();
		emitOutputUpdate();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		await output.closeTempFile();
		return snapshot;
	};

	const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
		const truncation = snapshot.truncation;
		let text = snapshot.content || emptyText;
		let details: CommandToolDetails | undefined;
		if (truncation.truncated) {
			details = { truncation, fullOutputPath: snapshot.fullOutputPath };
			const startLine = truncation.totalLines - truncation.outputLines + 1;
			const endLine = truncation.totalLines;
			if (truncation.lastLinePartial) {
				const lastLineSize = formatSize(output.getLastLineBytes());
				text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
			} else if (truncation.truncatedBy === "lines") {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
			} else {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
			}
		}
		return { text, details };
	};

	const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

	try {
		let exitCode: number | null;
		try {
			const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
				onData: handleData,
				signal,
				timeout,
				env: spawnContext.env,
			});
			exitCode = result.exitCode;
		} catch (err) {
			const snapshot = await finishOutput();
			const { text } = formatOutput(snapshot, "");
			if (err instanceof Error && err.message === "aborted") {
				throw new Error(appendStatus(text, "Command aborted"));
			}
			if (err instanceof Error && err.message.startsWith("timeout:")) {
				const timeoutSecs = err.message.split(":")[1];
				throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
			}
			throw err;
		}

		const snapshot = await finishOutput();
		const { text: outputText, details } = formatOutput(snapshot);
		if (exitCode !== 0 && exitCode !== null) {
			throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
		}
		return { content: [{ type: "text", text: outputText }], details };
	} finally {
		clearUpdateTimer();
	}
}

// ============================================================================
// TUI rendering (shared; shell-specific adapters only pick the call prefix)
// ============================================================================

const COMMAND_PREVIEW_LINES = 5;

export type CommandRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type CommandResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class CommandResultRenderComponent extends Container {
	state: CommandResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatCommandCall(callPrefix: string, args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${callPrefix}${commandDisplay}`)) + timeoutSuffix;
}

function rebuildCommandResultRenderComponent(
	component: CommandResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: CommandToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, COMMAND_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

/** Minimal result shape consumed by the shared result renderer. */
type CommandRenderResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details: CommandToolDetails | undefined;
};

/**
 * TUI call/result renderers for a shell tool. `callPrefix` is the shell-facing
 * call title ("$ " for bash, "PS> " for pwsh).
 */
export function createCommandToolRenderers(options: { callPrefix: string }): {
	renderCall: (
		args: { command?: string; timeout?: number } | undefined,
		theme: Theme,
		context: ToolRenderContext<CommandRenderState>,
	) => Component;
	renderResult: (
		result: CommandRenderResultLike,
		resultOptions: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<CommandRenderState>,
	) => Component;
} {
	const { callPrefix } = options;
	return {
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCommandCall(callPrefix, args));
			return text;
		},
		renderResult(result, resultOptions, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && resultOptions.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!resultOptions.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as CommandResultRenderComponent | undefined) ?? new CommandResultRenderComponent();
			rebuildCommandResultRenderComponent(
				component,
				result,
				resultOptions,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}
