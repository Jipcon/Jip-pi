import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { getShellConfig } from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type CommandOperations,
	type CommandRenderState,
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

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export type BashToolDetails = CommandToolDetails;

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export type BashOperations = CommandOperations;

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalCommandOperations({
		toolName: "bash",
		// Bash executable resolution stays lazy: it happens inside exec(), not at
		// tool creation time.
		resolveSpawnConfig: () => {
			const config = getShellConfig(options?.shellPath);
			return {
				executable: config.shell,
				args: config.args,
				commandTransport: config.commandTransport,
			};
		},
	});
}

export type BashSpawnContext = CommandSpawnContext;

export type BashSpawnHook = CommandSpawnHook;

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, CommandRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const renderers = createCommandToolRenderers({ callPrefix: "$ " });
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: bashToolSystemPromptContribution.snippet,
		promptGuidelines: exposeSessionEnvironment ? [...bashToolSystemPromptContribution.guidelines] : undefined,
		parameters: bashSchema,
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
				tempFilePrefix: "pi-bash",
				signal,
				onUpdate,
			});
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
