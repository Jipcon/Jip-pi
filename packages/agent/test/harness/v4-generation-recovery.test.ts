import type { Api, AssistantMessage, DeferredHandle, Model, RetryPolicy } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import {
	AgentHarness,
	type CurrentOperation,
	classifyGenerationOutcome,
	type EffectPendingGeneration,
	type Entry,
	type Generation,
	type GenerationContext,
	InMemorySessionRepo,
	type LaneConfiguration,
	nextAction,
	normalizeRetryPolicy,
	type Operation,
	type PlannerInputs,
	type RunPhase,
	type RunResult,
	type RunState,
	retryDelayMs,
	type SettledAssistantMessage,
	saturatingAdd,
} from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";
import { type V4SessionRepo, v4Backends } from "./fixtures/v4-jsonl-backends.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function firstText(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	const first = content[0];
	return first?.type === "text" ? first.text : undefined;
}

function settledMessage(message: AssistantMessage): SettledAssistantMessage {
	return message as SettledAssistantMessage;
}

function retryableError(text: string, timestamp = 1): SettledAssistantMessage {
	return settledMessage(fauxAssistantMessage(text, { stopReason: "error", errorMessage: "fetch failed", timestamp }));
}

function terminalError(text: string, timestamp = 1): SettledAssistantMessage {
	return settledMessage(
		fauxAssistantMessage(text, { stopReason: "error", errorMessage: "insufficient_quota", timestamp }),
	);
}

function deferredHandle(): DeferredHandle {
	return { provider: "r3-provider", modelId: "faux-1", api: "r3-api", id: "deferred-id" };
}

