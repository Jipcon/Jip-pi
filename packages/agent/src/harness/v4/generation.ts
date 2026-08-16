import type { AssistantMessage, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "../types.ts";
import type { Entry, SettledAssistantMessage } from "./base.ts";
import { assertJsonValue } from "./codec.ts";
import { HarnessNotImplementedError } from "./errors.ts";
import { buildInboxDrainPlan, type InboxSelection, inboxEmpty, selectInboxDrain } from "./inbox.ts";
import type {
	Continuation,
	Generation,
	GenerationContext,
	NormalizedRetryPolicy,
	OperationError,
	RunPhase,
	RunState,
} from "./operation.ts";
import { type Register, SessionError } from "./storage.ts";
import type { Action, CurrentOperation, EffectPlan, InboxDrainPlan, PlannerInputs, RunOutcome } from "./surface.ts";
import { requireLeafId, toolPhaseAction } from "./tools.ts";

export type EffectPendingGeneration = Extract<Generation, { status: "effect_pending" }>;

/**
 * First-match settlement classification for one finished generation attempt.
 * R3 explicitly skips R9 overflow inference: a genuine `length` is a normal
 * completion, and an `aborted` output without a Harness-owned cancellation is
 * invalid provider output normalized to an ordinary error before matching.
 */
export type GenerationSettlement =
	| { kind: "completed" }
	| { kind: "deferred" }
	| { kind: "tools" }
	| {
			kind: "retry";
			failedAttempt: number;
			nextAttempt: number;
			delayMs: number;
			notBefore: number;
			errorMessage: string;
	  }
	| { kind: "failure"; error: OperationError };

/** Validate and normalize a retry policy into the durable generation shape. */
export function normalizeRetryPolicy(policy: RetryPolicy): NormalizedRetryPolicy {
	const maxRetries = sanitizeRetries(policy.maxRetries);
	const baseDelayMs = sanitizeDelay(policy.baseDelayMs);
	return { maxAttempts: policy.enabled ? maxRetries + 1 : 1, baseDelayMs };
}

function sanitizeRetries(maxRetries: number): number {
	if (!Number.isFinite(maxRetries)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER - 1, Math.max(0, Math.floor(maxRetries)));
}

function sanitizeDelay(baseDelayMs: number): number {
	if (!Number.isFinite(baseDelayMs)) return 0;
	return Math.max(0, baseDelayMs);
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function assistantEffectKey(operationId: string, stepId: string, attempt: number): string {
	return `${operationId}:${stepId}:attempt:${attempt}`;
}

/** Exponential backoff for a failed attempt (1-indexed), saturating at Number.MAX_SAFE_INTEGER. */
export function retryDelayMs(policy: NormalizedRetryPolicy, failedAttempt: number): number {
	let delay = policy.baseDelayMs;
	for (let index = 1; index < failedAttempt; index++) {
		if (delay > Number.MAX_SAFE_INTEGER / 2) return Number.MAX_SAFE_INTEGER;
		delay *= 2;
	}
	return Math.min(delay, Number.MAX_SAFE_INTEGER);
}

export function saturatingAdd(base: number, addition: number): number {
	if (base > Number.MAX_SAFE_INTEGER - addition) return Number.MAX_SAFE_INTEGER;
	return base + addition;
}

export function classifyGenerationOutcome(
	message: SettledAssistantMessage,
	generation: EffectPendingGeneration,
	now: number,
): GenerationSettlement {
	// R3 owns no cancellation: any aborted output is invalid provider output and
	// is classified as an ordinary error instead of an abort outcome.
	const normalized: SettledAssistantMessage =
		message.stopReason === "aborted"
			? {
					...message,
					stopReason: "error",
					errorMessage: message.errorMessage ?? "Provider response was aborted without a harness cancellation",
				}
			: message;
	const toolCalls = normalized.content.filter((part) => part.type === "toolCall");
	if (toolCalls.length > 0 || normalized.stopReason === "toolUse") {
		return { kind: "tools" };
	}
	if (normalized.stopReason === "stop" || normalized.stopReason === "length") {
		return { kind: "completed" };
	}
	if (normalized.stopReason === "deferred") {
		if (normalized.deferred === undefined) {
			return {
				kind: "failure",
				error: {
					code: "provider_error",
					message: "Provider returned a deferred response without a deferred handle",
				},
			};
		}
		return { kind: "deferred" };
	}
	const error: OperationError = {
		code: "provider_error",
		message: normalized.errorMessage ?? "Provider request failed",
	};
	const failedAttempt = generation.attempt;
	const nextAttempt = failedAttempt + 1;
	if (isRetryableAssistantError(normalized) && nextAttempt <= generation.context.retryPolicy.maxAttempts) {
		const delayMs = retryDelayMs(generation.context.retryPolicy, failedAttempt);
		return {
			kind: "retry",
			failedAttempt,
			nextAttempt,
			delayMs,
			notBefore: saturatingAdd(now, delayMs),
			errorMessage: error.message,
		};
	}
	return { kind: "failure", error };
}

/** The atomic settlement successor state for every first-match decision. */
export function settlementPhase(
	decision: GenerationSettlement,
	generation: EffectPendingGeneration,
	responseEntryId: string,
	message: SettledAssistantMessage,
	nextId: () => string,
	adaptive: boolean,
): RunPhase {
	switch (decision.kind) {
		case "completed":
			return {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			};
		case "tools": {
			const calls: Extract<RunPhase, { kind: "tools" }>["batch"]["calls"] = [];
			let sourceIndex = 0;
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				calls.push({
					status: "planned",
					sourceIndex,
					resultEntryId: nextId(),
					...(message.stopReason === "length" ? { truncated: true as const } : {}),
				});
				sourceIndex++;
			}
			return {
				kind: "tools",
				batch: {
					assistantEntryId: responseEntryId,
					configuration: structuredClone(generation.context.configuration),
					turnId: generation.context.stepId,
					argumentAuthority: adaptive ? { kind: "adaptive_pending" } : { kind: "standard_tool_args_registers" },
					calls,
				},
			};
		}
		case "deferred":
			return {
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: generation.context.stepId,
					sourceEntryId: responseEntryId,
					poll: 0,
					configuration: structuredClone(generation.context.configuration),
					streamOptions: structuredClone(generation.context.streamOptions),
				},
			};
		case "retry":
			return {
				kind: "assistant",
				generation: {
					status: "retry_wait",
					context: structuredClone(generation.context),
					nextAttempt: decision.nextAttempt,
					notBefore: decision.notBefore,
					errorMessage: decision.errorMessage,
				},
			};
		case "failure":
			return {
				kind: "failure_drain",
				error: structuredClone(decision.error),
				provenance: { kind: "response", entryId: responseEntryId },
			};
	}
}

