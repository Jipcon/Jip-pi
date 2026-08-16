import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@earendil-works/pi-agent-core/harness-v4";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type CandidateTurnObservation,
	CandidateTurnRunner,
	type ExecutorFactory,
	type LoopAdmission,
	LoopAdmissionError,
	type LoopAdmissionErrorCode,
	type LoopPrompt,
	type TerminalDecision,
	type TerminalPolicy,
	type WorkspaceMetadataSource,
} from "./candidate-turn-runner.ts";
import type { TaskEvaluation, TaskVerifier, TurnEvidence } from "./evaluator.ts";
import type { HarnessV4AdaptiveLane, HarnessV4LeafTurnBasis } from "./harness-leaf-turn-adapter.ts";
import type { CandidatePolicyStateCapsule } from "./harness-v4-contract.ts";
import type {
	LeafTurnCursor,
	LeafTurnResult,
	LeafTurnRunSettlement,
	LeafTurnSuspension,
} from "./leaf-turn-executor.ts";
import type { PolicyBundleRef } from "./policy-bundle.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import type { CandidateStateProjector } from "./state-projector.ts";
import type { TrajectoryRecord, TrajectoryStore } from "./trajectory-store.ts";
import { sanitizeTrajectoryMetrics } from "./trajectory-store.ts";

export {
	CandidateTurnRunner,
	defaultTerminalPolicy,
	type ExecutorFactory,
	type LoopAdmission,
	LoopAdmissionError,
	type LoopAdmissionErrorCode,
	type LoopPrompt,
	type TerminalDecision,
	type TerminalPolicy,
	type WorkspaceMetadataSource,
} from "./candidate-turn-runner.ts";

export interface SingleCandidateTaskConfig {
	taskId: string;
	candidateId: string;
	policyBundle: PolicyBundleRef;
	frozenModel: { provider: string; modelId: string };
	verifier?: TaskVerifier;
}

export interface SingleCandidateAdaptiveToolLoopOptions {
	session: Session;
	lane: HarnessV4AdaptiveLane;
	registry: PolicyRegistry;
	projector: CandidateStateProjector;
	executorFactory: ExecutorFactory;
	/** The fixed read/write/edit/bash catalog configured on the harness. */
	tools: AgentTool[];
	workspaceRoot: string;
	workspaceMetadata?: WorkspaceMetadataSource;
	trajectory?: TrajectoryStore;
	task: SingleCandidateTaskConfig;
	terminalPolicy?: TerminalPolicy;
	onProjectionFault?: (error: Error) => void;
	/**
	 * Stage 7 branch-origin guard: checked before every start/advance. A
	 * frozen source lane throws BranchOriginFrozen and no effect happens.
	 */
	originGuard?: () => Promise<void>;
}

export type AdaptiveLoopStep =
	| {
			kind: "turn";
			turn: LeafTurnResult;
			state: CandidatePolicyStateCapsule;
			evidence: TurnEvidence;
			decision: TerminalDecision;
			settlement?: LeafTurnRunSettlement;
			evaluation?: TaskEvaluation;
	  }
	| { kind: "suspended"; operation: LeafTurnSuspension }
	| { kind: "projection_fault"; code: "projection_mismatch" | "policy_fault"; message: string }
	| { kind: "policy_fault"; message: string }
	| { kind: "budget_exhausted"; budget: "turns" | "tools" | "tokens"; state: CandidatePolicyStateCapsule }
	| { kind: "model_drift"; message: string }
	| { kind: "rejected"; message: string };

export interface AdaptiveLoopMetrics {
	providerRequests: number;
	turns: number;
	latencyMs: { total: number; perTurn: number[] };
	tokens: Usage;
	toolErrors: number;
	toolBlocks: number;
	redundantCalls: number;
	verificationCoverage: number;
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
}

