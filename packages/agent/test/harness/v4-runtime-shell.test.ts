import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type CurrentOperation,
	describeAction,
	HarnessClosedError,
	HarnessEventBus,
	HarnessFaultError,
	HarnessHookRegistry,
	HarnessNotImplementedError,
	type HookInvocation,
	InMemorySessionRepo,
	type LaneConfiguration,
	type LaneLastResult,
	ManualEffectGate,
	nextAction,
	type Operation,
	type RunState,
	RuntimeCoordinator,
	restoreLane,
	type Session,
	type SessionSnapshot,
} from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";

const MODEL = {
	id: "model",
	name: "Model",
	api: "openai-responses",
	provider: "provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} satisfies Model<Api>;

const MODELS = {
	getModel: (provider: string, id: string) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
} as Models;

const CONFIGURATION: LaneConfiguration = {
	model: { provider: MODEL.provider, modelId: MODEL.id },
	thinkingLevel: "off",
	activeToolNames: [],
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function runState(triggerEntryId: string): RunState {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		phase: {
			kind: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

async function createSuspendedSession(id: string): Promise<{ session: Session; operationId: string }> {
	const session = await new InMemorySessionRepo().create({ id });
	const promptEntryId = await session.appendMessage(userMessage("hello"));
	const operationId = "operation";
	const operation = {
		operationId,
		lane: "main",
		sourceLeafId: null,
		startedAt: 10,
		intent: { kind: "run", promptEntryIds: [promptEntryId] },
	} satisfies Operation;
	await session.commit({
		writes: [
			{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: CONFIGURATION },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: operationId, pendingNextRun: [] },
			},
			{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
			{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: runState(promptEntryId) },
		],
	});
	return { session, operationId };
}

describe("Harness v4 R1 restore", () => {
	it("restores an open operation with exactly five point reads and bounded hydration", async () => {
		const { session, operationId } = await createSuspendedSession("runtime-restore");
		const instrumented = new InstrumentedSession(session);

		const { harness, suspended } = await AgentHarness.create({
			session: instrumented,
			models: MODELS,
			model: MODEL,
			drive: "manual",
		});

		expect(suspended).toEqual([
			expect.objectContaining({
				lane: "main",
				operationId,
				kind: "run",
				reason: "crash",
				prompt: [userMessage("hello")],
			}),
		]);
		expect(instrumented.registerReads()).toEqual([
			{ namespace: "lane.config", key: "main" },
			{ namespace: "lane.state", key: "main" },
			{ namespace: "lane.leaf", key: "main" },
			{ namespace: "op.meta", key: operationId },
			{ namespace: "op.state", key: operationId },
		]);
		expect(instrumented.entryReads()).toEqual([[expect.any(String)]]);
		expect(instrumented.branchScans()).toBe(0);
		expect(instrumented.historyScans()).toBe(0);
		expect(instrumented.commits()).toEqual([]);

		await harness.close();
	});

	it("validates idle lane leaves and pending next-run payloads", async () => {
		const session = await new InMemorySessionRepo().create({ id: "runtime-idle-validation" });
		await session.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: CONFIGURATION },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: ["missing"] },
				},
			],
		});

		await expect(AgentHarness.create({ session, models: MODELS, model: MODEL })).rejects.toMatchObject({
			code: "corruption",
		});
	});

	it("seeds only the missing main configuration before restore", async () => {
		const session = await new InMemorySessionRepo().create({ id: "runtime-seed" });
		const instrumented = new InstrumentedSession(session);

		const { harness, suspended } = await AgentHarness.create({
			session: instrumented,
			models: MODELS,
			model: MODEL,
		});

		expect(suspended).toEqual([]);
		expect(instrumented.commits()).toHaveLength(1);
		expect(await harness.getModel()).toEqual(MODEL);
		await harness.close();
	});
});

