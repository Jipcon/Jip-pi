import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantEffectKey, syntheticAbortedMessage } from "./generation.ts";
import {
	buildInboxDrainPlan,
	customWriteProjects,
	type InboxSelection,
	pendingMessagePayload,
	requirePendingEntry,
} from "./inbox.ts";
import type { Deferred, RunState, ToolBatch } from "./operation.ts";
import type { Action, CurrentOperation, EffectPlan, InboxDrainPlan, PlannerInputs, RunOutcome } from "./surface.ts";
import {
	abortedToolResultText,
	assistantToolCall,
	interruptedToolResultText,
	requireLeafId,
	syntheticToolResult,
	toolEffectPlan,
} from "./tools.ts";

/**
 * Pure R6 cancellation-first planner. Runs before the identity gate, retry,
 * and the ordinary phase planners: once the durable control is
 * `cancel_requested`, no new provider request, tool replay, retry, decision
 * hook, before_run_end, or deferred poll may be planned. Only already-durable
 * effects are awaited, accepted writes are drained, at most one best-effort
 * deferred cancellation is dispatched, and the operation is finished aborted.
 * No I/O and no process-local implicit state beyond the injected inputs.
 */

function abortedOutcome(current: CurrentOperation, inputs: PlannerInputs): RunOutcome {
	const base: RunOutcome = { kind: "aborted", leafId: requireLeafId(current) };
	const state = current.state;
	if (state.kind !== "run" || state.latestAssistantEntryId === null) return base;
	// The reserved/real latest assistant entry is reused verbatim; no
	// synthetic assistant entry is ever fabricated for an abort.
	const value = inputs.loaded.get(state.latestAssistantEntryId);
	if (value === undefined || !("id" in value) || value.type !== "message" || value.message.role !== "assistant") {
		return base;
	}
	return { ...base, finalEntryId: value.id, finalMessage: structuredClone(value.message) };
}

/** Writes-only drain selection: steer and follow-up are never consumed again. */
function cancellationDrainPlan(state: RunState, inputs: PlannerInputs): InboxDrainPlan | undefined {
	if (state.inbox.writes.length === 0) return undefined;
	const entries = state.inbox.writes.map((id) => {
		const pending = requirePendingEntry(inputs.loaded, id);
		if (pending.type === "message") {
			return { id, type: "message" as const, message: pendingMessagePayload(inputs.loaded, id) };
		}
		return {
			id,
			type: "custom" as const,
			customType: pending.customType,
			...(pending.payload === undefined ? {} : { data: structuredClone(pending.payload) }),
		};
	});
	const selection: InboxSelection = {
		consumedWrites: [...state.inbox.writes],
		consumedSteer: [],
		consumedFollowUp: [],
		entries,
		projected: entries.some(
			(entry) =>
				entry.type === "message" ||
				(entry.customType !== undefined && customWriteProjects(entry.customType, inputs.projectedCustomTypes)),
		),
	};
	return buildInboxDrainPlan(state, selection);
}

function checkpointCancellation(current: CurrentOperation, state: RunState, inputs: PlannerInputs): Action {
	const drain = cancellationDrainPlan(state, inputs);
	if (drain !== undefined) return { kind: "drain", plan: drain, telemetryContext: inputs.telemetryContext };
	return { kind: "finish", result: abortedOutcome(current, inputs) };
}

function assistantCancellation(
	current: CurrentOperation,
	generation: Extract<RunState["phase"], { kind: "assistant" }>["generation"],
	inputs: PlannerInputs,
): Action {
	switch (generation.status) {
		case "ready":
		case "retry_wait":
			return { kind: "finish", result: abortedOutcome(current, inputs) };
		case "effect_pending": {
			const key = assistantEffectKey(current.operation.operationId, generation.context.stepId, generation.attempt);
			if (inputs.running.has(key)) return { kind: "await_effect", key };
			// Not started or restored unknown: settle the reserved ids with a
			// synthetic aborted response, zero usage, never a replay.
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
				output: { kind: "assistant", key, message: syntheticAbortedMessage(generation, inputs.now) },
				telemetryContext: inputs.telemetryContext,
			};
		}
	}
}