export type AdaptiveLoopRunResult =
	| { kind: "completed"; evaluation: TaskEvaluation; state: CandidatePolicyStateCapsule; metrics: AdaptiveLoopMetrics }
	| { kind: "failed"; reason: string; state?: CandidatePolicyStateCapsule; metrics: AdaptiveLoopMetrics }
	| { kind: "aborted"; state?: CandidatePolicyStateCapsule; metrics: AdaptiveLoopMetrics }
	| { kind: "stopped"; reason: string; state: CandidatePolicyStateCapsule; metrics: AdaptiveLoopMetrics }
	| { kind: "suspended"; operation: LeafTurnSuspension; metrics: AdaptiveLoopMetrics }
	| {
			kind: "budget_exhausted";
			budget: "turns" | "tools" | "tokens";
			state: CandidatePolicyStateCapsule;
			metrics: AdaptiveLoopMetrics;
	  }
	| {
			kind: "projection_fault";
			code: "projection_mismatch" | "policy_fault";
			message: string;
			metrics: AdaptiveLoopMetrics;
	  }
	| { kind: "admission_rejected"; code: LoopAdmissionErrorCode; message: string; metrics: AdaptiveLoopMetrics };

/**
 * Single-candidate adaptive tool loop: the Stage 5 wrapper around the shared
 * CandidateTurnRunner (Stage 8, S8.2). Admission -> frozen catalog/bundle
 * checks -> turn-by-turn advance -> post-turn projection/evaluation before
 * the next provider request -> typed terminal outcomes. No branching, no
 * second planner; TrajectoryStore writes never touch the execution path.
 */
export class SingleCandidateAdaptiveToolLoop {
	private readonly options: SingleCandidateAdaptiveToolLoopOptions;
	private readonly trajectory: TrajectoryStore | undefined;
	private runner: CandidateTurnRunner | undefined;
	private lastCapsule: CandidatePolicyStateCapsule | undefined;
	private providerRequests = 0;
	private turnCount = 0;
	private perTurnLatencyMs: number[] = [];
	private totalLatencyMs = 0;
	private redundantCalls = 0;
	private tokenTotals: Usage = structuredClone(ZERO_USAGE);
	private faulted: AdaptiveLoopStep | undefined;
	private admitted: LoopAdmission | undefined;
	private startedAt = 0;
	private trajectorySeq = 0;

	constructor(options: SingleCandidateAdaptiveToolLoopOptions) {
		this.options = options;
		this.trajectory = options.trajectory;
	}

	private getRunner(): CandidateTurnRunner {
		if (this.runner === undefined) {
			this.runner = new CandidateTurnRunner({
				session: this.options.session,
				lane: this.options.lane,
				registry: this.options.registry,
				projector: this.options.projector,
				executorFactory: this.options.executorFactory,
				tools: this.options.tools,
				workspaceRoot: this.options.workspaceRoot,
				workspaceMetadata: this.options.workspaceMetadata,
				task: this.options.task,
				verifier: this.options.task.verifier,
				terminalPolicy: this.options.terminalPolicy,
				originGuard: this.options.originGuard,
			});
		}
		return this.runner;
	}

	/** Admission: frozen model, fixed tool catalog, resolvable bundle, origin capsule. */
	async admit(): Promise<LoopAdmission> {
		if (this.admitted !== undefined) return this.admitted;
		this.admitted = await this.getRunner().admit();
		return this.admitted;
	}

	/** Durable inherited basis for the next Run of the same Task. */
	nextRunBasis(): HarnessV4LeafTurnBasis | undefined {
		if (this.lastCapsule === undefined) return undefined;
		const capsule = this.lastCapsule;
		return {
			schemaVersion: 1,
			taskId: capsule.basis.taskId,
			candidateId: capsule.basis.candidateId,
			policyBundle: capsule.basis.policyBundle,
			projectorVersion: capsule.basis.projectorVersion,
			inheritedPolicyState: structuredClone(capsule),
			start: { kind: "prompt" },
		};
	}

	start(prompt: LoopPrompt, options?: { inheritedBasis?: HarnessV4LeafTurnBasis }): Promise<AdaptiveLoopStep> {
		return this.executeStep((runner) => runner.start(prompt, options));
	}

	advance(afterCursor?: LeafTurnCursor): Promise<AdaptiveLoopStep> {
		return this.executeStep((runner) => runner.advance(afterCursor));
	}

	async abort(): Promise<void> {
		await this.runner?.abort();
	}

	getLastCapsule(): CandidatePolicyStateCapsule | undefined {
		return this.lastCapsule === undefined ? undefined : structuredClone(this.lastCapsule);
	}

