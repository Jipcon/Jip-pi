import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Session } from "@earendil-works/pi-agent-core/harness-v4";
import { type CandidateUsageLedger, scanCandidateUsage } from "./adaptive-task-budget.ts";
import { type CandidatePolicyState, initialCandidateState, type WorkspaceMetadata } from "./candidate-policy-state.ts";
import {
	evaluateTask,
	type TaskEvaluation,
	type TaskVerifier,
	type TaskVerifierResult,
	type TurnEvidence,
} from "./evaluator.ts";
import type { HarnessV4AdaptiveLane, HarnessV4LeafTurnBasis } from "./harness-leaf-turn-adapter.ts";
import type { CandidatePolicyStateCapsule, ProjectionBasis } from "./harness-v4-contract.ts";
import type {
	LeafTurnCommand,
	LeafTurnCursor,
	LeafTurnExecutor,
	LeafTurnOutcome,
	LeafTurnResult,
	LeafTurnRunSettlement,
	LeafTurnSuspension,
} from "./leaf-turn-executor.ts";
import {
	computeToolCatalogFingerprint,
	FIXED_TOOL_NAMES,
	type PolicyBundle,
	type PolicyBundleRef,
	PROJECTOR_VERSION,
	TOOL_POLICY_FAULT_FINGERPRINT,
} from "./policy-bundle.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import { type CandidateStateProjector, createOriginCapsule, StateProjectionMismatch } from "./state-projector.ts";

/**
 * Recoverable single-turn candidate runner (Stage 8, S8.2): one LeafTurn per
 * call, post-turn projection + deterministic TurnEvaluator + durable cost
 * observation before returning. Supports root prompt Runs (start) and
 * already-durable-accepted exact child Runs (advance). Process-local metrics
 * are not authoritative here: the durable usage ledger is rebuilt from
 * Harness usage rows and the TaskJournal.
 */

export type ExecutorFactory = (basis: HarnessV4LeafTurnBasis) => LeafTurnExecutor;

export type TerminalDecision = { kind: "continue" } | { kind: "stop"; reason: string };
export type TerminalPolicy = (turn: LeafTurnResult, state: CandidatePolicyState) => TerminalDecision;

/** Deterministic default: a final answer (no tool calls) stops the loop. */
export function defaultTerminalPolicy(turn: LeafTurnResult, _state: CandidatePolicyState): TerminalDecision {
	const hasToolCalls = turn.message.content.some((part) => part.type === "toolCall");
	return hasToolCalls ? { kind: "continue" } : { kind: "stop", reason: "final answer" };
}

export interface WorkspaceMetadataSource {
	capture(): Promise<WorkspaceMetadata> | WorkspaceMetadata;
}

export type LoopAdmissionErrorCode =
	| "missing_bundle"
	| "corrupt_bundle"
	| "catalog_drift"
	| "model_drift"
	| "invalid_root";

export class LoopAdmissionError extends Error {
	readonly code: LoopAdmissionErrorCode;

	constructor(code: LoopAdmissionErrorCode, message: string) {
		super(message);
		this.name = "LoopAdmissionError";
		this.code = code;
	}
}

export interface LoopAdmission {
	originCapsule: CandidatePolicyStateCapsule;
	bundle: PolicyBundle;
	catalogFingerprint: string;
}

export interface CandidateTurnObservation {
	turn: LeafTurnResult;
	capsule: CandidatePolicyStateCapsule;
	evidence: TurnEvidence;
	settlement?: LeafTurnRunSettlement;
	evaluation?: TaskEvaluation;
	verifierResult?: TaskVerifierResult;
}

export type CandidateTurnStep =
	| { kind: "turn"; observation: CandidateTurnObservation; decision: TerminalDecision }
	| { kind: "suspended"; operation: LeafTurnSuspension }
	| { kind: "projection_fault"; code: "projection_mismatch" | "policy_fault"; message: string }
	| { kind: "policy_fault"; message: string }
	| { kind: "budget_exhausted"; budget: "turns" | "tools" | "tokens"; state: CandidatePolicyStateCapsule }
	| { kind: "model_drift"; message: string }
	| { kind: "rejected"; code?: LoopAdmissionErrorCode; message: string };

