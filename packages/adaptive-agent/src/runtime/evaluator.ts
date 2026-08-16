import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import {
	type CandidatePhase,
	type CandidatePolicyState,
	MAX_MUTATED_FILES,
	MAX_RECENT_FINGERPRINTS,
} from "./candidate-policy-state.ts";
import { FIXED_TOOL_NAMES, fingerprintOfJson } from "./policy-bundle.ts";

export interface VerificationRules {
	/** Regexes matched against the effective command of bash calls. */
	commandPatterns: string[];
}

export const NO_VERIFICATION_RULES: VerificationRules = { commandPatterns: [] };

/** Deterministic facts of one durable tool step, reconstructible from entries. */
export interface ToolStepFacts {
	toolName: string;
	decision: "allow" | "guard" | "block";
	/** Effective args; undefined for block decisions. */
	args: Record<string, JsonValue> | undefined;
	isError: boolean;
	seq: number;
	timestamp: number;
}

export interface TurnFacts {
	assistantEntryId: string;
	seq: number;
	timestamp: number;
	steps: ToolStepFacts[];
	usageTokens: number;
}

export interface StepEvidence {
	toolName: string;
	decision: "allow" | "guard" | "block";
	isError: boolean;
	redundant: boolean;
	seq: number;
	fingerprint: string;
}

export interface TurnEvidence {
	phase: CandidatePhase;
	steps: number;
	verificationAttempts: number;
	verificationSuccesses: number;
	verificationDebt: number;
	coverage: number;
	redundantCalls: number;
	failureFingerprints: string[];
}

function canonicalArgs(args: Record<string, JsonValue> | undefined): string | undefined {
	return args === undefined ? undefined : fingerprintOfJson(args);
}

function isVerificationStep(step: ToolStepFacts, rules: VerificationRules): boolean {
	if (step.toolName !== "bash" || step.args === undefined) return false;
	const command = step.args.command;
	if (typeof command !== "string") return false;
	return rules.commandPatterns.some((pattern) => new RegExp(pattern).test(command));
}

function pushBounded(
	list: { kind: "action" | "failure"; seq: number; hash: string }[],
	item: { kind: "action" | "failure"; seq: number; hash: string },
): void {
	list.push(item);
	if (list.length > MAX_RECENT_FINGERPRINTS) list.splice(0, list.length - MAX_RECENT_FINGERPRINTS);
}

/**
 * The single deterministic step reducer shared by StepEvaluator, TurnEvaluator
 * and CandidateStateProjector. `redundant` is caller-computed within the turn
 * scope (an identical tool call after the first one in the same batch).
 */
export function reduceStep(
	state: CandidatePolicyState,
	step: ToolStepFacts,
	rules: VerificationRules,
	redundant: boolean,
): { state: CandidatePolicyState; evidence: StepEvidence } {
	const next = structuredClone(state);
	const argsFingerprint = canonicalArgs(step.args);
	const actionFingerprint = fingerprintOfJson({
		toolName: step.toolName,
		args: argsFingerprint === undefined ? null : argsFingerprint,
		isError: step.isError,
	} as unknown as JsonValue);
	const toolKey = (FIXED_TOOL_NAMES as readonly string[]).includes(step.toolName) ? step.toolName : "other";
	next.tools.byTool[toolKey] ??= { allow: 0, guard: 0, block: 0, success: 0, failure: 0 };
	const perTool = next.tools.byTool[toolKey]!;
	next.steps += 1;
	next.tools[step.decision] += 1;
	perTool[step.decision] += 1;
	if (step.isError) {
		next.tools.failure += 1;
		perTool.failure += 1;
		pushBounded(next.failures, { kind: "failure", seq: step.seq, hash: actionFingerprint });
	} else {
		next.tools.success += 1;
		perTool.success += 1;
	}
	if (redundant) next.tools.duplicate += 1;
	pushBounded(next.recent, { kind: "action", seq: step.seq, hash: actionFingerprint });
	next.budgets.tools.used += 1;

	// File freshness: only write/edit mutate; read counts reads.
	const path = step.args !== undefined && typeof step.args.path === "string" ? step.args.path : undefined;
	if (path !== undefined && (step.toolName === "write" || step.toolName === "edit") && !step.isError) {
		applyMutation(next, path, step.toolName, step.seq, step.timestamp);
	} else if (path !== undefined && step.toolName === "read" && !step.isError) {
		next.files.totalReads += 1;
		const existing = next.files.mutated.find((file) => file.path === path);
		if (existing !== undefined) existing.reads += 1;
	}

	// Verification evidence: deterministic classification of bash calls.
	const verified = isVerificationStep(step, rules);
	if (verified) {
		next.verification.attempts += 1;
		if (step.isError) {
			next.verification.failures += 1;
		} else {
			next.verification.successes += 1;
			next.verification.lastVerifiedSeq = step.seq;
		}
	}
	next.verification.debt = countDebt(next);
	next.verification.coverage = computeCoverage(next.verification);

	return {
		state: next,
		evidence: {
			toolName: step.toolName,
			decision: step.decision,
			isError: step.isError,
			redundant,
			seq: step.seq,
			fingerprint: actionFingerprint,
		},
	};
}