	metrics(): AdaptiveLoopMetrics {
		const state = this.lastCapsule?.snapshot;
		return {
			providerRequests: this.providerRequests,
			turns: this.turnCount,
			latencyMs: { total: this.totalLatencyMs, perTurn: [...this.perTurnLatencyMs] },
			tokens: structuredClone(this.tokenTotals),
			// Execution errors exclude blocked calls: a block is its own metric.
			toolErrors: state === undefined ? 0 : Math.max(0, state.tools.failure - state.tools.block),
			toolBlocks: state?.tools.block ?? 0,
			redundantCalls: this.redundantCalls,
			verificationCoverage: state?.verification.coverage ?? 0,
		};
	}

	/** Convenience drive: start plus advance until a terminal step. */
	async run(
		prompt: LoopPrompt,
		options?: { inheritedBasis?: HarnessV4LeafTurnBasis },
	): Promise<AdaptiveLoopRunResult> {
		try {
			await this.admit();
		} catch (error) {
			if (error instanceof LoopAdmissionError) {
				return { kind: "admission_rejected", code: error.code, message: error.message, metrics: this.metrics() };
			}
			throw error;
		}
		let step = await this.start(prompt, options);
		while (step.kind === "turn" && step.decision.kind === "continue" && step.settlement === undefined) {
			step = await this.advance(step.turn.cursor);
		}
		return this.mapStepToRunResult(step);
	}

	private async executeStep(
		drive: (
			runner: CandidateTurnRunner,
		) => Promise<{ step: Awaited<ReturnType<CandidateTurnRunner["advance"]>>["step"]; drove: boolean }>,
	): Promise<AdaptiveLoopStep> {
		if (this.faulted !== undefined) return this.faulted;
		const runner = this.getRunner();
		this.startedAt = Date.now();
		const { step, drove } = await drive(runner);
		if (drove) {
			this.providerRequests += 1;
			this.totalLatencyMs += Date.now() - this.startedAt;
			if (step.kind === "turn") {
				this.perTurnLatencyMs.push(Date.now() - this.startedAt);
				this.turnCount += 1;
				addUsage(this.tokenTotals, step.observation.turn.usage);
				this.lastCapsule = step.observation.capsule;
				this.redundantCalls += step.observation.evidence.redundantCalls;
			}
		}
		return this.mapStep(step);
	}

	private mapStep(step: Awaited<ReturnType<CandidateTurnRunner["advance"]>>["step"]): AdaptiveLoopStep {
		switch (step.kind) {
			case "turn": {
				const observation = step.observation;
				const mapped: AdaptiveLoopStep = {
					kind: "turn",
					turn: observation.turn,
					state: observation.capsule,
					evidence: observation.evidence,
					decision: step.decision,
					...(observation.settlement === undefined ? {} : { settlement: observation.settlement }),
					...(observation.evaluation === undefined ? {} : { evaluation: observation.evaluation }),
				};
				this.appendTrajectoryForTurn(observation);
				return mapped;
			}
			case "suspended": {
				this.appendTrajectory({ kind: "task", metrics: { suspension: step.operation.reason } });
				return { kind: "suspended", operation: step.operation };
			}
			case "projection_fault": {
				const faulted: AdaptiveLoopStep = {
					kind: "projection_fault",
					code: step.code,
					message: step.message,
				};
				this.faulted = faulted;
				this.options.onProjectionFault?.(new Error(step.message));
				return faulted;
			}
			case "policy_fault": {
				const faulted: AdaptiveLoopStep = { kind: "policy_fault", message: step.message };
				this.faulted = faulted;
				return faulted;
			}
			case "budget_exhausted": {
				const faulted: AdaptiveLoopStep = {
					kind: "budget_exhausted",
					budget: step.budget,
					state: step.state,
				};
				this.faulted = faulted;
				return faulted;
			}
			case "model_drift":
				return { kind: "model_drift", message: step.message };
			case "rejected":
				return {
					kind: "rejected",
					message: step.code === undefined ? step.message : `${step.code}: ${step.message}`,
				};
		}
	}

