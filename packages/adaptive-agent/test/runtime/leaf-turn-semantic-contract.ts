import type { AgentMessage, AgentOptions, AgentTool, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { LeafTurnSemanticExecutor } from "../../src/index.ts";

export type SemanticProviderStep =
	| { kind: "message"; message: AssistantMessage }
	| { kind: "throw"; error: Error }
	| { kind: "wait_for_abort" };

export interface LeafTurnSemanticFixtureOptions {
	providerSteps: SemanticProviderStep[];
	tools?: AgentTool[];
	beforeToolCall?: AgentOptions["beforeToolCall"];
	toolExecution?: ToolExecutionMode;
}

export interface LeafTurnSemanticFixture {
	executor: LeafTurnSemanticExecutor;
	providerRequestCount(): number;
	firstProviderRequest: Promise<void>;
}

export type CreateLeafTurnSemanticFixture = (options: LeafTurnSemanticFixtureOptions) => LeafTurnSemanticFixture;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TOOL_PARAMETERS = Type.Object({ value: Type.String() });

export function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "semantic-contract",
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export function createToolUseMessage(toolCalls: ToolCall[]): AssistantMessage {
	return {
		...createAssistantMessage("", "toolUse"),
		content: toolCalls,
	};
}

function createTool(
	name: string,
	execute: AgentTool<typeof TOOL_PARAMETERS>["execute"],
): AgentTool<typeof TOOL_PARAMETERS> {
	return {
		name,
		label: name,
		description: `${name} contract tool`,
		parameters: TOOL_PARAMETERS,
		execute,
	};
}

function resultText(result: ToolResultMessage): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

/** Shared process-local assertions. A Harness fixture can reuse these without weakening its durable suite. */
export function describeLeafTurnSemanticContract(name: string, createFixture: CreateLeafTurnSemanticFixture): void {
	describe(name, () => {
		it("returns one no-tool assistant response without another provider request", async () => {
			const fixture = createFixture({
				providerSteps: [
					{ kind: "message", message: createAssistantMessage("done") },
					{ kind: "message", message: createAssistantMessage("must not run") },
				],
			});

			const observation = await fixture.executor.execute(createUserMessage("start"));

			expect(observation.message.content).toEqual([{ type: "text", text: "done" }]);
			expect(observation.toolResults).toEqual([]);
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("finishes a tool call before returning and does not start the next provider request", async () => {
			const effects: string[] = [];
			const tool = createTool("echo", async (_toolCallId, params) => {
				effects.push(params.value);
				return {
					content: [{ type: "text", text: `echoed:${params.value}` }],
					details: {},
				};
			});
			const fixture = createFixture({
				providerSteps: [
					{
						kind: "message",
						message: createToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "one" } },
						]),
					},
					{ kind: "message", message: createAssistantMessage("must not run") },
				],
				tools: [tool],
			});

			const observation = await fixture.executor.execute(createUserMessage("start"));

			expect(effects).toEqual(["one"]);
			expect(observation.toolResults).toHaveLength(1);
			expect(observation.toolResults[0]?.toolCallId).toBe("call-1");
			expect(resultText(observation.toolResults[0] as ToolResultMessage)).toBe("echoed:one");
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("executes a sequential batch and returns results in source order", async () => {
			const effects: string[] = [];
			const first = createTool("first", async () => {
				effects.push("first");
				return { content: [{ type: "text", text: "first-result" }], details: {} };
			});
			const second = createTool("second", async () => {
				effects.push("second");
				return { content: [{ type: "text", text: "second-result" }], details: {} };
			});
			const fixture = createFixture({
				providerSteps: [
					{
						kind: "message",
						message: createToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "first", arguments: { value: "one" } },
							{ type: "toolCall", id: "call-2", name: "second", arguments: { value: "two" } },
						]),
					},
				],
				tools: [first, second],
				toolExecution: "sequential",
			});

			const observation = await fixture.executor.execute(createUserMessage("start"));

			expect(effects).toEqual(["first", "second"]);
			expect(observation.toolResults.map((result) => result.toolCallId)).toEqual(["call-1", "call-2"]);
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("waits for a parallel batch and still returns results in source order", async () => {
			const firstStarted = createDeferred();
			const secondStarted = createDeferred();
			const releaseFirst = createDeferred();
			const releaseSecond = createDeferred();
			const secondFinished = createDeferred();
			const completionOrder: string[] = [];
			const first = createTool("first", async () => {
				firstStarted.resolve();
				await releaseFirst.promise;
				completionOrder.push("first");
				return { content: [{ type: "text", text: "first-result" }], details: {} };
			});
			const second = createTool("second", async () => {
				secondStarted.resolve();
				await releaseSecond.promise;
				completionOrder.push("second");
				secondFinished.resolve();
				return { content: [{ type: "text", text: "second-result" }], details: {} };
			});
			const fixture = createFixture({
				providerSteps: [
					{
						kind: "message",
						message: createToolUseMessage([
							{ type: "toolCall", id: "call-1", name: "first", arguments: { value: "one" } },
							{ type: "toolCall", id: "call-2", name: "second", arguments: { value: "two" } },
						]),
					},
				],
				tools: [first, second],
				toolExecution: "parallel",
			});

			const execution = fixture.executor.execute(createUserMessage("start"));
			await Promise.all([firstStarted.promise, secondStarted.promise]);
			releaseSecond.resolve();
			await secondFinished.promise;
			releaseFirst.resolve();
			const observation = await execution;

			expect(completionOrder).toEqual(["second", "first"]);
			expect(observation.toolResults.map((result) => result.toolCallId)).toEqual(["call-1", "call-2"]);
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("returns a blocked tool result without starting the effect", async () => {
			let effects = 0;
			const tool = createTool("blocked", async () => {
				effects++;
				return { content: [{ type: "text", text: "must not execute" }], details: {} };
			});
			const fixture = createFixture({
				providerSteps: [
					{
						kind: "message",
						message: createToolUseMessage([
							{ type: "toolCall", id: "call-blocked", name: "blocked", arguments: { value: "x" } },
						]),
					},
				],
				tools: [tool],
				beforeToolCall: async () => ({ block: true, reason: "blocked by contract" }),
			});

			const observation = await fixture.executor.execute(createUserMessage("start"));

			expect(effects).toBe(0);
			expect(observation.toolResults).toHaveLength(1);
			expect(observation.toolResults[0]?.isError).toBe(true);
			expect(resultText(observation.toolResults[0] as ToolResultMessage)).toBe("blocked by contract");
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("returns a provider failure as the completed turn", async () => {
			const fixture = createFixture({
				providerSteps: [{ kind: "throw", error: new Error("provider failed") }],
			});

			const observation = await fixture.executor.execute(createUserMessage("start"));

			expect(observation.message.stopReason).toBe("error");
			expect(observation.message.errorMessage).toBe("provider failed");
			expect(observation.toolResults).toEqual([]);
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("returns an aborted provider turn", async () => {
			const fixture = createFixture({ providerSteps: [{ kind: "wait_for_abort" }] });
			const execution = fixture.executor.execute(createUserMessage("start"));
			await fixture.firstProviderRequest;

			fixture.executor.abort();
			const observation = await execution;

			expect(observation.message.stopReason).toBe("aborted");
			expect(observation.toolResults).toEqual([]);
			expect(fixture.providerRequestCount()).toBe(1);
		});

		it("waits for an aborted tool to finalize before returning", async () => {
			const toolStarted = createDeferred();
			const tool = createTool("wait", async (_toolCallId, _params, signal) => {
				toolStarted.resolve();
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("tool aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "must not complete" }], details: {} };
			});
			const fixture = createFixture({
				providerSteps: [
					{
						kind: "message",
						message: createToolUseMessage([
							{ type: "toolCall", id: "call-wait", name: "wait", arguments: { value: "x" } },
						]),
					},
				],
				tools: [tool],
			});
			const execution = fixture.executor.execute(createUserMessage("start"));
			await toolStarted.promise;

			fixture.executor.abort();
			const observation = await execution;

			expect(observation.toolResults).toHaveLength(1);
			expect(observation.toolResults[0]?.isError).toBe(true);
			expect(resultText(observation.toolResults[0] as ToolResultMessage)).toBe("tool aborted");
			expect(fixture.providerRequestCount()).toBe(1);
		});
	});
}
