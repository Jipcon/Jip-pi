import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { JsonValue } from "./base.ts";
import type { RunState, ToolBatch } from "./operation.ts";
import { SessionError } from "./storage.ts";
import type { Action, CurrentOperation, EffectPlan, PlannerInputs, RunOutcome, SettlementOutput } from "./surface.ts";

export function requireLeafId(current: CurrentOperation): string {
	if (current.leafId === null) {
		throw new SessionError(
			"corruption",
			`Operation ${current.operation.operationId} has no leaf for a terminal outcome`,
		);
	}
	return current.leafId;
}

export function toolEffectKey(operationId: string, turnId: string, sourceIndex: number): string {
	return `${operationId}:${turnId}:tool:${sourceIndex}`;
}

/** Register key for the effective arguments of one standard-Run tool call. */
export function toolArgsKey(operationId: string, turnId: string, sourceIndex: number): string {
	return `${operationId}:${turnId}:${sourceIndex}`;
}

export function toolEffectPlan(
	current: CurrentOperation,
	batch: ToolBatch,
	sourceIndex: number,
	telemetryContext: EffectPlan["telemetryContext"],
	recovery = false,
): Extract<EffectPlan, { kind: "tool" }> {
	const args =
		batch.argumentAuthority.kind === "adaptive_tool_batch_entry"
			? ({ kind: "batch_entry", entryId: batch.argumentAuthority.entryId } as const)
			: ({ kind: "register", key: toolArgsKey(current.operation.operationId, batch.turnId, sourceIndex) } as const);
	return {
		kind: "tool",
		key: toolEffectKey(current.operation.operationId, batch.turnId, sourceIndex),
		assistantEntryId: batch.assistantEntryId,
		turnId: batch.turnId,
		sourceIndex,
		args,
		...(recovery ? { recovery: true as const } : {}),
		telemetryContext,
		operationId: current.operation.operationId,
	};
}

