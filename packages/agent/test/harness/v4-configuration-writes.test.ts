import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../../src/harness-v4.ts";
import {
	type AdaptiveRunBasisInput,
	AgentHarness,
	InMemorySessionRepo,
	type Operation,
	type RunResult,
	type RunState,
} from "../../src/harness-v4.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function textOf(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	if (typeof message.content === "string") return message.content;
	const part = message.content.find((candidate) => candidate.type === "text");
	return part?.type === "text" ? part.text : undefined;
}

async function createRuntime(options: { drive?: "automatic" | "manual"; tools?: AgentTool[] } = {}) {
	const faux = fauxProvider({ provider: "r5-config", api: "r5-config-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 2_200_000_000_000 });
	const session = await repo.create({ id: `r5-config-${Math.random().toString(36).slice(2, 8)}` });
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(options.tools === undefined ? {} : { tools: options.tools }),
	});
	return { faux, harness, model, models, repo, session };
}

type SettledRunValue = Exclude<Extract<RunResult, { ok: true }>["value"], { kind: "suspended" }>;

type SettledResumeValue = Exclude<
	Extract<Awaited<ReturnType<AgentHarness["resume"]>>, { ok: true }>["value"],
	{ kind: "suspended" }
>;

function requireSuccess(result: RunResult): SettledRunValue {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R5 Run");
	return result.value;
}

function requireResumeSuccess(result: Awaited<ReturnType<AgentHarness["resume"]>>): SettledResumeValue {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R5 resume");
	return result.value;
}

describe("Harness v4 R5 settlement races", () => {
	it("merges a steer accepted during a live assistant effect into the settlement", async () => {
		const { faux, harness, session } = await createRuntime({ drive: "automatic" });
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const contexts: Context[] = [];
		faux.setResponses([
			() => blocked,
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("after steer");
			},
		]);
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		// The admission bumps op.state while the effect is live; the old
		// seq-CAS settlement would have thrown ownership loss here.
		await harness.steer(userMessage("steer during effect"));
		release?.(fauxAssistantMessage("first"));
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "after steer" }] },
		});
		expect(faux.state.callCount).toBe(2);
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"hello",
			"first",
			"steer during effect",
		]);
		// The consumed steer left no pending register behind.
		const laneState = await session.getRegister("lane.state", "main");
		expect(laneState?.value.currentOperationId).toBeNull();
		await harness.close();
	});

	it("merges a deferred write accepted during parallel tool effects into the batch-finished transition", async () => {
		const tool: import("../../src/harness/types.ts").AgentHarnessTool<undefined> = {
			name: "read",
			description: "read tool",
			label: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "read ran" }], details: {} }),
		};
		const faux = fauxProvider({ provider: "r5-tool-race", api: "r5-tool-race-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 2_210_000_000_000 });
		const session = await repo.create({ id: "r5-tool-race" });
		let releaseTool:
			| ((value: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
			| undefined;
		const toolGate = new Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>((resolve) => {
			releaseTool = resolve;
		});
		tool.execute = () => toolGate;
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool as unknown as AgentTool],
			activeToolNames: ["read"],
		});
		const contexts: Context[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			(context) => {
				contexts.push({ messages: structuredClone(context.messages) } as unknown as Context);
				return fauxAssistantMessage("after write");
			},
		]);
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await vi.waitFor(async () => expect(await harness.getOpenOperation()).toMatchObject({ kind: "run" }));
		const writeId = await harness.session.appendMessage(userMessage("write during tools"));
		releaseTool?.({ content: [{ type: "text", text: "read ran" }], details: {} });
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "after write" }] } });
		expect(faux.state.callCount).toBe(2);
		expect(await session.getEntry(writeId)).toMatchObject({ type: "message" });
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toContain(
			"write during tools",
		);
		await harness.close();
	});

	it("keeps an adaptive drive at one provider request when a steer arrives during the turn", async () => {
		const faux = fauxProvider({ provider: "r5-adaptive", api: "r5-adaptive-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 2_220_000_000_000 });
		const session = await repo.create({ id: "r5-adaptive" });
		const { harness } = await AgentHarness.create({ session, models, model });
		const basis = {
			schemaVersion: 1,
			taskId: "task",
			candidateId: "candidate",
			policyBundle: { version: "v1", fingerprint: "policy" },
			projectorVersion: "p1",
			inheritedPolicyState: { snapshot: {}, fingerprint: "state", basis: { cursor: { kind: "task_origin" } } },
			start: { kind: "prompt" },
		} satisfies AdaptiveRunBasisInput;

		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const contexts: Context[] = [];
		faux.setResponses([
			() => blocked,
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("next turn");
			},
		]);
		const pendingTurn = harness.promptAdaptiveTurn(userMessage("work"), basis);
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await harness.steer(userMessage("steer during turn"));
		release?.(fauxAssistantMessage("first turn"));
		const first = await pendingTurn;
		expect(first).toMatchObject({ ok: true, value: { kind: "turn" } });
		expect(faux.state.callCount).toBe(1);

		const second = await harness.resumeAdaptiveTurn();
		expect(second).toMatchObject({
			ok: true,
			value: { kind: "completed", finalMessage: { content: [{ text: "next turn" }] } },
		});
		expect(faux.state.callCount).toBe(2);
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"work",
			"first turn",
			"steer during turn",
		]);
		await harness.close();
	});
});