describe("Harness v4 R1 runtime primitives", () => {
	it("keeps manual effects parked and releases nested actions one at a time", async () => {
		const gate = new ManualEffectGate("manual");
		const order: string[] = [];
		const operation = gate.run({ kind: "outer", description: "outer" }, async () => {
			order.push("outer-start");
			await gate.run({ kind: "inner", description: "inner" }, () => {
				order.push("inner");
			});
			order.push("outer-end");
		});

		expect(order).toEqual([]);
		expect(await gate.peekAction()).toEqual({ kind: "outer", description: "outer" });
		expect(await gate.executeAction()).toEqual({ kind: "outer", description: "outer" });
		await vi.waitFor(async () => expect(await gate.peekAction()).toEqual({ kind: "inner", description: "inner" }));
		expect(order).toEqual(["outer-start"]);
		expect(await gate.executeAction()).toEqual({ kind: "inner", description: "inner" });
		await operation;
		expect(order).toEqual(["outer-start", "inner", "outer-end"]);
		expect(await gate.peekAction()).toBeUndefined();
	});

	it("runs independent automatic effects in parallel", async () => {
		const gate = new ManualEffectGate("automatic");
		const releases: Array<() => void> = [];
		const started: number[] = [];
		const effect = (index: number) =>
			gate.run({ kind: "effect", description: String(index) }, () => {
				started.push(index);
				return new Promise<void>((resolve) => releases.push(resolve));
			});

		const first = effect(1);
		const second = effect(2);
		expect(started).toEqual([1, 2]);
		releases[1]?.();
		releases[0]?.();
		await Promise.all([first, second]);
	});

	it("serializes lane mutations and rejects parked work on close", async () => {
		const session = await new InMemorySessionRepo().create({ id: "runtime-coordinator" });
		const coordinator = new RuntimeCoordinator(
			session,
			"manual",
			{},
			{ enabled: false, maxRetries: 0, baseDelayMs: 1 },
		);
		const order: string[] = [];
		const first = coordinator.mutateLane("main", async () => {
			order.push("first-start");
			await Promise.resolve();
			order.push("first-end");
		});
		const second = coordinator.mutateLane("main", () => {
			order.push("second");
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second"]);

		const parked = coordinator.gate.run({ kind: "effect", description: "parked" }, () => Promise.resolve());
		const closing = coordinator.close();
		await expect(parked).rejects.toBeInstanceOf(HarnessClosedError);
		await closing;
		await expect(coordinator.mutateLane("main", () => undefined)).rejects.toBeInstanceOf(HarnessClosedError);
	});

	it("faults the whole coordinator when an admitted storage commit fails", async () => {
		const session = await new InMemorySessionRepo().create({ id: "runtime-fault" });
		const coordinator = new RuntimeCoordinator(
			session,
			"automatic",
			{},
			{ enabled: false, maxRetries: 0, baseDelayMs: 1 },
		);
		const fault = new Error("disk failed");

		await expect(coordinator.commit({ writes: [] }, () => Promise.reject(fault))).rejects.toMatchObject({
			cause: fault,
		} satisfies Partial<HarnessFaultError>);
		await expect(coordinator.mutateLane("main", () => undefined)).rejects.toBeInstanceOf(HarnessFaultError);
		expect(coordinator.isFaulted()).toBe(true);
		await coordinator.close();
	});

	it("settles transitions only while register seq and settings tokens still match", async () => {
		const { session } = await createSuspendedSession("runtime-cas");
		const coordinator = new RuntimeCoordinator(
			session,
			"automatic",
			{},
			{ enabled: false, maxRetries: 0, baseDelayMs: 1 },
		);
		const restored = await restoreLane(session, "main");
		if (restored.kind !== "suspended") throw new Error("Expected a suspended operation");
		const current: CurrentOperation = restored.current;
		const next = structuredClone(current.state);
		if (next.kind !== "run" || next.phase.kind !== "checkpoint") throw new Error("Expected checkpoint state");
		next.phase.skipInboxOnce = true;

		await session.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: structuredClone(current.laneState),
				},
			],
		});
		await expect(coordinator.commitTransition(current, next)).resolves.toBeUndefined();

		const fresh = await restoreLane(session, "main");
		if (fresh.kind !== "suspended") throw new Error("Expected a suspended operation");
		const staleSettingsRevision = coordinator.runtimeSnapshot().settingsRevision;
		await coordinator.setStreamOptions({ timeoutMs: 1 });
		await expect(
			coordinator.commitTransition(fresh.current, next, fresh.current.configurationSeq, staleSettingsRevision),
		).resolves.toBeUndefined();

		const settled = await coordinator.commitTransition(
			fresh.current,
			next,
			fresh.current.configurationSeq,
			coordinator.runtimeSnapshot().settingsRevision,
		);
		expect(settled?.state).toEqual(next);
		expect(settled?.operationStateSeq).toBeGreaterThan(fresh.current.operationStateSeq);
		await coordinator.close();
	});

	it("describes every planner action variant", () => {
		const telemetryContext = NOOP_TELEMETRY_CONTEXT;
		const effect = {
			kind: "hook",
			key: "hook",
			name: "before_resume",
			event: {},
			telemetryContext,
			operationId: "operation",
		} as const;
		expect(describeAction({ kind: "transition", next: runState("entry"), telemetryContext }).kind).toBe("transition");
		expect(describeAction({ kind: "dispatch", effect }).kind).toBe("dispatch");
		expect(describeAction({ kind: "await_effect", key: "effect" }).kind).toBe("await_effect");
		expect(
			describeAction({
				kind: "settle",
				plan: effect,
				output: { kind: "hook", key: "hook", result: undefined },
				telemetryContext,
			}).kind,
		).toBe("settle");
		expect(describeAction({ kind: "wait", until: 1, telemetryContext }).kind).toBe("wait");
		expect(describeAction({ kind: "suspend", result: { kind: "declined", leafId: null } }).kind).toBe("suspend");
		expect(describeAction({ kind: "finish", result: { kind: "declined", leafId: null } }).kind).toBe("finish");
	});

	it("plans the first R3 transition from a restored need_assistant checkpoint", async () => {
		const { session } = await createSuspendedSession("runtime-planner-shell");
		const restored = await restoreLane(session, "main");
		if (restored.kind !== "suspended") throw new Error("Expected a suspended operation");
		const action = nextAction(restored.current, {
			running: new Map(),
			deferredPollsRemaining: 0,
			deferredCancellations: new Set(),
			loaded: restored.loaded,
			runtime: {
				settingsRevision: 0,
				streamOptions: {},
				retryPolicy: { maxAttempts: 1, baseDelayMs: 1000 },
			},
			now: 1,
			nextId: () => "step",
			telemetryContext: NOOP_TELEMETRY_CONTEXT,
		});
		expect(action).toMatchObject({
			kind: "transition",
			next: { phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 1 } } },
		});
		await session.close();
	});

	it("validates all durable operation state and last-result variants", () => {
		const states = [
			runState("entry"),
			{
				kind: "compaction",
				control: { status: "running" },
				structural: { taskId: "task", status: "deciding" },
			},
			{
				kind: "navigation",
				control: { status: "running" },
				targetId: null,
				summarize: false,
				phase: { kind: "ready_to_commit" },
			},
		] as const;
		const results = [
			{ operationId: "run", kind: "run", leafId: "leaf", outcome: "completed", runCompletion: "assistant" },
			{ operationId: "compact", kind: "compaction", leafId: "leaf", outcome: "declined" },
			{ operationId: "navigate", kind: "navigation", leafId: null, outcome: "aborted" },
		] satisfies LaneLastResult[];
		expect(states.map((state) => state.kind)).toEqual(["run", "compaction", "navigation"]);
		expect(results.map((result) => result.kind)).toEqual(["run", "compaction", "navigation"]);
	});
});

