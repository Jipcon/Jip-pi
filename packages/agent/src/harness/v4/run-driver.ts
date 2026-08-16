import type { Models, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { AgentToolResult } from "../../types.ts";
import type { Entry, JsonValue, LaneConfiguration } from "./base.ts";
import { cancellationAction } from "./cancellation.ts";
import { HarnessClosedError, HarnessFaultError } from "./errors.ts";
import type { HarnessEventBus } from "./events.ts";
import { applyPatch, nextAction, retryDelayMs, syntheticAbortedMessage, syntheticFailedMessage } from "./generation.ts";
import type { HarnessHookRegistry } from "./hooks.ts";
import type { OperationState, RunPhase } from "./operation.ts";
import { restoreLane } from "./restore.ts";
import { actionInfo, type RuntimeCoordinator } from "./runtime.ts";
import { type Register, type Session, SessionError } from "./storage.ts";
import type {
	AdaptiveToolClearanceDecision,
	CurrentOperation,
	EffectKey,
	EffectOutput,
	EffectPlan,
	Effects,
	PlannerInputs,
	RunOutcome,
	SettlementOutput,
} from "./surface.ts";
import { assistantToolCall, interruptedToolResultText, syntheticToolResult, toolEffectPlan } from "./tools.ts";

export interface RunDriverDependencies {
	session: Session;
	coordinator: RuntimeCoordinator;
	hooks: HarnessHookRegistry;
	events: HarnessEventBus;
	models: Models;
	effects: Effects;
	telemetry: TelemetryContext;
	getToolNames(): string[];
	onDispatch?(key: EffectKey, current: CurrentOperation): void;
	onEffectEnd?(key: EffectKey): void;
	/**
	 * Prepare one standard tool call: declaration lookup, schema validation,
	 * prepareArguments, before_tool hook (gated). Never starts an effect.
	 */
	prepareToolCall(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
	): Promise<ToolPreparation>;
	/** Whole-batch adaptive clearance (gated); fault fails closed into blocks. */
	clearAdaptiveBatch(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
	): Promise<AdaptiveClearanceComposed>;
	/** Unknown-effect recovery check: captured and current replay must both be safe. */
	canReplayTool(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
	): Promise<boolean>;
	/** Sequential when run settings demand it or any pending call declares sequential. */
	isSequentialBatch(current: CurrentOperation, batch: Extract<RunPhase, { kind: "tools" }>["batch"]): Promise<boolean>;
	/** Registered custom-entry projector types; custom pending writes project iff registered. */
	projectedCustomTypes: ReadonlySet<string>;
	/** Process-local dedupe of best-effort deferred cancellations per operation source. */
	deferredCancellations: Set<string>;
	/**
	 * Pre-dispatch verification for assistant effects, invoked before the
	 * provider intent commit. The runtime decides whether the operation is an
	 * exact continuation that still owes its first provider request; thrown
	 * errors abort the drive before any provider call, intent, or side effect.
	 */
	verifyFirstAssistantDispatch?(
		current: CurrentOperation,
		plan: Extract<EffectPlan, { kind: "assistant" }>,
	): Promise<void>;
}

export type ToolPreparation =
	| { kind: "prepared"; args: Record<string, JsonValue>; replay: "never" | "safe" }
	| { kind: "immediate"; result: AgentToolResult<unknown>; terminate: boolean };

export interface AdaptiveClearanceComposed {
	entryData: JsonValue;
	/** One decision per batch call, source-ordered; truncated and faulted calls are blocks. */
	decisions: AdaptiveToolClearanceDecision[];
}

/** Process-local stop condition; a yield is never a durable state. */
export type DriveSelector = { kind: "settled" } | { kind: "post_turn" };

export type DriveResult =
	| { kind: "outcome"; outcome: RunOutcome; external?: true }
	| { kind: "yielded"; assistantEntryId: string; leafId: string };

/**
 * Control-flow marker: an external writer removed the operation registers and
 * cleared `lane.currentOperationId` while this driver held process-local
 * work. The driver stops without writing and materializes the final outcome
 * from `lane.lastResult`.
 */
export class OperationExternallyFinalizedError extends Error {
	constructor(operationId: string) {
		super(`Operation ${operationId} was externally finalized`);
		this.name = "OperationExternallyFinalized";
	}
}

interface LiveEffect {
	plan: EffectPlan;
	promise: Promise<EffectOutput>;
}

/**
 * Process-local interpreter loop over the pure planner: transition / dispatch /
 * await_effect / settle / wait / suspend / finish plus the durable tools phase
 * (prepare_tools / clear_tools / recover_tool). `running` is the only
 * process-local live-effect authority; a durable `effect_pending` state without
 * a running key is unknown-effect recovery, never a blind replay.
 */
export class GenerationRunDriver {
	private readonly deps: RunDriverDependencies;
	private readonly running = new Map<EffectKey, LiveEffect>();
	private hydrated = new Map<string, Entry | Register>();
	private turnStarted = false;
	private retried = false;
	private turnToolResults: ToolResultMessage[] = [];
	/**
	 * Finish boundaries whose before_run_end hook already ran in this drive.
	 * Crash/reopen or a new boundary re-arms the hook; within one drive the
	 * planner must not re-dispatch it for the same may_finish boundary.
	 */
	private readonly hookBoundaries = new Set<string>();

	constructor(deps: RunDriverDependencies) {
		this.deps = deps;
	}

	async drive(
		initial: CurrentOperation,
		loaded: ReadonlyMap<string, Entry | Register>,
		selector: DriveSelector = { kind: "settled" },
	): Promise<DriveResult> {
		const current = initial;
		this.hydrated = new Map(loaded);
		this.turnToolResults = [];
		this.hookBoundaries.clear();
		try {
			return await this.driveLoop(current, selector);
		} catch (error) {
			if (error instanceof OperationExternallyFinalizedError) {
				return {
					kind: "outcome",
					outcome: await this.materializeExternalFinalization(
						current.operation.operationId,
						current.operation.lane,
					),
					external: true,
				};
			}
			throw error;
		}
	}

	private async driveLoop(initial: CurrentOperation, selector: DriveSelector): Promise<DriveResult> {
		let current = initial;
		for (;;) {
			const identitySuspension = this.identityGate(current);
			if (identitySuspension !== undefined) return { kind: "outcome", outcome: identitySuspension };
			// Queue admissions during a live effect are only observable as
			// op.state bumps; the planner needs their pending payloads, so
			// re-restore before any action that could decode them.
			if (this.missingPendingRegisters(current)) {
				current = await this.replan(current, "pending hydration");
				continue;
			}
			// R6 cancellation-first: the durable cancel marker supersedes the
			// identity gate, retry, and every ordinary phase planner.
			const action =
				cancellationAction(current, this.plannerInputs(current)) ??
				nextAction(current, this.plannerInputs(current));
			switch (action.kind) {
				case "transition": {
					const previousPhase = toolsPhase(current);
					const next = await this.deps.effects.commitTransition(
						current,
						action.next,
						action.telemetryContext,
						action.expectedConfigurationSeq,
						action.expectedSettingsRevision,
					);
					if (next === undefined) {
						current = await this.replan(current, "transition");
						break;
					}
					const retryAttempt = this.retryReadyAttempt(current.state, next.state);
					if (retryAttempt !== undefined) {
						this.retried = true;
						this.deps.events.emit({
							type: "retry_start",
							lane: current.operation.lane,
							runId: current.operation.operationId,
							step: "assistant",
							attempt: retryAttempt,
						});
					}
					current = next;
					if (previousPhase !== undefined) {
						this.emitTurnEnd(current, previousPhase.batch);
						if (selector.kind === "post_turn" && current.state.control.status !== "cancel_requested") {
							return {
								kind: "yielded",
								assistantEntryId: previousPhase.batch.assistantEntryId,
								leafId: current.leafId ?? previousPhase.batch.assistantEntryId,
							};
						}
					}
					break;
				}
				case "drain": {
					const drained = await this.deps.effects.commitInboxDrain(current, action.plan, action.telemetryContext);
					if (drained === undefined) {
						current = await this.replan(current, "inbox drain");
						break;
					}
					current = drained.current;
					for (const entry of drained.entries) this.hydrated.set(entry.id, entry);
					break;
				}
				case "dispatch": {
					const plan = action.effect;
					// Exact-continuation second gate: before the intent commits,
					// before any provider call or streaming side effect.
					if (plan.kind === "assistant" && this.deps.verifyFirstAssistantDispatch !== undefined) {
						await this.deps.verifyFirstAssistantDispatch(current, plan);
					}
					if (action.intent !== undefined) {
						// Keep the durable generation context aligned with the
						// verified plan (e.g. sampling provenance metadata) so
						// crash recovery rebuilds the identical request.
						if (
							plan.kind === "assistant" &&
							action.intent.kind === "run" &&
							action.intent.phase.kind === "assistant"
						) {
							action.intent.phase.generation.context.streamOptions = structuredClone(plan.streamOptions);
						}
						const next = await this.deps.effects.commitTransition(current, action.intent, this.deps.telemetry);
						if (next === undefined) {
							current = await this.replan(current, "dispatch intent");
							break;
						}
						current = next;
					}
					if (plan.kind === "assistant" && !this.turnStarted) {
						this.turnStarted = true;
						this.deps.events.emit({
							type: "turn_start",
							lane: current.operation.lane,
							runId: current.operation.operationId,
							turnId: plan.generation.context.stepId,
						});
					}
					if (plan.kind === "cancel_deferred") this.deps.deferredCancellations.add(plan.key);
					await this.prepareRequest(current, plan);
					this.deps.onDispatch?.(plan.key, current);
					const promise = this.deps.effects.run(plan);
					this.running.set(plan.key, { plan, promise });
					if (plan.kind === "hook") {
						// Hooks have no durable intent state: await inline so the
						// next planner pass cannot re-dispatch the same boundary.
						const awaited = await this.awaitLiveEffect(current, plan.key, selector);
						if ("yielded" in awaited) return awaited.yielded;
						current = awaited.current;
					}
					break;
				}
				case "await_effect": {
					const awaited = await this.awaitLiveEffect(current, action.key, selector);
					if ("yielded" in awaited) return awaited.yielded;
					current = awaited.current;
					break;
				}
				case "settle": {
					this.beforeSettlement(current, action.plan, action.output);
					const settled = await this.deps.effects.commitEffectSettlement(
						current,
						action.plan,
						action.output,
						action.telemetryContext,
					);
					if (settled === undefined) {
						current = await this.replan(current, "effect settlement");
						break;
					}
					if (settled.hookConsumed === true) this.recordHookBoundary(current);
					current = settled.current;
					if (settled.settledEntry !== undefined) this.hydrated.set(settled.settledEntry.id, settled.settledEntry);
					const turnEnded = this.afterSettlement(current, action.plan, action.output, settled.settledEntry);
					if (selector.kind === "post_turn" && turnEnded && this.postTurnBoundary(current)) {
						return this.yieldTurn(current);
					}
					break;
				}
				case "prepare_tools": {
					const phase = requireToolsPhase(current);
					const batch = phase.batch;
					const sequential = await this.deps.isSequentialBatch(current, batch);
					const planned = batch.calls.filter((call) => call.status === "planned" && call.truncated !== true);
					const toPrepare = sequential ? planned.slice(0, 1) : planned;
					for (const call of toPrepare) {
						const preparation = await this.deps.prepareToolCall(current, batch, call.sourceIndex);
						const plan = toolEffectPlan(current, batch, call.sourceIndex, this.deps.telemetry);
						if (preparation.kind === "immediate") {
							const output: Extract<SettlementOutput, { kind: "tool" }> = {
								kind: "tool",
								key: plan.key,
								result: preparation.result,
								isError: true,
								terminate: preparation.terminate,
							};
							this.beforeSettlement(current, plan, output);
							const settled = await this.deps.effects.commitEffectSettlement(
								current,
								plan,
								output,
								this.deps.telemetry,
							);
							if (settled === undefined) {
								current = await this.replan(current, "immediate tool settlement");
								break;
							}
							current = settled.current;
							if (settled.settledEntry !== undefined) {
								this.hydrated.set(settled.settledEntry.id, settled.settledEntry);
							}
							this.afterSettlement(current, plan, output, settled.settledEntry);
							continue;
						}
						const intent = await this.deps.effects.commitToolIntent(
							current,
							batch,
							call.sourceIndex,
							preparation.args,
							preparation.replay,
							this.deps.telemetry,
						);
						if (intent === undefined) {
							current = await this.replan(current, "tool intent");
							break;
						}
						current = intent.current;
						this.deps.onDispatch?.(intent.dispatch.key, current);
						const promise = this.deps.effects.run(intent.dispatch);
						this.running.set(intent.dispatch.key, { plan: intent.dispatch, promise });
					}
					break;
				}
				case "clear_tools": {
					const phase = requireToolsPhase(current);
					const batch = phase.batch;
					const composed = await this.deps.clearAdaptiveBatch(current, batch);
					const intent = await this.deps.effects.commitAdaptiveBatchIntent(
						current,
						batch,
						composed.entryData,
						composed.decisions,
						this.deps.telemetry,
					);
					if (intent === undefined) {
						current = await this.replan(current, "adaptive batch intent");
						break;
					}
					current = intent.current;
					if (intent.entry !== undefined) this.hydrated.set(intent.entry.id, intent.entry);
					for (const dispatch of intent.dispatches) {
						this.deps.onDispatch?.(dispatch.key, current);
						const promise = this.deps.effects.run(dispatch);
						this.running.set(dispatch.key, { plan: dispatch, promise });
					}
					break;
				}
				case "recover_tool": {
					const phase = requireToolsPhase(current);
					const batch = phase.batch;
					const plan = action.plan;
					if (plan.kind !== "tool") throw new Error("Recovery plan is not a tool effect");
					if (await this.deps.canReplayTool(current, batch, plan.sourceIndex)) {
						this.deps.onDispatch?.(plan.key, current);
						const promise = this.deps.effects.run(plan);
						this.running.set(plan.key, { plan, promise });
						break;
					}
					this.beforeSettlement(current, plan, action.synthetic, true);
					const settled = await this.deps.effects.commitEffectSettlement(
						current,
						plan,
						action.synthetic,
						action.telemetryContext,
					);
					if (settled === undefined) {
						current = await this.replan(current, "tool recovery");
						break;
					}
					current = settled.current;
					if (settled.settledEntry !== undefined) this.hydrated.set(settled.settledEntry.id, settled.settledEntry);
					this.afterSettlement(current, plan, action.synthetic, settled.settledEntry);
					break;
				}
				case "wait": {
					await this.deps.effects.sleepUntil(action.until, action.telemetryContext, current.operation.operationId);
					break;
				}
				case "suspend": {
					if (action.result.kind === "suspended" && action.result.reason === "deferred") {
						this.deps.events.emit({
							type: "run_suspend",
							lane: current.operation.lane,
							runId: current.operation.operationId,
							reason: "deferred",
							deferred: action.result.deferred,
						});
					}
					return { kind: "outcome", outcome: action.result as RunOutcome };
				}
				case "finish": {
					const previousPhase = toolsPhase(current);
					if (previousPhase !== undefined) this.emitTurnEnd(current, previousPhase.batch);
					const committed = await this.deps.effects.commitTerminal(current, action.result);
					if (committed === undefined) {
						current = await this.replan(current, "terminal commit");
						break;
					}
					return { kind: "outcome", outcome: action.result as RunOutcome };
				}
			}
		}
	}

	/**
	 * Inlined await: every continuation must stay synchronous between the
	 * effect resolution and the next gated park, or runToCompletion can
	 * observe an empty gate while the drive is between actions.
	 */
	private async awaitLiveEffect(
		current: CurrentOperation,
		key: EffectKey,
		selector: DriveSelector,
	): Promise<{ current: CurrentOperation } | { yielded: DriveResult }> {
		const live = this.running.get(key);
		if (live === undefined) throw new Error("Planner awaited an effect with no live process");
		this.running.delete(key);
		if (live.plan.kind === "cancel_deferred") {
			// The cancellation attempt has no durable output: await it (never
			// a settlement commit) and let the planner finish aborted.
			try {
				await live.promise;
			} catch (error) {
				if (
					error instanceof OperationExternallyFinalizedError ||
					error instanceof HarnessClosedError ||
					error instanceof HarnessFaultError ||
					error instanceof SessionError
				) {
					throw error;
				}
			}
			this.deps.onEffectEnd?.(key);
			return { current };
		}
		let output: SettlementOutput;
		try {
			const raw = await live.promise;
			if (raw.kind === "not_started") {
				output = this.syntheticForNotStarted(live.plan);
			} else if (raw.kind === "tool_raw" && live.plan.kind === "tool") {
				output = await this.deps.effects.finalizeTool(live.plan, raw);
			} else if (raw.kind === "tool_raw") {
				throw new Error(`Effect ${live.plan.key} produced ${raw.kind} without settlement`);
			} else {
				output = raw;
			}
		} catch (error) {
			if (
				error instanceof OperationExternallyFinalizedError ||
				error instanceof HarnessClosedError ||
				error instanceof HarnessFaultError ||
				error instanceof SessionError
			) {
				throw error;
			}
			if (live.plan.kind === "assistant") {
				// The operation signal was pulled: the live attempt died from a
				// Harness-owned cancellation, never a retryable failure.
				const abortedByOperation = this.deps.coordinator.operationSignal(live.plan.operationId).aborted;
				output = {
					kind: "assistant",
					key: live.plan.key,
					message: abortedByOperation
						? syntheticAbortedMessage(live.plan.generation, Date.now())
						: syntheticFailedMessage(
								live.plan.generation,
								error instanceof Error ? error.message : String(error),
								Date.now(),
							),
				};
			} else if (live.plan.kind === "tool") {
				output = {
					kind: "tool",
					key: live.plan.key,
					result: {
						content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
						details: {},
					},
					isError: true,
					terminate: false,
				};
			} else {
				throw error;
			}
		}
		this.deps.onEffectEnd?.(key);
		this.beforeSettlement(current, live.plan, output);
		const settled = await this.deps.effects.commitEffectSettlement(current, live.plan, output, this.deps.telemetry);
		if (settled === undefined) {
			return { current: await this.replan(current, "effect settlement") };
		}
		if (settled.hookConsumed === true) this.recordHookBoundary(current);
		const next = settled.current;
		if (settled.settledEntry !== undefined) this.hydrated.set(settled.settledEntry.id, settled.settledEntry);
		const turnEnded = this.afterSettlement(next, live.plan, output, settled.settledEntry);
		if (selector.kind === "post_turn" && turnEnded && this.postTurnBoundary(next)) {
			return { yielded: this.yieldTurn(next) };
		}
		return { current: next };
	}

	/**
	 * The durable cancel marker landed between intent and effect execution:
	 * the effect never started. Cancellation replacements mirror the pure
	 * planner: aborted response for generations, interrupted result for tools,
	 * a skipped (undefined-result) hook for hook plans.
	 */
	private syntheticForNotStarted(plan: EffectPlan): SettlementOutput {
		const now = Date.now();
		switch (plan.kind) {
			case "assistant":
				return { kind: "assistant", key: plan.key, message: syntheticAbortedMessage(plan.generation, now) };
			case "tool": {
				const { toolCallId, toolName } = assistantToolCall(this.hydrated, plan.assistantEntryId, plan.sourceIndex);
				return syntheticToolResult(plan, toolCallId, toolName, interruptedToolResultText(toolName), now);
			}
			case "hook":
				return { kind: "hook", key: plan.key, result: undefined };
			default:
				throw new Error(
					`Effect ${plan.key} of kind ${plan.kind} was never started without a cancellation settlement`,
				);
		}
	}

	/**
	 * Bounded re-restore under the lane mutation line. A stale CAS/identity
	 * observation replans; a vanished operation with a cleared
	 * `lane.currentOperationId` is external finalization and stops the driver
	 * without any write.
	 */
	private async replan(current: CurrentOperation, stage: string): Promise<CurrentOperation> {
		const lane = current.operation.lane;
		const restored = await this.deps.coordinator.mutateLane(lane, () => restoreLane(this.deps.session, lane));
		if (restored.kind === "idle") {
			const lastResult = await this.deps.session.getRegister("lane.lastResult", lane);
			if (lastResult?.value.operationId !== current.operation.operationId) {
				throw new SessionError(
					"corruption",
					`Operation ${current.operation.operationId} vanished without a matching lane.lastResult during ${stage}`,
				);
			}
			throw new OperationExternallyFinalizedError(current.operation.operationId);
		}
		this.hydrated = new Map(restored.loaded);
		return restored.current;
	}

	/**
	 * External finalization: materialize the RunOutcome from `lane.lastResult`
	 * and emit exactly one end event. No operation registers are rebuilt and
	 * nothing durable is written.
	 */
	private async materializeExternalFinalization(operationId: string, lane: string): Promise<RunOutcome> {
		const lastResult = await this.deps.session.getRegister("lane.lastResult", lane);
		if (lastResult === undefined || lastResult.value.operationId !== operationId || lastResult.value.kind !== "run") {
			throw new SessionError(
				"corruption",
				`External finalization of ${operationId} has no matching lane.lastResult`,
			);
		}
		const result = lastResult.value;
		let outcome: RunOutcome;
		switch (result.outcome) {
			case "completed":
				outcome = {
					kind: "completed",
					leafId: result.leafId ?? lane,
					...(result.runCompletion === undefined ? {} : { runCompletion: result.runCompletion }),
				};
				break;
			case "failed":
				outcome = { kind: "failed", leafId: result.leafId ?? lane, error: structuredClone(result.error) };
				break;
			case "aborted":
				outcome = { kind: "aborted", leafId: result.leafId ?? lane };
				break;
			case "declined":
				throw new SessionError("corruption", `Run ${operationId} externally finalized with a non-run outcome`);
		}
		if (result.finalAssistantEntryId !== undefined) {
			const entry = (await this.deps.session.getEntries([result.finalAssistantEntryId])).get(
				result.finalAssistantEntryId,
			);
			if (entry?.type === "message" && entry.message.role === "assistant") {
				outcome = { ...outcome, finalEntryId: entry.id, finalMessage: structuredClone(entry.message) };
			}
		}
		const eventBase = {
			type: "run_end" as const,
			lane,
			runId: operationId,
			leafId: outcome.leafId,
		};
		if (outcome.kind === "failed") {
			this.deps.events.emit({ ...eventBase, outcome: "failed" as const, error: outcome.error });
		} else {
			this.deps.events.emit({ ...eventBase, outcome: outcome.kind });
		}
		return outcome;
	}

	private missingPendingRegisters(current: CurrentOperation): boolean {
		if (current.state.kind !== "run") return false;
		const ids = [...current.state.inbox.steer, ...current.state.inbox.followUp, ...current.state.inbox.writes];
		if (current.state.control.status === "cancel_requested") {
			ids.push(...current.state.control.drainedSteer, ...current.state.control.drainedFollowUp);
		}
		return ids.some((id) => !this.hydrated.has(`pending.entry/${id}`));
	}

	private recordHookBoundary(current: CurrentOperation): void {
		if (current.state.kind !== "run") return;
		const phase = current.state.phase;
		if (phase.kind !== "checkpoint" || phase.continuation.kind !== "may_finish") return;
		this.hookBoundaries.add(
			`${current.operation.operationId}:${phase.triggerEntryId}:${phase.continuation.includeFinalAssistant}`,
		);
	}

	private hookPendingAt(current: CurrentOperation): boolean {
		if (!this.deps.hooks.has("before_run_end")) return false;
		if (current.state.kind !== "run") return false;
		const phase = current.state.phase;
		if (phase.kind !== "checkpoint" || phase.continuation.kind !== "may_finish") return false;
		return !this.hookBoundaries.has(
			`${current.operation.operationId}:${phase.triggerEntryId}:${phase.continuation.includeFinalAssistant}`,
		);
	}

	/**
	 * A post-turn drive must never start a second provider request: when the
	 * completed turn's successor boundary would drain input (or run the
	 * before_run_end hook that can extend the Run), yield first and let the
	 * next drive consume it. A cancelled operation never yields: the
	 * cancellation planner owns the successor and can only finish aborted.
	 */
	private postTurnBoundary(current: CurrentOperation): boolean {
		if (current.state.kind !== "run" || current.state.control.status === "cancel_requested") return false;
		const phase = current.state.phase;
		const inbox = current.state.inbox;
		const hasInput = inbox.steer.length > 0 || inbox.followUp.length > 0 || inbox.writes.length > 0;
		if (phase.kind === "checkpoint") {
			if (phase.skipInboxOnce === true) return false;
			if (hasInput) return true;
			return this.hookPendingAt(current);
		}
		if (phase.kind === "failure_drain") return hasInput;
		return false;
	}

	private yieldTurn(current: CurrentOperation): DriveResult {
		if (current.state.kind !== "run" || current.state.latestAssistantEntryId === null) {
			throw new SessionError("corruption", "Post-turn yield has no latest assistant entry");
		}
		return {
			kind: "yielded",
			assistantEntryId: current.state.latestAssistantEntryId,
			leafId: current.leafId ?? current.state.latestAssistantEntryId,
		};
	}

	/** Emitted before the durable settlement commit: the live completion signal precedes entry_added. */
	private beforeSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
		recovery = false,
	): void {
		if (plan.kind !== "tool") return;
		this.emitToolEnd(current, plan, output as Extract<SettlementOutput, { kind: "tool" }>, recovery);
	}

	private afterSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
		entry: Entry | undefined,
	): boolean {
		if (plan.kind !== "tool") {
			return this.emitSettlementEvents(current, plan, output);
		}
		if (entry !== undefined && entry.type === "message" && entry.message.role === "toolResult") {
			this.turnToolResults.push(entry.message);
		}
		if (entry !== undefined && entry.type === "message" && entry.message.role === "toolResult") {
			this.deps.events.emit({
				type: "message_start",
				lane: current.operation.lane,
				runId: current.operation.operationId,
				message: entry.message,
			});
			this.deps.events.emit({
				type: "message_end",
				lane: current.operation.lane,
				runId: current.operation.operationId,
				message: entry.message,
				entryId: entry.id,
			});
		}
		return false;
	}

	private emitToolEnd(
		current: CurrentOperation,
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<SettlementOutput, { kind: "tool" }>,
		recovery = false,
	): void {
		const { toolCallId, toolName } = assistantToolCall(this.hydrated, plan.assistantEntryId, plan.sourceIndex);
		this.deps.events.emit({
			type: "tool_end",
			lane: current.operation.lane,
			runId: current.operation.operationId,
			turnId: plan.turnId,
			toolCallId,
			toolName,
			result: output.result,
			isError: output.isError,
			terminate: output.terminate,
			...(recovery ? { recovery: true as const } : {}),
		});
	}

	/** The ready gate: missing captured identity suspends without burning an attempt. */
	private identityGate(current: CurrentOperation): RunOutcome | undefined {
		const state = current.state;
		if (
			state.control.status === "cancel_requested" ||
			state.kind !== "run" ||
			state.phase.kind !== "assistant" ||
			state.phase.generation.status !== "ready"
		) {
			return undefined;
		}
		const missing = missingIdentity(
			state.phase.generation.context.configuration,
			this.deps.models,
			new Set(this.deps.getToolNames()),
		);
		if (missing.tools.length === 0 && missing.models.length === 0) return undefined;
		this.deps.events.emit({
			type: "run_suspend",
			lane: current.operation.lane,
			runId: current.operation.operationId,
			reason: "missing_identities",
			missing,
		});
		return {
			kind: "suspended",
			reason: "missing_identities",
			leafId: requireLeaf(current),
			missing,
			startedAt: current.operation.startedAt,
		};
	}

	private plannerInputs(current: CurrentOperation): PlannerInputs {
		const phase = current.state.kind === "run" ? current.state.phase : undefined;
		const configuration =
			phase?.kind === "assistant" ? phase.generation.context.configuration : current.configuration;
		const model = this.deps.models.getModel(configuration.model.provider, configuration.model.modelId);
		return {
			running: new Map([...this.running].map(([key, live]) => [key, live.plan])),
			deferredPollsRemaining: 0,
			deferredCancellations: this.deps.deferredCancellations,
			loaded: this.hydrated,
			runtime: this.deps.coordinator.runtimeSnapshot(),
			now: Date.now(),
			nextId: () => this.deps.session.idGenerator.next(),
			runBeforeRunEndHook: this.hookPendingAt(current),
			projectedCustomTypes: this.deps.projectedCustomTypes,
			...(model === undefined ? {} : { model: { maxTokens: model.maxTokens, contextWindow: model.contextWindow } }),
			telemetryContext: this.deps.telemetry,
		};
	}

	private retryReadyAttempt(previous: OperationState, next: OperationState): number | undefined {
		if (previous.kind !== "run" || next.kind !== "run") return undefined;
		if (next.phase.kind !== "assistant" || next.phase.generation.status !== "ready") return undefined;
		if (next.phase.generation.nextAttempt <= 1) return undefined;
		if (previous.phase.kind !== "assistant") return undefined;
		const recovered =
			previous.phase.generation.status === "retry_wait" || previous.phase.generation.status === "effect_pending";
		return recovered ? next.phase.generation.nextAttempt : undefined;
	}

	/** Every real attempt runs before_request again, always from the captured base options. */
	private async prepareRequest(current: CurrentOperation, plan: EffectPlan): Promise<void> {
		if (plan.kind !== "assistant" || !this.deps.hooks.has("before_request")) return;
		const configuration = plan.generation.context.configuration;
		const model = this.deps.models.getModel(configuration.model.provider, configuration.model.modelId);
		if (model === undefined) return;
		const hook = await this.deps.coordinator.gate.run(
			actionInfo("hook", "Run before_request hook"),
			() =>
				this.deps.hooks.run("before_request", {
					lane: current.operation.lane,
					runId: current.operation.operationId,
					model,
					step: "assistant",
					attempt: plan.generation.attempt,
					streamOptions: structuredClone(plan.streamOptions),
				}),
			{ operationId: current.operation.operationId, onCancel: () => undefined },
		);
		try {
			plan.streamOptions = applyPatch(plan.streamOptions, hook?.streamOptions);
		} catch (error) {
			this.deps.events.emit({
				type: "handler_error",
				kind: "hook",
				hook: "before_request",
				error: error instanceof Error ? error.message : String(error),
				lane: current.operation.lane,
			});
		}
	}

	private emitSettlementEvents(current: CurrentOperation, plan: EffectPlan, output: SettlementOutput): boolean {
		if (plan.kind !== "assistant" || output.kind !== "assistant" || current.state.kind !== "run") return false;
		const lane = current.operation.lane;
		const runId = current.operation.operationId;
		const phase = current.state.phase;
		if (phase.kind === "assistant" && phase.generation.status === "retry_wait") {
			const failedAttempt = phase.generation.nextAttempt - 1;
			this.deps.events.emit({
				type: "retry_scheduled",
				lane,
				runId,
				step: "assistant",
				attempt: failedAttempt,
				maxAttempts: phase.generation.context.retryPolicy.maxAttempts,
				delayMs: retryDelayMs(phase.generation.context.retryPolicy, failedAttempt),
				errorMessage: phase.generation.errorMessage,
			});
			return false;
		}
		if (this.retried) {
			this.retried = false;
			if (phase.kind === "failure_drain") {
				this.deps.events.emit({
					type: "retry_end",
					lane,
					runId,
					step: "assistant",
					attempt: plan.generation.attempt,
					success: false,
					finalError: phase.error.message,
				});
			} else {
				this.deps.events.emit({
					type: "retry_end",
					lane,
					runId,
					step: "assistant",
					attempt: plan.generation.attempt,
					success: true,
				});
			}
		}
		if (phase.kind === "tools") {
			// The turn continues through the durable tool batch; turn_end is
			// emitted only after the complete batch settles.
			return false;
		}
		if (this.turnStarted) {
			this.turnStarted = false;
			this.deps.events.emit({
				type: "turn_end",
				lane,
				runId,
				turnId: plan.generation.context.stepId,
				message: output.message,
				toolResults: [],
			});
			return true;
		}
		return false;
	}

	private emitTurnEnd(current: CurrentOperation, batch: Extract<RunPhase, { kind: "tools" }>["batch"]): void {
		if (!this.turnStarted) return;
		this.turnStarted = false;
		const value = this.hydrated.get(batch.assistantEntryId);
		const message =
			value !== undefined && "id" in value && value.type === "message" && value.message.role === "assistant"
				? value.message
				: undefined;
		if (message === undefined) {
			throw new SessionError("corruption", `Assistant entry ${batch.assistantEntryId} is missing for turn_end`);
		}
		this.deps.events.emit({
			type: "turn_end",
			lane: current.operation.lane,
			runId: current.operation.operationId,
			turnId: batch.turnId,
			message,
			toolResults: this.turnToolResults.splice(0),
		});
	}
}

function toolsPhase(current: CurrentOperation): Extract<RunPhase, { kind: "tools" }> | undefined {
	if (current.state.kind !== "run" || current.state.phase.kind !== "tools") return undefined;
	return current.state.phase;
}

function requireToolsPhase(current: CurrentOperation): Extract<RunPhase, { kind: "tools" }> {
	const phase = toolsPhase(current);
	if (phase === undefined) throw new Error("Driver expected a tools phase");
	return phase;
}

function requireLeaf(current: CurrentOperation): string {
	if (current.leafId === null) {
		throw new Error(`Operation ${current.operation.operationId} has no lane leaf`);
	}
	return current.leafId;
}

/** Shared identity check for the ready gate and the resume entry check. */
export function missingIdentity(
	configuration: LaneConfiguration,
	models: Models,
	availableTools: ReadonlySet<string>,
): { tools: string[]; models: string[] } {
	const missingTools = configuration.activeToolNames.filter((name) => !availableTools.has(name));
	const model = models.getModel(configuration.model.provider, configuration.model.modelId);
	const missingModels = model === undefined ? [`${configuration.model.provider}/${configuration.model.modelId}`] : [];
	return { tools: missingTools, models: missingModels };
}