describe("Harness v4 R5 lane configuration", () => {
	it("keeps the current step on the old snapshot and captures the new one for the next step", async () => {
		const providerA = fauxProvider({ provider: "r5-config-a", api: "r5-config-a-api" });
		const providerB = fauxProvider({ provider: "r5-config-b", api: "r5-config-b-api" });
		const models = createModels();
		models.setProvider(providerA.provider);
		models.setProvider(providerB.provider);
		const modelA = providerA.getModel() as Model<Api>;
		const modelB = providerB.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 2_230_000_000_000 });
		const session = await repo.create({ id: "r5-config-race" });
		const { harness } = await AgentHarness.create({ session, models, model: modelA });

		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		providerA.setResponses([() => blocked]);
		providerB.setResponses([fauxAssistantMessage("from provider b")]);
		const events: Array<{ property: string; value: unknown; previous: unknown }> = [];
		harness.events.on("config_update", (event) => {
			if (event.type === "config_update" && "property" in event && event.property === "model") {
				events.push({ property: event.property, value: event.value, previous: event.previous });
			}
		});

		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(providerA.state.callCount).toBe(1));
		// Setter during the live step: the current generation keeps its captured model.
		await harness.setModel(modelB);
		expect(events).toHaveLength(1);
		await harness.steer(userMessage("more"));
		release?.(fauxAssistantMessage("from provider a"));
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "from provider b" }], provider: "r5-config-b" },
		});
		expect(providerA.state.callCount).toBe(1);
		expect(providerB.state.callCount).toBe(1);
		expect(events[0]).toEqual({
			property: "model",
			value: { provider: "r5-config-b", modelId: "faux-1" },
			previous: { provider: "r5-config-a", modelId: "faux-1" },
		});
		await harness.close();
	});

	it("captures the new configuration when the setter commits before generation start", async () => {
		const { faux, harness } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("high thinking")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		// Setter wins the race: the transition CAS fails, the drive replans,
		// and the new step captures the new configuration.
		await harness.setThinkingLevel("high");
		await harness.runToCompletion();
		const value = requireSuccess(await pending);
		expect(value).toMatchObject({ kind: "completed" });
		// The durable generation context captured the post-setter snapshot.
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		expect(laneState?.value.currentOperationId).toBeNull();
		const lastResult = await harness.getLastResult();
		expect(lastResult?.outcome).toBe("completed");
		await harness.close();
	});

	it("defensively clones configuration values and updates the restored snapshot", async () => {
		const writeTool: AgentTool = {
			name: "write",
			description: "write tool",
			label: "write",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "wrote" }], details: {} }),
		};
		const { faux, harness } = await createRuntime({ tools: [writeTool] });
		const names = ["write"];
		faux.setResponses([fauxAssistantMessage("done")]);
		await harness.setActiveTools(names);
		names.push("mutated-after-set");
		expect(await harness.getActiveTools()).toEqual(["write"]);
		requireSuccess(await harness.prompt("hello"));
		await harness.close();
	});
});