export interface CandidateTurnRunnerOptions {
	session: Session;
	lane: HarnessV4AdaptiveLane;
	registry: PolicyRegistry;
	projector: CandidateStateProjector;
	/** Root mode: creates the executor on first start. */
	executorFactory?: ExecutorFactory;
	/** Attached mode: an already-admitted exact child executor (advance only). */
	executor?: LeafTurnExecutor;
	/** The fixed read/write/edit/bash catalog configured on the harness. */
	tools: AgentTool[];
	workspaceRoot: string;
	workspaceMetadata?: WorkspaceMetadataSource;
	task: {
		taskId: string;
		candidateId: string;
		policyBundle: PolicyBundleRef;
		frozenModel: { provider: string; modelId: string };
	};
	verifier?: TaskVerifier;
	terminalPolicy?: TerminalPolicy;
	/**
	 * Stage 7 branch-origin guard: checked before every start/advance. A
	 * frozen source lane throws BranchOriginFrozen and no effect happens.
	 */
	originGuard?: () => Promise<void>;
	/** Basis to reuse (root reattach or attached child identity). */
	inheritedBasis?: HarnessV4LeafTurnBasis;
	/**
	 * Exact-continuation children: the source session that owns the usage
	 * rows of the inherited prefix (forks never copy the usage ledger).
	 */
	inheritedUsageSource?: Session;
}

export type LoopPrompt = Extract<LeafTurnCommand, { kind: "start" }>["prompt"];

export class CandidateTurnRunner {
	private readonly options: CandidateTurnRunnerOptions;
	private executor: LeafTurnExecutor | undefined;
	private basis: HarnessV4LeafTurnBasis | undefined;
	private seedFingerprint = "";
	private admitted: LoopAdmission | undefined;
	private turnCount = 0;

	constructor(options: CandidateTurnRunnerOptions) {
		this.options = options;
	}

	get observedTurnCount(): number {
		return this.turnCount;
	}

	/** Durable usage ledger rebuilt from this candidate session's usage rows. */
	async durableUsage(): Promise<CandidateUsageLedger> {
		return scanCandidateUsage(this.options.session);
	}

	async admit(): Promise<LoopAdmission> {
		if (this.admitted !== undefined) return this.admitted;
		const task = this.options.task;
		const bundle = await this.resolveBundle(task.policyBundle);
		await this.checkCatalog(bundle);
		await this.checkModel();
		const workspaceMetadata = await this.captureWorkspaceMetadata();
		const originCapsule = createOriginCapsule({
			taskId: task.taskId,
			candidateId: task.candidateId,
			sessionId: this.options.session.metadata.id,
			lane: this.options.lane.name,
			policyBundle: task.policyBundle,
			snapshot: initialCandidateState(
				bundle.rules.budgets.maxTurns,
				bundle.rules.budgets.maxToolCalls,
				bundle.rules.budgets.maxTokens,
			),
			...(workspaceMetadata === undefined ? {} : { workspaceMetadata }),
		});
		this.admitted = {
			originCapsule,
			bundle,
			catalogFingerprint: computeToolCatalogFingerprint(this.options.tools),
		};
		return this.admitted;
	}

	/**
	 * Observes an already-durable turn without dispatching anything: used by
	 * crash recovery to re-derive the projection of a parked or settled turn.
	 */
	async observeTurn(input: { turn: LeafTurnResult; settlement?: LeafTurnRunSettlement }): Promise<CandidateTurnStep> {
		// Crash recovery may observe a durable turn before any executor (and
		// therefore basis) exists; derive the same deterministic basis first.
		await this.ensureBasis();
		return this.observeOutcome({
			kind: "turn",
			turn: input.turn,
			run: input.settlement === undefined ? { kind: "open" } : { kind: "settled", result: input.settlement },
		});
	}

	start(
		prompt: LoopPrompt,
		options?: { inheritedBasis?: HarnessV4LeafTurnBasis },
	): Promise<{ step: CandidateTurnStep; drove: boolean }> {
		return this.executeStep((executor) => executor.execute({ kind: "start", prompt }), options?.inheritedBasis);
	}

	advance(afterCursor?: LeafTurnCursor): Promise<{ step: CandidateTurnStep; drove: boolean }> {
		return this.executeStep((executor) => executor.execute({ kind: "advance", afterCursor }));
	}

	async abort(): Promise<void> {
		if (this.executor === undefined) return;
		await this.executor.abort();
	}

	private async ensureBasis(): Promise<void> {
		if (this.basis === undefined) {
			const admission = this.options.executorFactory === undefined ? undefined : await this.admit();
			this.basis =
				this.options.inheritedBasis ??
				(admission === undefined
					? undefined
					: {
							schemaVersion: 1,
							taskId: admission.originCapsule.basis.taskId,
							candidateId: admission.originCapsule.basis.candidateId,
							policyBundle: admission.originCapsule.basis.policyBundle,
							projectorVersion: PROJECTOR_VERSION,
							inheritedPolicyState: structuredClone(admission.originCapsule),
							start: { kind: "prompt" },
						});
			if (this.basis === undefined) {
				throw new LoopAdmissionError("invalid_root", "observing a turn requires a run basis");
			}
		}
		if (this.seedFingerprint === "") {
			this.seedFingerprint = this.basis.inheritedPolicyState.fingerprint;
		}
	}