/**
 * Synthetic zero-usage aborted response for a cancelled generation that never
 * produced (or cannot use) a live provider response. Reuses the reserved
 * response entry id; carries no tool calls and never routes into the
 * retry/tool/deferred classifiers.
 */
export function syntheticAbortedMessage(generation: EffectPendingGeneration, now: number): SettledAssistantMessage {
	const { configuration } = generation.context;
	return {
		role: "assistant",
		content: [],
		timestamp: now,
		api: "unknown",
		provider: configuration.model.provider,
		model: configuration.model.modelId,
		stopReason: "aborted",
		errorMessage: "Generation was aborted before settlement",
		usage: zeroUsage(),
	};
}

/** Synthetic zero-usage interrupted response for an attempt that reached its cap without settlement. */
export function syntheticInterruptedMessage(generation: EffectPendingGeneration, now: number): SettledAssistantMessage {
	const { configuration } = generation.context;
	return {
		role: "assistant",
		content: [],
		timestamp: now,
		api: "unknown",
		provider: configuration.model.provider,
		model: configuration.model.modelId,
		stopReason: "error",
		errorMessage: `Generation attempt ${generation.attempt} was interrupted before settlement`,
		usage: zeroUsage(),
	};
}

/** In-band error for a dispatched generation effect whose process failed after intent was durable. */
export function syntheticFailedMessage(
	generation: EffectPendingGeneration,
	reason: string,
	now: number,
): SettledAssistantMessage {
	const message = syntheticInterruptedMessage(generation, now);
	return { ...message, errorMessage: `Generation effect failed: ${reason}` };
}

