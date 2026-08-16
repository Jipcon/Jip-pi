/**
 * Tests for AgentSession.executeShell / recordShellResult:
 * - shell identity is carried through execution and persistence
 * - legacy executeBash keeps writing legacy-shaped records
 * - custom operations are the only execution path (host spawn never runs)
 * - bash_execution_update streaming events stay bash-only (RPC surface)
 */

import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandOperations } from "../src/core/tools/command-tool.ts";
import { getShellConfig } from "../src/utils/shell.ts";
import type { Harness } from "./test-harness.ts";
import { createHarness } from "./test-harness.ts";

function capturingOperations(commands: string[]): CommandOperations {
	return {
		exec: async (command, _cwd, { onData }) => {
			commands.push(command);
			onData(Buffer.from("captured output"));
			return { exitCode: 0 };
		},
	};
}

/** Detect a real pwsh executable, mirroring the pwsh tool's resolution order. */
function findPwshForTest(): string | null {
	if (process.platform === "win32") {
		try {
			const result = childProcess.spawnSync("where", ["pwsh.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) return firstMatch;
			}
		} catch {
			// Ignore errors
		}
		const programFiles = process.env.ProgramFiles;
		const knownPath = programFiles ? join(programFiles, "PowerShell", "7", "pwsh.exe") : undefined;
		if (knownPath && existsSync(knownPath)) return knownPath;
		return null;
	}
	try {
		const result = childProcess.spawnSync("which", ["pwsh"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) return firstMatch;
		}
	} catch {
		// Ignore errors
	}
	return null;
}

const pwshAvailable = findPwshForTest() !== null;
const bashAvailable = ((): boolean => {
	try {
		getShellConfig();
		return true;
	} catch {
		return false;
	}
})();

describe("AgentSession.executeShell", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function createTestSession(): Promise<Harness> {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		return harness;
	}

	it("executes through the provided operations and records shell=bash", async () => {
		const harness = await createTestSession();
		const commands: string[] = [];
		const result = await harness.session.executeShell("echo hi", "bash", undefined, {
			operations: capturingOperations(commands),
		});

		expect(commands).toEqual(["echo hi"]);
		expect(result.output).toContain("captured output");

		const recorded = harness.agent.state.messages.at(-1) as {
			role: string;
			shell?: string;
			command?: string;
		};
		expect(recorded.role).toBe("bashExecution");
		expect(recorded.shell).toBe("bash");
		expect(recorded.command).toBe("echo hi");
	});

	it("records shell=pwsh for pwsh execution", async () => {
		const harness = await createTestSession();
		const commands: string[] = [];
		await harness.session.executeShell("Get-ChildItem", "pwsh", undefined, {
			operations: capturingOperations(commands),
		});

		expect(commands).toEqual(["Get-ChildItem"]);
		const recorded = harness.agent.state.messages.at(-1) as {
			role: string;
			shell?: string;
			command?: string;
		};
		expect(recorded.role).toBe("bashExecution");
		expect(recorded.shell).toBe("pwsh");
		expect(recorded.command).toBe("Get-ChildItem");
	});

	it("persists shell execution messages to the session", async () => {
		const harness = await createTestSession();
		await harness.session.executeShell("ls", "pwsh", undefined, {
			operations: capturingOperations([]),
		});

		const entries = harness.sessionManager.getEntries();
		const messageEntries = entries.filter((entry) => entry.type === "message");
		const recorded = messageEntries.at(-1)?.message as { role: string; shell?: string } | undefined;
		expect(recorded?.role).toBe("bashExecution");
		expect(recorded?.shell).toBe("pwsh");
	});

	it("legacy executeBash records shell=bash (absent on truly legacy records only)", async () => {
		const harness = await createTestSession();
		await harness.session.executeBash("legacy-cmd", undefined, {
			operations: capturingOperations([]),
		});

		const recorded = harness.agent.state.messages.at(-1) as {
			role: string;
			shell?: string;
			command?: string;
		};
		expect(recorded.role).toBe("bashExecution");
		expect(recorded.shell).toBe("bash");
		expect(recorded.command).toBe("legacy-cmd");
	});

	it("emits bash_execution_update only for bash execution", async () => {
		const harness = await createTestSession();
		await harness.session.executeBash("echo bash", undefined, {
			id: "req-bash",
			operations: capturingOperations([]),
		});
		await harness.session.executeShell("Get-ChildItem", "pwsh", undefined, {
			operations: capturingOperations([]),
		});

		const updates = harness.eventsOfType("bash_execution_update");
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.every((event) => event.id === "req-bash")).toBe(true);
	});

	it("keeps excluded-from-context (!!) semantics on the generic path", async () => {
		const harness = await createTestSession();
		await harness.session.executeShell("hidden-cmd", "bash", undefined, {
			excludeFromContext: true,
			operations: capturingOperations([]),
		});

		const recorded = harness.agent.state.messages.at(-1) as { excludeFromContext?: boolean };
		expect(recorded.excludeFromContext).toBe(true);
	});

	it("abortShell cancels a running shell command", async () => {
		const harness = await createTestSession();
		let aborted = false;
		const operations: CommandOperations = {
			exec: async (_command, _cwd, { signal }) => {
				await new Promise<void>((resolve, reject) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
					setTimeout(() => resolve(), 10_000);
				});
				return { exitCode: 0 };
			},
		};

		const pending = harness.session.executeShell("sleep 10", "bash", undefined, { operations });
		harness.session.abortShell();
		const result = await pending;
		expect(aborted).toBe(true);
		expect(result.cancelled).toBe(true);
	});

	it.runIf(pwshAvailable)("executes pwsh commands through the real local pwsh backend", async () => {
		const harness = await createTestSession();
		const result = await harness.session.executeShell("Write-Output 'shell-real-pwsh'", "pwsh");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("shell-real-pwsh");

		const recorded = harness.agent.state.messages.at(-1) as { role: string; shell?: string };
		expect(recorded.role).toBe("bashExecution");
		expect(recorded.shell).toBe("pwsh");
	});

	it.runIf(bashAvailable)("executes bash commands through the real local bash backend", async () => {
		const harness = await createTestSession();
		const result = await harness.session.executeShell("printf '%s\\n' shell-real-bash", "bash");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("shell-real-bash");

		const recorded = harness.agent.state.messages.at(-1) as { role: string; shell?: string };
		expect(recorded.role).toBe("bashExecution");
		expect(recorded.shell).toBe("bash");
	});

	it.runIf(pwshAvailable && bashAvailable)("pwsh execution never resolves through the bash shell config", async () => {
		const harness = await createTestSession();
		// Bash-specific syntax must fail under pwsh; prove the pwsh path did not
		// route through the bash resolver.
		const pwshResult = await harness.session.executeShell("$PSVersionTable.PSVersion.Major", "pwsh");
		expect(pwshResult.exitCode).toBe(0);
		expect(pwshResult.output).toMatch(/[5-9]|1[0-9]/);
	});
});