function applyMutation(
	state: CandidatePolicyState,
	path: string,
	toolName: "write" | "edit",
	seq: number,
	timestamp: number,
): void {
	state.files.totalMutations += 1;
	let fresh = state.files.mutated.find((file) => file.path === path);
	if (fresh === undefined) {
		fresh = { path, reads: 0, writes: 0, edits: 0, lastMutationSeq: 0, lastMutationTimestamp: 0 };
		state.files.mutated.push(fresh);
		if (state.files.mutated.length > MAX_MUTATED_FILES) state.files.mutated.shift();
	}
	fresh[toolName === "write" ? "writes" : "edits"] += 1;
	fresh.lastMutationSeq = seq;
	fresh.lastMutationTimestamp = timestamp;
}

function countDebt(state: CandidatePolicyState): number {
	if (state.verification.lastVerifiedSeq === 0) return state.files.totalMutations;
	let debt = 0;
	for (const file of state.files.mutated) {
		if (file.lastMutationSeq > state.verification.lastVerifiedSeq) debt += file.writes + file.edits;
	}
	return debt;
}

function computeCoverage(verification: CandidatePolicyState["verification"]): number {
	if (verification.attempts === 0) return 0;
	const ratio = Math.round((100 * verification.successes) / verification.attempts);
	return verification.debt === 0 ? ratio : Math.min(ratio, 50);
}

/**
 * The single deterministic turn reducer: applies every step source-ordered and
 * derives the turn-level phase. Shared by TurnEvaluator and the projector.
 */
export function reduceTurn(
	state: CandidatePolicyState,
	turn: TurnFacts,
	rules: VerificationRules,
): { state: CandidatePolicyState; evidence: TurnEvidence } {
	let next = structuredClone(state);
	const seen = new Map<string, boolean>();
	const evidence: TurnEvidence = {
		phase: "working",
		steps: turn.steps.length,
		verificationAttempts: 0,
		verificationSuccesses: 0,
		verificationDebt: 0,
		coverage: 0,
		redundantCalls: 0,
		failureFingerprints: [],
	};
	for (const step of turn.steps) {
		const key = `${step.toolName}:${canonicalArgs(step.args) ?? ""}`;
		const repeated = seen.has(key);
		seen.set(key, true);
		const reduced = reduceStep(next, step, rules, repeated);
		next = reduced.state;
		if (reduced.evidence.redundant) evidence.redundantCalls += 1;
		if (reduced.evidence.isError) evidence.failureFingerprints.push(reduced.evidence.fingerprint);
		if (isVerificationStep(step, rules)) {
			evidence.verificationAttempts += 1;
			if (!step.isError) evidence.verificationSuccesses += 1;
		}
	}
	next.turns += 1;
	next.budgets.turns.used += 1;
	next.budgets.tokens.used += turn.usageTokens;
	if (turn.steps.length === 0) next.phase = "answering";
	else if (evidence.verificationAttempts > 0) next.phase = "verifying";
	else next.phase = "working";
	evidence.phase = next.phase;
	evidence.verificationDebt = next.verification.debt;
	evidence.coverage = next.verification.coverage;
	return { state: next, evidence };
}

/** StepEvaluator: effect-scope evidence from the shared deterministic reducer. */
export class DeterministicStepEvaluator {
	readonly rules: VerificationRules;

	constructor(rules: VerificationRules = NO_VERIFICATION_RULES) {
		this.rules = rules;
	}

	evaluate(
		state: CandidatePolicyState,
		step: ToolStepFacts,
		redundant: boolean,
	): { state: CandidatePolicyState; evidence: StepEvidence } {
		return reduceStep(state, step, this.rules, redundant);
	}
}

/** TurnEvaluator: turn aggregation over the same deterministic reducer. */
export class DeterministicTurnEvaluator {
	readonly rules: VerificationRules;

	constructor(rules: VerificationRules = NO_VERIFICATION_RULES) {
		this.rules = rules;
	}

	evaluate(state: CandidatePolicyState, turn: TurnFacts): { state: CandidatePolicyState; evidence: TurnEvidence } {
		return reduceTurn(state, turn, this.rules);
	}
}

/** Hard verifier: runs in the candidate workspace, outside the frozen model. */
export interface TaskVerifier {
	readonly id: string;
	verify(): Promise<TaskVerifierResult>;
}

export type TaskVerifierResult = { ok: true; coverage: number } | { ok: false; error: string };

export interface TaskEvaluationInput {
	settlement?: "completed" | "failed" | "aborted";
	state: CandidatePolicyState;
	verifier?: TaskVerifierResult;
}

export type TaskEvaluation =
	| { kind: "verified"; coverage: number }
	| { kind: "failed"; reason: string }
	| { kind: "unknown"; reason: string };

/**
 * TaskEvaluator ground truth: verified requires an actual verifier pass; a
 * plain final answer without verifier evidence is never reported as success.
 */
export function evaluateTask(input: TaskEvaluationInput): TaskEvaluation {
	if (input.settlement === "failed") return { kind: "failed", reason: "run failed" };
	if (input.settlement === "aborted") return { kind: "failed", reason: "run aborted" };
	if (input.verifier === undefined) {
		return {
			kind: "unknown",
			reason: input.settlement === "completed" ? "no verifier evidence" : "task did not settle",
		};
	}
	if (!input.verifier.ok) return { kind: "failed", reason: input.verifier.error };
	return {
		kind: "verified",
		coverage: input.verifier.coverage,
	};
}
