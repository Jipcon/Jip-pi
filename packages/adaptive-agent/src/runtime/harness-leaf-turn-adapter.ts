import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AdaptiveAdvanceResult,
	AdaptiveTurnResult,
	AgentLane,
	JsonValue,
	ResumeResult,
	RunOutcome,
	RunResult,
} from "@earendil-works/pi-agent-core/harness-v4";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { NotBranchableCheckpointError, SourceCheckpointChangedError } from "./continuation-checkpoint.ts";
import {
	MissingIdentitiesError,
	NonDeterministicRequestPolicyError,
	RequestFingerprintMismatchError,
	UnsupportedSamplingControlError,
	WorkspaceSnapshotMismatchError,
} from "./exact-request.ts";
import type { AdaptiveRunBasisData } from "./harness-v4-contract.ts";
import type {
	CheckpointMismatch,
	DriverBusy,
	LeafTurnAbortOutcome,
	LeafTurnAbortRejected,
	LeafTurnCommand,
	LeafTurnCursor,
	LeafTurnExecutionResult,
	LeafTurnExecutor,
	LeafTurnOutcome,
	LeafTurnRejected,
	LeafTurnResult,
	LeafTurnRunSettlement,
	LeafTurnSuspension,
} from "./leaf-turn-executor.ts";
import { StateProjectionMismatch } from "./state-projector.ts";

export type HarnessV4LeafTurnBasis = Omit<AdaptiveRunBasisData, "operationId">;

export interface HarnessV4AdaptiveLane extends AgentLane {
	promptAdaptive(message: AgentMessage | AgentMessage[], basis: { [key: string]: JsonValue }): Promise<RunResult>;
	promptAdaptiveTurn(
		message: AgentMessage | AgentMessage[],
		basis: { [key: string]: JsonValue },
	): Promise<AdaptiveTurnResult>;
	resumeAdaptiveTurn(): Promise<AdaptiveAdvanceResult>;
}

export interface HarnessV4LeafTurnAdapterOptions {
	lane: HarnessV4AdaptiveLane;
	basis: HarnessV4LeafTurnBasis;
	/**
	 * Stage 7 branch-origin guard: invoked before any start/advance dispatch.
	 * A frozen source lane throws BranchOriginFrozen and no effect happens.
	 */
	originGuard?: () => Promise<void>;
}

