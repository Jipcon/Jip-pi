import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPwshToolResult, type ToolResultEvent } from "../src/core/extensions/index.ts";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { resolveInitialActiveToolNames } from "../src/core/sdk.ts";
import {
	allToolNames,
	createAllToolDefinitions,
	createCodingToolDefinitions,
	createCodingTools,
	createLocalPwshOperations,
	createPwshTool,
	createPwshToolDefinition,
	getDefaultCommandToolName,
	getDefaultToolNames,
	type PwshOperations,
} from "../src/core/tools/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n") || ""
	);
}

/** Resolve a pwsh executable for real execution tests, mirroring the tool's resolution order. */
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

const pwshExecutable = findPwshForTest();
const describeWithPwsh = pwshExecutable ? describe : describe.skip;

describe("platform default command tool", () => {
	it("returns pwsh on Windows and bash elsewhere", () => {
		expect(getDefaultCommandToolName("win32")).toBe("pwsh");
		expect(getDefaultCommandToolName("linux")).toBe("bash");
		expect(getDefaultCommandToolName("darwin")).toBe("bash");
	});

	it("returns read/pwsh/edit/write on Windows", () => {
		expect(getDefaultToolNames("win32")).toEqual(["read", "pwsh", "edit", "write"]);
	});

	it("returns read/bash/edit/write on Linux and macOS", () => {
		expect(getDefaultToolNames("linux")).toEqual(["read", "bash", "edit", "write"]);
		expect(getDefaultToolNames("darwin")).toEqual(["read", "bash", "edit", "write"]);
	});

	it("keeps both bash and pwsh in the static catalog", () => {
		expect(allToolNames.has("bash")).toBe(true);
		expect(allToolNames.has("pwsh")).toBe(true);
	});

	it("createCodingTools and createCodingToolDefinitions include only the platform command tool", () => {
		const expected = ["read", getDefaultCommandToolName(), "edit", "write"];
		expect(createCodingTools(process.cwd()).map((tool) => tool.name)).toEqual(expected);
		expect(createCodingToolDefinitions(process.cwd()).map((tool) => tool.name)).toEqual(expected);
	});

	it("createAllToolDefinitions includes both bash and pwsh", () => {
		const definitions = createAllToolDefinitions(process.cwd());
		expect(definitions.bash.name).toBe("bash");
		expect(definitions.pwsh.name).toBe("pwsh");
	});
});

describe("initial active tool selection", () => {
	it("does not rewrite explicit tools on Windows", () => {
		expect(resolveInitialActiveToolNames({ tools: ["read", "bash"], platform: "win32" })).toEqual(["read", "bash"]);
		expect(resolveInitialActiveToolNames({ tools: ["read", "bash", "pwsh"], platform: "linux" })).toEqual([
			"read",
			"bash",
			"pwsh",
		]);
	});

	it("applies platform defaults when no explicit selection is provided", () => {
		expect(resolveInitialActiveToolNames({ platform: "win32" })).toEqual(["read", "pwsh", "edit", "write"]);
		expect(resolveInitialActiveToolNames({ platform: "linux" })).toEqual(["read", "bash", "edit", "write"]);
		expect(resolveInitialActiveToolNames({})).toEqual([...getDefaultToolNames()]);
	});

	it("supports noTools all and builtin", () => {
		expect(resolveInitialActiveToolNames({ noTools: "all", platform: "win32" })).toEqual([]);
		expect(resolveInitialActiveToolNames({ noTools: "builtin", platform: "linux" })).toEqual([]);
	});

	it("lets explicit tools win over noTools", () => {
		expect(resolveInitialActiveToolNames({ tools: ["read"], noTools: "all", platform: "win32" })).toEqual(["read"]);
	});

	it("applies excludeTools last", () => {
		expect(resolveInitialActiveToolNames({ tools: ["read", "bash", "pwsh"], excludeTools: ["pwsh"] })).toEqual([
			"read",
			"bash",
		]);
		expect(resolveInitialActiveToolNames({ excludeTools: ["pwsh"], platform: "win32" })).toEqual([
			"read",
			"edit",
			"write",
		]);
	});
});