function toolsCancellation(current: CurrentOperation, batch: ToolBatch, inputs: PlannerInputs): Action {
	const state = current.state as RunState;
	const pendingIndex = batch.calls.findIndex((call) => call.status !== "completed");
	if (pendingIndex === -1) {
		const last = batch.calls.at(-1);
		const next: RunState = {
			...structuredClone(state),
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: last === undefined ? batch.assistantEntryId : last.resultEntryId,
			},
		};
		return { kind: "transition", next, telemetryContext: inputs.telemetryContext };
	}
	const call = batch.calls[pendingIndex]!;
	const plan = toolEffectPlan(current, batch, call.sourceIndex, inputs.telemetryContext);
	const { toolCallId, toolName } = assistantToolCall(inputs.loaded, batch.assistantEntryId, call.sourceIndex);
	if (call.status === "planned") {
		// No prepare, clearance, before_tool, or tool effect: an aborted
		// synthetic settles the reserved result id with zero usage.
		return {
			kind: "settle",
			plan,
			output: syntheticToolResult(plan, toolCallId, toolName, abortedToolResultText(toolName), inputs.now),
			telemetryContext: inputs.telemetryContext,
		};
	}
	if (inputs.running.has(plan.key)) return { kind: "await_effect", key: plan.key };
	// Restored pending without a process-local running key is never replayed.
	return {
		kind: "settle",
		plan,
		output: syntheticToolResult(plan, toolCallId, toolName, interruptedToolResultText(toolName), inputs.now),
		telemetryContext: inputs.telemetryContext,
	};
}

function deferredHandle(loaded: PlannerInputs["loaded"], sourceEntryId: string): AssistantMessage["deferred"] {
	const value = loaded.get(sourceEntryId);
	if (value === undefined || !("id" in value) || value.type !== "message" || value.message.role !== "assistant") {
		return undefined;
	}
	const message = value.message;
	return message.stopReason === "deferred" ? message.deferred : undefined;
}

function deferredCancellation(current: CurrentOperation, deferred: Deferred, inputs: PlannerInputs): Action {
	const runningDeferred = [...inputs.running.values()].find((plan) => plan.kind === "deferred");
	if (runningDeferred !== undefined) return { kind: "await_effect", key: runningDeferred.key };
	const key = `${current.operation.operationId}:${deferred.sourceEntryId}`;
	const handle = deferredHandle(inputs.loaded, deferred.sourceEntryId);
	if (handle !== undefined && !inputs.deferredCancellations.has(key)) {
		const plan: Extract<EffectPlan, { kind: "cancel_deferred" }> = {
			kind: "cancel_deferred",
			key,
			sourceEntryId: deferred.sourceEntryId,
			handle: structuredClone(handle),
			telemetryContext: inputs.telemetryContext,
			operationId: current.operation.operationId,
		};
		return { kind: "dispatch", effect: plan };
	}
	// Already attempted in this process, or no captured provider identity:
	// skip the call and finish aborted.
	return { kind: "finish", result: abortedOutcome(current, inputs) };
}

function runCancellation(current: CurrentOperation, state: RunState, inputs: PlannerInputs): Action {
	switch (state.phase.kind) {
		case "checkpoint":
			return checkpointCancellation(current, state, inputs);
		case "assistant":
			return assistantCancellation(current, state.phase.generation, inputs);
		case "tools":
			return toolsCancellation(current, state.phase.batch, inputs);
		case "compaction":
			// R8/R10 own normal structural execution; R6 only aborts the
			// representable not-started scaffold without summary/provider/hook.
			return { kind: "finish", result: abortedOutcome(current, inputs) };
		case "deferred":
			return deferredCancellation(current, state.phase.deferred, inputs);
		case "failure_drain":
			return checkpointCancellation(current, state, inputs);
	}
}

export function cancellationAction(current: CurrentOperation, inputs: PlannerInputs): Action | undefined {
	const state = current.state;
	if (state.control.status !== "cancel_requested") return undefined;
	switch (state.kind) {
		case "run":
			return runCancellation(current, state, inputs);
		case "compaction":
			return { kind: "finish", result: { kind: "aborted", leafId: requireLeafId(current) } };
		case "navigation":
			return { kind: "finish", result: { kind: "aborted", leafId: current.leafId } };
	}
}
