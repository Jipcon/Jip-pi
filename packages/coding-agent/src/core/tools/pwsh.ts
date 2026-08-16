import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawnSync } from "child_process";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type CommandOperations,
	type CommandRenderState,
	type CommandSpawnConfig,
	type CommandSpawnContext,
	type CommandSpawnHook,
	type CommandToolDetails,
	createCommandToolRenderers,
	createLocalCommandOperations,
	executeCommandTool,
	resolveCommandSpawnContext,
} from "./command-tool.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

const pwshSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const pwshToolSystemPromptContribution = {
	snippet: "Execute PowerShell commands (Get-ChildItem, Get-Content, Select-String, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type PwshToolInput = Static<typeof pwshSchema>;

export type PwshToolDetails = CommandToolDetails;

/**
 * Pluggable operations for the pwsh tool.
 * Override these to delegate command execution to remote systems.
 */
export type PwshOperations = CommandOperations;

/** Pwsh startup argv shared by every resolution path. */
const PWSH_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];

/**
 * Windows: pwsh must inherit the console encoding. Spawning with
 * windowsHide (CREATE_NO_WINDOW) detaches pwsh from any console, and
 * PowerShell 7 then falls back to the system ANSI codepage for
 * [Console]::OutputEncoding (verified: GBK/936 on this machine), corrupting
 * UTF-8 output. Without windowsHide, pwsh inherits the parent console's
 * codepage, which is UTF-8 in pi's normal terminal usage and round-trips
 * non-ASCII text correctly.
 */
const PWSH_WINDOWS_HIDE = false;

function findPwshOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		for (const candidate of ["pwsh.exe", "pwsh"]) {
			try {
				const result = spawnSync("where", [candidate], {
					encoding: "utf-8",
					timeout: 5000,
					windowsHide: true,
				});
				if (result.status === 0 && result.stdout) {
					const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
					if (firstMatch && existsSync(firstMatch)) {
						return firstMatch;
					}
				}
			} catch {
				// Ignore errors
			}
		}
		return null;
	}

	// Unix: Use 'which' and trust its output
	try {
		const result = spawnSync("which", ["pwsh"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

function findKnownPwshPath(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	const programFiles = process.env.ProgramFiles;
	const candidate = programFiles ? `${programFiles}\\PowerShell\\7\\pwsh.exe` : undefined;
	return candidate && existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the PowerShell 7 executable and its startup argv.
 *
 * Resolution order:
 * 1. User-specified pwshPath
 * 2. pwsh / pwsh.exe on PATH
 * 3. Windows known path %ProgramFiles%\PowerShell\7\pwsh.exe
 * 4. Explicit error
 *
 * Never falls back to Windows PowerShell 5.1 (powershell.exe), Git Bash, or
 * cmd.exe. This runs inside operations.exec(), so importing the module or
 * creating tool definitions never searches for or launches pwsh.
 */
export function resolvePwshSpawnConfig(pwshPath?: string): CommandSpawnConfig {
	const args = [...PWSH_ARGS];
	if (pwshPath) {
		if (existsSync(pwshPath)) {
			return { executable: pwshPath, args, windowsHide: PWSH_WINDOWS_HIDE };
		}
		throw new Error(`Custom pwsh path not found: ${pwshPath}`);
	}

	const onPath = findPwshOnPath();
	if (onPath) {
		return { executable: onPath, args, windowsHide: PWSH_WINDOWS_HIDE };
	}

	const knownPath = findKnownPwshPath();
	if (knownPath) {
		return { executable: knownPath, args, windowsHide: PWSH_WINDOWS_HIDE };
	}

	throw new Error(
		`No pwsh (PowerShell 7) found. Options:\n` +
			`  1. Install PowerShell 7: https://learn.microsoft.com/powershell/scripting/install/installing-powershell\n` +
			`  2. Add pwsh to PATH\n` +
			`  3. Set pwshPath in settings.json`,
	);
}

/**
 * Create pwsh operations using pi's built-in local execution backend.
 *
 * This is useful for extensions that want pi's standard local PowerShell
 * behavior while wrapping or rewriting commands.
 */
export function createLocalPwshOperations(options?: { pwshPath?: string }): PwshOperations {
	return createLocalCommandOperations({
		toolName: "pwsh",
		// Pwsh executable resolution stays lazy: it happens inside exec(), not at
		// tool creation time.
		resolveSpawnConfig: () => resolvePwshSpawnConfig(options?.pwshPath),
	});
}

export type PwshSpawnContext = CommandSpawnContext;

export type PwshSpawnHook = CommandSpawnHook;

export interface PwshToolOptions {
	/** Custom operations for command execution. Default: local PowerShell 7 */
	operations?: PwshOperations;
	/** Command prefix prepended to every command (for example profile setup commands) */
	commandPrefix?: string;
	/** Optional explicit pwsh executable path from settings */
	pwshPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: PwshSpawnHook;
}

export function createPwshToolDefinition(
	cwd: string,
	options?: PwshToolOptions,
): ToolDefinition<typeof pwshSchema, PwshToolDetails | undefined, CommandRenderState> {
	const ops = options?.operations ?? createLocalPwshOperations({ pwshPath: options?.pwshPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const renderers = createCommandToolRenderers({ callPrefix: "PS> " });
	return {
		name: "pwsh",
		label: "pwsh",
		description: `Execute a PowerShell command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: pwshToolSystemPromptContribution.snippet,
		promptGuidelines: exposeSessionEnvironment ? [...pwshToolSystemPromptContribution.guidelines] : undefined,
		parameters: pwshSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?,
			onUpdate?,
			ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveCommandSpawnContext(
				resolvedCommand,
				cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			return executeCommandTool({
				timeout,
				ops,
				spawnContext,
				tempFilePrefix: "pi-pwsh",
				signal,
				onUpdate,
			});
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	};
}

export function createPwshTool(cwd: string, options?: PwshToolOptions): AgentTool<typeof pwshSchema> {
	const definition = createPwshToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