describe("pwsh tool definition", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pwsh-tool-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("creates tools and definitions without resolving the pwsh executable", () => {
		// Remove every pwsh discovery source (PATH, known install paths) and verify
		// definition creation still succeeds: resolution is lazy and happens only
		// inside operations.exec().
		const savedPath = process.env.PATH;
		const savedProgramFiles = process.env.ProgramFiles;
		process.env.PATH = "";
		delete process.env.ProgramFiles;
		try {
			createPwshToolDefinition(testDir);
			createPwshTool(testDir);
			createAllToolDefinitions(testDir);
		} finally {
			if (savedPath !== undefined) process.env.PATH = savedPath;
			if (savedProgramFiles !== undefined) process.env.ProgramFiles = savedProgramFiles;
		}
	});

	it("reports an explicit error for a missing custom pwshPath", async () => {
		const ops = createLocalPwshOperations({ pwshPath: join(testDir, "missing-pwsh.exe") });
		await expect(ops.exec("Write-Output x", testDir, { onData: () => {} })).rejects.toThrow(
			"Custom pwsh path not found",
		);
	});

	it("does not resolve the executable when constructing operations", async () => {
		// Creating operations must never touch the filesystem; only exec() resolves.
		const ops = createLocalPwshOperations({ pwshPath: join(testDir, "missing-pwsh.exe") });
		await expect(ops.exec("Write-Output x", testDir, { onData: () => {} })).rejects.toThrow(
			"Custom pwsh path not found",
		);
	});

	it.runIf(pwshExecutable === null)("reports an explicit error when pwsh is not installed", async () => {
		const ops = createLocalPwshOperations();
		await expect(ops.exec("Write-Output x", testDir, { onData: () => {} })).rejects.toThrow(/No pwsh/);
	});

	it("throws when the working directory does not exist", async () => {
		const tool = createPwshTool("/this/directory/definitely/does/not/exist/12345");
		await expect(tool.execute("test-call-cwd", { command: "Write-Output x" })).rejects.toThrow(
			/Working directory does not exist/,
		);
	});

	it("renders call titles with the PS> prefix", () => {
		initTheme();
		const definition = createPwshToolDefinition(testDir);
		const context: ToolRenderContext = {
			args: { command: "Get-ChildItem" },
			toolCallId: "test-render-call",
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd: testDir,
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
		};
		const component = definition.renderCall?.({ command: "Get-ChildItem" }, theme, context);
		expect(component).toBeDefined();
		const lines = component!.render(80).join("\n");
		expect(lines).toContain("PS>");
		expect(lines).toContain("Get-ChildItem");
	});

	it.runIf(pwshExecutable !== null)("prepends commandPrefix when configured", async () => {
		const tool = createPwshTool(testDir, {
			pwshPath: pwshExecutable!,
			commandPrefix: "$env:PWSH_PREFIX_TEST = 'prefix-output'",
		});
		const result = await tool.execute("test-prefix", { command: "Write-Output $env:PWSH_PREFIX_TEST" });
		expect(getTextOutput(result).trim()).toBe("prefix-output");
	});

	it("isPwshToolResult narrows pwsh tool results", () => {
		const bashEvent = { toolName: "bash", details: undefined } as unknown as ToolResultEvent;
		const pwshEvent = { toolName: "pwsh", details: undefined } as unknown as ToolResultEvent;
		expect(isPwshToolResult(pwshEvent)).toBe(true);
		expect(isPwshToolResult(bashEvent)).toBe(false);
	});
});