const CONFIGURATION: LaneConfiguration = {
	model: { provider: "r3-provider", modelId: "faux-1" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function runState(triggerEntryId: string, phase?: RunPhase): RunState {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		phase: phase ?? {
			kind: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

const OPERATION: Operation = {
	operationId: "operation",
	lane: "main",
	sourceLeafId: null,
	startedAt: 10,
	intent: { kind: "run", promptEntryIds: ["prompt"] },
};

function currentWith(phase: RunPhase, configuration: LaneConfiguration = CONFIGURATION): CurrentOperation {
	return {
		operation: OPERATION,
		state: runState("prompt", phase),
		operationStateSeq: 1,
		laneState: { currentOperationId: "operation", pendingNextRun: [] },
		laneStateSeq: 1,
		leafId: "prompt",
		configuration,
		configurationSeq: 1,
	};
}

function assistantEntry(id: string, message: AgentMessage): Entry {
	return { id, parentId: null, seq: 1, timestamp: 1, type: "message", message };
}

function plannerInputs(
	overrides: Partial<PlannerInputs> = {},
	loaded: ReadonlyMap<string, Entry> = new Map(),
): PlannerInputs {
	return {
		running: new Map(),
		deferredPollsRemaining: 0,
		deferredCancellations: new Set(),
		loaded,
		runtime: {
			settingsRevision: 0,
			streamOptions: { timeoutMs: 5000 },
			retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
		},
		now: 1000,
		nextId: () => "next-id",
		model: { maxTokens: 4096, contextWindow: 128_000 },
		telemetryContext: NOOP_TELEMETRY_CONTEXT,
		...overrides,
	};
}

function generationContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
	return {
		stepId: "step",
		triggerEntryId: "prompt",
		configuration: CONFIGURATION,
		streamOptions: {},
		retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
		overflowRecoveryUsed: false,
		...overrides,
	};
}

function readyGeneration(nextAttempt = 1): Extract<Generation, { status: "ready" }> {
	return { status: "ready", context: generationContext(), nextAttempt };
}

function retryWaitGeneration(
	overrides: Partial<Extract<Generation, { status: "retry_wait" }>> = {},
): Extract<Generation, { status: "retry_wait" }> {
	return {
		status: "retry_wait",
		context: generationContext(),
		nextAttempt: 2,
		notBefore: 2000,
		errorMessage: "boom",
		...overrides,
	};
}

async function createRuntimeWithRepo(
	repo: V4SessionRepo,
	options: {
		drive?: "automatic" | "manual";
		retry?: RetryPolicy;
		instrument?: boolean;
		tools?: AgentHarnessTool<undefined>[];
		activeToolNames?: string[];
		id?: string;
	} = {},
) {
	const faux = fauxProvider({ provider: "r3-provider", api: "r3-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const raw = await repo.create({ id: options.id ?? `r3-${options.drive ?? "auto"}` });
	const session = options.instrument === true ? new InstrumentedSession(raw) : raw;
	const tools = options.tools ?? [];
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(options.retry === undefined ? {} : { retry: options.retry }),
		...(tools.length === 0 ? {} : { tools }),
		...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
	});
	return { faux, harness, model, models, repo, session };
}

async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
	return createRuntimeWithRepo(new InMemorySessionRepo({ now: () => 1_800_000_000_000 }), options);
}

function settledValue<TValue>(result: { ok: true; value: TValue } | { ok: false; error: unknown }): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

describe("R3 pure planner and classifier", () => {
	it("exhausts every R3 generation state into the documented actions", () => {
		const checkpoint = currentWith(runState("prompt").phase);
		const transition = nextAction(checkpoint, plannerInputs({ nextId: () => "step-1" }));
		expect(transition).toMatchObject({
			kind: "transition",
			expectedConfigurationSeq: 1,
			expectedSettingsRevision: 0,
			next: {
				phase: {
					kind: "assistant",
					generation: { status: "ready", nextAttempt: 1, context: { stepId: "step-1" } },
				},
			},
		});

		const ready: RunPhase = { kind: "assistant", generation: readyGeneration() };
		const dispatch = nextAction(currentWith(ready), plannerInputs({ nextId: () => "reserved" }));
		expect(dispatch).toMatchObject({
			kind: "dispatch",
			intent: {
				phase: {
					kind: "assistant",
					generation: {
						status: "effect_pending",
						attempt: 1,
						responseEntryId: "reserved",
						usageId: "reserved",
						intendedOutputLimit: 4096,
						contextWindow: 128_000,
					},
				},
			},
			effect: { kind: "assistant", key: "operation:step:attempt:1" },
		});
		if (dispatch.kind !== "dispatch" || dispatch.effect.kind !== "assistant") {
			throw new Error("Expected dispatch");
		}
		const dispatchedGeneration = dispatch.effect.generation;

		const livePending: RunPhase = { kind: "assistant", generation: dispatchedGeneration };
		const running = new Map([[dispatch.effect.key, dispatch.effect]]);
		const awaitAction = nextAction(currentWith(livePending), plannerInputs({ running }));
		expect(awaitAction).toEqual({ kind: "await_effect", key: dispatch.effect.key });

		const restoredBelowCap: RunPhase = {
			kind: "assistant",
			generation: { ...dispatchedGeneration, status: "effect_pending" },
		};
		expect(nextAction(currentWith(restoredBelowCap), plannerInputs())).toMatchObject({
			kind: "transition",
			next: { phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 2 } } },
		});

		const atCap: RunPhase = {
			kind: "assistant",
			generation: {
				...dispatchedGeneration,
				status: "effect_pending",
				attempt: 3,
				context: { ...dispatchedGeneration.context, retryPolicy: { maxAttempts: 3, baseDelayMs: 100 } },
			},
		};
		const settle = nextAction(currentWith(atCap), plannerInputs());
		expect(settle).toMatchObject({
			kind: "settle",
			output: {
				kind: "assistant",
				message: { stopReason: "error", errorMessage: "Generation attempt 3 was interrupted before settlement" },
			},
		});

		const waiting: RunPhase = {
			kind: "assistant",
			generation: retryWaitGeneration({ nextAttempt: 2, notBefore: 2000, errorMessage: "boom" }),
		};
		expect(nextAction(currentWith(waiting), plannerInputs())).toMatchObject({ kind: "wait", until: 2000 });
		expect(nextAction(currentWith(waiting), plannerInputs({ now: 2000 }))).toMatchObject({
			kind: "transition",
			next: { phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 2 } } },
		});

		const completed = assistantEntry("response", fauxAssistantMessage("done"));
		const mayFinish: RunPhase = {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: "response",
		};
		const finish = nextAction(currentWith(mayFinish), plannerInputs({}, new Map([["response", completed]])));
		expect(finish).toMatchObject({ kind: "finish", result: { kind: "completed", finalEntryId: "response" } });

		const drained: RunPhase = {
			kind: "failure_drain",
			error: { code: "provider_error", message: "gone" },
			provenance: { kind: "response", entryId: "response" },
		};
		const failed = nextAction(currentWith(drained), plannerInputs({}, new Map([["response", completed]])));
		expect(failed).toMatchObject({ kind: "finish", result: { kind: "failed", finalEntryId: "response" } });

		const deferredMessage = fauxAssistantMessage("deferred", {
			stopReason: "deferred",
			deferred: deferredHandle(),
		});
		const suspended: RunPhase = {
			kind: "deferred",
			deferred: {
				status: "suspended",
				stepId: "step",
				sourceEntryId: "response",
				poll: 0,
				configuration: CONFIGURATION,
				streamOptions: {},
			},
		};
		const suspend = nextAction(
			currentWith(suspended),
			plannerInputs({}, new Map([["response", assistantEntry("response", deferredMessage)]])),
		);
		expect(suspend).toMatchObject({
			kind: "suspend",
			result: { kind: "suspended", reason: "deferred", finalEntryId: "response" },
		});

		const toolsPhase: RunPhase = {
			kind: "tools",
			batch: {
				assistantEntryId: "response",
				configuration: CONFIGURATION,
				turnId: "step",
				argumentAuthority: { kind: "standard_tool_args_registers" },
				calls: [],
			},
		};
		// R4: a tool-bearing response now enters the durable tools phase instead of failing closed.
		expect(nextAction(currentWith(toolsPhase), plannerInputs())).toMatchObject({
			kind: "transition",
			next: { phase: { kind: "checkpoint", continuation: { kind: "need_assistant" } } },
		});
		const deferredPending: RunPhase = {
			kind: "deferred",
			deferred: {
				status: "effect_pending",
				stepId: "step",
				sourceEntryId: "response",
				poll: 1,
				responseEntryId: "next",
				usageId: "usage",
				configuration: CONFIGURATION,
				streamOptions: {},
			},
		};
		expect(() => nextAction(currentWith(deferredPending), plannerInputs())).toThrow(/deferred polling/);
	});

	it("keeps the ready gate honest: no model window means no dispatch", () => {
		const ready: RunPhase = { kind: "assistant", generation: readyGeneration() };
		expect(() => nextAction(currentWith(ready), plannerInputs({ model: undefined }))).toThrow(
			/without resolved model identity/,
		);
	});

	it("classifies every R3 settlement outcome first-match", () => {
		const pending = (attempt: number): EffectPendingGeneration => ({
			status: "effect_pending",
			context: {
				stepId: "step",
				triggerEntryId: "prompt",
				configuration: CONFIGURATION,
				streamOptions: {},
				retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
				overflowRecoveryUsed: false,
			},
			attempt,
			responseEntryId: "response",
			usageId: "usage",
			intendedOutputLimit: 4096,
			contextWindow: 128_000,
		});

		expect(classifyGenerationOutcome(settledMessage(fauxAssistantMessage("stop")), pending(1), 1000)).toEqual({
			kind: "completed",
		});
		expect(
			classifyGenerationOutcome(
				settledMessage(fauxAssistantMessage("cut", { stopReason: "length" })),
				pending(1),
				1000,
			),
		).toEqual({ kind: "completed" });
		expect(
			classifyGenerationOutcome(
				settledMessage(fauxAssistantMessage("later", { stopReason: "deferred", deferred: deferredHandle() })),
				pending(1),
				1000,
			),
		).toEqual({ kind: "deferred" });
		expect(
			classifyGenerationOutcome(
				settledMessage(fauxAssistantMessage("deferred", { stopReason: "deferred" })),
				pending(1),
				1000,
			),
		).toMatchObject({ kind: "failure", error: { code: "provider_error" } });
		expect(classifyGenerationOutcome(retryableError("boom"), pending(1), 1000)).toEqual({
			kind: "retry",
			failedAttempt: 1,
			nextAttempt: 2,
			delayMs: 100,
			notBefore: 1100,
			errorMessage: "fetch failed",
		});
		expect(classifyGenerationOutcome(retryableError("boom"), pending(3), 1000)).toMatchObject({
			kind: "failure",
		});
		expect(classifyGenerationOutcome(terminalError("quota"), pending(1), 1000)).toMatchObject({
			kind: "failure",
			error: { code: "provider_error" },
		});
		expect(
			classifyGenerationOutcome(
				settledMessage(fauxAssistantMessage("x", { stopReason: "aborted" })),
				pending(1),
				1000,
			),
		).toMatchObject({
			kind: "failure",
			error: { message: "Provider response was aborted without a harness cancellation" },
		});
		expect(
			classifyGenerationOutcome(
				settledMessage(fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })),
				pending(1),
				1000,
			),
		).toEqual({ kind: "tools" });
	});

	it("normalizes policies and saturates backoff arithmetic", () => {
		expect(normalizeRetryPolicy({ enabled: false, maxRetries: 5, baseDelayMs: 100 })).toEqual({
			maxAttempts: 1,
			baseDelayMs: 100,
		});
		expect(normalizeRetryPolicy({ enabled: true, maxRetries: 2.9, baseDelayMs: 100 })).toEqual({
			maxAttempts: 3,
			baseDelayMs: 100,
		});
		expect(normalizeRetryPolicy({ enabled: true, maxRetries: -3, baseDelayMs: -10 })).toEqual({
			maxAttempts: 1,
			baseDelayMs: 0,
		});
		expect(retryDelayMs({ maxAttempts: 3, baseDelayMs: 25 }, 1)).toBe(25);
		expect(retryDelayMs({ maxAttempts: 3, baseDelayMs: 25 }, 2)).toBe(50);
		expect(retryDelayMs({ maxAttempts: 3, baseDelayMs: 25 }, 3)).toBe(100);
		expect(retryDelayMs({ maxAttempts: 64, baseDelayMs: Number.MAX_SAFE_INTEGER }, 64)).toBe(Number.MAX_SAFE_INTEGER);
		expect(saturatingAdd(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(saturatingAdd(5, 3)).toBe(8);
	});
});