	private appendTrajectoryForTurn(observation: CandidateTurnObservation): void {
		if (observation.verifierResult !== undefined) {
			this.appendTrajectory({
				kind: "evaluator_evidence",
				turn: observation.turn,
				metrics: {
					verifierId: this.options.task.verifier?.id,
					verifier: observation.verifierResult,
				},
			});
		}
		if (observation.evaluation !== undefined && observation.settlement !== undefined) {
			this.appendTrajectory({
				kind: "task",
				metrics: { evaluation: observation.evaluation, settlement: observation.settlement.kind },
			});
		}
		this.appendTrajectory({
			kind: "turn",
			turn: observation.turn,
			state: observation.capsule,
			evidence: observation.evidence,
			metrics: {
				toolResults: observation.turn.toolResults.map((result) => ({
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					isError: result.isError,
					contentLength: result.content.reduce(
						(length, part) => length + (part.type === "text" ? part.text.length : 0),
						0,
					),
				})),
			},
		});
	}

	private appendTrajectory(record: {
		kind: "turn" | "task" | "evaluator_evidence";
		turn?: LeafTurnResult;
		state?: CandidatePolicyStateCapsule;
		evidence?: TurnEvidence;
		metrics?: Record<string, unknown>;
	}): void {
		const trajectory = this.trajectory;
		if (trajectory === undefined) return;
		const turn = record.turn;
		const state = record.state ?? this.lastCapsule;
		const trajectoryRecord: TrajectoryRecord = {
			id:
				turn === undefined
					? `${record.kind}:${this.options.task.taskId}:${this.options.task.candidateId}:${this.trajectorySeq++}`
					: `${record.kind}:${turn.operationId}:${turn.assistantEntryId}`,
			kind: record.kind,
			taskId: this.options.task.taskId,
			candidateId: this.options.task.candidateId,
			sessionId: this.options.session.metadata.id,
			operationId: turn?.operationId ?? "",
			...(turn === undefined ? {} : { assistantEntryId: turn.assistantEntryId }),
			policyBundleVersion: this.options.task.policyBundle.version,
			policyBundleFingerprint: this.options.task.policyBundle.fingerprint,
			...(state === undefined ? {} : { stateFingerprint: state.fingerprint }),
			metrics: sanitizeTrajectoryMetrics({
				...(record.metrics ?? {}),
				...(record.evidence === undefined ? {} : { evidence: record.evidence }),
				...(turn === undefined ? {} : { turnSummary: summarizeTurn(turn) }),
			}) as Record<string, unknown>,
			recordedAt: Date.now(),
		};
		// Fire and forget: the store is never on the correctness path, and a
		// failing store must not surface as an unhandled rejection.
		trajectory.append(trajectoryRecord).catch(() => undefined);
	}

	private mapStepToRunResult(step: AdaptiveLoopStep): AdaptiveLoopRunResult {
		const metrics = this.metrics();
		switch (step.kind) {
			case "turn":
				if (step.settlement === undefined) {
					return {
						kind: "stopped",
						reason: step.decision.kind === "stop" ? step.decision.reason : "loop stopped",
						state: step.state,
						metrics,
					};
				}
				if (step.settlement.kind === "completed") {
					return {
						kind: "completed",
						evaluation: step.evaluation ?? { kind: "unknown", reason: "no evaluation" },
						state: step.state,
						metrics,
					};
				}
				if (step.settlement.kind === "aborted") return { kind: "aborted", state: step.state, metrics };
				return { kind: "failed", reason: step.settlement.error.message, state: step.state, metrics };
			case "suspended":
				return { kind: "suspended", operation: step.operation, metrics };
			case "budget_exhausted":
				return { kind: "budget_exhausted", budget: step.budget, state: step.state, metrics };
			case "projection_fault":
				return { kind: "projection_fault", code: step.code, message: step.message, metrics };
			case "policy_fault":
				return { kind: "projection_fault", code: "policy_fault", message: step.message, metrics };
			case "model_drift":
				return { kind: "failed", reason: step.message, metrics };
			case "rejected":
				return { kind: "failed", reason: step.message, metrics };
		}
	}
}

function summarizeTurn(turn: LeafTurnResult): Record<string, unknown> {
	return {
		toolResultCount: turn.toolResults.length,
		toolErrors: turn.toolResults.filter((result) => result.isError).length,
		contentLength: turn.message.content.reduce(
			(length, part) => length + (part.type === "text" ? part.text.length : 0),
			0,
		),
	};
}