describeWithPwsh("pwsh tool execution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pwsh-exec-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executes simple commands", async () => {
		const tool = createPwshTool(testDir);
		const result = await tool.execute("test-call-1", { command: "Write-Output 'hello pwsh'" });
		expect(getTextOutput(result)).toContain("hello pwsh");
		expect(result.details).toBeUndefined();
	});

	it("executes multi-line scripts", async () => {
		const tool = createPwshTool(testDir);
		const result = await tool.execute("test-call-2", { command: '1..3 | ForEach-Object { "line $_" }' });
		const output = getTextOutput(result);
		expect(output).toContain("line 1");
		expect(output).toContain("line 2");
		expect(output).toContain("line 3");
	});

	it("preserves non-ASCII command text and output", async () => {
		const tool = createPwshTool(testDir);
		const result = await tool.execute("test-call-3", { command: "Write-Output '中文输出'" });
		expect(getTextOutput(result)).toContain("中文输出");
	});

	it("handles single and double quotes in commands", async () => {
		const tool = createPwshTool(testDir);
		const result = await tool.execute("test-call-4", {
			command: "Write-Output 'single-quoted'; Write-Output \"double-quoted\"",
		});
		const output = getTextOutput(result);
		expect(output).toContain("single-quoted");
		expect(output).toContain("double-quoted");
	});

	it("passes environment variables through", async () => {
		const ops = createLocalPwshOperations();
		const chunks: Buffer[] = [];
		const result = await ops.exec("Write-Output $env:PWSH_TEST_VAR", testDir, {
			onData: (data) => chunks.push(data),
			env: { ...process.env, PWSH_TEST_VAR: "from-local-ops" },
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
	});

	it("reports nonzero exit codes", async () => {
		const tool = createPwshTool(testDir);
		await expect(tool.execute("test-call-5", { command: "exit 7" })).rejects.toThrow(/exited with code 7/);
	});

	it("treats a terminating throw as failure", async () => {
		const tool = createPwshTool(testDir);
		await expect(tool.execute("test-call-6", { command: "throw 'boom'" })).rejects.toThrow(/exited with code/);
	});

	it("captures stderr from failing cmdlets", async () => {
		const tool = createPwshTool(testDir);
		await expect(tool.execute("test-call-7", { command: "Write-Error 'err-text-123'" })).rejects.toThrow(
			/err-text-123/,
		);
	});

	it("respects timeout", async () => {
		const tool = createPwshTool(testDir);
		await expect(tool.execute("test-call-8", { command: "Start-Sleep -Seconds 5", timeout: 1 })).rejects.toThrow(
			/timed out/i,
		);
	});

	it("aborts on signal and kills the process tree", async () => {
		const tool = createPwshTool(testDir);
		const controller = new AbortController();
		const pending = tool.execute("test-call-9", { command: "Start-Sleep -Seconds 10" }, controller.signal);
		setTimeout(() => controller.abort(), 200);
		await expect(pending).rejects.toThrow(/aborted/i);
	});

	it("truncates long output and persists the full output to a temp file", async () => {
		const tool = createPwshTool(testDir);
		const result = await tool.execute("test-call-10", {
			command: '1..3000 | ForEach-Object { "line $_" }',
		});
		const output = getTextOutput(result);
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.truncation?.truncatedBy).toBe("lines");
		expect(result.details?.fullOutputPath).toBeDefined();
		expect(output).toContain("line 3000");
		expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
		expect(output).not.toContain("Full output: undefined");

		const fullOutputPath = result.details?.fullOutputPath;
		expect(fullOutputPath).toBeDefined();
		expect(existsSync(fullOutputPath!)).toBe(true);
		const fullOutput = readFileSync(fullOutputPath!, "utf-8");
		expect(fullOutput).toContain("line 1");
		expect(fullOutput).toContain("line 3000");
	});

	it("coalesces streaming updates for chatty output", async () => {
		const operations: PwshOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < 5000; i++) {
					onData(Buffer.from(`line ${i}\n`, "utf-8"));
				}
				return { exitCode: 0 };
			},
		};
		const updates: Array<unknown> = [];
		const tool = createPwshTool(testDir, { operations });

		const result = await tool.execute("test-call-11", { command: "chatty" }, undefined, (update) =>
			updates.push(update),
		);

		expect(updates.length).toBeLessThan(25);
		expect(getTextOutput(result)).toContain("line 4999");
	});

	it("decodes UTF-8 characters split across output chunks", async () => {
		const euro = Buffer.from("€\n", "utf-8");
		const operations: PwshOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(euro.subarray(0, 1));
				onData(euro.subarray(1));
				return { exitCode: 0 };
			},
		};
		const tool = createPwshTool(testDir, { operations });

		const result = await tool.execute("test-call-12", { command: "split-utf8" });

		expect(getTextOutput(result).trim()).toBe("€");
	});

	it("resolves an explicit pwshPath", async () => {
		const ops = createLocalPwshOperations({ pwshPath: pwshExecutable! });
		const chunks: Buffer[] = [];
		const result = await ops.exec("Write-Output 'explicit-path'", testDir, {
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf-8")).toContain("explicit-path");
	});
});