describe.each(v4Backends())("R3 resume entry ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 1_800_000_000_000 }), options);
	}

	it("returns NothingToResume for an idle lane without touching storage", async () => {
		const { harness } = await createRuntime();
		expect(await harness.resume()).toMatchObject({ ok: false, error: { _tag: "NothingToResume" } });
		await harness.close();
	});

	it("rejects a concurrent resume while another drive owns the lane", async () => {
		const { faux, harness } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("driven")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await expect(harness.resume()).resolves.toMatchObject({ ok: false, error: { _tag: "LaneBusy" } });
		await harness.runToCompletion();
		settledValue(await pending);
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("emits run_resume for a restored operation and never creates a second operation", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("resumed-run")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
		});
		const events: string[] = [];
		reopened.events.on("run_resume", () => {
			events.push("run_resume");
		});
		const operations = await reopened.durableSession.listRegisters("op.meta");
		expect(operations).toHaveLength(1);
		const value = settledValue(await reopened.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "resumed-run" }] } });
		expect(events).toEqual(["run_resume"]);
		expect(await reopened.durableSession.listRegisters("op.meta")).toHaveLength(0);
		await reopened.close();
	});
});

describe("R3 retry behaviour", () => {
	it("settles immediately when retries are disabled", async () => {
		const { faux, harness } = await createRuntime({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 1000 } });
		faux.setResponses([retryableError("boom")]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "failed", error: { code: "provider_error" } });
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("retries with zero delay until an attempt succeeds", async () => {
		const { faux, harness } = await createRuntime({
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
		});
		faux.setResponses([retryableError("one"), retryableError("two"), fauxAssistantMessage("done")]);
		const events: string[] = [];
		for (const type of ["retry_scheduled", "retry_start", "retry_end", "turn_start", "turn_end"] as const) {
			harness.events.on(type, () => {
				events.push(type);
			});
		}
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "done" }] } });
		expect(faux.state.callCount).toBe(3);
		expect(events).toEqual([
			"turn_start",
			"retry_scheduled",
			"retry_start",
			"retry_scheduled",
			"retry_start",
			"retry_end",
			"turn_end",
		]);
		const rows = await harness.durableSession.scanUsage({ order: "asc" });
		expect(rows).toHaveLength(3);
		await harness.close();
	});

	it("drains into a failed terminal once attempts are exhausted", async () => {
		const { faux, harness } = await createRuntime({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			instrument: true,
		});
		faux.setResponses([retryableError("one"), retryableError("two")]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({
			kind: "failed",
			finalMessage: { stopReason: "error", errorMessage: "fetch failed" },
		});
		expect(faux.state.callCount).toBe(2);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const assistantEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		expect(assistantEntries).toHaveLength(2);
		expect(await harness.getLastResult()).toMatchObject({
			outcome: "failed",
			finalAssistantEntryId: (value as { finalEntryId?: string }).finalEntryId,
		});
		await harness.close();
	});

	it("never retries a non-retryable provider error", async () => {
		const { faux, harness } = await createRuntime({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 0 } });
		faux.setResponses([terminalError("quota")]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "failed", finalMessage: { errorMessage: "insufficient_quota" } });
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});
});

