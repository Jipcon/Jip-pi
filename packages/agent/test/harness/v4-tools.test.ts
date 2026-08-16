import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import {
	AgentHarness,
	type AgentToolResult,
	InMemorySessionRepo,
	type RunResult,
	UuidV7Generator,
} from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";

interface ToolOptions {
	parameters?: ReturnType<typeof Type.Object>;
	executionMode?: "sequential" | "parallel";
	replay?: "never" | "safe";
	prepareArguments?: (args: unknown) => unknown;
	execute?: (params: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
}

function makeTool(name: string, options: ToolOptions = {}): AgentHarnessTool<undefined> {
	return {
		name,
		description: `${name} tool`,
		label: name,
		parameters: options.parameters ?? Type.Object({ path: Type.String() }),
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		...(options.replay === undefined ? {} : { replay: options.replay }),
		...(options.prepareArguments === undefined ? {} : { prepareArguments: options.prepareArguments }),
		execute: options.execute
			? async (_toolCallId, params, _signal, _onUpdate) => options.execute!(params as Record<string, unknown>)
			: async () => okResult(`${name} ran`),
	};
}

function okResult(text: string, extra: Partial<AgentToolResult<unknown>> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {}, ...extra };
}

async function createRuntime(
	options: {
		drive?: "automatic" | "manual";
		tools?: AgentHarnessTool<undefined>[];
		activeToolNames?: string[];
		instrument?: boolean;
		adaptivePolicy?: import("../../src/harness-v4.ts").AdaptiveToolBatchClearance;
		toolContext?: undefined | (() => Promise<undefined>);
		sequential?: boolean;
		id?: string;
	} = {},
) {
	const faux = fauxProvider({ provider: "r4-provider", api: "r4-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 1_900_000_000_000 });
	const raw = await repo.create({ id: options.id ?? `r4-${options.drive ?? "auto"}` });
	const session = options.instrument === true ? new InstrumentedSession(raw) : raw;
	const tools = options.tools ?? [];
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(tools.length === 0 ? {} : { tools }),
		...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
		...(options.adaptivePolicy === undefined ? {} : { adaptiveToolPolicy: options.adaptivePolicy }),
		...(options.sequential === true ? { toolExecution: "sequential" } : {}),
	});
	return { faux, harness, model, models, repo, session };
}

function settledValue(result: RunResult) {
	if (!result.ok) throw result.error;
	return result.value;
}