export function applyPatch(
	base: AgentHarnessStreamOptions,
	patch: AgentHarnessStreamOptionsPatch | undefined,
): AgentHarnessStreamOptions {
	if (patch === undefined) return structuredClone(base);
	const next: AgentHarnessStreamOptions = structuredClone(base);
	for (const key of [
		"deferred",
		"transport",
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"cacheRetention",
	] as const) {
		if (!Object.hasOwn(patch, key)) continue;
		const value = patch[key];
		if (value === undefined) delete next[key];
		else Object.assign(next, { [key]: structuredClone(value) });
	}
	if (Object.hasOwn(patch, "headers")) {
		if (patch.headers === undefined) delete next.headers;
		else {
			const headers = { ...(next.headers ?? {}) };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			next.headers = headers;
		}
	}
	if (Object.hasOwn(patch, "metadata")) {
		if (patch.metadata === undefined) delete next.metadata;
		else {
			const metadata = { ...(next.metadata ?? {}) };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			next.metadata = metadata;
		}
	}
	assertJsonValue(next, "streamOptions");
	return next;
}

function messageEntry(loaded: ReadonlyMap<string, Entry | Register>, id: string): AssistantMessage | undefined {
	const value = loaded.get(id);
	if (value === undefined || !("id" in value) || value.type !== "message" || value.message.role !== "assistant") {
		return undefined;
	}
	return structuredClone(value.message);
}

function requireAssistantMessage(loaded: ReadonlyMap<string, Entry | Register>, id: string): AssistantMessage {
	const message = messageEntry(loaded, id);
	if (message === undefined) {
		throw new SessionError("corruption", `Entry ${id} is not an assistant message`);
	}
	return message;
}

/** Pure R3 planner: exhausts run generation states into the six interpreter actions. */
export function nextAction(current: CurrentOperation, inputs: PlannerInputs): Action {
	const state = current.state;
	switch (state.kind) {
		case "run":
			return runAction(current, state, inputs);
		case "compaction":
		case "navigation":
			throw new HarnessNotImplementedError(`nextAction for ${state.kind} operations`);
	}
}

function runAction(current: CurrentOperation, state: RunState, inputs: PlannerInputs): Action {
	switch (state.phase.kind) {
		case "checkpoint":
			return checkpointAction(current, state, state.phase.triggerEntryId, state.phase.continuation, inputs);
		case "assistant":
			return assistantAction(current, state, state.phase.generation, inputs);
		case "tools":
			return toolPhaseAction(current, state.phase.batch, inputs);
		case "compaction":
			throw new HarnessNotImplementedError("run compaction");
		case "deferred":
			return deferredAction(current, state.phase.deferred, inputs);
		case "failure_drain":
			return drainAction(current, state.phase, inputs);
	}
}