describe("R3 generation hooks", () => {
	it("runs before_request once per real attempt from the captured base options", async () => {
		const { faux, harness } = await createRuntime({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		const attempts: Array<{ attempt: number; timeoutMs: number | undefined }> = [];
		harness.hooks.on("before_request", ({ attempt, streamOptions }) => {
			attempts.push({ attempt, timeoutMs: streamOptions.timeoutMs });
			return { streamOptions: { timeoutMs: (streamOptions.timeoutMs ?? 0) + attempt } };
		});
		faux.setResponses([retryableError("one"), fauxAssistantMessage("done")]);
		settledValue(await harness.prompt("hello"));
		expect(attempts).toEqual([
			{ attempt: 1, timeoutMs: undefined },
			{ attempt: 2, timeoutMs: undefined },
		]);
		await harness.close();
	});

	it("keeps captured stream options independent of later global setters", async () => {
		const { faux, harness } = await createRuntime({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			drive: "manual",
		});
		const seen: number[] = [];
		harness.hooks.on("before_request", ({ streamOptions }) => {
			seen.push((streamOptions.timeoutMs as number | undefined) ?? -1);
			return undefined;
		});
		faux.setResponses([retryableError("one"), fauxAssistantMessage("done")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.setStreamOptions({ timeoutMs: 42_000 });
		await harness.executeAction();
		await harness.runToCompletion();
		settledValue(await pending);
		expect(seen).toEqual([-1, -1]);
		await harness.close();
	});
});

describe.each(v4Backends())("R3 recovery and durability ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 1_800_000_000_000 }), options);
	}

	it("keeps response, usage, and successor state in one atomic settlement commit", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		faux.setResponses([fauxAssistantMessage("atomic", { timestamp: 7 })]);
		settledValue(await harness.prompt("hello"));
		const instrumented = session as InstrumentedSession;
		const settlement = instrumented.commits().find((commit) => commit.writes.some((write) => write.kind === "usage"));
		expect(settlement).toBeDefined();
		expect(settlement!.writes.map((write) => write.kind)).toEqual(["entry", "register", "usage", "register"]);
		const [entry, leaf, usage, state] = settlement!.writes as [never, never, never, never] & {
			[k: number]: unknown;
		};
		void entry;
		void leaf;
		void usage;
		void state;
		await harness.close();
	});

	it("materializes the reserved ids and zero synthetic usage at the cap", async () => {
		const faux = fauxProvider({ provider: "r3-cap", api: "r3-cap-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const repo = backend.create({ now: () => 1 });
		const session = await repo.create({ id: "r3-cap" });
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const operationId = "operation";
		const operation: Operation = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 10,
			intent: { kind: "run", promptEntryIds: [promptEntryId] },
		};
		const reservedEntryId = "reserved-entry";
		const reservedUsageId = "reserved-usage";
		const context = {
			stepId: "step",
			triggerEntryId: promptEntryId,
			configuration: CONFIGURATION,
			streamOptions: {},
			retryPolicy: { maxAttempts: 1, baseDelayMs: 100 },
			overflowRecoveryUsed: false,
		};
		const pendingState: RunState = {
			...runState(promptEntryId),
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context,
					attempt: 1,
					responseEntryId: reservedEntryId,
					usageId: reservedUsageId,
					intendedOutputLimit: 4096,
					contextWindow: 128_000,
				},
			},
		};
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
				{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: pendingState },
			],
		});
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() as Model<Api> });
		expect(faux.state.callCount).toBe(0);
		const resumed = await harness.resume();
		expect(resumed).toMatchObject({
			ok: true,
			value: {
				operation: "run",
				kind: "failed",
				finalEntryId: reservedEntryId,
				finalMessage: {
					stopReason: "error",
					errorMessage: "Generation attempt 1 was interrupted before settlement",
				},
			},
		});
		expect(faux.state.callCount).toBe(0);
		const entry = await session.getEntries([reservedEntryId]);
		expect(entry.get(reservedEntryId)?.type).toBe("message");
		const rows = await session.scanUsage({ entryIds: [reservedEntryId] });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: reservedUsageId, adjustment: false });
		expect(rows[0]?.usage.totalTokens).toBe(0);
		expect(await session.getRegister("op.state", operationId)).toBeUndefined();
		expect(await harness.getLastResult()).toMatchObject({
			operationId,
			outcome: "failed",
			finalAssistantEntryId: reservedEntryId,
		});
		await harness.close();
	});

	it("resumes from a restored ready state and parks before any effect in manual mode", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("resumed")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(0);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			drive: "manual",
		});
		expect(faux.state.callCount).toBe(0);
		const resumed = reopened.resume();
		await vi.waitFor(async () => expect((await reopened.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(0);
		await reopened.runToCompletion();
		const value = settledValue(await resumed);
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "resumed" }] } });
		expect(faux.state.callCount).toBe(1);
		await reopened.close();
	});

	it("treats a restored effect_pending below the cap as unknown and advances the attempt", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		faux.setResponses([fauxAssistantMessage("second attempt")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId;
		if (operationId === null || operationId === undefined) throw new Error("Expected an open Run");
		const pendingGeneration = await harness.durableSession.getRegister("op.state", operationId);
		const reserved =
			pendingGeneration?.value.kind === "run" && pendingGeneration.value.phase.kind === "assistant"
				? pendingGeneration.value.phase.generation
				: undefined;
		if (reserved?.status !== "effect_pending") throw new Error("Expected effect_pending");
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(0);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const events: string[] = [];
		for (const type of ["retry_start", "turn_start", "turn_end", "run_end"] as const) {
			reopened.events.on(type, () => {
				events.push(type);
			});
		}
		expect(faux.state.callCount).toBe(0);
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "second attempt" }] } });
		expect(faux.state.callCount).toBe(1);
		expect(events).toEqual(["retry_start", "turn_start", "turn_end", "run_end"]);
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch.some((entry) => entry.id === reserved.responseEntryId)).toBe(false);
		await reopened.close();
	});

	it("keeps retry deadlines durable across reopen and waits until they pass", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 30 },
		});
		faux.setResponses([retryableError("boom"), fauxAssistantMessage("recovered")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_effect_settlement"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("sleep"));
		const metadata = structuredClone(session.metadata);
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId;
		const waitState = await harness.durableSession.getRegister("op.state", operationId as string);
		const generationState =
			waitState?.value.kind === "run" && waitState.value.phase.kind === "assistant"
				? waitState.value.phase.generation
				: undefined;
		if (generationState?.status !== "retry_wait") throw new Error("Expected retry_wait");
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 30 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(faux.state.callCount).toBe(1);
		const resumed = reopened.resume();
		await vi.waitFor(async () => expect((await reopened.peekAction())?.kind).toBe("commit_transition"));
		await reopened.runToCompletion();
		const value = settledValue(await resumed);
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "recovered" }] } });
		expect(faux.state.callCount).toBe(2);
		await reopened.close();
	});

	it("resumes from failure_drain into a failed terminal without a provider effect", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		faux.setResponses([terminalError("quota")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_effect_settlement"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_terminal"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(1);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({
			kind: "failed",
			error: { code: "provider_error", message: "insufficient_quota" },
		});
		expect(faux.state.callCount).toBe(1);
		expect(await reopened.getLastResult()).toMatchObject({ outcome: "failed" });
		await reopened.close();
	});

	it("suspends a valid deferred response without polling and resumes back into suspension", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("later", { stopReason: "deferred", deferred: deferredHandle() })]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({
			kind: "suspended",
			reason: "deferred",
			deferred: { id: "deferred-id" },
		});
		expect(faux.state.callCount).toBe(1);
		const open = await harness.getOpenOperation();
		expect(open).toMatchObject({
			kind: "run",
			turnCursor: { assistantEntryId: (value as { finalEntryId?: string }).finalEntryId, leafId: value.leafId },
		});
		const rows = await harness.durableSession.scanUsage({ order: "asc" });
		expect(rows).toHaveLength(1);
		const metadata = structuredClone(session.metadata);
		await harness.close();

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened, suspended } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
		});
		expect(suspended).toEqual([
			expect.objectContaining({
				kind: "run",
				reason: "crash",
				deferred: expect.objectContaining({ id: "deferred-id" }),
			}),
		]);
		expect(faux.state.callCount).toBe(1);
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "suspended", reason: "deferred" });
		expect(faux.state.callCount).toBe(1);
		await reopened.close();
	});

	it("routes tool-bearing responses into the durable tools phase instead of failing closed", async () => {
		const { faux, harness } = await createRuntime({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("missing-tool", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("after tools"),
		]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "after tools" }] } });
		expect(faux.state.callCount).toBe(2);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const toolResults = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			message: { isError: true, content: [{ type: "text", text: "Tool missing-tool not found" }] },
		});
		await harness.close();
	});
});

