import type { Api, ImageContent, Message, Model, Models, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { prepareToolCallArguments } from "../../tool-execution.ts";
import type { AgentEvent, AgentMessage, AgentTool, AgentToolCall, AgentToolResult } from "../../types.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import { convertToLlm } from "../messages.ts";
import type { AgentHarnessTool } from "../types.ts";
import type { Entry, JsonValue, LaneConfiguration, PendingEntry, ProvisionedEntry, UsageRow } from "./base.ts";
import { assertJsonValue, SessionCodec, validateUsage } from "./codec.ts";
import { buildContextMessages } from "./context.ts";
import { GatedEffects } from "./effects.ts";
import { HarnessNotImplementedError } from "./errors.ts";
import type { HarnessEventBus } from "./events.ts";
import { classifyGenerationOutcome, settlementPhase, zeroUsage } from "./generation.ts";
import type { HarnessHookRegistry } from "./hooks.ts";
import type {
	CompactionState,
	LaneLastResult,
	LaneState,
	NavigationState,
	Operation,
	OperationState,
	RunPhase,
	RunState,
	ToolCall,
} from "./operation.ts";
import { restoreLane } from "./restore.ts";
import type { AdaptiveClearanceComposed, DriveResult, DriveSelector, ToolPreparation } from "./run-driver.ts";
import { GenerationRunDriver, missingIdentity, OperationExternallyFinalizedError } from "./run-driver.ts";
import { actionInfo, HarnessClosedError, type RuntimeCoordinator, taggedError } from "./runtime.ts";
import { type Session, SessionError, type Transaction } from "./storage.ts";
import { streamAssistant } from "./stream-assistant.ts";
import type {
	AbortResult,
	AdaptiveAdmissionResult,
	AdaptiveAdvanceResult,
	AdaptiveRunBasisInput,
	AdaptiveToolBatchClearance,
	AdaptiveToolClearanceDecision,
	AdaptiveTurnResult,
	AgentHarnessOptions,
	CancelQueuedResult,
	Closed,
	CurrentOperation,
	EffectOutput,
	EffectPlan,
	Effects,
	ExactContinuationDispatchFacts,
	InboxDrainPlan,
	InvalidMessage,
	LaneBusy,
	MissingIdentities,
	NextRunResult,
	NoActiveOperation,
	NoActiveRun,
	NothingToResume,
	OperationResult,
	PostTurnCheckpointInfo,
	PostTurnCheckpointRejection,
	QueuedItem,
	QueueResult,
	RecordUsageResult,
	Resources,
	Result,
	ResumeResult,
	RunOutcome,
	RunResult,
	SettlementOutput,
	SettlementResult,
} from "./surface.ts";
import {
	abortedToolResultText,
	syntheticToolResultMessage,
	toolArgsKey,
	toolEffectPlan,
	truncatedToolResultText,
} from "./tools.ts";

const ADAPTIVE_RUN_BASIS_CUSTOM_TYPE = "adaptive.run_basis";

interface RunSettings {
	compaction: CompactionSettings;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	toolExecution: "sequential" | "parallel";
}

export interface MinimalRunRuntimeOptions<TContext extends object | undefined> {
	session: Session;
	models: Models;
	coordinator: RuntimeCoordinator;
	hooks: HarnessHookRegistry;
	events: HarnessEventBus;
	drive: "automatic" | "manual";
	systemPrompt?: string | ((context: TContext) => string | Promise<string>);
	toolContext?: TContext | (() => TContext | Promise<TContext>);
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: AgentHarnessOptions<TContext>["entryProjectors"];
	telemetryContext?: TelemetryContext;
	adaptiveToolPolicy?: AdaptiveToolBatchClearance;
	exactContinuationDispatchGate?: AgentHarnessOptions<TContext>["exactContinuationDispatchGate"];
	getTools(): AgentHarnessTool<TContext>[];
	getResources(): Resources;
	getRunSettings(): RunSettings;
	onLaneState(lane: string, state: MinimalRunLaneState): void;
}

export type MinimalRunLaneState =
	| { kind: "open"; current: CurrentOperation }
	| { kind: "idle"; lane: string; leafId: string | null; laneState: LaneState; laneStateSeq: number };

type AdaptiveAcceptance = { basis: AdaptiveRunBasisInput };

type AcceptedRun = {
	current: CurrentOperation;
	entries: Entry[];
};

type RunRejection = Extract<RunResult, { ok: false }>["error"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedError(): Closed {
	const message = "AgentHarness is closed";
	return taggedError("Closed", message, { message });
}

function invalidMessage(lane: string, reason: string): InvalidMessage {
	const message = `Invalid message for lane ${lane}: ${reason}`;
	return taggedError("InvalidMessage", message, { lane, reason, message });
}

function laneBusy(lane: string, operation: Operation): LaneBusy {
	const operationKind = operation.intent.kind;
	const message = `Lane ${lane} is busy with ${operationKind} operation ${operation.operationId}`;
	return taggedError("LaneBusy", message, {
		lane,
		operationId: operation.operationId,
		operationKind,
		message,
	});
}

function missingIdentities(lane: string, tools: string[], models: string[]): MissingIdentities {
	const message = `Lane ${lane} is missing required identities`;
	return taggedError("MissingIdentities", message, { lane, tools, models, message });
}

function noActiveRunError(lane: string): NoActiveRun {
	const message = `Lane ${lane} has no active Run to accept the queue item`;
	return taggedError("NoActiveRun", message, { lane, message });
}

function noActiveOperationError(lane: string): NoActiveOperation {
	const message = `Lane ${lane} has no active operation to abort`;
	return taggedError("NoActiveOperation", message, { lane, message });
}

function nothingToResume(lane: string): NothingToResume {
	const message = `Lane ${lane} has no active operation to resume`;
	return taggedError("NothingToResume", message, { lane, message });
}

function normalizePrompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
	if (typeof input !== "string") return structuredClone(Array.isArray(input) ? input : [input]);
	if (input.length === 0 && (images?.length ?? 0) === 0) return [];
	return [
		{
			role: "user",
			content: [
				...(input.length === 0 ? [] : [{ type: "text" as const, text: input }]),
				...(images ?? []).map((image) => structuredClone(image)),
			],
			timestamp: Date.now(),
		},
	];
}

function lastResult(operationId: string, state: RunState, result: RunOutcome): LaneLastResult {
	if (result.kind === "failed") {
		return {
			operationId,
			kind: "run",
			leafId: result.leafId,
			outcome: "failed",
			error: result.error,
			...(state.latestAssistantEntryId === null ? {} : { finalAssistantEntryId: state.latestAssistantEntryId }),
		};
	}
	if (result.kind === "completed") {
		return {
			operationId,
			kind: "run",
			leafId: result.leafId,
			outcome: "completed",
			...(state.latestAssistantEntryId === null ? {} : { finalAssistantEntryId: state.latestAssistantEntryId }),
			runCompletion: result.runCompletion ?? "assistant",
		};
	}
	if (result.kind === "aborted") {
		return {
			operationId,
			kind: "run",
			leafId: result.leafId,
			outcome: "aborted",
			...(state.latestAssistantEntryId === null ? {} : { finalAssistantEntryId: state.latestAssistantEntryId }),
		};
	}
	throw new HarnessNotImplementedError("terminal deferred suspension");
}

function structuralLastResult(
	operationId: string,
	state: CompactionState | NavigationState,
	result: Extract<OperationResult, { kind: "aborted" }>,
): LaneLastResult {
	return {
		operationId,
		kind: state.kind,
		leafId: result.leafId,
		outcome: "aborted",
	};
}

export class MinimalNoToolRunRuntime<TContext extends object | undefined> {
	private readonly options: MinimalRunRuntimeOptions<TContext>;
	private readonly codec: SessionCodec = new SessionCodec();
	private readonly effects: Effects;
	private readonly effectOwners = new Map<string, CurrentOperation>();
	private readonly driver: GenerationRunDriver;
	private readonly driving = new Set<string>();
	private readonly laneIdleWaiters = new Map<
		string,
		Array<{ resolve: () => void; reject: (error: unknown) => void }>
	>();
	private readonly deferredCancellations = new Set<string>();

	constructor(options: MinimalRunRuntimeOptions<TContext>) {
		this.options = options;
		const inner = {
			commitTransition: (
				current: CurrentOperation,
				next: OperationState,
				_telemetry: TelemetryContext,
				expectedConfigurationSeq?: number,
				expectedSettingsRevision?: number,
			) => this.commitTransition(current, next, expectedConfigurationSeq, expectedSettingsRevision),
			commitEffectSettlement: (current: CurrentOperation, plan: EffectPlan, output: SettlementOutput) =>
				this.commitEffectSettlement(current, plan, output),
			commitToolIntent: (current: CurrentOperation, batch, sourceIndex, args, replay) =>
				this.commitToolIntent(current, batch, sourceIndex, args, replay),
			commitAdaptiveBatchIntent: (current: CurrentOperation, batch, entryData, decisions) =>
				this.commitAdaptiveBatchIntent(current, batch, entryData, decisions),
			commitInboxDrain: (current: CurrentOperation, plan: InboxDrainPlan) => this.commitInboxDrain(current, plan),
			commitTerminal: (current: CurrentOperation, result: OperationResult) => this.commitTerminal(current, result),
			finalizeTool: (plan, output) => this.finalizeToolEffect(plan, output),
			runSummaryRequest: () => Promise.reject(new HarnessNotImplementedError("runSummaryRequest")),
			settleSummaryRequest: () => Promise.reject(new HarnessNotImplementedError("settleSummaryRequest")),
			run: (plan: EffectPlan) => this.runEffect(plan),
			sleep: (delayMs: number, _telemetry: TelemetryContext, operationId: string) =>
				this.sleepMs(delayMs, operationId),
			sleepUntil: (until: number, _telemetry: TelemetryContext, operationId: string) =>
				this.sleepMs(until - Date.now(), operationId),
		} satisfies Effects;
		this.effects = new GatedEffects(inner, options.coordinator.gate);
		this.driver = new GenerationRunDriver({
			session: options.session,
			coordinator: options.coordinator,
			hooks: options.hooks,
			events: options.events,
			models: options.models,
			effects: this.effects,
			telemetry: this.telemetry,
			getToolNames: () => options.getTools().map((tool) => tool.name),
			projectedCustomTypes: new Set(Object.keys(options.entryProjectors ?? {})),
			deferredCancellations: this.deferredCancellations,
			onDispatch: (key, current) => this.effectOwners.set(key, current),
			onEffectEnd: (key) => this.effectOwners.delete(key),
			prepareToolCall: (current, batch, sourceIndex) => this.prepareToolCall(current, batch, sourceIndex),
			clearAdaptiveBatch: (current, batch) => this.clearAdaptiveBatch(current, batch),
			canReplayTool: (current, batch, sourceIndex) => this.canReplayTool(current, batch, sourceIndex),
			isSequentialBatch: (current, batch) => this.isSequentialBatch(current, batch),
			verifyFirstAssistantDispatch: (current, plan) => this.verifyFirstAssistantDispatch(current, plan),
		});
	}

	prompt(lane: string, input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.mapSettledDrive(
			this.acceptAndDriveWith(lane, normalizePrompt(input, images), undefined, { kind: "settled" }),
		);
	}

	promptAdaptive(
		lane: string,
		input: AgentMessage | AgentMessage[],
		basis: AdaptiveRunBasisInput,
	): Promise<RunResult> {
		return this.mapSettledDrive(
			this.acceptAndDriveWith(lane, normalizePrompt(input), { basis: structuredClone(basis) }, { kind: "settled" }),
		);
	}

	promptAdaptiveTurn(
		lane: string,
		input: AgentMessage | AgentMessage[],
		basis: AdaptiveRunBasisInput,
	): Promise<AdaptiveTurnResult> {
		return this.mapTurnDrive(
			this.acceptAndDriveWith(
				lane,
				normalizePrompt(input),
				{ basis: structuredClone(basis) },
				{ kind: "post_turn" },
			),
		);
	}

	resume(lane: string): Promise<ResumeResult> {
		return this.mapSettledResume(this.resumeAndDriveWith(lane, { kind: "settled" }));
	}

	resumeAdaptiveTurn(lane: string): Promise<AdaptiveAdvanceResult> {
		return this.mapTurnResume(this.resumeAndDriveWith(lane, { kind: "post_turn" }));
	}

	/**
	 * Zero-prompt exact-continuation admission. One atomic transaction appends
	 * the `adaptive.run_basis` entry (parent = current leaf), writes the run
	 * operation with `promptEntryIds: []` and the basis entry as initial
	 * trigger, and opens the lane. No `before_run` hook runs, no prompt entry
	 * is appended, and no provider effect is dispatched. Crash recovery must
	 * never re-run this for the same child: the basis entry and the operation
	 * registers commit together, and a retry either observes the lane busy or
	 * re-attaches to the accepted Run.
	 */
	acceptAdaptiveContinuation(
		lane: string,
		basis: AdaptiveRunBasisInput,
		options?: { systemPromptOverride?: string; resumeData?: Record<string, JsonValue> },
	): Promise<AdaptiveAdmissionResult> {
		return this.acceptContinuation(lane, basis, options);
	}

	/**
	 * Narrow capture seam used by exact checkpoint capture. Under the lane
	 * mutation line the open Run is verified to be parked at a complete
	 * post-turn continuation checkpoint with no pending queue input, retry,
	 * or abort; the callback runs while the line is held, and the durable
	 * checkpoint is re-verified before the result is released. The callback
	 * must not call this lane's mutating APIs.
	 */
	capturePostTurnCheckpoint<T>(
		lane: string,
		callback: (info: PostTurnCheckpointInfo) => T | Promise<T>,
	): Promise<Result<T, PostTurnCheckpointRejection>> {
		return this.capturePostTurn(lane, callback);
	}

	// R5 public queue admission, cancellation, usage adjustments, and lane writes

	/**
	 * R6 durable abort: the first call atomically commits `cancel_requested`
	 * plus the steer/follow-up drain on the lane mutation line. Only the
	 * marker durability is awaited; reconciliation continues on the existing
	 * driver or a background recovery driver.
	 */
	async abort(lane: string): Promise<AbortResult> {
		try {
			const committed = await this.options.coordinator.mutateLaneWithWriter(
				lane,
				async (
					write,
				): Promise<
					| { kind: "no_active_operation" }
					| { kind: "already_cancelled"; operationId: string; steer: AgentMessage[]; followUp: AgentMessage[] }
					| { kind: "cancelled"; operationId: string; steer: AgentMessage[]; followUp: AgentMessage[] }
				> => {
					const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
					if (laneStateRegister === undefined) {
						throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
					}
					const operationId = laneStateRegister.value.currentOperationId;
					if (operationId === null) return { kind: "no_active_operation" };
					const stateRegister = await this.options.session.getRegister("op.state", operationId);
					if (stateRegister === undefined) {
						// Terminal or externally finalized: only a matching
						// lastResult distinguishes a settled operation from
						// durable corruption.
						const lastResult = await this.options.session.getRegister("lane.lastResult", lane);
						if (lastResult?.value.operationId === operationId) return { kind: "no_active_operation" };
						throw new SessionError("corruption", `Lane ${lane} has missing operation state`);
					}
					const state = stateRegister.value;
					if (state.control.status === "cancel_requested") {
						const payload = await this.drainedPayload(state.control.drainedSteer, state.control.drainedFollowUp);
						return { kind: "already_cancelled", operationId, ...payload };
					}
					const inbox = state.kind === "run" ? state.inbox : undefined;
					const payload = await this.drainedPayload(inbox?.steer ?? [], inbox?.followUp ?? []);
					const next: OperationState = {
						...structuredClone(state),
						control: {
							status: "cancel_requested",
							requestedAt: Date.now(),
							drainedSteer: inbox?.steer ?? [],
							drainedFollowUp: inbox?.followUp ?? [],
						},
						...(state.kind === "run" && inbox !== undefined
							? { inbox: { ...structuredClone(inbox), steer: [], followUp: [] } }
							: {}),
					};
					await write({
						writes: [
							{
								kind: "register",
								op: "set",
								namespace: "op.state",
								key: operationId,
								value: next,
							},
						],
					});
					return { kind: "cancelled", operationId, ...payload };
				},
			);
			if (committed.kind === "no_active_operation") return { ok: false, error: noActiveOperationError(lane) };
			const { operationId, steer, followUp } = committed;
			if (committed.kind === "already_cancelled") {
				// Repeated abort: zero writes, zero signals, zero events; the
				// first saved drained payload is returned verbatim.
				return { ok: true, value: { runId: operationId, steer, followUp } };
			}
			// Marker durable: pull the operation signal and wake the driver.
			this.options.coordinator.abortOperation(operationId);
			this.options.events.emit({
				type: "run_abort",
				lane,
				runId: operationId,
				steer: structuredClone(steer),
				followUp: structuredClone(followUp),
			});
			await this.emitQueueUpdate(lane);
			this.wakeCancelledLane(lane);
			return { ok: true, value: { runId: operationId, steer, followUp } };
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	private async drainedPayload(
		steerIds: readonly string[],
		followUpIds: readonly string[],
	): Promise<{ steer: AgentMessage[]; followUp: AgentMessage[] }> {
		const dereference = async (ids: readonly string[]): Promise<AgentMessage[]> => {
			const registers = await Promise.all(ids.map((id) => this.options.session.getRegister("pending.entry", id)));
			const messages: AgentMessage[] = [];
			for (let index = 0; index < ids.length; index++) {
				const register = registers[index];
				if (register?.value.type !== "message" || register.value.payload === undefined) continue;
				messages.push(structuredClone(register.value.payload as unknown as AgentMessage));
			}
			return messages;
		};
		const [steer, followUp] = await Promise.all([dereference(steerIds), dereference(followUpIds)]);
		return { steer, followUp };
	}

	/**
	 * After the cancel marker committed: an existing driver wakes through its
	 * operation signal; a suspended operation without a live driver starts a
	 * recovery driver. Automatic mode runs it in the background; manual mode
	 * registers it with the gate so runToCompletion drives the reconciliation.
	 */
	private wakeCancelledLane(lane: string): void {
		if (this.driving.has(lane)) return;
		const drive = this.resumeAndDriveWith(lane, { kind: "settled" });
		if (this.options.drive === "automatic") {
			void drive.catch(() => undefined);
			return;
		}
		this.options.coordinator.gate.track(drive);
		void drive.catch(() => undefined);
	}

	nextRun(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult> {
		return this.admitQueueItem(lane, "nextRun", input, images);
	}

	steer(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.admitRunQueueItem(lane, "steer", input, images);
	}

	followUp(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.admitRunQueueItem(lane, "followUp", input, images);
	}

	private async admitQueueItem(
		lane: string,
		kind: "nextRun",
		input: string | AgentMessage,
		images?: ImageContent[],
	): Promise<NextRunResult> {
		try {
			const messages = normalizePrompt(input, images);
			if (messages.length !== 1)
				return { ok: false, error: invalidMessage(lane, "queue admission requires one message") };
			const invalid = this.validateMessages(messages, kind);
			if (invalid !== undefined) return { ok: false, error: invalidMessage(lane, invalid) };
			const committed = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
				const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
				if (laneStateRegister === undefined) {
					throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
				}
				const id = this.options.session.idGenerator.next();
				const next: LaneState = {
					...structuredClone(laneStateRegister.value),
					pendingNextRun: [...laneStateRegister.value.pendingNextRun, id],
				};
				await write({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "pending.entry",
							key: id,
							value: { type: "message", payload: structuredClone(messages[0]!) },
						},
						{ kind: "register", op: "set", namespace: "lane.state", key: lane, value: next },
					],
				});
				return id;
			});
			await this.emitQueueUpdate(lane);
			return { ok: true, value: { entryId: committed } };
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	private async admitRunQueueItem(
		lane: string,
		kind: "steer" | "followUp",
		input: string | AgentMessage,
		images?: ImageContent[],
	): Promise<QueueResult> {
		try {
			const messages = normalizePrompt(input, images);
			if (messages.length !== 1)
				return { ok: false, error: invalidMessage(lane, "queue admission requires one message") };
			const invalid = this.validateMessages(messages, kind);
			if (invalid !== undefined) return { ok: false, error: invalidMessage(lane, invalid) };
			const committed = await this.options.coordinator.mutateLaneWithWriter(
				lane,
				async (
					write,
				): Promise<{ kind: "accepted"; entryId: string } | { kind: "rejected"; error: NoActiveRun }> => {
					const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
					if (laneStateRegister === undefined) {
						throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
					}
					const operationId = laneStateRegister.value.currentOperationId;
					if (operationId === null) return { kind: "rejected", error: noActiveRunError(lane) };
					const stateRegister = await this.options.session.getRegister("op.state", operationId);
					if (stateRegister === undefined) {
						throw new SessionError("corruption", `Lane ${lane} has missing operation state`);
					}
					const state = stateRegister.value;
					if (state.kind !== "run" || state.control.status !== "running") {
						return { kind: "rejected", error: noActiveRunError(lane) };
					}
					const id = this.options.session.idGenerator.next();
					const next: RunState = structuredClone(state);
					next.inbox[kind] = [...next.inbox[kind], id];
					await write({
						writes: [
							{
								kind: "register",
								op: "set",
								namespace: "pending.entry",
								key: id,
								value: { type: "message", payload: structuredClone(messages[0]!) },
							},
							{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: next },
						],
					});
					return { kind: "accepted", entryId: id };
				},
			);
			if (committed.kind === "rejected") return { ok: false, error: committed.error };
			await this.emitQueueUpdate(lane);
			return { ok: true, value: { entryId: committed.entryId } };
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	async cancelQueued(lane: string, entryId: string): Promise<CancelQueuedResult> {
		try {
			const outcome = await this.options.coordinator.mutateLaneWithWriter(
				lane,
				async (write): Promise<"cancelled" | "already_consumed" | "not_found"> => {
					const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
					if (laneStateRegister === undefined) {
						throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
					}
					// Triage 1: the id is still owned by a pending list of this lane.
					const without = (list: string[]): string[] => list.filter((id) => id !== entryId);
					if (laneStateRegister.value.pendingNextRun.includes(entryId)) {
						await write({
							writes: [
								{
									kind: "register",
									op: "set",
									namespace: "lane.state",
									key: lane,
									value: {
										...structuredClone(laneStateRegister.value),
										pendingNextRun: without(laneStateRegister.value.pendingNextRun),
									},
								},
								{ kind: "register", op: "delete", namespace: "pending.entry", key: entryId },
							],
						});
						return "cancelled";
					}
					const operationId = laneStateRegister.value.currentOperationId;
					if (operationId !== null) {
						const stateRegister = await this.options.session.getRegister("op.state", operationId);
						const state = stateRegister?.value;
						if (state !== undefined && state.kind === "run") {
							const inboxLists = [
								["steer", state.inbox.steer],
								["followUp", state.inbox.followUp],
								["writes", state.inbox.writes],
							] as const;
							for (const [list, ids] of inboxLists) {
								if (!ids.includes(entryId)) continue;
								const next: RunState = structuredClone(state);
								next.inbox[list] = without(ids);
								await write({
									writes: [
										{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: next },
										{ kind: "register", op: "delete", namespace: "pending.entry", key: entryId },
									],
								});
								return "cancelled";
							}
							if (state.control.status === "cancel_requested") {
								const control = state.control;
								const nextControl = {
									...structuredClone(control),
									drainedSteer: without(control.drainedSteer),
									drainedFollowUp: without(control.drainedFollowUp),
								};
								if (
									nextControl.drainedSteer.length !== control.drainedSteer.length ||
									nextControl.drainedFollowUp.length !== control.drainedFollowUp.length
								) {
									const drained: RunState = { ...structuredClone(state), control: nextControl };
									await write({
										writes: [
											{
												kind: "register",
												op: "set",
												namespace: "op.state",
												key: operationId,
												value: drained,
											},
											{ kind: "register", op: "delete", namespace: "pending.entry", key: entryId },
										],
									});
									return "cancelled";
								}
							}
						}
					}
					// Triage 2: the id already materialized as an immutable entry.
					if ((await this.options.session.getEntry(entryId)) !== undefined) return "already_consumed";
					// Triage 3: neither pending nor placed; repeated cancels stay not_found.
					return "not_found";
				},
			);
			await this.emitQueueUpdate(lane);
			return { ok: true, value: { kind: outcome } };
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	async recordUsage(
		lane: string,
		usage: Usage,
		options?: { entryId?: string; details?: JsonValue },
	): Promise<RecordUsageResult> {
		try {
			validateUsage(structuredClone(usage), "usage");
			if (options?.details !== undefined) assertJsonValue(options.details, "recordUsage.details");
			if (options?.entryId !== undefined) {
				const entry = await this.options.session.getEntry(options.entryId);
				if (entry === undefined) {
					throw new SessionError("invalid_payload", `Usage entry ${options.entryId} does not exist`);
				}
			}
			const usageId = this.options.session.idGenerator.next();
			const commit = await this.options.coordinator.commit({
				writes: [
					{
						kind: "usage",
						row: {
							id: usageId,
							usage: structuredClone(usage),
							adjustment: true,
							...(options?.entryId === undefined ? {} : { entryId: options.entryId }),
							...(options?.details === undefined ? {} : { details: structuredClone(options.details) }),
						},
					},
				],
			});
			const totals = (await this.options.session.getStats()).usage;
			const row: UsageRow = {
				id: usageId,
				seq: commit.seqs[0]!,
				usage: structuredClone(usage),
				adjustment: true,
				...(options?.entryId === undefined ? {} : { entryId: options.entryId }),
				...(options?.details === undefined ? {} : { details: structuredClone(options.details) }),
			};
			this.options.events.emit({ type: "usage", lane, row, totals });
			return { ok: true, value: { usageId, totals } };
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	// R5 Harness-aware lane tree writes

	async appendLaneMessage(lane: string, message: AgentMessage): Promise<string> {
		try {
			this.codec.validateMessage(message, "appendMessage");
		} catch (error) {
			throw new SessionError(
				"invalid_payload",
				`Invalid message appended to lane ${lane}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return this.appendLaneEntry(lane, { type: "message", message: structuredClone(message) });
	}

	async appendLaneCustomEntry(lane: string, customType: string, data?: JsonValue): Promise<string> {
		if (typeof customType !== "string" || customType.length === 0) {
			throw new SessionError("invalid_payload", `Custom entry appended to lane ${lane} has no customType`);
		}
		if (data !== undefined) {
			try {
				assertJsonValue(data, "appendCustomEntry.data");
			} catch (error) {
				throw new SessionError(
					"invalid_payload",
					`Invalid custom entry data for lane ${lane}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return this.appendLaneEntry(lane, {
			type: "custom",
			customType,
			...(data === undefined ? {} : { data: structuredClone(data) }),
		});
	}

	private async appendLaneEntry(
		lane: string,
		payload: { type: "message"; message: AgentMessage } | { type: "custom"; customType: string; data?: JsonValue },
	): Promise<string> {
		for (;;) {
			const placement = await this.options.coordinator.mutateLaneWithWriter(
				lane,
				async (
					write,
				): Promise<
					| { kind: "placed"; id: string; entry: Entry }
					| { kind: "deferred"; id: string; operationId: string }
					| { kind: "busy" }
				> => {
					const [laneStateRegister, leafRegister] = await Promise.all([
						this.options.session.getRegister("lane.state", lane),
						this.options.session.getRegister("lane.leaf", lane),
					]);
					if (laneStateRegister === undefined || leafRegister === undefined) {
						throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
					}
					const id = this.options.session.idGenerator.next();
					const operationId = laneStateRegister.value.currentOperationId;
					if (operationId === null) {
						const entry: ProvisionedEntry =
							payload.type === "message"
								? {
										id,
										parentId: leafRegister.value,
										type: "message",
										message: structuredClone(payload.message),
									}
								: {
										id,
										parentId: leafRegister.value,
										type: "custom",
										customType: payload.customType,
										...(payload.data === undefined ? {} : { data: structuredClone(payload.data) }),
									};
						await write({
							writes: [
								{ kind: "entry", entry },
								{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: id },
							],
						});
						const materialized = (await this.options.session.getEntries([id])).get(id);
						if (materialized === undefined) {
							throw new SessionError("corruption", `Placed entry ${id} is missing`);
						}
						return { kind: "placed", id, entry: materialized };
					}
					const stateRegister = await this.options.session.getRegister("op.state", operationId);
					if (stateRegister === undefined) {
						throw new SessionError("corruption", `Lane ${lane} has missing operation state`);
					}
					if (stateRegister.value.kind !== "run") return { kind: "busy" };
					const pending: PendingEntry =
						payload.type === "message"
							? { type: "message", payload: structuredClone(payload.message) }
							: {
									type: "custom",
									customType: payload.customType,
									...(payload.data === undefined ? {} : { payload: structuredClone(payload.data) }),
								};
					const next: RunState = structuredClone(stateRegister.value);
					next.inbox.writes = [...next.inbox.writes, id];
					await write({
						writes: [
							{ kind: "register", op: "set", namespace: "pending.entry", key: id, value: pending },
							{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: next },
						],
					});
					return { kind: "deferred", id, operationId };
				},
			);
			if (placement.kind === "placed") {
				this.emitPlacedEntry(lane, placement.entry);
				return placement.id;
			}
			if (placement.kind === "deferred") {
				this.options.events.emit({
					type: "write_pending",
					lane,
					runId: placement.operationId,
					entryId: placement.id,
					entryType: payload.type,
				});
				await this.emitQueueUpdate(lane);
				return placement.id;
			}
			// A structural operation owns the lane: release the line and wait
			// for it to finish before re-evaluating the placement.
			await this.waitForLaneIdle(lane);
		}
	}

	private emitPlacedEntry(lane: string, entry: Entry): void {
		if (entry.type === "message") {
			this.options.events.emit({ type: "message_start", lane, message: entry.message });
			this.options.events.emit({ type: "message_end", lane, message: entry.message, entryId: entry.id });
		}
		this.options.events.emit({ type: "entry_added", lane, entry });
	}

	private waitForLaneIdle(lane: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiters = this.laneIdleWaiters.get(lane) ?? [];
			waiters.push({ resolve, reject });
			this.laneIdleWaiters.set(lane, waiters);
		});
	}

	private notifyLaneIdle(lane: string): void {
		const waiters = this.laneIdleWaiters.get(lane);
		if (waiters === undefined) return;
		this.laneIdleWaiters.delete(lane);
		for (const waiter of waiters) waiter.resolve();
	}

	/**
	 * R6 lane idle condition: every lane job admitted before the call has
	 * finished, no process-local driver is active, and the lane has no open
	 * operation. The registration linearizes on the lane line; waiting itself
	 * never holds the line, so subsequent operations can start immediately.
	 */
	async waitForIdle(lane: string): Promise<void> {
		await this.options.coordinator.mutateLane(lane, () => undefined);
		for (;;) {
			if (this.options.coordinator.signal.aborted) throw new HarnessClosedError();
			const laneState = await this.options.session.getRegister("lane.state", lane);
			if (laneState === undefined) throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
			if (!this.driving.has(lane) && laneState.value.currentOperationId === null) return;
			await this.waitForLaneIdle(lane);
		}
	}

	/**
	 * R6 idle callback: waits for the same idle condition, then atomically
	 * takes a process-local lane reservation (the lane line is held for the
	 * callback duration). The callback must not call this lane's mutating
	 * APIs — that is the documented anti-deadlock contract. Errors propagate
	 * verbatim; close rejects callbacks that have not started yet and waits
	 * for one that has.
	 */
	async runWhenIdle(lane: string, callback: () => void | Promise<void>): Promise<void> {
		for (;;) {
			await this.waitForIdle(lane);
			const acquired = await this.options.coordinator.mutateLane(lane, async () => {
				const laneState = await this.options.session.getRegister("lane.state", lane);
				if (laneState === undefined) throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
				if (this.driving.has(lane) || laneState.value.currentOperationId !== null) return false;
				await callback();
				return true;
			});
			if (acquired) return;
		}
	}

	/** Releases append waiters when the harness closes; pending retries then fail closed. */
	closeWaiters(): void {
		const error = new HarnessClosedError();
		for (const lane of [...this.laneIdleWaiters.keys()]) {
			const waiters = this.laneIdleWaiters.get(lane) ?? [];
			this.laneIdleWaiters.delete(lane);
			for (const waiter of waiters) waiter.reject(error);
		}
	}

	/** Dereferences the current durable queue ids into a queue_update payload after a commit. */
	private async emitQueueUpdate(lane: string): Promise<void> {
		const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
		if (laneStateRegister === undefined) return;
		const operationId = laneStateRegister.value.currentOperationId;
		const stateRegister =
			operationId === null ? undefined : await this.options.session.getRegister("op.state", operationId);
		const steerIds = stateRegister?.value.kind === "run" ? stateRegister.value.inbox.steer : [];
		const followUpIds = stateRegister?.value.kind === "run" ? stateRegister.value.inbox.followUp : [];
		const nextRunIds = laneStateRegister.value.pendingNextRun;
		const dereference = async (ids: readonly string[]): Promise<QueuedItem[]> => {
			const registers = await Promise.all(ids.map((id) => this.options.session.getRegister("pending.entry", id)));
			const items: QueuedItem[] = [];
			for (let index = 0; index < ids.length; index++) {
				const register = registers[index];
				if (register === undefined || register.value.type !== "message" || register.value.payload === undefined) {
					continue;
				}
				items.push({
					entryId: ids[index]!,
					message: structuredClone(register.value.payload as unknown as AgentMessage),
				});
			}
			return items;
		};
		const [steer, followUp, nextRun] = await Promise.all([
			dereference(steerIds),
			dereference(followUpIds),
			dereference(nextRunIds),
		]);
		this.options.events.emit({ type: "queue_update", lane, steer, followUp, nextRun });
	}

	private async mapSettledDrive(
		pending: ReturnType<MinimalNoToolRunRuntime<TContext>["acceptAndDriveWith"]>,
	): Promise<RunResult> {
		const result = await pending;
		if (!result.ok) return result;
		if (result.result.kind !== "outcome") throw new Error("Settled drive yielded unexpectedly");
		return { ok: true, value: { runId: result.runId, ...result.result.outcome } };
	}

	private async mapTurnDrive(
		pending: ReturnType<MinimalNoToolRunRuntime<TContext>["acceptAndDriveWith"]>,
	): Promise<AdaptiveTurnResult> {
		const result = await pending;
		if (!result.ok) return result;
		if (result.result.kind === "outcome") {
			return { ok: true, value: { runId: result.runId, ...result.result.outcome } };
		}
		return {
			ok: true,
			value: {
				runId: result.runId,
				kind: "turn",
				assistantEntryId: result.result.assistantEntryId,
				leafId: result.result.leafId,
			},
		};
	}

	private async mapSettledResume(
		pending: ReturnType<MinimalNoToolRunRuntime<TContext>["resumeAndDriveWith"]>,
	): Promise<ResumeResult> {
		const result = await pending;
		if (!result.ok) return result;
		if (result.result.kind !== "outcome") throw new Error("Settled resume yielded unexpectedly");
		return { ok: true, value: { operation: "run", runId: result.runId, ...result.result.outcome } };
	}

	private async mapTurnResume(
		pending: ReturnType<MinimalNoToolRunRuntime<TContext>["resumeAndDriveWith"]>,
	): Promise<AdaptiveAdvanceResult> {
		const result = await pending;
		if (!result.ok) return result;
		if (result.result.kind === "outcome") {
			return { ok: true, value: { runId: result.runId, ...result.result.outcome } };
		}
		return {
			ok: true,
			value: {
				runId: result.runId,
				kind: "turn",
				assistantEntryId: result.result.assistantEntryId,
				leafId: result.result.leafId,
			},
		};
	}

	private async acceptAndDriveWith(
		lane: string,
		prompt: AgentMessage[],
		adaptive: AdaptiveAcceptance | undefined,
		selector: DriveSelector,
	): Promise<{ ok: false; error: RunRejection } | { ok: true; runId: string; result: DriveResult }> {
		try {
			const accepted = await this.accept(lane, prompt, adaptive);
			if (!accepted.ok) return accepted;
			this.driving.add(lane);
			try {
				const drive = this.driver.drive(
					accepted.value.current,
					new Map(accepted.value.entries.map((entry) => [entry.id, entry])),
					selector,
				);
				this.options.coordinator.gate.track(drive);
				const result = await drive;
				if (result.kind === "outcome" && result.external === true) {
					await this.markLaneExternallyFinalized(
						lane,
						accepted.value.current.operation.operationId,
						result.outcome.leafId,
					);
				}
				return { ok: true, runId: accepted.value.current.operation.operationId, result };
			} finally {
				this.driving.delete(lane);
				this.notifyLaneIdle(lane);
			}
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	private async resumeAndDriveWith(
		lane: string,
		selector: DriveSelector,
	): Promise<
		| { ok: false; error: Extract<ResumeResult, { ok: false }>["error"] }
		| { ok: true; runId: string; result: DriveResult }
	> {
		try {
			const restored = await this.options.coordinator.mutateLane(lane, () =>
				restoreLane(this.options.session, lane),
			);
			if (restored.kind === "idle") return { ok: false, error: nothingToResume(lane) };
			const current = restored.current;
			if (current.state.kind !== "run" && current.state.control.status !== "cancel_requested") {
				throw new HarnessNotImplementedError(`resume for ${current.state.kind} operations`);
			}
			if (this.driving.has(lane)) return { ok: false, error: laneBusy(lane, current.operation) };
			const ready = current.state.kind === "run" ? current.state.phase : undefined;
			if (
				current.state.control.status === "running" &&
				ready !== undefined &&
				ready.kind === "assistant" &&
				ready.generation.status === "ready"
			) {
				const missing = missingIdentity(
					ready.generation.context.configuration,
					this.options.models,
					new Set(this.options.getTools().map((tool) => tool.name)),
				);
				if (missing.tools.length > 0 || missing.models.length > 0) {
					return { ok: false, error: missingIdentities(lane, missing.tools, missing.models) };
				}
			}
			this.driving.add(lane);
			try {
				this.options.events.emit({
					type: "run_resume",
					lane,
					runId: current.operation.operationId,
				});
				const drive = this.driver.drive(current, restored.loaded, selector);
				this.options.coordinator.gate.track(drive);
				const result = await drive;
				if (result.kind === "outcome" && result.external === true) {
					await this.markLaneExternallyFinalized(lane, current.operation.operationId, result.outcome.leafId);
				}
				return { ok: true, runId: current.operation.operationId, result };
			} finally {
				this.driving.delete(lane);
				this.notifyLaneIdle(lane);
			}
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	/** External finalization: drop process-local operation state without any write. */
	private async markLaneExternallyFinalized(lane: string, operationId: string, leafId: string | null): Promise<void> {
		this.options.coordinator.releaseOperation(operationId);
		const laneStateRegister = await this.options.session.getRegister("lane.state", lane);
		if (laneStateRegister !== undefined) {
			this.options.onLaneState(lane, {
				kind: "idle",
				lane,
				leafId,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
			});
		}
	}

	private validateMessages(messages: AgentMessage[], path: string): string | undefined {
		try {
			for (let index = 0; index < messages.length; index++) {
				this.codec.validateMessage(messages[index], `${path}[${index}]`);
			}
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	private async resolveToolContext(): Promise<TContext> {
		const source = this.options.toolContext;
		return (typeof source === "function" ? await source() : source) as TContext;
	}

	private async resolveSystemPrompt(context?: TContext): Promise<string> {
		if (typeof this.options.systemPrompt === "string") return this.options.systemPrompt;
		if (this.options.systemPrompt === undefined) return "";
		return this.options.systemPrompt(context ?? (await this.resolveToolContext()));
	}

	private async accept(
		lane: string,
		prompt: AgentMessage[],
		adaptive?: AdaptiveAcceptance,
	): Promise<{ ok: true; value: AcceptedRun } | { ok: false; error: RunRejection }> {
		const invalidCaller = this.validateMessages(prompt, "prompt");
		if (invalidCaller !== undefined) return { ok: false, error: invalidMessage(lane, invalidCaller) };
		if (adaptive !== undefined) {
			try {
				assertJsonValue(adaptive.basis, "adaptive.run_basis");
			} catch (error) {
				return { ok: false, error: invalidMessage(lane, error instanceof Error ? error.message : String(error)) };
			}
		}

		const operationId = this.options.session.idGenerator.next();
		const previewSystemPrompt = await this.resolveSystemPrompt();
		const beforeRun = this.options.hooks.has("before_run")
			? await this.options.coordinator.gate.run(actionInfo("hook", "Run before_run hook"), () =>
					this.options.hooks.run("before_run", {
						lane,
						runId: operationId,
						prompt: structuredClone(prompt),
						systemPrompt: previewSystemPrompt,
						resources: this.options.getResources(),
					}),
				)
			: undefined;
		const injected = beforeRun?.messages ?? [];
		let invalidHook = this.validateMessages(injected, "before_run.messages");
		if (invalidHook === undefined && beforeRun?.resumeData !== undefined) {
			try {
				assertJsonValue(beforeRun.resumeData, "before_run.resumeData");
			} catch (error) {
				invalidHook = error instanceof Error ? error.message : String(error);
			}
		}
		const hookMessages = invalidHook === undefined ? injected : [];
		if (invalidHook !== undefined) {
			this.options.events.emit({
				type: "handler_error",
				kind: "hook",
				hook: "before_run",
				error: invalidHook,
				lane,
			});
		}

		return this.options.coordinator.withSettingsAndLaneWriter(lane, async (_runtime, write) => {
			const [laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (laneStateRegister === undefined || leafRegister === undefined || configurationRegister === undefined) {
				throw new Error(`Lane ${lane} is missing required registers`);
			}
			if (laneStateRegister.value.currentOperationId !== null) {
				const operationRegister = await this.options.session.getRegister(
					"op.meta",
					laneStateRegister.value.currentOperationId,
				);
				if (operationRegister === undefined) throw new Error(`Lane ${lane} has missing operation metadata`);
				return { ok: false, error: laneBusy(lane, operationRegister.value) };
			}

			const model = this.options.models.getModel(
				configurationRegister.value.model.provider,
				configurationRegister.value.model.modelId,
			);
			const availableTools = new Set(this.options.getTools().map((tool) => tool.name));
			const missingTools = configurationRegister.value.activeToolNames.filter((name) => !availableTools.has(name));
			const missingModels =
				model === undefined
					? [`${configurationRegister.value.model.provider}/${configurationRegister.value.model.modelId}`]
					: [];
			if (missingTools.length > 0 || missingModels.length > 0) {
				return { ok: false, error: missingIdentities(lane, missingTools, missingModels) };
			}

			const pendingRegisters = await Promise.all(
				laneStateRegister.value.pendingNextRun.map((id) => this.options.session.getRegister("pending.entry", id)),
			);
			const captured: Array<{ id: string; message: AgentMessage }> = [];
			for (let index = 0; index < pendingRegisters.length; index++) {
				const pending = pendingRegisters[index];
				const id = laneStateRegister.value.pendingNextRun[index]!;
				if (pending?.value.type !== "message" || pending.value.payload === undefined) {
					throw new Error(`Pending next-run item ${id} is invalid`);
				}
				const message = pending.value.payload as unknown as AgentMessage;
				const invalid = this.validateMessages([message], `pending.entry/${id}`);
				if (invalid !== undefined) throw new Error(invalid);
				captured.push({ id, message: structuredClone(message) });
			}

			const basisStart =
				adaptive === undefined || !isRecord(adaptive.basis.start) ? undefined : adaptive.basis.start.kind;
			if (captured.length + prompt.length + hookMessages.length === 0 && basisStart !== "exact_continuation") {
				return { ok: false, error: invalidMessage(lane, "acceptance would append no prompt entry") };
			}

			const writes: Transaction["writes"] = [];
			const entries: ProvisionedEntry[] = [];
			let parentId = leafRegister.value;
			let basisEntryId: string | undefined;
			if (adaptive !== undefined) {
				basisEntryId = this.options.session.idGenerator.next();
				const data = { ...structuredClone(adaptive.basis), operationId } satisfies JsonValue;
				const basisEntry = {
					id: basisEntryId,
					parentId,
					type: "custom",
					customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
					data,
				} satisfies ProvisionedEntry;
				entries.push(basisEntry);
				parentId = basisEntryId;
			}

			const promptEntryIds: string[] = [];
			for (const item of captured) {
				const id = item.id;
				entries.push({ id, parentId, type: "message", message: structuredClone(item.message) });
				promptEntryIds.push(id);
				parentId = id;
			}
			for (const message of [...prompt, ...hookMessages]) {
				const id = this.options.session.idGenerator.next();
				entries.push({ id, parentId, type: "message", message: structuredClone(message) });
				promptEntryIds.push(id);
				parentId = id;
			}
			for (const entry of entries) writes.push({ kind: "entry", entry });
			for (const item of captured) {
				writes.push({ kind: "register", op: "delete", namespace: "pending.entry", key: item.id });
			}

			const intent: Operation["intent"] = {
				kind: "run",
				promptEntryIds,
				...(basisEntryId === undefined ? {} : { adaptive: { basisEntryId } }),
				...(invalidHook === undefined && beforeRun?.systemPrompt !== undefined
					? { systemPromptOverride: beforeRun.systemPrompt }
					: {}),
				...(invalidHook === undefined && beforeRun?.resumeData !== undefined
					? { resumeData: beforeRun.resumeData as Record<string, JsonValue> }
					: {}),
			};
			const operation: Operation = {
				operationId,
				lane,
				sourceLeafId: leafRegister.value,
				startedAt: Date.now(),
				intent,
			};
			const state: RunState = {
				kind: "run",
				control: { status: "running" },
				settings: structuredClone(this.options.getRunSettings()),
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: parentId ?? basisEntryId ?? "",
					skipInboxOnce: true,
				},
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const nextLaneState: LaneState = { currentOperationId: operationId, pendingNextRun: [] };
			writes.push(
				{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: parentId },
				{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
				{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
				{ kind: "register", op: "set", namespace: "lane.state", key: lane, value: nextLaneState },
			);
			const result = await write({ writes });
			const operationStateIndex = writes.length - 2;
			const laneStateIndex = writes.length - 1;
			const current: CurrentOperation = {
				operation,
				state,
				operationStateSeq: result.seqs[operationStateIndex]!,
				laneState: nextLaneState,
				laneStateSeq: result.seqs[laneStateIndex]!,
				leafId: parentId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			const materialized = await this.options.session.getEntries(entries.map((entry) => entry.id));
			const committedEntries = entries.map((entry) => materialized.get(entry.id)!);
			this.options.onLaneState(lane, { kind: "open", current });
			this.options.events.emit({ type: "run_start", lane, runId: operationId });
			for (const entry of committedEntries) {
				if (entry.type === "message") {
					this.options.events.emit({ type: "message_start", lane, runId: operationId, message: entry.message });
					this.options.events.emit({
						type: "message_end",
						lane,
						runId: operationId,
						message: entry.message,
						entryId: entry.id,
					});
				}
				this.options.events.emit({ type: "entry_added", lane, entry });
			}
			await this.emitQueueUpdate(lane);
			return { ok: true, value: { current, entries: committedEntries } };
		});
	}

	private async acceptContinuation(
		lane: string,
		basis: AdaptiveRunBasisInput,
		options?: { systemPromptOverride?: string; resumeData?: Record<string, JsonValue> },
	): Promise<AdaptiveAdmissionResult> {
		try {
			if (!isRecord(basis) || !isRecord(basis.start) || basis.start.kind !== "exact_continuation") {
				return {
					ok: false,
					error: invalidMessage(lane, "exact continuation admission requires basis.start.kind exact_continuation"),
				};
			}
			try {
				assertJsonValue(basis, "adaptive.run_basis");
			} catch (error) {
				return { ok: false, error: invalidMessage(lane, error instanceof Error ? error.message : String(error)) };
			}
			if (options?.systemPromptOverride !== undefined && typeof options.systemPromptOverride !== "string") {
				return { ok: false, error: invalidMessage(lane, "systemPromptOverride must be a string") };
			}
			if (options?.resumeData !== undefined) {
				try {
					assertJsonValue(options.resumeData, "resumeData");
				} catch (error) {
					return {
						ok: false,
						error: invalidMessage(lane, error instanceof Error ? error.message : String(error)),
					};
				}
			}

			return this.options.coordinator.withSettingsAndLaneWriter(lane, async (_runtime, write) => {
				const [laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
					this.options.session.getRegister("lane.state", lane),
					this.options.session.getRegister("lane.leaf", lane),
					this.options.session.getRegister("lane.config", lane),
				]);
				if (laneStateRegister === undefined || leafRegister === undefined || configurationRegister === undefined) {
					throw new Error(`Lane ${lane} is missing required registers`);
				}
				if (laneStateRegister.value.currentOperationId !== null) {
					const operationRegister = await this.options.session.getRegister(
						"op.meta",
						laneStateRegister.value.currentOperationId,
					);
					if (operationRegister === undefined) throw new Error(`Lane ${lane} has missing operation metadata`);
					return { ok: false, error: laneBusy(lane, operationRegister.value) };
				}
				// A next-run queue item would require a prompt entry, which an
				// exact continuation must never append: reject instead of
				// silently capturing or dropping queued input.
				if (laneStateRegister.value.pendingNextRun.length > 0) {
					return {
						ok: false,
						error: invalidMessage(lane, "exact continuation admission must not capture pending next-run items"),
					};
				}

				const model = this.options.models.getModel(
					configurationRegister.value.model.provider,
					configurationRegister.value.model.modelId,
				);
				const availableTools = new Set(this.options.getTools().map((tool) => tool.name));
				const missingTools = configurationRegister.value.activeToolNames.filter(
					(name) => !availableTools.has(name),
				);
				const missingModels =
					model === undefined
						? [`${configurationRegister.value.model.provider}/${configurationRegister.value.model.modelId}`]
						: [];
				if (missingTools.length > 0 || missingModels.length > 0) {
					return { ok: false, error: missingIdentities(lane, missingTools, missingModels) };
				}

				const operationId = this.options.session.idGenerator.next();
				const basisEntryId = this.options.session.idGenerator.next();
				const data = { ...structuredClone(basis), operationId } satisfies JsonValue;
				const basisEntry = {
					id: basisEntryId,
					parentId: leafRegister.value,
					type: "custom",
					customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
					data,
				} satisfies ProvisionedEntry;
				const intent: Operation["intent"] = {
					kind: "run",
					promptEntryIds: [],
					adaptive: { basisEntryId },
					...(options?.systemPromptOverride === undefined
						? {}
						: { systemPromptOverride: options.systemPromptOverride }),
					...(options?.resumeData === undefined ? {} : { resumeData: structuredClone(options.resumeData) }),
				};
				const operation: Operation = {
					operationId,
					lane,
					sourceLeafId: leafRegister.value,
					startedAt: Date.now(),
					intent,
				};
				const state: RunState = {
					kind: "run",
					control: { status: "running" },
					settings: structuredClone(this.options.getRunSettings()),
					phase: {
						kind: "checkpoint",
						continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
						triggerEntryId: basisEntryId,
						skipInboxOnce: true,
					},
					inbox: { steer: [], followUp: [], writes: [] },
					latestAssistantEntryId: null,
				};
				const nextLaneState: LaneState = { currentOperationId: operationId, pendingNextRun: [] };
				const result = await write({
					writes: [
						{ kind: "entry", entry: basisEntry },
						{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: basisEntryId },
						{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
						{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
						{ kind: "register", op: "set", namespace: "lane.state", key: lane, value: nextLaneState },
					],
				});
				const current: CurrentOperation = {
					operation,
					state,
					operationStateSeq: result.seqs[3]!,
					laneState: nextLaneState,
					laneStateSeq: result.seqs[4]!,
					leafId: basisEntryId,
					configuration: structuredClone(configurationRegister.value),
					configurationSeq: configurationRegister.seq,
				};
				const materialized = (await this.options.session.getEntries([basisEntryId])).get(basisEntryId);
				if (materialized === undefined) {
					throw new SessionError("corruption", `Run basis entry ${basisEntryId} is missing`);
				}
				this.options.onLaneState(lane, { kind: "open", current });
				this.options.events.emit({ type: "run_start", lane, runId: operationId });
				this.options.events.emit({ type: "entry_added", lane, entry: materialized });
				await this.emitQueueUpdate(lane);
				return { ok: true, value: { runId: operationId, operationId, basisEntryId } };
			});
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	private async capturePostTurn<T>(
		lane: string,
		callback: (info: PostTurnCheckpointInfo) => T | Promise<T>,
	): Promise<Result<T, PostTurnCheckpointRejection>> {
		try {
			return await this.options.coordinator.mutateLane(lane, async () => {
				const restored = await restoreLane(this.options.session, lane);
				if (restored.kind === "idle") return { ok: false, error: noActiveOperationError(lane) };
				const current = restored.current;
				const operationId = current.operation.operationId;
				const reject = (reason: string): { ok: false; error: PostTurnCheckpointRejection } => {
					const message = `Lane ${lane} is not at a post-turn continuation checkpoint: ${reason}`;
					return {
						ok: false,
						error: taggedError("NotPostTurnCheckpoint", message, { lane, operationId, reason, message }),
					};
				};
				const state = current.state;
				if (state.kind !== "run") return reject(`open operation is ${state.kind}`);
				if (state.control.status !== "running") return reject("operation is cancelling");
				if (state.phase.kind !== "checkpoint" || state.phase.continuation.kind !== "need_assistant") {
					return reject(`run phase is ${state.phase.kind}`);
				}
				const inbox = state.inbox;
				if (inbox.steer.length + inbox.followUp.length + inbox.writes.length > 0) {
					return reject("pending queue input exists");
				}
				if (state.latestAssistantEntryId === null) return reject("no completed assistant turn");
				if (current.leafId === null) return reject("lane has no leaf");
				const info: PostTurnCheckpointInfo = {
					lane,
					operationId,
					turnCursor: { assistantEntryId: state.latestAssistantEntryId, leafId: current.leafId },
					triggerEntryId: state.phase.triggerEntryId,
					configuration: structuredClone(current.configuration),
				};
				const value = await callback(info);
				const [stateRegister, laneStateRegister, leafRegister] = await Promise.all([
					this.options.session.getRegister("op.state", operationId),
					this.options.session.getRegister("lane.state", lane),
					this.options.session.getRegister("lane.leaf", lane),
				]);
				if (
					stateRegister === undefined ||
					stateRegister.seq !== current.operationStateSeq ||
					laneStateRegister?.value.currentOperationId !== operationId ||
					leafRegister?.value !== current.leafId
				) {
					const message = `The post-turn checkpoint of ${operationId} changed during capture`;
					return { ok: false, error: taggedError("CheckpointChanged", message, { lane, operationId, message }) };
				}
				return { ok: true, value };
			});
		} catch (error) {
			if (error instanceof HarnessClosedError) return { ok: false, error: closedError() };
			throw error;
		}
	}

	/**
	 * Pre-dispatch second gate for exact continuations. Armed only while the
	 * Run's basis declares `exact_continuation` and no assistant generation
	 * has ever settled (`latestAssistantEntryId === null`); the first provider
	 * dispatch of the Run must re-verify the canonical request before the
	 * provider intent commits.
	 */
	private async verifyFirstAssistantDispatch(
		current: CurrentOperation,
		plan: Extract<EffectPlan, { kind: "assistant" }>,
	): Promise<void> {
		const gate = this.options.exactContinuationDispatchGate;
		if (gate === undefined) return;
		const state = current.state;
		if (state.kind !== "run" || state.latestAssistantEntryId !== null) return;
		const intent = current.operation.intent;
		if (intent.kind !== "run" || intent.adaptive === undefined) return;
		const basisEntryId = intent.adaptive.basisEntryId;
		const basisEntry = (await this.options.session.getEntries([basisEntryId])).get(basisEntryId);
		if (
			basisEntry === undefined ||
			basisEntry.type !== "custom" ||
			basisEntry.customType !== ADAPTIVE_RUN_BASIS_CUSTOM_TYPE ||
			!isRecord(basisEntry.data) ||
			!isRecord(basisEntry.data.start) ||
			basisEntry.data.start.kind !== "exact_continuation"
		) {
			return;
		}
		const lane = current.operation.lane;
		const branch =
			current.leafId === null
				? []
				: await this.options.session
						.view(lane)
						.findEntriesOnBranch({ start: current.leafId, order: "oldestFirst" });
		const messages = await buildContextMessages(branch, {
			customEntryProjectors: this.options.entryProjectors,
		});
		const systemPrompt =
			intent.systemPromptOverride !== undefined ? intent.systemPromptOverride : await this.resolveSystemPrompt();
		const providerMessages = await (this.options.toProviderMessages ?? convertToLlm)(structuredClone(messages));
		const facts: ExactContinuationDispatchFacts = {
			lane,
			operationId: current.operation.operationId,
			basisEntryId,
			basisData: structuredClone(basisEntry.data),
			configuration: structuredClone(plan.generation.context.configuration),
			systemPrompt,
			messages,
			providerMessages,
			tools: this.activeTools(plan.generation.context.configuration),
			streamOptions: structuredClone(plan.streamOptions),
			hooksRegistered: {
				transformContext: this.options.hooks.has("transform_context"),
				beforeRequest: this.options.hooks.has("before_request"),
				beforePayload: this.options.hooks.has("before_payload"),
			},
			customMessageTransform: this.options.toProviderMessages !== undefined,
		};
		const verified = await gate.verifyFirstDispatch(facts);
		if (verified?.metadataPatch === undefined) return;
		plan.streamOptions = {
			...plan.streamOptions,
			metadata: { ...(plan.streamOptions.metadata ?? {}), ...structuredClone(verified.metadataPatch) },
		};
	}

	private async commitTransition(
		current: CurrentOperation,
		next: OperationState,
		expectedConfigurationSeq?: number,
		expectedSettingsRevision?: number,
	): Promise<CurrentOperation | undefined> {
		const committed = await this.options.coordinator.commitTransition(
			current,
			next,
			expectedConfigurationSeq,
			expectedSettingsRevision,
		);
		if (committed !== undefined)
			this.options.onLaneState(current.operation.lane, { kind: "open", current: committed });
		return committed;
	}

	/**
	 * R5 drain transaction: source-ordered entries, pending register deletes,
	 * lane.leaf move, and the inbox/continuation/trigger/skipInboxOnce update
	 * happen atomically. The consumed ids must still form oldest-first
	 * prefixes of the latest durable inbox; otherwise the plan is stale and
	 * the interpreter re-restores and replans.
	 */
	private async commitInboxDrain(
		current: CurrentOperation,
		plan: InboxDrainPlan,
	): Promise<{ current: CurrentOperation; entries: Entry[] } | undefined> {
		const lane = current.operation.lane;
		const committed = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				leafRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				// External finalization or a vanished operation: replan.
				return undefined;
			}
			const state = stateRegister.value;
			if (state.kind !== "run") return undefined;
			const phase = state.phase;
			if (phase.kind !== "checkpoint" && phase.kind !== "failure_drain") {
				return undefined;
			}
			if (phase.kind !== plan.source.kind) return undefined;
			if (
				phase.kind === "checkpoint" &&
				plan.source.kind === "checkpoint" &&
				phase.continuation.kind !== plan.source.continuation
			) {
				return undefined;
			}
			// R6: a cancelled operation must never consume steer/follow-up
			// again, even when a stale pre-abort drain plan is released later.
			if (
				state.control.status === "cancel_requested" &&
				(plan.consumedSteer.length > 0 || plan.consumedFollowUp.length > 0)
			) {
				return undefined;
			}
			const inbox = state.inbox;
			const isPrefix = (consumed: readonly string[], list: readonly string[]): boolean =>
				consumed.length <= list.length && consumed.every((id, index) => list[index] === id);
			if (
				!isPrefix(plan.consumedWrites, inbox.writes) ||
				!isPrefix(plan.consumedSteer, inbox.steer) ||
				!isPrefix(plan.consumedFollowUp, inbox.followUp)
			) {
				return undefined;
			}
			const writes: Transaction["writes"] = [];
			let parentId = leafRegister.value;
			for (const item of plan.entries) {
				if (item.type === "message") {
					if (item.message === undefined) {
						throw new SessionError("corruption", `Drain entry ${item.id} has no message payload`);
					}
					writes.push({
						kind: "entry",
						entry: { id: item.id, parentId, type: "message", message: structuredClone(item.message) },
					});
				} else {
					if (item.customType === undefined) {
						throw new SessionError("corruption", `Drain entry ${item.id} has no customType`);
					}
					writes.push({
						kind: "entry",
						entry: {
							id: item.id,
							parentId,
							type: "custom",
							customType: item.customType,
							...(item.data === undefined ? {} : { data: structuredClone(item.data) }),
						},
					});
				}
				parentId = item.id;
			}
			if (plan.entries.length > 0) {
				writes.push({ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: parentId });
			}
			for (const id of [...plan.consumedWrites, ...plan.consumedSteer, ...plan.consumedFollowUp]) {
				writes.push({ kind: "register", op: "delete", namespace: "pending.entry", key: id });
			}
			const next: RunState = {
				...structuredClone(state),
				inbox: {
					steer: inbox.steer.slice(plan.consumedSteer.length),
					followUp: inbox.followUp.slice(plan.consumedFollowUp.length),
					writes: inbox.writes.slice(plan.consumedWrites.length),
				},
				phase: plan.next.phase,
			};
			writes.push({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: current.operation.operationId,
				value: next,
			});
			const result = await write({ writes });
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[writes.length - 1]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: parentId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			const materialized =
				plan.entries.length === 0
					? new Map<string, Entry>()
					: await this.options.session.getEntries(plan.entries.map((entry) => entry.id));
			const entries = plan.entries.map((entry) => {
				const value = materialized.get(entry.id);
				if (value === undefined) {
					throw new SessionError("corruption", `Drained entry ${entry.id} is missing`);
				}
				return value;
			});
			return { current: nextCurrent, entries };
		});
		if (committed === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: committed.current });
		for (const entry of committed.entries) this.emitPlacedEntry(lane, entry);
		await this.emitQueueUpdate(lane);
		return committed;
	}

	private get telemetry(): TelemetryContext {
		return this.options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
	}

	private resolveModel(configuration: LaneConfiguration): Model<Api> {
		const model = this.options.models.getModel(configuration.model.provider, configuration.model.modelId);
		if (model === undefined)
			throw new Error(`Model ${configuration.model.provider}/${configuration.model.modelId} disappeared`);
		return model;
	}

	private activeTools(configuration: LaneConfiguration): AgentTool[] {
		const byName = new Map(this.options.getTools().map((tool) => [tool.name, tool]));
		return configuration.activeToolNames.map((name) => {
			const tool = byName.get(name);
			if (tool === undefined) throw new Error(`Tool ${name} disappeared`);
			return tool as unknown as AgentTool;
		});
	}

	private async runEffect(plan: EffectPlan): Promise<EffectOutput> {
		if (plan.kind === "cancel_deferred") return this.runCancelDeferred(plan);
		const operation = this.effectOwners.get(plan.key);
		if (operation === undefined) throw new Error(`Effect ${plan.key} has no live owner`);
		// R6 start-check: every real external effect re-enters the lane
		// mutation line after its durable intent committed. Abort-first means
		// not_started; an externally finalized operation stops the driver.
		if (plan.kind === "assistant" || plan.kind === "tool" || plan.kind === "hook") {
			const start = await this.effectStartCheck(operation, plan);
			if (start !== undefined) return start;
		}
		if (plan.kind === "tool") return this.runToolEffect(plan, operation);
		if (plan.kind === "hook") return this.runHookEffect(plan, operation);
		if (plan.kind !== "assistant") throw new HarnessNotImplementedError(`effect ${plan.kind}`);
		const model = this.resolveModel(plan.generation.context.configuration);
		const branch =
			operation.leafId === null
				? []
				: await this.options.session.view(operation.operation.lane).findEntriesOnBranch({
						start: operation.leafId,
						order: "oldestFirst",
					});
		const messages = await buildContextMessages(branch, {
			customEntryProjectors: this.options.entryProjectors,
		});
		const systemPrompt =
			operation.operation.intent.kind === "run" && operation.operation.intent.systemPromptOverride !== undefined
				? operation.operation.intent.systemPromptOverride
				: await this.resolveSystemPrompt();
		const emit = async (event: AgentEvent): Promise<void> => {
			switch (event.type) {
				case "message_start":
					this.options.events.emit({
						type: "message_start",
						lane: operation.operation.lane,
						runId: operation.operation.operationId,
						message: event.message,
					});
					return;
				case "message_update":
					this.options.events.emit({
						type: "message_update",
						lane: operation.operation.lane,
						runId: operation.operation.operationId,
						message: event.message,
						event: event.assistantMessageEvent,
					});
					return;
				case "message_end":
					this.options.events.emit({
						type: "message_end",
						lane: operation.operation.lane,
						runId: operation.operation.operationId,
						message: event.message,
						entryId: plan.generation.responseEntryId,
					});
					return;
				default:
					return;
			}
		};
		const message = await streamAssistant(
			messages,
			{
				model,
				thinkingLevel: plan.generation.context.configuration.thinkingLevel,
				systemPrompt,
				tools: this.activeTools(plan.generation.context.configuration),
				transformContext: this.options.hooks.has("transform_context")
					? async (input) => {
							const transformed = await this.options.coordinator.gate.run(
								actionInfo("hook", "Run transform_context hook"),
								() =>
									this.options.hooks.run("transform_context", {
										lane: operation.operation.lane,
										runId: operation.operation.operationId,
										messages: input,
									}),
								{ operationId: operation.operation.operationId, onCancel: () => undefined },
							);
							if (transformed?.messages === undefined) return input;
							const invalid = this.validateMessages(transformed.messages, "transform_context.messages");
							if (invalid === undefined) return transformed.messages;
							this.options.events.emit({
								type: "handler_error",
								kind: "hook",
								hook: "transform_context",
								error: invalid,
								lane: operation.operation.lane,
							});
							return input;
						}
					: undefined,
				toProviderMessages: this.options.toProviderMessages ?? convertToLlm,
				models: this.options.models,
				streamOptions: plan.streamOptions,
				transformPayload: this.options.hooks.has("before_payload")
					? (payload) =>
							this.options.coordinator.gate
								.run(
									actionInfo("hook", "Run before_payload hook"),
									() =>
										this.options.hooks.run("before_payload", {
											lane: operation.operation.lane,
											runId: operation.operation.operationId,
											model,
											payload,
										}),
									{ operationId: operation.operation.operationId, onCancel: () => undefined },
								)
								.then((result) => result?.payload)
					: undefined,
				transformResponse: this.options.hooks.has("after_response")
					? async (response, metadata) => {
							const transformed = await this.options.coordinator.gate.run(
								actionInfo("hook", "Run after_response hook"),
								() =>
									this.options.hooks.run("after_response", {
										lane: operation.operation.lane,
										runId: operation.operation.operationId,
										...metadata,
										message: response,
									}),
								{ operationId: operation.operation.operationId, onCancel: () => undefined },
							);
							if (transformed?.message === undefined) return response;
							const invalid = this.validateMessages([transformed.message], "after_response.message");
							if (invalid === undefined) return transformed.message;
							this.options.events.emit({
								type: "handler_error",
								kind: "hook",
								hook: "after_response",
								error: invalid,
								lane: operation.operation.lane,
							});
							return response;
						}
					: undefined,
				telemetryContext: this.telemetry,
				signal: this.options.coordinator.operationSignal(operation.operation.operationId),
			},
			emit,
		);
		return { kind: "assistant", key: plan.key, message };
	}

	/**
	 * Linearized pre-execution check for every real external effect: running
	 * control with the still-owned intent registers the effect as started;
	 * a durable cancel marker resolves not_started without touching the
	 * provider; a vanished operation is external finalization.
	 */
	private async effectStartCheck(operation: CurrentOperation, plan: EffectPlan): Promise<EffectOutput | undefined> {
		return this.options.coordinator.mutateLane(operation.operation.lane, async () => {
			const operationId = operation.operation.operationId;
			const lane = operation.operation.lane;
			const [stateRegister, laneStateRegister, lastResultRegister] = await Promise.all([
				this.options.session.getRegister("op.state", operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.lastResult", lane),
			]);
			if (stateRegister === undefined) {
				if (
					laneStateRegister?.value.currentOperationId === null &&
					lastResultRegister?.value.operationId === operationId
				) {
					throw new OperationExternallyFinalizedError(operationId);
				}
				throw new SessionError("corruption", `Operation ${operationId} lost its state while still current`);
			}
			const state = stateRegister.value;
			if (state.control.status === "cancel_requested") return { kind: "not_started", key: plan.key };
			if (plan.kind === "hook") return undefined;
			let ownsIntent: boolean;
			if (plan.kind === "assistant") {
				ownsIntent =
					state.kind === "run" &&
					state.phase.kind === "assistant" &&
					state.phase.generation.status === "effect_pending" &&
					state.phase.generation.attempt === plan.generation.attempt &&
					state.phase.generation.responseEntryId === plan.generation.responseEntryId;
			} else if (plan.kind === "tool") {
				ownsIntent =
					state.kind === "run" &&
					state.phase.kind === "tools" &&
					state.phase.batch.turnId === plan.turnId &&
					state.phase.batch.calls[plan.sourceIndex]?.status === "effect_pending";
			} else {
				ownsIntent = true;
			}
			return ownsIntent ? undefined : { kind: "not_started", key: plan.key };
		});
	}

	/**
	 * R6 best-effort deferred cancellation: captured provider/model/handle
	 * identity, close-only signal, process-local once per operation source.
	 * Failures are telemetry-only and never block the aborted terminal.
	 */
	private async runCancelDeferred(plan: Extract<EffectPlan, { kind: "cancel_deferred" }>): Promise<EffectOutput> {
		try {
			const model = this.options.models.getModel(plan.handle.provider, plan.handle.modelId);
			const provider = this.options.models.getProvider(plan.handle.provider);
			if (model !== undefined && provider?.cancelDeferred !== undefined) {
				await this.options.models.cancelDeferred(model, structuredClone(plan.handle), {
					signal: this.options.coordinator.signal,
				});
			}
			return { kind: "cancel_deferred", key: plan.key };
		} catch (error) {
			// Telemetry/fault callback only: no durable failure settlement.
			this.options.events.emit({
				type: "handler_error",
				kind: "event",
				event: "cancel_deferred",
				error: error instanceof Error ? error.message : String(error),
			});
			return { kind: "cancel_deferred", key: plan.key };
		}
	}

	private async runHookEffect(
		plan: Extract<EffectPlan, { kind: "hook" }>,
		operation: CurrentOperation,
	): Promise<EffectOutput> {
		if (plan.name !== "before_run_end") throw new HarnessNotImplementedError(`hook effect ${plan.name}`);
		const branch =
			operation.leafId === null
				? []
				: await this.options.session
						.view(operation.operation.lane)
						.findEntriesOnBranch({ start: operation.leafId, order: "oldestFirst" });
		const messages = await buildContextMessages(branch, {
			customEntryProjectors: this.options.entryProjectors,
		});
		const result = await this.options.hooks.run("before_run_end", {
			lane: operation.operation.lane,
			runId: operation.operation.operationId,
			messages,
		});
		return { kind: "hook", key: plan.key, result };
	}

	private async commitEffectSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
	): Promise<SettlementResult | undefined> {
		if (plan.kind === "tool") {
			return this.commitToolSettlement(current, plan, output as Extract<SettlementOutput, { kind: "tool" }>);
		}
		if (plan.kind === "hook") {
			return this.commitHookSettlement(current, output as Extract<SettlementOutput, { kind: "hook" }>);
		}
		if (plan.kind !== "assistant" || output.kind !== "assistant") {
			throw new HarnessNotImplementedError("non-assistant settlement");
		}
		const lane = current.operation.lane;
		const settled = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				leafRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			// R5 concurrent-merge: no seq CAS here. Verify the effect identity is
			// still pending, then rebuild the successor from the LATEST state so
			// concurrent queue/write admissions are preserved verbatim.
			if (stateRegister.value.kind !== "run" || stateRegister.value.phase.kind !== "assistant") {
				return undefined;
			}
			const generation = stateRegister.value.phase.generation;
			if (
				generation.status !== "effect_pending" ||
				generation.attempt !== plan.generation.attempt ||
				generation.responseEntryId !== plan.generation.responseEntryId ||
				generation.usageId !== plan.generation.usageId
			) {
				return undefined;
			}
			// R6 cancellation settlement: the durable cancel marker decides the
			// successor, never the ordinary classifier. A cancelled operation
			// only ever writes an aborted response (live usage when available,
			// zero usage for not-started/restored synthetics) and moves into a
			// cancellation checkpoint instead of retry/tools/deferred. Under a
			// running control an aborted provider output is never persisted as
			// an aborted entry: it normalizes to an ordinary error.
			const cancelled = stateRegister.value.control.status === "cancel_requested";
			const message = cancelled
				? { ...structuredClone(output.message), stopReason: "aborted" as const }
				: output.message.stopReason === "aborted"
					? {
							...structuredClone(output.message),
							stopReason: "error" as const,
							errorMessage:
								output.message.errorMessage ?? "Provider response was aborted without a harness cancellation",
						}
					: structuredClone(output.message);
			const next: RunState = {
				...structuredClone(stateRegister.value),
				latestAssistantEntryId: plan.generation.responseEntryId,
				phase: cancelled
					? {
							kind: "checkpoint",
							continuation: { kind: "may_finish", includeFinalAssistant: true },
							triggerEntryId: plan.generation.responseEntryId,
						}
					: settlementPhase(
							classifyGenerationOutcome(message, plan.generation, Date.now()),
							plan.generation,
							plan.generation.responseEntryId,
							message,
							() => this.options.session.idGenerator.next(),
							current.operation.intent.kind === "run" && current.operation.intent.adaptive !== undefined,
						),
			};
			const writes: Transaction["writes"] = [
				{
					kind: "entry",
					entry: {
						id: plan.generation.responseEntryId,
						parentId: leafRegister.value,
						type: "message",
						message,
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: plan.generation.responseEntryId },
				{
					kind: "usage",
					row: {
						id: plan.generation.usageId,
						entryId: plan.generation.responseEntryId,
						usage: structuredClone(message.usage ?? zeroUsage()),
						adjustment: false,
					},
				},
				{ kind: "register", op: "set", namespace: "op.state", key: current.operation.operationId, value: next },
			];
			const result = await write({ writes });
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[3]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: plan.generation.responseEntryId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			const entry = (await this.options.session.getEntries([plan.generation.responseEntryId])).get(
				plan.generation.responseEntryId,
			)!;
			const row: UsageRow = {
				id: plan.generation.usageId,
				seq: result.seqs[2]!,
				entryId: plan.generation.responseEntryId,
				usage: structuredClone(message.usage ?? zeroUsage()),
				adjustment: false,
			};
			return { current: nextCurrent, entry, row };
		});
		if (settled === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: settled.current });
		this.options.events.emit({ type: "entry_added", lane, entry: settled.entry });
		this.options.events.emit({
			type: "usage",
			lane,
			row: settled.row,
			totals: (await this.options.session.getStats()).usage,
		});
		return { current: settled.current, settledEntry: settled.entry };
	}

	/**
	 * before_run_end settlement: stale results (queue/control/operation
	 * changed while the hook ran) are discarded for replan; a returned
	 * follow-up is born placed in the same transaction as the need_assistant
	 * state and never passes through pending.entry.
	 */
	private async commitHookSettlement(
		current: CurrentOperation,
		output: Extract<SettlementOutput, { kind: "hook" }>,
	): Promise<SettlementResult | undefined> {
		const lane = current.operation.lane;
		const settled = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				leafRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			const state = stateRegister.value;
			const stale =
				state.kind !== "run" ||
				state.phase.kind !== "checkpoint" ||
				state.phase.continuation.kind !== "may_finish" ||
				state.inbox.steer.length > 0 ||
				state.inbox.followUp.length > 0 ||
				state.inbox.writes.length > 0 ||
				state.control.status !== "running";
			if (stale) return undefined;
			const hookResult = output.result as { followUp?: string } | undefined;
			const followUp =
				typeof hookResult?.followUp === "string" && hookResult.followUp.length > 0
					? hookResult.followUp
					: undefined;
			const fresh: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: structuredClone(state),
				operationStateSeq: stateRegister.seq,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: leafRegister.value,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			if (followUp === undefined) {
				return { current: fresh, hookConsumed: true as const };
			}
			const entryId = this.options.session.idGenerator.next();
			const message: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: followUp }],
				timestamp: Date.now(),
			};
			const next: RunState = {
				...structuredClone(state),
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: entryId,
					skipInboxOnce: true,
				},
			};
			const result = await write({
				writes: [
					{ kind: "entry", entry: { id: entryId, parentId: leafRegister.value, type: "message", message } },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: entryId },
					{ kind: "register", op: "set", namespace: "op.state", key: current.operation.operationId, value: next },
				],
			});
			const entry = (await this.options.session.getEntries([entryId])).get(entryId)!;
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[2]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: entryId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			return { current: nextCurrent, entry, hookConsumed: true as const };
		});
		if (settled === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: settled.current });
		if (settled.entry !== undefined) {
			this.emitPlacedEntry(lane, settled.entry);
		}
		return settled.entry === undefined
			? { current: settled.current, hookConsumed: true }
			: { current: settled.current, settledEntry: settled.entry, hookConsumed: true };
	}

	// R4 durable tool phase

	private readonly batchContexts = new Map<string, Promise<TContext>>();

	private batchContext(turnId: string): Promise<TContext> {
		const existing = this.batchContexts.get(turnId);
		if (existing !== undefined) return existing;
		const promise = this.options.coordinator.gate.run(actionInfo("hook", "Resolve tool context for batch"), () =>
			this.resolveToolContext(),
		);
		this.batchContexts.set(turnId, promise);
		return promise;
	}

	private toolByName(name: string): AgentHarnessTool<TContext> | undefined {
		return this.options.getTools().find((tool) => tool.name === name);
	}

	private async loadAssistantEntry(assistantEntryId: string): Promise<Extract<Entry, { type: "message" }>> {
		const entry = (await this.options.session.getEntries([assistantEntryId])).get(assistantEntryId);
		if (entry === undefined || entry.type !== "message" || entry.message.role !== "assistant") {
			throw new Error(`Assistant entry ${assistantEntryId} is not a message`);
		}
		return entry as Extract<Entry, { type: "message" }>;
	}

	private async toolCallFromAssistant(assistantEntryId: string, sourceIndex: number): Promise<AgentToolCall> {
		const entry = await this.loadAssistantEntry(assistantEntryId);
		const content = (entry.message as { content: unknown }).content as ReadonlyArray<unknown>;
		const call = content.filter((part) => (part as { type?: string }).type === "toolCall")[sourceIndex];
		if (call === undefined || (call as { type?: string }).type !== "toolCall") {
			throw new Error(`Tool call ${sourceIndex} is missing from ${assistantEntryId}`);
		}
		return call as AgentToolCall;
	}

	private async toolArgsForPlan(
		plan: Extract<EffectPlan, { kind: "tool" }>,
	): Promise<{ toolCallId: string; toolName: string; args: Record<string, JsonValue> }> {
		const call = await this.toolCallFromAssistant(plan.assistantEntryId, plan.sourceIndex);
		if (plan.args.kind === "register") {
			const register = await this.options.session.getRegister("op.tool_args", plan.args.key);
			if (register === undefined) throw new Error(`Tool args register ${plan.args.key} missing`);
			return { toolCallId: call.id, toolName: call.name, args: structuredClone(register.value) };
		}
		const entry = (await this.options.session.getEntries([plan.args.entryId])).get(plan.args.entryId);
		if (entry === undefined || entry.type !== "custom") {
			throw new Error(`Tool batch entry ${plan.args.entryId} is not a custom entry`);
		}
		const decisions = (entry.data as { decisions?: Array<{ effectiveArgs?: Record<string, JsonValue> }> } | undefined)
			?.decisions;
		const decision = decisions?.[plan.sourceIndex];
		if (decision?.effectiveArgs === undefined) {
			throw new Error(`Tool batch entry ${plan.args.entryId} has no effective args for ${plan.sourceIndex}`);
		}
		return { toolCallId: call.id, toolName: call.name, args: structuredClone(decision.effectiveArgs) };
	}

	private errorToolResult(message: string): AgentToolResult<unknown> {
		return { content: [{ type: "text", text: message }], details: {} };
	}

	private async runToolEffect(
		plan: Extract<EffectPlan, { kind: "tool" }>,
		operation: CurrentOperation,
	): Promise<EffectOutput> {
		const lane = operation.operation.lane;
		const runId = operation.operation.operationId;
		const { toolCallId, toolName, args } = await this.toolArgsForPlan(plan);
		const tool = this.toolByName(toolName);
		if (tool === undefined) throw new Error(`Tool ${toolName} disappeared`);
		const context = await this.batchContext(plan.turnId);
		this.options.events.emit({
			type: "tool_start",
			lane,
			runId,
			turnId: plan.turnId,
			toolCallId,
			toolName,
			args,
			...(plan.recovery === true ? { recovery: true as const } : {}),
		});
		try {
			const updateEvents: Promise<void>[] = [];
			let acceptingUpdates = true;
			const result = await tool.execute(
				toolCallId,
				args as never,
				this.options.coordinator.operationSignal(operation.operation.operationId),
				(partialResult) => {
					if (!acceptingUpdates) return;
					updateEvents.push(
						Promise.resolve(
							this.options.events.emit({
								type: "tool_update",
								lane,
								runId,
								turnId: plan.turnId,
								toolCallId,
								toolName,
								partialResult,
							}),
						),
					);
				},
				context,
			);
			acceptingUpdates = false;
			await Promise.all(updateEvents);
			return { kind: "tool_raw", key: plan.key, result: result as AgentToolResult<unknown>, isError: false };
		} catch (error) {
			return {
				kind: "tool_raw",
				key: plan.key,
				result: this.errorToolResult(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		}
	}

	private async finalizeToolEffect(
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<EffectOutput, { kind: "tool_raw" }>,
	): Promise<Extract<SettlementOutput, { kind: "tool" }>> {
		const operation = this.effectOwners.get(plan.key);
		if (operation === undefined) throw new Error(`Tool effect ${plan.key} has no live owner`);
		const { toolCallId, toolName, args } = await this.toolArgsForPlan(plan);
		let result = output.result;
		let isError = output.isError;
		// R6: after_tool runs only when it was already registered as started;
		// an abort committed before the hook start-check skips the hook.
		const aborted = this.options.coordinator.operationSignal(operation.operation.operationId).aborted;
		if (this.options.hooks.has("after_tool") && !aborted) {
			const hook = await this.options.coordinator.gate.run(
				actionInfo("hook", "Run after_tool hook"),
				() =>
					this.options.hooks.run("after_tool", {
						lane: operation.operation.lane,
						runId: operation.operation.operationId,
						toolCallId,
						toolName,
						args,
						content: result.content,
						details: result.details as JsonValue | undefined,
						isError,
						...(result.usage === undefined ? {} : { usage: result.usage }),
					}),
				{ operationId: operation.operation.operationId, onCancel: () => undefined },
			);
			if (hook !== undefined) {
				result = {
					...result,
					content: hook.content ?? result.content,
					details: hook.details ?? result.details,
					usage: hook.usage ?? result.usage,
					terminate: hook.terminate ?? result.terminate,
				};
				isError = hook.isError ?? isError;
			}
		}
		// Normalize an invalid tool return value before it can reach storage.
		const candidate: ToolResultMessage = {
			role: "toolResult",
			toolCallId,
			toolName,
			content: result.content ?? [],
			details: result.details,
			...(result.usage === undefined ? {} : { usage: result.usage }),
			isError,
			timestamp: Date.now(),
		};
		try {
			this.codec.validateMessage(candidate, "tool.result");
		} catch (error) {
			result = this.errorToolResult(
				`Tool returned an invalid result: ${error instanceof Error ? error.message : String(error)}`,
			);
			isError = true;
		}
		return { kind: "tool", key: plan.key, result, isError, terminate: result.terminate === true };
	}

	private async prepareToolCall(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
	): Promise<ToolPreparation> {
		const call = await this.toolCallFromAssistant(batch.assistantEntryId, sourceIndex);
		const tool = this.toolByName(call.name);
		if (tool === undefined) {
			return { kind: "immediate", result: this.errorToolResult(`Tool ${call.name} not found`), terminate: false };
		}
		try {
			const preparedCall = prepareToolCallArguments(tool as unknown as AgentTool, call);
			const validated = validateToolArguments(tool, preparedCall) as Record<string, JsonValue>;
			assertJsonValue(validated, "tool.arguments");
			let effectiveArgs = validated;
			// R6: before_tool runs only when it was already started; a durable
			// abort before the hook start-check skips the hook (commitToolIntent
			// then rejects the intent and the cancellation planner takes over).
			const aborted = this.options.coordinator.operationSignal(current.operation.operationId).aborted;
			if (this.options.hooks.has("before_tool") && !aborted) {
				const hook = await this.options.coordinator.gate.run(
					actionInfo("hook", "Run before_tool hook"),
					() =>
						this.options.hooks.run("before_tool", {
							lane: current.operation.lane,
							runId: current.operation.operationId,
							toolCallId: call.id,
							toolName: call.name,
							args: structuredClone(validated),
						}),
					{ operationId: current.operation.operationId, onCancel: () => undefined },
				);
				if (hook?.block !== undefined) {
					return {
						kind: "immediate",
						result: this.errorToolResult(hook.block.reason),
						terminate: hook.block.terminate === true,
					};
				}
				if (hook?.args !== undefined) {
					// Replaced arguments must pass schema validation again.
					const replaced = { ...preparedCall, arguments: hook.args };
					const revalidated = validateToolArguments(tool, replaced) as Record<string, JsonValue>;
					assertJsonValue(revalidated, "tool.arguments");
					effectiveArgs = revalidated;
				}
			}
			return { kind: "prepared", args: effectiveArgs, replay: tool.replay ?? "never" };
		} catch (error) {
			return {
				kind: "immediate",
				result: this.errorToolResult(error instanceof Error ? error.message : String(error)),
				terminate: false,
			};
		}
	}

	private async clearAdaptiveBatch(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
	): Promise<AdaptiveClearanceComposed> {
		const assistantEntry = await this.loadAssistantEntry(batch.assistantEntryId);
		const allCalls = ((assistantEntry.message as { content: unknown }).content as ReadonlyArray<unknown>).filter(
			(part) => (part as { type?: string }).type === "toolCall",
		) as AgentToolCall[];
		const tools = this.activeTools(batch.configuration);
		let clearance: { policyStateFingerprint: string; decisions: AdaptiveToolClearanceDecision[] };
		try {
			clearance = await this.options.coordinator.gate.run(
				actionInfo("hook", "Run adaptive tool batch clearance"),
				async () => {
					const policy = this.options.adaptiveToolPolicy;
					if (policy === undefined) throw new Error("Adaptive Runs require a ToolPolicy clearance adapter");
					return policy.clearBatch({
						batch,
						assistantEntry,
						calls: allCalls
							.map((call, index) => ({ sourceIndex: index, call }))
							.filter(({ sourceIndex }) => {
								const durable = batch.calls[sourceIndex];
								return durable?.status === "planned" && durable.truncated === true
									? false
									: durable?.status === "planned";
							}),
						tools: tools as unknown as AgentTool[],
						sessionId: this.options.session.metadata.id,
						lane: current.operation.lane,
						operationId: current.operation.operationId,
						basisEntryId:
							current.operation.intent.kind === "run"
								? current.operation.intent.adaptive?.basisEntryId
								: undefined,
					});
				},
			);
		} catch (error) {
			const reason = `ToolPolicy fault: ${error instanceof Error ? error.message : String(error)}`;
			clearance = {
				policyStateFingerprint: "policy-fault",
				decisions: allCalls.map((call, index) => ({
					kind: "block",
					sourceIndex: index,
					toolCallId: call.id,
					toolName: call.name,
					replay: "never",
					reason,
				})),
			};
		}
		const byIndex = new Map(clearance.decisions.map((decision) => [decision.sourceIndex, decision]));
		const decisions: AdaptiveToolClearanceDecision[] = allCalls.map((call, index) => {
			const durableCall = batch.calls[index];
			if (durableCall?.status === "planned" && durableCall.truncated === true) {
				return {
					kind: "block",
					sourceIndex: index,
					toolCallId: call.id,
					toolName: call.name,
					replay: "never",
					reason: truncatedToolResultText(call.name),
				};
			}
			const decision = byIndex.get(index);
			if (decision === undefined) {
				throw new Error("ToolPolicy clearance did not cover every tool call");
			}
			if (durableCall?.status !== "planned") {
				return {
					kind: "block",
					sourceIndex: index,
					toolCallId: call.id,
					toolName: call.name,
					replay: "never",
					reason: "ToolPolicy clearance raced a durable call transition",
				};
			}
			if (decision.toolCallId !== call.id || decision.toolName !== call.name) {
				return {
					kind: "block",
					sourceIndex: index,
					toolCallId: call.id,
					toolName: call.name,
					replay: "never",
					reason: "ToolPolicy decision does not match the proposed tool call",
				};
			}
			if (decision.kind !== "block") {
				if (decision.replay !== "safe" && decision.replay !== "never") {
					return {
						kind: "block",
						sourceIndex: index,
						toolCallId: call.id,
						toolName: call.name,
						replay: "never",
						reason: "ToolPolicy returned an invalid replay declaration",
					};
				}
				try {
					const tool = this.toolByName(call.name);
					if (tool === undefined) throw new Error(`Tool ${call.name} not found`);
					const replaced = { ...call, arguments: decision.effectiveArgs as Record<string, JsonValue> };
					const validated = validateToolArguments(tool, replaced) as Record<string, JsonValue>;
					assertJsonValue(validated, "tool.arguments");
					return { ...decision, effectiveArgs: validated };
				} catch (error) {
					return {
						kind: "block",
						sourceIndex: index,
						toolCallId: call.id,
						toolName: call.name,
						replay: "never",
						reason: `ToolPolicy effective arguments are invalid: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			return decision;
		});
		const entryData = {
			schemaVersion: 1,
			policyStateFingerprint: clearance.policyStateFingerprint,
			decisions: decisions.map((decision) =>
				decision.kind === "block"
					? {
							kind: "block",
							sourceIndex: decision.sourceIndex,
							toolCallId: decision.toolCallId,
							toolName: decision.toolName,
							reason: decision.reason ?? "Tool execution was blocked",
						}
					: {
							kind: decision.kind,
							sourceIndex: decision.sourceIndex,
							toolCallId: decision.toolCallId,
							toolName: decision.toolName,
							effectiveArgs: decision.effectiveArgs,
							replay: decision.replay,
						},
			),
		} as unknown as JsonValue;
		assertJsonValue(entryData, "adaptive.tool_batch");
		return { entryData, decisions };
	}

	private async canReplayTool(
		_current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
	): Promise<boolean> {
		const call = batch.calls[sourceIndex];
		if (call === undefined || call.status !== "effect_pending" || call.replay !== "safe") return false;
		const proposed = await this.toolCallFromAssistant(batch.assistantEntryId, sourceIndex);
		const tool = this.toolByName(proposed.name);
		return tool !== undefined && (tool.replay ?? "never") === "safe";
	}

	private async isSequentialBatch(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
	): Promise<boolean> {
		if (current.state.kind !== "run" || current.state.settings.toolExecution === "sequential") return true;
		for (const call of batch.calls) {
			if (call.status !== "planned") continue;
			const proposed = await this.toolCallFromAssistant(batch.assistantEntryId, call.sourceIndex);
			if (this.toolByName(proposed.name)?.executionMode === "sequential") return true;
		}
		return false;
	}

	private async commitToolIntent(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
		args: Record<string, JsonValue>,
		replay: "never" | "safe",
	): Promise<{ current: CurrentOperation; dispatch: EffectPlan } | undefined> {
		const lane = current.operation.lane;
		const committed = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			const state = stateRegister.value;
			if (state.kind !== "run" || state.phase.kind !== "tools") {
				return undefined;
			}
			// R6: no tool intent may commit once cancellation is durable.
			if (state.control.status !== "running") return undefined;
			if (state.phase.batch.turnId !== batch.turnId) return undefined;
			const call = state.phase.batch.calls[sourceIndex];
			if (call === undefined || call.status !== "planned" || call.truncated === true) return undefined;
			const nextBatch: Extract<RunPhase, { kind: "tools" }>["batch"] = {
				...structuredClone(state.phase.batch),
				calls: state.phase.batch.calls.map(
					(candidate, index): ToolCall =>
						index === sourceIndex
							? {
									status: "effect_pending",
									sourceIndex: candidate.sourceIndex,
									resultEntryId: candidate.resultEntryId,
									replay,
								}
							: structuredClone(candidate),
				),
			};
			// R5 concurrent-merge: rebuild from the latest state so accepted
			// queue/write input survives the intent transaction.
			const next: RunState = { ...structuredClone(state), phase: { kind: "tools", batch: nextBatch } };
			const result = await write({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.tool_args",
						key: toolArgsKey(current.operation.operationId, batch.turnId, sourceIndex),
						value: structuredClone(args),
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: current.operation.operationId,
						value: next,
					},
				],
			});
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[1]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: current.leafId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			return {
				current: nextCurrent,
				dispatch: toolEffectPlan(nextCurrent, nextBatch, sourceIndex, this.telemetry),
			};
		});
		if (committed === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: committed.current });
		return committed;
	}

	private async commitAdaptiveBatchIntent(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		entryData: JsonValue,
		decisions: AdaptiveToolClearanceDecision[],
	): Promise<{ current: CurrentOperation; dispatches: EffectPlan[]; entry: Entry } | undefined> {
		const lane = current.operation.lane;
		const committed = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				leafRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			const state = stateRegister.value;
			if (state.kind !== "run" || state.phase.kind !== "tools") {
				return undefined;
			}
			// R6: no adaptive batch intent may commit once cancellation is durable.
			if (state.control.status !== "running") return undefined;
			if (state.phase.batch.turnId !== batch.turnId) return undefined;
			if (state.phase.batch.argumentAuthority.kind !== "adaptive_pending") {
				return undefined;
			}
			const entryId = this.options.session.idGenerator.next();
			const nextCalls: ToolCall[] = state.phase.batch.calls.map((call, index) => {
				const decision = decisions[index];
				if (decision === undefined) throw new Error("Clearance decisions do not cover every call");
				if ((call.status === "planned" && call.truncated === true) || decision.kind === "block") {
					return structuredClone(call);
				}
				return {
					status: "effect_pending",
					sourceIndex: call.sourceIndex,
					resultEntryId: call.resultEntryId,
					replay: decision.replay,
				};
			});
			const nextBatch: Extract<RunPhase, { kind: "tools" }>["batch"] = {
				...structuredClone(state.phase.batch),
				argumentAuthority: { kind: "adaptive_tool_batch_entry", entryId },
				calls: nextCalls,
			};
			// R5 concurrent-merge: rebuild from the latest state so accepted
			// queue/write input survives the clearance transaction.
			const next: RunState = { ...structuredClone(state), phase: { kind: "tools", batch: nextBatch } };
			const result = await write({
				writes: [
					{
						kind: "entry",
						entry: {
							id: entryId,
							parentId: leafRegister.value,
							type: "custom",
							customType: "adaptive.tool_batch",
							data: structuredClone(entryData),
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: entryId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: current.operation.operationId,
						value: next,
					},
				],
			});
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[2]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: entryId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			const entry = (await this.options.session.getEntries([entryId])).get(entryId)!;
			const dispatches = nextCalls.flatMap((call, index) =>
				call.status === "effect_pending" ? [toolEffectPlan(nextCurrent, nextBatch, index, this.telemetry)] : [],
			);
			return { current: nextCurrent, entry, dispatches };
		});
		if (committed === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: committed.current });
		this.options.events.emit({ type: "entry_added", lane, entry: committed.entry });
		return { current: committed.current, dispatches: committed.dispatches, entry: committed.entry };
	}

	private async commitToolSettlement(
		current: CurrentOperation,
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<SettlementOutput, { kind: "tool" }>,
	): Promise<SettlementResult | undefined> {
		const lane = current.operation.lane;
		const settled = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, leafRegister, configurationRegister] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.getRegister("lane.leaf", lane),
				this.options.session.getRegister("lane.config", lane),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				leafRegister === undefined ||
				configurationRegister === undefined ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			const state = stateRegister.value;
			if (state.kind !== "run" || state.phase.kind !== "tools") {
				return undefined;
			}
			const batch = state.phase.batch;
			if (batch.turnId !== plan.turnId) return undefined;
			const call = batch.calls[plan.sourceIndex];
			if (call === undefined) return undefined;
			if (call.status !== "effect_pending" && call.status !== "planned") return undefined;
			const cancelled = state.control.status === "cancel_requested";
			const proposed = await this.toolCallFromAssistant(batch.assistantEntryId, plan.sourceIndex);
			let message: ToolResultMessage;
			let usage: Usage | undefined;
			if (cancelled && call.status === "planned") {
				// A planned call under cancellation is never prepared or
				// executed: an aborted synthetic settles the reserved result id
				// with zero usage, no matter which stale plan carried it here.
				message = syntheticToolResultMessage(
					proposed.id,
					proposed.name,
					abortedToolResultText(proposed.name),
					Date.now(),
				);
				usage = undefined;
			} else {
				message = {
					role: "toolResult",
					toolCallId: proposed.id,
					toolName: proposed.name,
					content: output.result.content ?? [],
					details: output.result.details,
					...(output.result.usage === undefined ? {} : { usage: output.result.usage }),
					...(output.result.addedToolNames?.length ? { addedToolNames: output.result.addedToolNames } : {}),
					isError: output.isError,
					timestamp: Date.now(),
				};
				try {
					this.codec.validateMessage(message, "tool.result");
				} catch (error) {
					const synthetic = syntheticToolResultMessage(
						proposed.id,
						proposed.name,
						`Tool returned an invalid result: ${error instanceof Error ? error.message : String(error)}`,
						Date.now(),
					);
					message = { ...synthetic, details: {} };
				}
				usage = message.usage;
				if (usage !== undefined) {
					try {
						validateUsage(usage);
					} catch {
						usage = zeroUsage();
					}
				}
			}
			const isLast = plan.sourceIndex === batch.calls.length - 1;
			const nextCalls: ToolCall[] = batch.calls.map((candidate, index) =>
				index === plan.sourceIndex
					? {
							status: "completed",
							sourceIndex: candidate.sourceIndex,
							resultEntryId: candidate.resultEntryId,
							// Cancellation is never hijacked by tool terminate
							// semantics; live results are preserved verbatim.
							terminate: cancelled ? false : output.terminate,
						}
					: structuredClone(candidate),
			);
			const next: RunState = {
				...structuredClone(state),
				phase: { kind: "tools", batch: { ...structuredClone(batch), calls: nextCalls } },
			};
			const toolArgsRegisters = isLast
				? await this.options.session.listRegisters(
						"op.tool_args",
						`${current.operation.operationId}:${batch.turnId}:`,
					)
				: [];
			const writes: Transaction["writes"] = [
				{
					kind: "entry",
					entry: {
						id: call.resultEntryId,
						parentId: leafRegister.value,
						type: "message",
						message,
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: call.resultEntryId },
				...toolArgsRegisters.map((register): Transaction["writes"][number] => ({
					kind: "register",
					op: "delete",
					namespace: "op.tool_args",
					key: register.key,
				})),
				{ kind: "register", op: "set", namespace: "op.state", key: current.operation.operationId, value: next },
			];
			let usageWrite: Extract<Transaction["writes"][number], { kind: "usage" }> | undefined;
			if (usage !== undefined) {
				usageWrite = {
					kind: "usage",
					row: {
						id: this.options.session.idGenerator.next(),
						entryId: call.resultEntryId,
						usage,
						adjustment: false,
					},
				};
				writes.splice(2, 0, usageWrite);
			}
			const result = await write({ writes });
			const nextCurrent: CurrentOperation = {
				operation: structuredClone(current.operation),
				state: next,
				operationStateSeq: result.seqs[writes.length - 1]!,
				laneState: structuredClone(laneStateRegister.value),
				laneStateSeq: laneStateRegister.seq,
				leafId: call.resultEntryId,
				configuration: structuredClone(configurationRegister.value),
				configurationSeq: configurationRegister.seq,
			};
			const entry = (await this.options.session.getEntries([call.resultEntryId])).get(call.resultEntryId)!;
			return {
				current: nextCurrent,
				entry,
				...(usageWrite === undefined
					? {}
					: {
							row: {
								id: usageWrite.row.id,
								seq: result.seqs[3]!,
								entryId: usageWrite.row.entryId,
								usage: structuredClone(usageWrite.row.usage),
								adjustment: false,
							},
						}),
			};
		});
		if (settled === undefined) return undefined;
		this.options.onLaneState(lane, { kind: "open", current: settled.current });
		this.options.events.emit({ type: "entry_added", lane, entry: settled.entry });
		if ("row" in settled && settled.row !== undefined) {
			this.options.events.emit({
				type: "usage",
				lane,
				row: settled.row,
				totals: (await this.options.session.getStats()).usage,
			});
		}
		return { current: settled.current, settledEntry: settled.entry };
	}

	private async commitTerminal(
		current: CurrentOperation,
		result: OperationResult,
	): Promise<CurrentOperation | undefined> {
		if (result.kind === "suspended") throw new HarnessNotImplementedError("suspended terminal");
		const lane = current.operation.lane;
		const committed = await this.options.coordinator.mutateLaneWithWriter(lane, async (write) => {
			const [stateRegister, laneStateRegister, toolArgs, preparations] = await Promise.all([
				this.options.session.getRegister("op.state", current.operation.operationId),
				this.options.session.getRegister("lane.state", lane),
				this.options.session.listRegisters("op.tool_args", `${current.operation.operationId}:`),
				this.options.session.listRegisters("op.preparation", `${current.operation.operationId}:`),
			]);
			if (
				stateRegister === undefined ||
				laneStateRegister === undefined ||
				stateRegister.seq !== current.operationStateSeq ||
				laneStateRegister.value.currentOperationId !== current.operation.operationId
			) {
				return undefined;
			}
			const state = stateRegister.value;
			if (state.kind !== current.operation.intent.kind) throw new Error("Terminal state kind mismatch");
			const pendingIds =
				state.kind === "run"
					? [
							...state.inbox.steer,
							...state.inbox.followUp,
							...state.inbox.writes,
							...(state.control.status === "cancel_requested"
								? [...state.control.drainedSteer, ...state.control.drainedFollowUp]
								: []),
						]
					: [];
			const nextLaneState: LaneState = {
				...structuredClone(laneStateRegister.value),
				currentOperationId: null,
			};
			const terminalResult: LaneLastResult =
				state.kind === "run"
					? lastResult(current.operation.operationId, state, result as RunOutcome)
					: structuralLastResult(
							current.operation.operationId,
							state,
							result as Extract<OperationResult, { kind: "aborted" }>,
						);
			const writes: Transaction["writes"] = [
				{ kind: "register", op: "delete", namespace: "op.meta", key: current.operation.operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: current.operation.operationId },
				...toolArgs.map((register): Transaction["writes"][number] => ({
					kind: "register",
					op: "delete",
					namespace: "op.tool_args",
					key: register.key,
				})),
				...preparations.map((register): Transaction["writes"][number] => ({
					kind: "register",
					op: "delete",
					namespace: "op.preparation",
					key: register.key,
				})),
				...pendingIds.map((id): Transaction["writes"][number] => ({
					kind: "register",
					op: "delete",
					namespace: "pending.entry",
					key: id,
				})),
				{ kind: "register", op: "set", namespace: "lane.lastResult", key: lane, value: terminalResult },
				{ kind: "register", op: "set", namespace: "lane.state", key: lane, value: nextLaneState },
			];
			const commit = await write({ writes });
			return { laneState: nextLaneState, laneStateSeq: commit.seqs.at(-1)! };
		});
		if (committed === undefined) return undefined;
		this.options.coordinator.releaseOperation(current.operation.operationId);
		this.options.onLaneState(lane, {
			kind: "idle",
			lane,
			leafId: current.leafId,
			laneState: committed.laneState,
			laneStateSeq: committed.laneStateSeq,
		});
		this.notifyLaneIdle(lane);
		if (current.state.kind === "run") {
			this.emitRunEnd(lane, current.operation.operationId, result as Exclude<RunOutcome, { kind: "suspended" }>);
		} else if (current.state.kind === "compaction") {
			this.options.events.emit({
				type: "compaction_end",
				lane,
				runId: current.operation.operationId,
				reason: "manual",
				outcome: "aborted",
			});
		} else {
			this.options.events.emit({
				type: "navigation_end",
				lane,
				runId: current.operation.operationId,
				oldLeafId: current.operation.sourceLeafId,
				newLeafId: current.leafId,
				outcome: "aborted",
			});
		}
		return current;
	}

	private emitRunEnd(lane: string, runId: string, result: Exclude<RunOutcome, { kind: "suspended" }>): void {
		const eventBase = {
			type: "run_end" as const,
			lane,
			runId,
			leafId: result.leafId,
		};
		if (result.kind === "failed") {
			this.options.events.emit(
				result.finalEntryId === undefined
					? { ...eventBase, outcome: "failed" as const, error: result.error }
					: {
							...eventBase,
							outcome: "failed" as const,
							error: result.error,
							finalEntryId: result.finalEntryId,
							finalMessage: result.finalMessage,
						},
			);
		} else {
			this.options.events.emit(
				result.finalEntryId === undefined
					? { ...eventBase, outcome: result.kind }
					: {
							...eventBase,
							outcome: result.kind,
							finalEntryId: result.finalEntryId,
							finalMessage: result.finalMessage,
						},
			);
		}
	}

	private async sleepMs(delayMs: number, operationId: string): Promise<void> {
		if (delayMs <= 0) return;
		const closeSignal = this.options.coordinator.signal;
		if (closeSignal.aborted) throw new HarnessClosedError();
		const signal = this.options.coordinator.operationSignal(operationId);
		if (signal.aborted) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				closeSignal.removeEventListener("abort", onClose);
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, delayMs);
			const onClose = () => {
				clearTimeout(timeout);
				reject(new HarnessClosedError());
			};
			const onAbort = () => {
				// Operation abort wakes the retry wait; the cancellation
				// planner takes over on the next pass. Close always wins.
				if (closeSignal.aborted) {
					clearTimeout(timeout);
					reject(new HarnessClosedError());
					return;
				}
				clearTimeout(timeout);
				resolve();
			};
			closeSignal.addEventListener("abort", onClose, { once: true });
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