	private async executeStep(
		drive: (executor: LeafTurnExecutor) => Promise<Awaited<ReturnType<LeafTurnExecutor["execute"]>>>,
		inheritedBasis?: HarnessV4LeafTurnBasis,
	): Promise<{ step: CandidateTurnStep; drove: boolean }> {
		const originGuard = this.options.originGuard;
		if (originGuard !== undefined) await originGuard();
		try {
			if (this.options.executorFactory !== undefined) {
				await this.admit();
			} else {
				await this.checkCatalog(await this.resolveBundle(this.options.task.policyBundle));
			}
			// The frozen model is re-checked before every provider request
			// (admission caches, drift between turns must still stop).
			await this.checkModel();
		} catch (error) {
			if (error instanceof LoopAdmissionError) {
				const step: CandidateTurnStep =
					error.code === "model_drift"
						? { kind: "model_drift", message: error.message }
						: { kind: "rejected", code: error.code, message: error.message };
				return { step, drove: false };
			}
			throw error;
		}
		if (this.executor === undefined) {
			if (inheritedBasis !== undefined) this.basis = inheritedBasis;
			await this.ensureBasis();
			this.executor = this.options.executor ?? this.options.executorFactory!(this.basis!);
		}
		const result = await drive(this.executor);
		if (!result.ok) {
			return { step: { kind: "rejected", message: result.error.message }, drove: true };
		}
		return { step: await this.observeOutcome(result.value), drove: true };
	}

	private async observeOutcome(outcome: LeafTurnOutcome): Promise<CandidateTurnStep> {
		if (outcome.kind === "suspended") {
			return { kind: "suspended", operation: outcome.operation };
		}
		const turn = outcome.turn;
		const settlement = outcome.run.kind === "settled" ? outcome.run.result : undefined;
		this.turnCount += 1;

		if (await this.turnHasPolicyFault(turn)) {
			return {
				kind: "policy_fault",
				message: "The turn's tool batch was cleared by a ToolPolicy fault",
			};
		}

		let capsule: CandidatePolicyStateCapsule;
		let evidence: TurnEvidence | undefined;
		try {
			capsule = await this.projectPostTurn(turn, settlement, (observed) => {
				evidence = observed;
			});
		} catch (error) {
			return error instanceof StateProjectionMismatch
				? { kind: "projection_fault", code: "projection_mismatch", message: error.message }
				: {
						kind: "projection_fault",
						code: "policy_fault",
						message: error instanceof Error ? error.message : String(error),
					};
		}
		const turnEvidence: TurnEvidence = evidence ?? {
			phase: capsule.snapshot.phase,
			steps: turn.toolResults.length,
			verificationAttempts: 0,
			verificationSuccesses: 0,
			verificationDebt: capsule.snapshot.verification.debt,
			coverage: capsule.snapshot.verification.coverage,
			redundantCalls: 0,
			failureFingerprints: [],
		};

		const bundle = await this.resolveBundle(this.options.task.policyBundle);
		if (capsule.snapshot.budgets.turns.used >= bundle.rules.budgets.maxTurns) {
			return { kind: "budget_exhausted", budget: "turns", state: capsule };
		}
		if (capsule.snapshot.budgets.tools.used >= bundle.rules.budgets.maxToolCalls) {
			return { kind: "budget_exhausted", budget: "tools", state: capsule };
		}
		if (capsule.snapshot.budgets.tokens.used >= bundle.rules.budgets.maxTokens) {
			return { kind: "budget_exhausted", budget: "tokens", state: capsule };
		}

		let evaluation: TaskEvaluation | undefined;
		let verifierResult: TaskVerifierResult | undefined;
		if (settlement !== undefined) {
			if (settlement.kind === "completed" && this.options.verifier !== undefined) {
				verifierResult = await this.options.verifier.verify();
			}
			evaluation = evaluateTask({ settlement: settlement.kind, state: capsule.snapshot, verifier: verifierResult });
		}
		const decision =
			settlement !== undefined
				? ({ kind: "stop", reason: `run settled: ${settlement.kind}` } as const)
				: (this.options.terminalPolicy ?? defaultTerminalPolicy)(turn, capsule.snapshot);

		return {
			kind: "turn",
			observation: {
				turn,
				capsule,
				evidence: turnEvidence,
				...(settlement === undefined ? {} : { settlement }),
				...(evaluation === undefined ? {} : { evaluation }),
				...(verifierResult === undefined ? {} : { verifierResult }),
			},
			decision,
		};
	}

