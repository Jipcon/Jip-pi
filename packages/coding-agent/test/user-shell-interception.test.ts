/**
 * Regression tests for the canonical user_shell interception dispatch.
 *
 * Verifies:
 * - canonical-first: user_shell handlers win over legacy user_bash listeners
 * - legacy-fallback: unhandled Bash commands still reach user_bash listeners
 * - strict "handled" definition: empty result objects fall through
 * - pwsh commands never consult legacy user_bash listeners
 * - interception happens exactly once (no double dispatch)
 * - handler errors are reported and do not break the dispatch
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { interceptShellCommand } from "../src/core/shell-dispatch.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("user_shell interception dispatch", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-shell-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		delete (globalThis as any).testVar;
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(...extensions: string[]): Promise<ExtensionRunner> {
		fs.rmSync(extensionsDir, { recursive: true, force: true });
		fs.mkdirSync(extensionsDir);
		for (let i = 0; i < extensions.length; i++) {
			fs.writeFileSync(path.join(extensionsDir, `e${i}.ts`), extensions[i]);
		}
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr);
	}

	const bashInput = { shell: "bash" as const, command: "ls", excludeFromContext: false, cwd: "/tmp" };
	const pwshInput = { shell: "pwsh" as const, command: "Get-ChildItem", excludeFromContext: false, cwd: "/tmp" };

	it("returns undefined when no handlers are registered", async () => {
		const runner = await createRunner();
		expect(await interceptShellCommand(runner, bashInput)).toBeUndefined();
		expect(await interceptShellCommand(runner, pwshInput)).toBeUndefined();
	});

	it("lets a canonical user_shell result win and never consults legacy user_bash", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async () => ({
				result: { output: "handled-in-vm", exitCode: 0, cancelled: false, truncated: false },
			}));`,
			`export default p => p.on("user_bash", async () => { globalThis.testVar = 1; });`,
		);
		const result = await interceptShellCommand(runner, bashInput);
		expect(result?.result?.output).toBe("handled-in-vm");
		expect(result?.operations).toBeUndefined();
		// Legacy listener must not have been consulted.
		expect((globalThis as any).testVar).toBe(0);
	});

	it("lets canonical operations win without executing anything", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async () => ({
				operations: { exec: async () => ({ exitCode: 0 }) },
			}));`,
			`export default p => p.on("user_bash", async () => { globalThis.testVar = 1; });`,
		);
		const result = await interceptShellCommand(runner, bashInput);
		expect(result?.operations).toBeDefined();
		expect(result?.result).toBeUndefined();
		expect((globalThis as any).testVar).toBe(0);
	});

	it("treats an empty canonical result as unhandled and falls back to user_bash", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async () => ({}));`,
			`export default p => p.on("user_bash", async () => {
				globalThis.testVar = 1;
				return { operations: { exec: async () => ({ exitCode: 0 }) } };
			});`,
		);
		const result = await interceptShellCommand(runner, bashInput);
		expect(result?.operations).toBeDefined();
		expect((globalThis as any).testVar).toBe(1);
	});

	it("never consults legacy user_bash for pwsh commands", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_bash", async () => { globalThis.testVar = 1; });`,
		);
		expect(await interceptShellCommand(runner, pwshInput)).toBeUndefined();
		expect((globalThis as any).testVar).toBe(0);
	});

	it("intercepts pwsh commands through user_shell (sandbox boundary stays ahead of host execution)", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async e => {
				globalThis.testVar = e.shell;
				return { result: { output: "sandboxed", exitCode: 0, cancelled: false, truncated: false } };
			});`,
		);
		const result = await interceptShellCommand(runner, pwshInput);
		expect(result?.result?.output).toBe("sandboxed");
		expect((globalThis as any).testVar).toBe("pwsh");
	});

	it("short-circuits later user_shell handlers once one handles", async () => {
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async () => ({
				result: { output: "first", exitCode: 0, cancelled: false, truncated: false },
			}));`,
			`export default p => p.on("user_shell", async () => { globalThis.testVar = 1; });`,
		);
		const result = await interceptShellCommand(runner, pwshInput);
		expect(result?.result?.output).toBe("first");
		expect((globalThis as any).testVar).toBe(0);
	});

	it("reports canonical handler errors and falls back to legacy user_bash", async () => {
		const errors: string[] = [];
		(globalThis as any).testVar = 0;
		const runner = await createRunner(
			`export default p => p.on("user_shell", async () => { throw new Error("boom"); });`,
			`export default p => p.on("user_bash", async () => {
				globalThis.testVar = 1;
				return { result: { output: "legacy", exitCode: 0, cancelled: false, truncated: false } };
			});`,
		);
		runner.onError((error) => errors.push(error.error));
		const result = await interceptShellCommand(runner, bashInput);
		expect(result?.result?.output).toBe("legacy");
		expect((globalThis as any).testVar).toBe(1);
		expect(errors).toContain("boom");
	});
});