describe("Harness v4 R1 observation primitives", () => {
	it("buffers watcher events between snapshot and start and isolates listener failures", async () => {
		const bus = new HarnessEventBus();
		const handlerErrors: string[] = [];
		bus.on("handler_error", (event) => {
			handlerErrors.push(event.error);
		});
		bus.on("run_start", () => {
			throw new Error("listener failed");
		});
		const snapshot = { lanes: [], faulted: false } satisfies SessionSnapshot;
		const watcher = bus.watch(() => snapshot);
		bus.emit({ type: "run_start", lane: "main", runId: "run" });
		const received: string[] = [];
		watcher.start((event) => {
			received.push(event.type);
		});
		bus.emit({ type: "run_end", lane: "main", runId: "run", leafId: null, outcome: "completed" });
		await vi.waitFor(() => expect(handlerErrors).toEqual(["listener failed"]));
		expect(watcher.snapshot).toEqual(snapshot);
		expect(received).toEqual(["run_start", "run_end", "handler_error"]);
	});

	it("aggregates hooks in registration order and fails closed before tools", async () => {
		const bus = new HarnessEventBus();
		const errors: string[] = [];
		bus.on("handler_error", (event) => {
			errors.push(event.error);
		});
		const hooks = new HarnessHookRegistry(bus);
		hooks.on(
			"before_run",
			() => ({ messages: [userMessage("one")], systemPrompt: "one", resumeData: { one: true } }),
			{ id: "one" },
		);
		hooks.on(
			"before_run",
			(event) => ({ messages: [userMessage(String(event.prompt.length))], systemPrompt: "two" }),
			{ id: "two" },
		);
		expect(() => hooks.on("before_run", () => undefined, { id: "one" })).toThrow(/duplicate/i);
		const beforeRun = await hooks.run("before_run", {
			lane: "main",
			runId: "run",
			prompt: [userMessage("base")],
			systemPrompt: "base",
			resources: {},
		} satisfies HookInvocation<"before_run">);
		expect(beforeRun).toEqual({
			messages: [userMessage("one"), userMessage("2")],
			systemPrompt: "two",
			resumeData: { one: { one: true } },
		});

		hooks.on("before_tool", () => {
			throw new Error("tool hook failed");
		});
		const beforeTool = await hooks.run("before_tool", {
			lane: "main",
			runId: "run",
			toolCallId: "call",
			toolName: "write",
			args: {},
		} satisfies HookInvocation<"before_tool">);
		expect(beforeTool).toEqual({ block: { reason: "tool hook failed" } });
		expect(errors).toContain("tool hook failed");
	});
});

describe("Harness v4 R1 public shell", () => {
	it("exposes restored lanes and keeps later structural operations unavailable", async () => {
		const session = await new InMemorySessionRepo().create({ id: "runtime-public" });
		const { harness } = await AgentHarness.create({ session, models: MODELS, model: MODEL });

		expect((await harness.lane("main"))?.name).toBe("main");
		expect(await harness.lanes()).toEqual([expect.objectContaining({ name: "main", leafId: null, operation: null })]);
		await expect(harness.compact()).rejects.toBeInstanceOf(HarnessNotImplementedError);
		await harness.close();
	});
});