describe("Harness v4 R4 standard tool batches", () => {
	it("executes a complete tool batch and continues to the next generation", async () => {
		const { faux, harness } = await createRuntime({ tools: [makeTool("read")], activeToolNames: ["read"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("after read"),
		]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "after read" }] } });
		expect(faux.state.callCount).toBe(2);

		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch.map((entry) => entry.type)).toEqual(["message", "message", "message", "message"]);
		const assistant = branch[1] as Extract<(typeof branch)[number], { type: "message" }>;
		expect(assistant).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "toolUse" } });
		expect(branch[2]).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: ((assistant.message as { content: unknown }).content as { type: "toolCall"; id: string }[])[0]!
					.id,
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "read ran" }],
			},
		});
		expect(await harness.getLastResult()).toMatchObject({
			outcome: "completed",
			runCompletion: "assistant",
		});
		expect(await harness.durableSession.listRegisters("op.tool_args")).toHaveLength(0);
		const rows = await harness.durableSession.scanUsage({ order: "asc" });
		expect(rows).toHaveLength(2);
		await harness.close();
	});

	it("keeps planned → effect_pending → completed durable with the args register lifecycle", async () => {
		const { faux, harness, session } = await createRuntime({
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			instrument: true,
		});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" })]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "failed" });
		const instrumented = session as InstrumentedSession;
		const commits = instrumented.commits().slice(1);
		const intent = commits.find((commit) =>
			commit.writes.some((write) => write.kind === "register" && write.namespace === "op.tool_args"),
		);
		expect(intent?.writes.map((write) => (write.kind === "register" ? write.namespace : write.kind))).toEqual([
			"op.tool_args",
			"op.state",
		]);
		const settlement = commits.find((commit) =>
			commit.writes.some(
				(write) =>
					write.kind === "entry" && write.entry.type === "message" && write.entry.message.role === "toolResult",
			),
		);
		expect(settlement?.writes.map((write) => (write.kind === "register" ? write.namespace : write.kind))).toEqual([
			"entry",
			"lane.leaf",
			"op.tool_args",
			"op.state",
		]);
		await harness.close();
	});

	it("reserves follower UUIDv7 result ids for every batch call", async () => {
		const { faux, harness } = await createRuntime({ tools: [makeTool("read")], activeToolNames: ["read"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" }), fauxToolCall("read", { path: "y" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const assistantEntry = branch[1]!;
		const resultEntries = branch.slice(2, 4);
		const assistantTimestamp = UuidV7Generator.timestamp(assistantEntry.id);
		for (const entry of resultEntries) {
			expect(UuidV7Generator.timestamp(entry.id)).toBeGreaterThanOrEqual(assistantTimestamp);
		}
		await harness.close();
	});

	it("synthesizes unknown-tool, invalid-argument, and blocked results without effects or registers", async () => {
		const executed: string[] = [];
		const tools = [
			makeTool("valid", {
				execute: async () => {
					executed.push("valid");
					return okResult("valid ran");
				},
			}),
			makeTool("strict", {
				parameters: Type.Object({ required: Type.String() }),
				execute: async () => {
					executed.push("strict");
					return okResult("strict ran");
				},
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["valid", "strict"] });
		harness.hooks.on("before_tool", ({ toolName, args }) => {
			if (toolName === "valid" && args.path === "blocked.txt") {
				return { block: { reason: "policy blocked", terminate: false } };
			}
			return undefined;
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("missing", { path: "x" }),
					fauxToolCall("strict", {}),
					fauxToolCall("valid", { path: "blocked.txt" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		expect(executed).toEqual([]);
		expect(await harness.durableSession.listRegisters("op.tool_args")).toHaveLength(0);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const results = branch.filter(
			(entry): entry is Extract<(typeof branch)[number], { type: "message" }> =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results).toHaveLength(3);
		expect(results.map((entry) => (entry.message as { isError?: boolean }).isError)).toEqual([true, true, true]);
		expect(results[0]).toMatchObject({ message: { content: [{ text: "Tool missing not found" }] } });
		expect(results[0]?.type).toBe("message");
		expect(results[2]).toMatchObject({ message: { content: [{ text: "policy blocked" }] } });
		await harness.close();
	});

	it("re-validates replaced before_tool arguments and persists only the effective args", async () => {
		const seen: string[] = [];
		const tools = [
			makeTool("read", {
				parameters: Type.Object({ path: Type.String({ minLength: 2 }) }),
				prepareArguments: (args) => ({ path: `prepared-${(args as { path: string }).path}` }),
				execute: async (params) => {
					const path = String((params as { path?: unknown }).path);
					seen.push(path);
					return okResult(`read ${path}`);
				},
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["read"] });
		harness.hooks.on("before_tool", ({ args }) => {
			return { args: { path: `guarded-${args.path}` } };
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		expect(seen).toEqual(["guarded-prepared-x"]);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const result = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(result).toMatchObject({ message: { content: [{ text: "read guarded-prepared-x" }] } });
		await harness.close();
	});

	it("synthesizes truncated results for a genuine length response without executing effects", async () => {
		const executed: string[] = [];
		const tools = [
			makeTool("read", {
				execute: async () => {
					executed.push("read");
					return okResult("read ran");
				},
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["read"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "cut" })], { stopReason: "length" }),
			fauxAssistantMessage("recovered"),
		]);
		settledValue(await harness.prompt("hello"));
		expect(executed).toEqual([]);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const result = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(result).toMatchObject({
			message: {
				isError: true,
				content: [{ type: "text", text: expect.stringContaining("output token limit") }],
			},
		});
		await harness.close();
	});

	it("runs parallel effects concurrently but finalizes and persists results in source order", async () => {
		const order: string[] = [];
		const releases: Array<() => void> = [];
		const tools = ["first", "second"].map((name) =>
			makeTool(name, {
				execute: async (params) => {
					order.push(`start-${name}`);
					await new Promise<void>((resolve) => releases.push(resolve));
					order.push(`end-${name}`);
					return okResult(`${name} ran ${params.path}`);
				},
			}),
		);
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["first", "second"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("second", { path: "s" }), fauxToolCall("first", { path: "f" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await vi.waitFor(() => expect(order).toEqual(["start-second", "start-first"]));
		// The second effect finishes first: its result must still materialize last.
		releases[1]?.();
		await vi.waitFor(() => expect(order).toContain("end-first"));
		releases[0]?.();
		const value = settledValue(await pending);
		expect(value).toMatchObject({ kind: "completed" });
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const results = branch.filter(
			(entry): entry is Extract<(typeof branch)[number], { type: "message" }> =>
				entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results.map((entry) => (entry.message as { toolName?: string }).toolName)).toEqual(["second", "first"]);
		await harness.close();
	});

	it("serializes the whole batch when one call declares sequential", async () => {
		const order: string[] = [];
		const tools = [
			makeTool("slow", {
				executionMode: "sequential",
				execute: async () => {
					order.push("start-slow");
					await new Promise((resolve) => setTimeout(resolve, 20));
					order.push("end-slow");
					return okResult("slow ran");
				},
			}),
			makeTool("fast", {
				execute: async () => {
					order.push("start-fast");
					return okResult("fast ran");
				},
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["slow", "fast"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { path: "s" }), fauxToolCall("fast", { path: "f" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		expect(order).toEqual(["start-slow", "end-slow", "start-fast"]);
		await harness.close();
	});

	it("settles with terminated_tools when every result terminates", async () => {
		const tools = [
			makeTool("stop", {
				execute: async () => okResult("stopped", { terminate: true }),
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["stop"] });
		faux.setResponses([fauxAssistantMessage([fauxToolCall("stop", { path: "x" })], { stopReason: "toolUse" })]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({
			kind: "completed",
			runCompletion: "terminated_tools",
		});
		expect((value as { finalEntryId?: string }).finalEntryId).toBeUndefined();
		expect(faux.state.callCount).toBe(1);
		expect(await harness.getLastResult()).toMatchObject({
			outcome: "completed",
			runCompletion: "terminated_tools",
		});
		await harness.close();
	});

	it("continues when only some results terminate", async () => {
		const tools = [
			makeTool("stop", { execute: async () => okResult("stopped", { terminate: true }) }),
			makeTool("go", { execute: async () => okResult("went") }),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["stop", "go"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("stop", { path: "x" }), fauxToolCall("go", { path: "y" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("continues"),
		]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "continues" }] } });
		expect(faux.state.callCount).toBe(2);
		await harness.close();
	});

	it("normalizes invalid tool return values into a synthetic error before storage", async () => {
		const tools = [
			makeTool("broken", {
				execute: async () => okResult("broken", { content: [{ type: "text", text: 1 } as never] }),
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["broken"] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("broken", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const result = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(result).toMatchObject({
			message: { isError: true, content: [{ type: "text", text: expect.stringContaining("invalid result") }] },
		});
		await harness.close();
	});

	it("persists the tool usage row atomically with the result entry", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const tools = [makeTool("read", { execute: async () => okResult("read ran", { usage }) })];
		const { faux, harness, session } = await createRuntime({
			tools,
			activeToolNames: ["read"],
			instrument: true,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		const instrumented = session as InstrumentedSession;
		const settlement = instrumented.commits().find((commit) => commit.writes.some((write) => write.kind === "usage"));
		expect(settlement).toBeDefined();
		const entryWrite = settlement!.writes.find((write) => write.kind === "entry");
		const usageWrite = settlement!.writes.find((write) => write.kind === "usage");
		expect((usageWrite as { row: { entryId?: string } }).row.entryId).toBe(
			(entryWrite as { entry: { id: string } }).entry.id,
		);
		const rows = await harness.durableSession.scanUsage({ order: "asc" });
		expect(rows).toHaveLength(3);
		await harness.close();
	});

	it("emits tool events in a deterministic order around durable commits", async () => {
		// makeTool execute signature ignores onUpdate; use a direct tool instead
		const direct: AgentHarnessTool<undefined> = {
			name: "read",
			description: "read tool",
			label: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id, _params, _signal, onUpdate) => {
				onUpdate?.(okResult("partial"));
				return okResult("read ran");
			},
		};
		const { faux, harness } = await createRuntime({ tools: [direct], activeToolNames: ["read"] });
		const events: string[] = [];
		for (const type of [
			"turn_start",
			"tool_start",
			"tool_update",
			"tool_end",
			"entry_added",
			"message_start",
			"message_update",
			"message_end",
			"usage",
			"turn_end",
			"run_end",
		] as const) {
			harness.events.on(type, () => {
				events.push(type);
			});
		}
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.prompt("hello"));
		await vi.waitFor(() => expect(events.at(-1)).toBe("run_end"));
		expect(events).toEqual([
			"message_start",
			"message_end",
			"entry_added",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"entry_added",
			"usage",
			"tool_start",
			"tool_update",
			"tool_end",
			"entry_added",
			"message_start",
			"message_end",
			"turn_end",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"entry_added",
			"usage",
			"turn_end",
			"run_end",
		]);
		await harness.close();
	});

	it("parks the whole manual drive without any provider or tool effect", async () => {
		const executed: string[] = [];
		const tools = [
			makeTool("read", {
				execute: async () => {
					executed.push("read");
					return okResult("read ran");
				},
			}),
		];
		const { faux, harness } = await createRuntime({ tools, activeToolNames: ["read"], drive: "manual" });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(0);
		expect(executed).toEqual([]);
		await harness.runToCompletion();
		settledValue(await pending);
		expect(executed).toEqual(["read"]);
		expect(faux.state.callCount).toBe(2);
		await harness.close();
	});
});