describe("R3 identity", () => {
	it("returns MissingIdentities from a restored ready state without burning an attempt", async () => {
		const session = await new InMemorySessionRepo({ now: () => 1 }).create({ id: "r3-identity" });
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const operationId = "operation";
		const missingConfiguration: LaneConfiguration = {
			model: { provider: "missing-provider", modelId: "missing-model" },
			thinkingLevel: "off",
			activeToolNames: [],
		};
		const operation: Operation = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 10,
			intent: { kind: "run", promptEntryIds: [promptEntryId] },
		};
		const readyState: RunState = {
			...runState(promptEntryId),
			phase: {
				kind: "assistant",
				generation: {
					status: "ready",
					context: {
						stepId: "step",
						triggerEntryId: promptEntryId,
						configuration: missingConfiguration,
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 100 },
						overflowRecoveryUsed: false,
					},
					nextAttempt: 1,
				},
			},
		};
		await session.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: missingConfiguration },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: operationId, pendingNextRun: [] },
				},
				{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
				{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: readyState },
			],
		});
		const faux = fauxProvider({ provider: "r3-identity", api: "r3-identity-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() as Model<Api> });
		const before = await session.getRegister("op.state", operationId);
		expect(await harness.resume()).toMatchObject({
			ok: false,
			error: { _tag: "MissingIdentities", models: ["missing-provider/missing-model"] },
		});
		const after = await session.getRegister("op.state", operationId);
		expect(after?.seq).toBe(before?.seq);
		expect(after?.value).toEqual(before?.value);
		expect(faux.state.callCount).toBe(0);
		await harness.close();
	});

	it("turns a post-intent identity loss into an in-band failed response", async () => {
		const tool: AgentHarnessTool<undefined> = {
			name: "read",
			description: "read a file",
			label: "read",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: 1,
				details: undefined,
			}),
		};
		const { faux, harness } = await createRuntime({
			drive: "manual",
			tools: [tool],
			activeToolNames: ["read"],
		});
		faux.setResponses([fauxAssistantMessage("never")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.setTools([]);
		await harness.runToCompletion();
		const value = settledValue(await pending);
		expect(value).toMatchObject({
			kind: "failed",
			error: { code: "provider_error", message: "Generation effect failed: Tool read disappeared" },
		});
		expect(faux.state.callCount).toBe(0);
		await harness.close();
	});
});

