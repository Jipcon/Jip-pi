import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { Entry } from "./base.ts";
import type { OperationState } from "./operation.ts";
import { actionInfo, type ManualEffectGate } from "./runtime.ts";
import type {
	CurrentOperation,
	EffectOutput,
	EffectPlan,
	Effects,
	OperationResult,
	SettlementOutput,
	SettlementResult,
	SummaryRequestOutput,
} from "./surface.ts";

function planDetails(plan: EffectPlan): { key: string; kind: EffectPlan["kind"] } {
	return { key: plan.key, kind: plan.kind };
}

/**
 * Replacement result for a parked external effect whose operation was aborted
 * before the effect was released: it must never start, so it resolves as
 * `not_started` (assistant/tool/deferred/cancel_deferred) or as a skipped hook
 * invocation (the settlement then observes the stale control and replans).
 */
function cancelledEffectOutput(plan: EffectPlan): EffectOutput {
	if (plan.kind === "hook") return { kind: "hook", key: plan.key, result: undefined };
	return { kind: "not_started", key: plan.key };
}

/** Gates the complete Effects boundary without changing the underlying implementation. */
export class GatedEffects implements Effects {
	private readonly inner: Effects;
	private readonly gate: ManualEffectGate;

	constructor(inner: Effects, gate: ManualEffectGate) {
		this.inner = inner;
		this.gate = gate;
	}

	commitTransition(
		current: CurrentOperation,
		next: OperationState,
		telemetry: TelemetryContext,
		expectedConfigurationSeq?: number,
		expectedSettingsRevision?: number,
	): Promise<CurrentOperation | undefined> {
		return this.gate.run(
			actionInfo("commit_transition", `Commit ${next.kind} transition`),
			() =>
				this.inner.commitTransition(current, next, telemetry, expectedConfigurationSeq, expectedSettingsRevision),
			{ operationId: current.operation.operationId },
		);
	}

	commitEffectSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
		telemetry: TelemetryContext,
	): Promise<SettlementResult | undefined> {
		return this.gate.run(
			actionInfo("commit_effect_settlement", `Settle ${plan.kind} effect`, planDetails(plan)),
			() => this.inner.commitEffectSettlement(current, plan, output, telemetry),
			{ operationId: current.operation.operationId },
		);
	}

	commitToolIntent(
		current: CurrentOperation,
		batch: Parameters<Effects["commitToolIntent"]>[1],
		sourceIndex: number,
		args: Parameters<Effects["commitToolIntent"]>[3],
		replay: Parameters<Effects["commitToolIntent"]>[4],
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; dispatch: EffectPlan } | undefined> {
		return this.gate.run(
			actionInfo("commit_tool_intent", `Persist tool intent for call ${sourceIndex}`, {
				turnId: batch.turnId,
				sourceIndex,
			}),
			() => this.inner.commitToolIntent(current, batch, sourceIndex, args, replay, telemetry),
			{ operationId: current.operation.operationId },
		);
	}

	commitAdaptiveBatchIntent(
		current: CurrentOperation,
		batch: Parameters<Effects["commitAdaptiveBatchIntent"]>[1],
		entryData: Parameters<Effects["commitAdaptiveBatchIntent"]>[2],
		decisions: Parameters<Effects["commitAdaptiveBatchIntent"]>[3],
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; dispatches: EffectPlan[]; entry: Entry } | undefined> {
		return this.gate.run(
			actionInfo("commit_adaptive_batch", `Persist adaptive tool batch ${batch.turnId}`, {
				turnId: batch.turnId,
			}),
			() => this.inner.commitAdaptiveBatchIntent(current, batch, entryData, decisions, telemetry),
			{ operationId: current.operation.operationId },
		);
	}

	commitInboxDrain(
		current: CurrentOperation,
		plan: Parameters<Effects["commitInboxDrain"]>[1],
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; entries: Entry[] } | undefined> {
		return this.gate.run(
			actionInfo("commit_inbox_drain", `Apply ${plan.entries.length} deferred entries`, {
				entries: plan.entries.length,
			}),
			() => this.inner.commitInboxDrain(current, plan, telemetry),
			{ operationId: current.operation.operationId },
		);
	}

	commitTerminal(current: CurrentOperation, result: OperationResult): Promise<CurrentOperation | undefined> {
		return this.gate.run(
			actionInfo("commit_terminal", `Commit ${result.kind} terminal outcome`),
			() => this.inner.commitTerminal(current, result),
			{ operationId: current.operation.operationId },
		);
	}

	finalizeTool(
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<EffectOutput, { kind: "tool_raw" }>,
	): Promise<Extract<SettlementOutput, { kind: "tool" }>> {
		return this.gate.run(actionInfo("finalize_tool", "Finalize tool result", planDetails(plan)), () =>
			this.inner.finalizeTool(plan, output),
		);
	}

	runSummaryRequest(plan: Parameters<Effects["runSummaryRequest"]>[0]): Promise<SummaryRequestOutput> {
		return this.gate.run(
			actionInfo("run_summary_request", `Run summary request ${plan.requestIndex}`, {
				taskId: plan.taskId,
				attempt: plan.attempt,
				requestIndex: plan.requestIndex,
			}),
			() => this.inner.runSummaryRequest(plan),
		);
	}

	settleSummaryRequest(
		current: CurrentOperation,
		plan: Parameters<Effects["settleSummaryRequest"]>[1],
		response: Parameters<Effects["settleSummaryRequest"]>[2],
		telemetry: TelemetryContext,
	): Promise<CurrentOperation> {
		return this.gate.run(
			actionInfo("settle_summary_request", `Settle summary request ${plan.requestIndex}`, {
				taskId: plan.taskId,
				attempt: plan.attempt,
				requestIndex: plan.requestIndex,
			}),
			() => this.inner.settleSummaryRequest(current, plan, response, telemetry),
			{ operationId: current.operation.operationId },
		);
	}

	run(plan: EffectPlan): Promise<EffectOutput> {
		return this.gate.run(
			actionInfo(plan.kind, `Run ${plan.kind} effect`, planDetails(plan)),
			() => this.inner.run(plan),
			{ operationId: plan.operationId, onCancel: () => cancelledEffectOutput(plan) },
		);
	}

	sleep(delayMs: number, telemetry: TelemetryContext, operationId: string): Promise<void> {
		return this.gate.run(
			actionInfo("sleep", `Sleep ${delayMs}ms`, { delayMs }),
			() => this.inner.sleep(delayMs, telemetry, operationId),
			{ operationId, onCancel: () => undefined },
		);
	}

	sleepUntil(until: number, telemetry: TelemetryContext, operationId: string): Promise<void> {
		return this.gate.run(
			actionInfo("sleep", `Sleep until ${until}`, { until }),
			() => this.inner.sleepUntil(until, telemetry, operationId),
			{ operationId, onCancel: () => undefined },
		);
	}
}