function checkpointAction(
	current: CurrentOperation,
	state: RunState,
	triggerEntryId: string,
	continuation: Extract<RunPhase, { kind: "checkpoint" }>["continuation"],
	inputs: PlannerInputs,
): Action {
	const phase = state.phase as Extract<RunPhase, { kind: "checkpoint" }>;
	if (phase.skipInboxOnce !== true) {
		const drain = planCheckpointDrain(state, continuation, inputs);
		if (drain !== undefined) return { kind: "drain", plan: drain, telemetryContext: inputs.telemetryContext };
	}
	switch (continuation.kind) {
		case "need_assistant": {
			const context: GenerationContext = {
				stepId: inputs.nextId(),
				triggerEntryId,
				configuration: structuredClone(current.configuration),
				streamOptions: structuredClone(inputs.runtime.streamOptions),
				retryPolicy: structuredClone(inputs.runtime.retryPolicy),
				overflowRecoveryUsed: continuation.overflowRecoveryUsed,
			};
			const next: RunState = {
				...structuredClone(state),
				phase: {
					kind: "assistant",
					generation: { status: "ready", context, nextAttempt: 1 },
				},
			};
			return {
				kind: "transition",
				next,
				telemetryContext: inputs.telemetryContext,
				expectedConfigurationSeq: current.configurationSeq,
				expectedSettingsRevision: inputs.runtime.settingsRevision,
			};
		}
		case "may_finish": {
			// The before_run_end hook only runs at a normal, fully drained
			// finish boundary. The interpreter supplies the process-local flag
			// so the planner stays pure and the hook is never re-dispatched
			// within one drive.
			if (inboxEmpty(state.inbox) && inputs.runBeforeRunEndHook === true) {
				return {
					kind: "dispatch",
					effect: {
						kind: "hook",
						key: `${current.operation.operationId}:before_run_end`,
						name: "before_run_end",
						event: {},
						telemetryContext: inputs.telemetryContext,
						operationId: current.operation.operationId,
					},
				};
			}
			const result: RunOutcome = continuation.includeFinalAssistant
				? {
						kind: "completed",
						leafId: requireLeafId(current),
						finalEntryId: triggerEntryId,
						finalMessage: requireAssistantMessage(inputs.loaded, triggerEntryId),
					}
				: { kind: "completed", leafId: requireLeafId(current) };
			return { kind: "finish", result };
		}
	}
}

/**
 * R5 checkpoint drain: all deferred writes, then steer per the captured
 * steeringMode, then follow-up per the captured followUpMode at may_finish
 * only. Projected input switches to a fresh need_assistant boundary with
 * skipInboxOnce; unprojected custom writes keep the current continuation.
 */
function planCheckpointDrain(
	state: RunState,
	continuation: Continuation,
	inputs: PlannerInputs,
): InboxDrainPlan | undefined {
	const selection = selectInboxDrain(
		state.inbox,
		state.settings,
		continuation.kind === "may_finish",
		inputs.loaded,
		inputs.projectedCustomTypes,
	);
	if (selection === undefined) return undefined;
	return buildInboxDrainPlan(state, selection);
}