	private async projectPostTurn(
		turn: LeafTurnResult,
		settlement: LeafTurnRunSettlement | undefined,
		observeTurn: (evidence: TurnEvidence) => void,
	): Promise<CandidatePolicyStateCapsule> {
		const workspaceMetadata = await this.captureWorkspaceMetadata();
		const basis: ProjectionBasis = {
			taskId: this.basis!.taskId,
			candidateId: this.basis!.candidateId,
			sessionId: this.options.session.metadata.id,
			lane: this.options.lane.name,
			operationId: turn.operationId,
			cursor: {
				kind: "post_turn",
				cursor: turn.cursor,
				...(settlement === undefined ? {} : { terminalOutcome: settlement.kind }),
			},
			policyBundle: this.basis!.policyBundle,
			projectorVersion: PROJECTOR_VERSION,
			inheritedStateFingerprint: this.seedFingerprint,
			...(workspaceMetadata === undefined ? {} : { workspaceMetadata }),
		};
		return this.options.projector.project(
			basis,
			{
				session: this.options.session,
				...(this.options.inheritedUsageSource === undefined
					? {}
					: { inheritedUsageSource: this.options.inheritedUsageSource }),
			},
			observeTurn,
		);
	}

	private async turnHasPolicyFault(turn: LeafTurnResult): Promise<boolean> {
		const entries = await this.options.session.findEntriesOnBranch({
			start: turn.cursor.leafId,
			stopAtId: turn.cursor.assistantEntryId,
			order: "oldestFirst",
		});
		return entries.some((entry) => {
			if (entry.type !== "custom" || entry.customType !== "adaptive.tool_batch") return false;
			const data = entry.data as { policyStateFingerprint?: unknown } | undefined;
			return data?.policyStateFingerprint === TOOL_POLICY_FAULT_FINGERPRINT;
		});
	}

	private async captureWorkspaceMetadata(): Promise<WorkspaceMetadata | undefined> {
		const source = this.options.workspaceMetadata;
		if (source === undefined) return undefined;
		return source.capture();
	}

	private async resolveBundle(ref: PolicyBundleRef): Promise<PolicyBundle> {
		try {
			return await this.options.registry.resolve(ref);
		} catch (error) {
			throw new LoopAdmissionError("corrupt_bundle", error instanceof Error ? error.message : String(error));
		}
	}

	private async checkCatalog(bundle: PolicyBundle): Promise<void> {
		if (this.options.tools.length !== FIXED_TOOL_NAMES.length) {
			throw new LoopAdmissionError(
				"catalog_drift",
				`expected ${FIXED_TOOL_NAMES.length} fixed tools, got ${this.options.tools.length}`,
			);
		}
		for (let index = 0; index < FIXED_TOOL_NAMES.length; index++) {
			if (this.options.tools[index]?.name !== FIXED_TOOL_NAMES[index]) {
				throw new LoopAdmissionError("catalog_drift", `expected ${FIXED_TOOL_NAMES[index]} at index ${index}`);
			}
		}
		const fingerprint = computeToolCatalogFingerprint(this.options.tools);
		if (fingerprint !== bundle.rules.toolCatalogFingerprint) {
			throw new LoopAdmissionError(
				"catalog_drift",
				`tool catalog fingerprint ${fingerprint} does not match the pinned bundle`,
			);
		}
		const activeTools = await this.options.lane.getActiveTools();
		if (
			activeTools.length !== FIXED_TOOL_NAMES.length ||
			activeTools.some((name, index) => name !== FIXED_TOOL_NAMES[index])
		) {
			throw new LoopAdmissionError(
				"catalog_drift",
				`lane active tools ${activeTools.join(",")} do not match the fixed catalog`,
			);
		}
	}

	private async checkModel(): Promise<void> {
		const model = await this.options.lane.getModel();
		const frozen = this.options.task.frozenModel;
		if (model === undefined || model.provider !== frozen.provider || model.id !== frozen.modelId) {
			throw new LoopAdmissionError(
				"model_drift",
				`lane model ${model?.provider}/${model?.id} is not the frozen model ${frozen.provider}/${frozen.modelId}`,
			);
		}
	}
}