export function truncatedToolResultText(toolName: string): string {
	return `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
}

export function interruptedToolResultText(toolName: string): string {
	return `Tool call "${toolName}" was interrupted before settlement and cannot be replayed safely.`;
}

export function abortedToolResultText(toolName: string): string {
	return `Tool call "${toolName}" was not executed: the Run was aborted.`;
}

export function syntheticToolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	now: number,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: now,
	};
}

export function syntheticToolResult(
	plan: Extract<EffectPlan, { kind: "tool" }>,
	toolCallId: string,
	toolName: string,
	text: string,
	now: number,
): Extract<SettlementOutput, { kind: "tool" }> {
	return {
		kind: "tool",
		key: plan.key,
		result: {
			content: syntheticToolResultMessage(toolCallId, toolName, text, now).content,
			details: {},
		},
		isError: true,
		terminate: false,
	};
}

export function assistantToolCall(
	loaded: PlannerInputs["loaded"],
	assistantEntryId: string,
	sourceIndex: number,
): { toolCallId: string; toolName: string } {
	const value = loaded.get(assistantEntryId);
	if (value === undefined || !("id" in value) || value.type !== "message" || value.message.role !== "assistant") {
		throw new SessionError("corruption", `Assistant entry ${assistantEntryId} is not a message`);
	}
	const call = value.message.content.filter((part) => part.type === "toolCall")[sourceIndex];
	if (call === undefined || call.type !== "toolCall") {
		throw new SessionError("corruption", `Tool call ${sourceIndex} is missing from ${assistantEntryId}`);
	}
	return { toolCallId: call.id, toolName: call.name };
}

interface DurableToolDecision {
	kind: "allow" | "argument_guard" | "block";
	sourceIndex: number;
	toolCallId: string;
	toolName: string;
	effectiveArgs?: Record<string, JsonValue>;
	replay?: "safe" | "never";
	reason?: string;
}

/** Durable decisions of a committed `adaptive.tool_batch` entry; opaque payload parsed structurally. */
export function durableBatchDecisions(loaded: PlannerInputs["loaded"], entryId: string): DurableToolDecision[] {
	const value = loaded.get(entryId);
	if (value === undefined || !("id" in value) || value.type !== "custom") {
		throw new SessionError("corruption", `Tool batch entry ${entryId} is not a custom entry`);
	}
	const data = value.data as { decisions?: unknown } | undefined;
	if (data === undefined || !Array.isArray(data.decisions)) {
		throw new SessionError("corruption", `Tool batch entry ${entryId} has no decisions`);
	}
	const decisions: DurableToolDecision[] = [];
	for (let index = 0; index < data.decisions.length; index++) {
		const candidate = data.decisions[index] as Record<string, unknown> | null;
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			(candidate.kind !== "allow" && candidate.kind !== "argument_guard" && candidate.kind !== "block") ||
			typeof candidate.sourceIndex !== "number" ||
			typeof candidate.toolCallId !== "string" ||
			typeof candidate.toolName !== "string"
		) {
			throw new SessionError("corruption", `Tool batch entry ${entryId} decision ${index} is invalid`);
		}
		decisions.push({
			kind: candidate.kind,
			sourceIndex: candidate.sourceIndex,
			toolCallId: candidate.toolCallId,
			toolName: candidate.toolName,
			...(candidate.effectiveArgs !== undefined
				? { effectiveArgs: candidate.effectiveArgs as Record<string, JsonValue> }
				: {}),
			...(candidate.replay !== undefined ? { replay: candidate.replay as "safe" | "never" } : {}),
			...(candidate.reason !== undefined ? { reason: String(candidate.reason) } : {}),
		});
	}
	return decisions;
}

/**
 * Pure planner for the durable tools phase. Produces batch-finish transitions,
 * synthetic settlements (truncated/blocked), preparation intents, awaited
 * effects, and unknown-effect recovery — never a direct effect.
 */
export function toolPhaseAction(current: CurrentOperation, batch: ToolBatch, inputs: PlannerInputs): Action {
	const completed = batch.calls.filter((call) => call.status === "completed");
	if (batch.calls.length === 0 || completed.length === batch.calls.length) {
		if (batch.calls.length > 0 && batch.calls.every((call) => call.status === "completed" && call.terminate)) {
			const result: RunOutcome = {
				kind: "completed",
				leafId: requireLeafId(current),
				runCompletion: "terminated_tools",
			};
			return { kind: "finish", result };
		}
		const last = batch.calls.at(-1);
		const next: RunState = {
			...structuredClone(current.state as RunState),
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: last === undefined ? batch.assistantEntryId : last.resultEntryId,
			},
		};
		return { kind: "transition", next, telemetryContext: inputs.telemetryContext };
	}

	const pendingIndex = batch.calls.findIndex((call) => call.status !== "completed");
	const call = batch.calls[pendingIndex]!;
	if (call.status === "planned") {
		if (call.truncated === true) {
			const plan = toolEffectPlan(current, batch, call.sourceIndex, inputs.telemetryContext);
			const { toolCallId, toolName } = assistantToolCall(inputs.loaded, batch.assistantEntryId, call.sourceIndex);
			return {
				kind: "settle",
				plan,
				output: syntheticToolResult(plan, toolCallId, toolName, truncatedToolResultText(toolName), inputs.now),
				telemetryContext: inputs.telemetryContext,
			};
		}
		switch (batch.argumentAuthority.kind) {
			case "standard_tool_args_registers":
				return { kind: "prepare_tools", telemetryContext: inputs.telemetryContext };
			case "adaptive_pending":
				return { kind: "clear_tools", telemetryContext: inputs.telemetryContext };
			case "adaptive_tool_batch_entry": {
				const plan = toolEffectPlan(current, batch, call.sourceIndex, inputs.telemetryContext);
				const decisions = durableBatchDecisions(inputs.loaded, batch.argumentAuthority.entryId);
				const decision = decisions[call.sourceIndex];
				if (decision === undefined || decision.kind !== "block") {
					throw new SessionError("corruption", `Tool call ${call.sourceIndex} has no durable block decision`);
				}
				return {
					kind: "settle",
					plan,
					output: syntheticToolResult(
						plan,
						decision.toolCallId,
						decision.toolName,
						decision.reason ?? "Tool execution was blocked",
						inputs.now,
					),
					telemetryContext: inputs.telemetryContext,
				};
			}
		}
	}

	const plan = toolEffectPlan(current, batch, call.sourceIndex, inputs.telemetryContext, true);
	if (inputs.running.has(plan.key)) return { kind: "await_effect", key: plan.key };
	const { toolCallId, toolName } = assistantToolCall(inputs.loaded, batch.assistantEntryId, call.sourceIndex);
	return {
		kind: "recover_tool",
		plan,
		synthetic: syntheticToolResult(plan, toolCallId, toolName, interruptedToolResultText(toolName), inputs.now),
		telemetryContext: inputs.telemetryContext,
	};
}