describe("Harness v4 R5 failure_drain inbox reuse", () => {
	async function createFailureSession(
		id: string,
		inbox: RunState["inbox"],
		pending: Array<{
			id: string;
			value:
				| { type: "message"; payload: AgentMessage }
				| { type: "custom"; customType: string; payload?: JsonValue };
		}>,
	) {
		const faux = fauxProvider({ provider: `r5-failure-${id}`, api: `r5-failure-${id}-api` });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 2_240_000_000_000 });
		const session = await repo.create({ id });
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const failedResponse: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "boom" }],
			api: `r5-failure-${id}-api`,
			provider: `r5-failure-${id}`,
			model: "faux-1",
			stopReason: "error",
			errorMessage: "gone",
			usage: {
				input: 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		};
		const responseEntryId = await session.appendMessage(failedResponse);
		const operationId = "operation";
		const operation: Operation = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [promptEntryId] },
		};
		const state: RunState = {
			kind: "run",
			control: { status: "running" },
			settings: {
				compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				toolExecution: "parallel",
			},
			phase: {
				kind: "failure_drain",
				error: { code: "provider_error", message: "gone" },
				provenance: { kind: "response", entryId: responseEntryId },
			},
			inbox: structuredClone(inbox),
			latestAssistantEntryId: responseEntryId,
		};
		await session.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "main",
					value: {
						model: { provider: `r5-failure-${id}`, modelId: "faux-1" },
						thinkingLevel: "off",
						activeToolNames: [],
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: operationId, pendingNextRun: [] },
				},
				{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
				{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
				...pending.map((item) => ({
					kind: "register" as const,
					op: "set" as const,
					namespace: "pending.entry" as const,
					key: item.id,
					value: item.value,
				})),
			],
		});
		return { faux, models, model, session };
	}

	it("recovers a failure_drain boundary with projecting steer input", async () => {
		const steerId = "steer-recovery";
		const { faux, models, model, session } = await createFailureSession(
			"failure-recover",
			{ steer: [steerId], followUp: [], writes: [] },
			[{ id: steerId, value: { type: "message", payload: userMessage("recover now") } }],
		);
		faux.setResponses([fauxAssistantMessage("recovered")]);
		const { harness, suspended } = await AgentHarness.create({ session, models, model });
		expect(suspended).toHaveLength(1);
		const contexts: Context[] = [];
		faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("recovered");
			},
		]);
		const value = requireResumeSuccess(await harness.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "recovered" }] } });
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toContain(
			"recover now",
		);
		expect(await session.getRegister("pending.entry", steerId)).toBeUndefined();
		await harness.close();
	});

	it("keeps the original failure for unprojected custom writes", async () => {
		const writeId = "custom-unprojected";
		const { models, model, session } = await createFailureSession(
			"failure-unprojected",
			{ steer: [], followUp: [], writes: [writeId] },
			[{ id: writeId, value: { type: "custom", customType: "app.internal", payload: { note: "x" } } }],
		);
		const { harness, suspended } = await AgentHarness.create({ session, models, model });
		expect(suspended).toHaveLength(1);
		const value = requireResumeSuccess(await harness.resume());
		expect(value).toMatchObject({ kind: "failed", error: { code: "provider_error", message: "gone" } });
		expect(await session.getEntry(writeId)).toMatchObject({ type: "custom", customType: "app.internal" });
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		await harness.close();
	});

	it("keeps the configuration register intact after terminal cleanup", async () => {
		const { faux, harness, session } = await createRuntime({});
		faux.setResponses([fauxAssistantMessage("done")]);
		requireSuccess(await harness.prompt("hello"));
		const configuration = await session.getRegister("lane.config", "main");
		expect(configuration).toMatchObject({
			value: { model: { provider: "r5-config" }, thinkingLevel: "off", activeToolNames: [] },
		});
		await harness.close();
	});
});

describe("Harness v4 R5 write_pending durability events", () => {
	it("emits write_pending only after the durable acceptance", async () => {
		const { faux, harness, session } = await createRuntime({});
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => blocked, fauxAssistantMessage("after")]);
		const events: Array<{ entryId: string; entryType: string }> = [];
		harness.events.on("write_pending", (event) => {
			events.push({ entryId: event.entryId, entryType: event.entryType });
		});
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const writeId = await harness.session.appendMessage(userMessage("durable first"));
		expect(await session.getRegister("pending.entry", writeId)).toBeDefined();
		await vi.waitFor(() => expect(events).toEqual([{ entryId: writeId, entryType: "message" }]));
		release?.(fauxAssistantMessage("first"));
		requireSuccess(await pendingRun);
		await harness.close();
	});
});