describe("R3 drive parity", () => {
	it("produces byte-equivalent durable results in automatic and manual mode", async () => {
		const outcomes: Array<{
			lastResult: unknown;
			entries: unknown[];
			usage: unknown[];
		}> = [];
		for (const drive of ["automatic", "manual"] as const) {
			const { faux, harness } = await createRuntime({
				drive,
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			faux.setResponses([retryableError("boom"), fauxAssistantMessage("parity")]);
			let value: RunResult | undefined;
			if (drive === "automatic") {
				value = await harness.prompt("hello");
			} else {
				const pending = harness.prompt("hello");
				await vi.waitFor(async () => expect(await harness.peekAction()).toBeDefined());
				await harness.runToCompletion();
				value = await pending;
			}
			expect(value).toMatchObject({ ok: true, value: { kind: "completed" } });
			const entries = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
			const lastResult = await harness.getLastResult();
			outcomes.push({
				lastResult: lastResult && {
					kind: lastResult.kind,
					outcome: lastResult.outcome,
					runCompletion: (lastResult as { runCompletion?: string }).runCompletion,
					leafMatchesFinal:
						lastResult.finalAssistantEntryId !== undefined &&
						lastResult.finalAssistantEntryId === lastResult.leafId,
				},
				entries: entries.map((entry) =>
					entry.type === "message"
						? {
								type: entry.type,
								role: entry.message.role,
								text: firstText(entry.message),
								stopReason: entry.message.role === "assistant" ? entry.message.stopReason : undefined,
							}
						: { type: entry.type },
				),
				usage: (await harness.durableSession.scanUsage({ order: "asc" })).map((row) => ({
					totalTokens: row.usage.totalTokens,
					adjustment: row.adjustment,
				})),
			});
			await harness.close();
		}
		expect(outcomes[1]).toEqual(outcomes[0]);
	});
});

describe.each(v4Backends())("R3 close/reopen boundaries ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 1_800_000_000_000 }), options);
	}

	it("reopens a checkpoint boundary with zero effects and completes after resume", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("checkpoint")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(0);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened, suspended } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
		});
		expect(suspended).toHaveLength(1);
		expect(faux.state.callCount).toBe(0);
		const value = settledValue(await reopened.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "checkpoint" }] } });
		expect(faux.state.callCount).toBe(1);
		await reopened.close();
	});

	it("reopens a live effect_pending boundary without replaying the attempt", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		faux.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new Error("provider request aborted by close")),
						{ once: true },
					);
				}),
			fauxAssistantMessage("recovered"),
		]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.executeAction();
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		expect(faux.state.callCount).toBe(1);
		const value = settledValue(await reopened.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "recovered" }] } });
		expect(faux.state.callCount).toBe(2);
		await reopened.close();
	});

	it("reopens a retry_wait boundary with the deadline still pending and waits durably", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
		});
		faux.setResponses([retryableError("boom"), fauxAssistantMessage("slow recovery")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_effect_settlement"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("sleep"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
		});
		expect(faux.state.callCount).toBe(1);
		const resumed = reopened.resume();
		await vi.waitFor(async () => expect((await reopened.peekAction())?.kind).toBe("sleep"));
		const parked = await reopened.peekAction();
		expect(parked).toMatchObject({ kind: "sleep", details: { until: expect.any(Number) } });
		expect(faux.state.callCount).toBe(1);
		const laneState = await reopened.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId;
		const waitState = await reopened.durableSession.getRegister("op.state", operationId as string);
		const generationState =
			waitState?.value.kind === "run" && waitState.value.phase.kind === "assistant"
				? waitState.value.phase.generation
				: undefined;
		expect(generationState?.status).toBe("retry_wait");
		await reopened.close();
		await expect(resumed).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(1);
	});

	it("reopens a deferred boundary and keeps the operation open through resume", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("later", { stopReason: "deferred", deferred: deferredHandle() })]);
		const value = settledValue(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "suspended", reason: "deferred" });
		const metadata = structuredClone(session.metadata);
		await harness.close();

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		expect(faux.state.callCount).toBe(1);
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "suspended", reason: "deferred" });
		expect(await reopened.getOpenOperation()).toMatchObject({
			kind: "run",
			turnCursor: { assistantEntryId: (resumed as { finalEntryId?: string }).finalEntryId },
		});
		await reopened.close();
	});
});
