/**
 * Canonical-first, legacy-fallback interception dispatch for interactive
 * ! / !! commands.
 *
 * Dispatch rules:
 * 1. Emit the canonical `user_shell` event. A handler "handles" the command
 *    only when it returns `result` or `operations`; empty objects fall through.
 * 2. Only when unhandled and the resolved shell is Bash, emit the legacy
 *    `user_bash` event so existing listeners keep working.
 * 3. Otherwise the caller executes on the host with the resolved shell.
 *
 * Execution happens exactly once, by whichever path produced the result or
 * operations, so handlers can never cause double execution.
 */

import type { ShellKind } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { UserShellEventResult } from "./extensions/types.ts";

export interface ShellCommandInput {
	shell: ShellKind;
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

export async function interceptShellCommand(
	runner: ExtensionRunner,
	input: ShellCommandInput,
): Promise<UserShellEventResult | undefined> {
	const canonical = await runner.emitUserShell({
		type: "user_shell",
		shell: input.shell,
		command: input.command,
		excludeFromContext: input.excludeFromContext,
		cwd: input.cwd,
	});
	if (canonical) {
		return canonical;
	}
	if (input.shell !== "bash") {
		// Legacy user_bash listeners only ever describe Bash execution.
		return undefined;
	}
	return runner.emitUserBash({
		type: "user_bash",
		command: input.command,
		excludeFromContext: input.excludeFromContext,
		cwd: input.cwd,
	});
}