function assistantAction(
	current: CurrentOperation,
	state: RunState,
	generation: Generation,
	inputs: PlannerInputs,
): Action {
	switch (generation.status) {
		case "ready": {
			if (inputs.model === undefined) {
				throw new Error("Planner reached assistant ready without resolved model identity");
			}
			const attempt = generation.nextAttempt;
			const responseEntryId = inputs.nextId();
			const usageId = inputs.nextId();
			const pending: EffectPendingGeneration = {
				status: "effect_pending",
				context: structuredClone(generation.context),
				attempt,
				responseEntryId,
				usageId,
				intendedOutputLimit: inputs.model.maxTokens,
				contextWindow: inputs.model.contextWindow,
			};
			const intent: RunState = {
				...structuredClone(state),
				phase: { kind: "assistant", generation: structuredClone(pending) },
			};
			const plan: Extract<EffectPlan, { kind: "assistant" }> = {
				kind: "assistant",
				key: assistantEffectKey(current.operation.operationId, generation.context.stepId, attempt),
				generation: structuredClone(pending),
				streamOptions: structuredClone(generation.context.streamOptions),
				telemetryContext: inputs.telemetryContext,
				operationId: current.operation.operationId,
			};
			return { kind: "dispatch", intent, effect: plan };
		}
		case "effect_pending": {
			const key = assistantEffectKey(current.operation.operationId, generation.context.stepId, generation.attempt);
			if (inputs.running.has(key)) return { kind: "await_effect", key };
			// Unknown-effect recovery: the original attempt is never replayed and
			// its reserved ids are never materialized.
			if (generation.attempt < generation.context.retryPolicy.maxAttempts) {
				const next: RunState = {
					...structuredClone(state),
					phase: {
						kind: "assistant",
						generation: {
							status: "ready",
							context: structuredClone(generation.context),
							nextAttempt: generation.attempt + 1,
						},
					},
				};
				return { kind: "transition", next, telemetryContext: inputs.telemetryContext };
			}
			const plan: Extract<EffectPlan, { kind: "assistant" }> = {
				kind: "assistant",
				key,
				generation: structuredClone(generation),
				streamOptions: structuredClone(generation.context.streamOptions),
				telemetryContext: inputs.telemetryContext,
				operationId: current.operation.operationId,
			};
			return {
				kind: "settle",
				plan,
				output: { kind: "assistant", key, message: syntheticInterruptedMessage(generation, inputs.now) },
				telemetryContext: inputs.telemetryContext,
			};
		}
		case "retry_wait": {
			if (inputs.now < generation.notBefore) {
				return { kind: "wait", until: generation.notBefore, telemetryContext: inputs.telemetryContext };
			}
			const next: RunState = {
				...structuredClone(state),
				phase: {
					kind: "assistant",
					generation: {
						status: "ready",
						context: structuredClone(generation.context),
						nextAttempt: generation.nextAttempt,
					},
				},
			};
			return { kind: "transition", next, telemetryContext: inputs.telemetryContext };
		}
	}
}

function deferredAction(
	current: CurrentOperation,
	deferred: Extract<RunPhase, { kind: "deferred" }>["deferred"],
	inputs: PlannerInputs,
): Action {
	if (deferred.status !== "suspended") throw new HarnessNotImplementedError("deferred polling");
	const message = requireAssistantMessage(inputs.loaded, deferred.sourceEntryId);
	if (message.stopReason !== "deferred" || message.deferred === undefined) {
		throw new SessionError("corruption", `Deferred source entry ${deferred.sourceEntryId} has no deferred handle`);
	}
	const result: RunOutcome = {
		kind: "suspended",
		reason: "deferred",
		leafId: requireLeafId(current),
		finalEntryId: deferred.sourceEntryId,
		deferred: structuredClone(message.deferred),
		startedAt: current.operation.startedAt,
	};
	return { kind: "suspend", result };
}

function drainAction(
	current: CurrentOperation,
	phase: Extract<RunPhase, { kind: "failure_drain" }>,
	inputs: PlannerInputs,
): Action {
	if (phase.provenance.kind !== "response") throw new HarnessNotImplementedError("structural failure drain");
	const state = current.state as RunState;
	const drain = planFailureDrain(state, inputs);
	if (drain !== undefined) return { kind: "drain", plan: drain, telemetryContext: inputs.telemetryContext };
	const message = requireAssistantMessage(inputs.loaded, phase.provenance.entryId);
	const result: RunOutcome = {
		kind: "failed",
		leafId: requireLeafId(current),
		error: structuredClone(phase.error),
		finalEntryId: phase.provenance.entryId,
		finalMessage: message,
	};
	return { kind: "finish", result };
}

/**
 * R5 failure boundary reuse of the inbox planner: writes, then steer, then
 * follow-up. Projecting input clears the failure into a fresh need_assistant
 * boundary; unprojected custom writes keep the original failure. The
 * before_run_end hook never runs at a failure boundary.
 */
function planFailureDrain(state: RunState, inputs: PlannerInputs): InboxDrainPlan | undefined {
	const selection: InboxSelection | undefined = selectInboxDrain(
		state.inbox,
		state.settings,
		true,
		inputs.loaded,
		inputs.projectedCustomTypes,
	);
	if (selection === undefined) return undefined;
	return buildInboxDrainPlan(state, selection);
}