export class HarnessV4LeafTurnInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessV4LeafTurnInvariantError";
	}
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function addUsage(total: Usage, addition: Usage): void {
	total.input += addition.input;
	total.output += addition.output;
	total.cacheRead += addition.cacheRead;
	total.cacheWrite += addition.cacheWrite;
	total.totalTokens += addition.totalTokens;
	total.cost.input += addition.cost.input;
	total.cost.output += addition.cost.output;
	total.cost.cacheRead += addition.cost.cacheRead;
	total.cost.cacheWrite += addition.cost.cacheWrite;
	total.cost.total += addition.cost.total;
	if (addition.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + addition.cacheWrite1h;
	if (addition.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + addition.reasoning;
}

function aggregateUsage(rows: Array<{ usage: Usage }>): Usage {
	const total = structuredClone(ZERO_USAGE);
	for (const row of rows) addUsage(total, row.usage);
	return total;
}

function cursorsEqual(left: LeafTurnCursor, right: LeafTurnCursor): boolean {
	return (
		left.operationId === right.operationId &&
		left.assistantEntryId === right.assistantEntryId &&
		left.leafId === right.leafId
	);
}

function driverBusy(): DriverBusy {
	return { kind: "driver_busy", message: "HarnessV4LeafTurnAdapter is already executing a command" };
}

/** Maps thrown exact-continuation gate errors onto typed LeafTurn rejections. */
function mapExactRejection(error: unknown, lane: string): LeafTurnRejected | undefined {
	if (error instanceof RequestFingerprintMismatchError) {
		return { kind: "request_fingerprint_mismatch", message: error.message };
	}
	if (error instanceof NonDeterministicRequestPolicyError) {
		return { kind: "non_deterministic_request_policy", message: error.message };
	}
	if (error instanceof UnsupportedSamplingControlError) {
		return { kind: "unsupported_sampling_control", message: error.message };
	}
	if (error instanceof WorkspaceSnapshotMismatchError) {
		return { kind: "workspace_snapshot_mismatch", message: error.message };
	}
	if (error instanceof StateProjectionMismatch) {
		return { kind: "state_projection_mismatch", message: error.message };
	}
	if (error instanceof NotBranchableCheckpointError) {
		return { kind: "not_branchable_checkpoint", message: error.message };
	}
	if (error instanceof SourceCheckpointChangedError) {
		return { kind: "source_checkpoint_changed", message: error.message };
	}
	if (error instanceof MissingIdentitiesError) {
		return { kind: "missing_identities", lane, tools: [], models: [], message: error.message };
	}
	return undefined;
}

function checkpointMismatch(expected: LeafTurnCursor, actual: LeafTurnCursor | null): CheckpointMismatch {
	return {
		kind: "checkpoint_mismatch",
		expected: structuredClone(expected),
		actual: actual === null ? null : structuredClone(actual),
		message: "The requested LeafTurn cursor is not the lane's durable cursor",
	};
}

function mapRunRejection(result: Extract<RunResult, { ok: false }>): LeafTurnRejected {
	const { error } = result;
	switch (error._tag) {
		case "LaneBusy":
			return {
				kind: "lane_busy",
				lane: error.lane,
				operationId: error.operationId,
				operationKind: error.operationKind,
				message: error.message,
			};
		case "MissingIdentities":
			return {
				kind: "missing_identities",
				lane: error.lane,
				tools: [...error.tools],
				models: [...error.models],
				message: error.message,
			};
		case "InvalidMessage":
			return { kind: "invalid_message", lane: error.lane, reason: error.reason, message: error.message };
		case "Closed":
			return { kind: "closed", message: error.message };
		case "UnknownSkill":
		case "UnknownTemplate":
			throw new HarnessV4LeafTurnInvariantError(`Adaptive admission returned ${error._tag}`);
	}
}

function mapResumeRejection(result: Extract<ResumeResult, { ok: false }>): LeafTurnRejected {
	const { error } = result;
	switch (error._tag) {
		case "LaneBusy":
			return {
				kind: "lane_busy",
				lane: error.lane,
				operationId: error.operationId,
				operationKind: error.operationKind,
				message: error.message,
			};
		case "MissingIdentities":
			return {
				kind: "missing_identities",
				lane: error.lane,
				tools: [...error.tools],
				models: [...error.models],
				message: error.message,
			};
		case "NothingToResume":
			return { kind: "nothing_to_resume", lane: error.lane, message: error.message };
		case "Closed":
			return { kind: "closed", message: error.message };
	}
}

function mapTurnRejection(result: Extract<AdaptiveTurnResult, { ok: false }>): LeafTurnRejected {
	return mapRunRejection(result as Extract<RunResult, { ok: false }>);
}

function mapAdvanceRejection(result: Extract<AdaptiveAdvanceResult, { ok: false }>): LeafTurnRejected {
	return mapResumeRejection(result as Extract<ResumeResult, { ok: false }>);
}

function mapSettlement(outcome: Exclude<RunOutcome, { kind: "suspended" }>): LeafTurnRunSettlement {
	switch (outcome.kind) {
		case "completed":
			return outcome.finalEntryId === undefined
				? { kind: "completed", leafId: outcome.leafId }
				: {
						kind: "completed",
						leafId: outcome.leafId,
						finalEntryId: outcome.finalEntryId,
						finalMessage: structuredClone(outcome.finalMessage),
					};
		case "aborted":
			return outcome.finalEntryId === undefined
				? { kind: "aborted", leafId: outcome.leafId }
				: {
						kind: "aborted",
						leafId: outcome.leafId,
						finalEntryId: outcome.finalEntryId,
						finalMessage: structuredClone(outcome.finalMessage),
					};
		case "failed":
			return outcome.finalEntryId === undefined
				? { kind: "failed", leafId: outcome.leafId, error: structuredClone(outcome.error) }
				: {
						kind: "failed",
						leafId: outcome.leafId,
						error: structuredClone(outcome.error),
						finalEntryId: outcome.finalEntryId,
						finalMessage: structuredClone(outcome.finalMessage),
					};
	}
}

function mapSuspension(
	lane: string,
	runId: string,
	outcome: Extract<RunOutcome, { kind: "suspended" }>,
): LeafTurnSuspension {
	if (outcome.reason === "deferred") {
		return {
			lane,
			operationId: runId,
			kind: "run",
			reason: "deferred",
			startedAt: outcome.startedAt,
			deferred: structuredClone(outcome.deferred),
			missing: { tools: [], models: [] },
		};
	}
	return {
		lane,
		operationId: runId,
		kind: "run",
		reason: "missing_identities",
		startedAt: outcome.startedAt,
		missing: { tools: [...outcome.missing.tools], models: [...outcome.missing.models] },
	};
}

async function settleWithDrive<T>(lane: HarnessV4AdaptiveLane, pending: Promise<T>): Promise<T> {
	let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
	void pending.then(
		(value) => {
			settled = { ok: true, value };
		},
		(error: unknown) => {
			settled = { ok: false, error };
		},
	);
	while (settled === undefined) {
		try {
			await lane.runToCompletion();
		} catch (error) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (settled === undefined) throw error;
		}
		if (settled === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	if (!settled.ok) throw settled.error;
	return settled.value;
}

export class HarnessV4LeafTurnAdapter implements LeafTurnExecutor {
	private readonly lane: HarnessV4AdaptiveLane;
	private readonly basis: HarnessV4LeafTurnBasis;
	private readonly originGuard: (() => Promise<void>) | undefined;
	private executing = false;

	constructor(options: HarnessV4LeafTurnAdapterOptions) {
		this.lane = options.lane;
		this.basis = structuredClone(options.basis);
		this.originGuard = options.originGuard;
	}

	async execute(command: LeafTurnCommand): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>> {
		if (this.executing) return { ok: false, error: driverBusy() };
		if (this.originGuard !== undefined) {
			await this.originGuard();
		}
		this.executing = true;
		try {
			return command.kind === "start" ? await this.start(command.prompt) : await this.advance(command.afterCursor);
		} finally {
			this.executing = false;
		}
	}

	async abort(): Promise<LeafTurnExecutionResult<LeafTurnAbortOutcome, LeafTurnAbortRejected>> {
		const aborted = await this.lane.abort();
		if (!aborted.ok) {
			switch (aborted.error._tag) {
				case "NoActiveOperation":
					return {
						ok: false,
						error: {
							kind: "no_active_operation",
							lane: aborted.error.lane,
							message: aborted.error.message,
						},
					};
				case "Closed":
					return { ok: false, error: { kind: "closed", message: aborted.error.message } };
			}
		}
		// The durable cancel marker is committed; the in-flight start()/advance()
		// promise resolves with the aborted outcome once reconciliation reaches
		// the terminal, and no second provider request is ever started.
		return {
			ok: true,
			value: {
				operationId: aborted.value.runId,
				steer: aborted.value.steer,
				followUp: aborted.value.followUp,
			},
		};
	}

	private async start(
		prompt: Extract<LeafTurnCommand, { kind: "start" }>["prompt"],
	): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>> {
		const beforeLeafId = await this.lane.getLeafId();
		const basis = structuredClone(this.basis) as unknown as { [key: string]: JsonValue };
		let admitted: Awaited<ReturnType<HarnessV4AdaptiveLane["promptAdaptiveTurn"]>>;
		try {
			admitted = await settleWithDrive(this.lane, this.lane.promptAdaptiveTurn(prompt, basis));
		} catch (error) {
			const mapped = mapExactRejection(error, this.lane.name);
			if (mapped !== undefined) return { ok: false, error: mapped };
			throw error;
		}
		if (!admitted.ok) return { ok: false, error: mapTurnRejection(admitted) };
		const value = admitted.value;
		if (value.kind === "turn") {
			return this.buildYieldedTurn(value.runId, value.assistantEntryId, value.leafId, beforeLeafId);
		}
		const outcome = value as { runId: string } & RunOutcome;
		if (outcome.kind === "suspended") {
			return {
				ok: true,
				value: {
					kind: "suspended",
					operation: mapSuspension(this.lane.name, value.runId, outcome),
				},
			};
		}
		return this.buildTurnOutcome(value.runId, outcome, beforeLeafId);
	}

	private async advance(
		afterCursor?: LeafTurnCursor,
	): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>> {
		const open = await this.lane.getOpenOperation();
		const settledCursor = open === null ? await this.durableTerminalCursor() : null;
		const actual: LeafTurnCursor | null =
			open === null
				? settledCursor
				: open.turnCursor === null
					? null
					: { operationId: open.operationId, ...open.turnCursor };
		if (afterCursor !== undefined && (actual === null || !cursorsEqual(afterCursor, actual))) {
			return { ok: false, error: checkpointMismatch(afterCursor, actual) };
		}
		if (open === null) {
			return {
				ok: false,
				error: {
					kind: "nothing_to_resume",
					lane: this.lane.name,
					message: `Lane ${this.lane.name} has no open Run`,
				},
			};
		}
		if (open.kind !== "run") {
			return {
				ok: false,
				error: {
					kind: "unexpected_operation",
					lane: this.lane.name,
					operationId: open.operationId,
					operationKind: open.kind,
					message: `Lane ${this.lane.name} has an open ${open.kind} operation`,
				},
			};
		}
		const beforeLeafId = await this.lane.getLeafId();
		let resumed: Awaited<ReturnType<HarnessV4AdaptiveLane["resumeAdaptiveTurn"]>>;
		try {
			resumed = await settleWithDrive(this.lane, this.lane.resumeAdaptiveTurn());
		} catch (error) {
			const mapped = mapExactRejection(error, this.lane.name);
			if (mapped !== undefined) return { ok: false, error: mapped };
			throw error;
		}
		if (!resumed.ok) return { ok: false, error: mapAdvanceRejection(resumed) };
		const value = resumed.value;
		if (value.kind === "turn") {
			return this.buildYieldedTurn(value.runId, value.assistantEntryId, value.leafId, beforeLeafId);
		}
		const outcome = value as { runId: string } & RunOutcome;
		if (outcome.kind === "suspended") {
			return {
				ok: true,
				value: {
					kind: "suspended",
					operation: mapSuspension(this.lane.name, value.runId, outcome),
				},
			};
		}
		return this.buildTurnOutcome(value.runId, outcome, beforeLeafId);
	}

	private async buildYieldedTurn(
		runId: string,
		assistantEntryId: string,
		leafId: string,
		beforeLeafId: string | null,
	): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>> {
		const turn = await this.durableTurn(runId, assistantEntryId, leafId, beforeLeafId);
		return {
			ok: true,
			value: {
				kind: "turn",
				turn,
				run: { kind: "open" },
			},
		};
	}

	private async durableTurn(
		runId: string,
		assistantEntryId: string,
		leafId: string,
		beforeLeafId: string | null,
	): Promise<LeafTurnResult> {
		const turnCommit = await this.lane.session.getTurnCommit({ assistantEntryId, leafId });
		if (turnCommit === undefined) {
			throw new HarnessV4LeafTurnInvariantError("Run returned before its complete turn commit was queryable");
		}
		const message = turnCommit.assistantEntry.message;
		if (message.role !== "assistant") {
			throw new HarnessV4LeafTurnInvariantError("Turn commit did not contain an assistant response");
		}
		const toolResults = turnCommit.toolResultEntries.map((entry) => entry.message);
		if (toolResults.some((result) => result.role !== "toolResult")) {
			throw new HarnessV4LeafTurnInvariantError("Turn commit contained a non-tool result suffix");
		}
		const cursor: LeafTurnCursor = {
			operationId: runId,
			assistantEntryId: turnCommit.assistantEntry.id,
			leafId,
		};
		return {
			operationId: runId,
			cursor,
			beforeLeafId,
			afterLeafId: leafId,
			assistantEntryId: turnCommit.assistantEntry.id,
			toolResultEntryIds: turnCommit.toolResultEntries.map((entry) => entry.id),
			usageRowIds: turnCommit.usageRows.map((row) => row.id),
			message: structuredClone(message as AssistantMessage),
			toolResults: structuredClone(toolResults as ToolResultMessage[]),
			usage: aggregateUsage(turnCommit.usageRows),
		};
	}

	private async buildTurnOutcome(
		runId: string,
		outcome: Exclude<RunOutcome, { kind: "suspended" }>,
		beforeLeafId: string | null,
	): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>> {
		if (outcome.finalEntryId !== undefined && outcome.finalMessage !== undefined) {
			const turn = await this.durableTurn(runId, outcome.finalEntryId, outcome.leafId, beforeLeafId);
			return {
				ok: true,
				value: {
					kind: "turn",
					turn,
					run: { kind: "settled", result: mapSettlement(outcome) },
				},
			};
		}
		// terminated_tools: the run settled without a final assistant message.
		// The durable turn still names its assistant entry via lane.lastResult.
		const lastResult = await this.lane.getLastResult();
		if (
			outcome.kind !== "completed" ||
			lastResult?.kind !== "run" ||
			lastResult.finalAssistantEntryId === undefined
		) {
			throw new HarnessV4LeafTurnInvariantError("Harness v4 settled without a final assistant entry");
		}
		const turn = await this.durableTurn(runId, lastResult.finalAssistantEntryId, outcome.leafId, beforeLeafId);
		return {
			ok: true,
			value: {
				kind: "turn",
				turn,
				run: { kind: "settled", result: mapSettlement(outcome) },
			},
		};
	}

	private async durableTerminalCursor(): Promise<LeafTurnCursor | null> {
		const result = await this.lane.getLastResult();
		if (result?.kind !== "run" || result.leafId === null || result.finalAssistantEntryId === undefined) {
			return null;
		}
		const turn = await this.lane.session.getTurnCommit({
			assistantEntryId: result.finalAssistantEntryId,
			leafId: result.leafId,
		});
		if (turn === undefined) return null;
		return {
			operationId: result.operationId,
			assistantEntryId: result.finalAssistantEntryId,
			leafId: result.leafId,
		};
	}
}
