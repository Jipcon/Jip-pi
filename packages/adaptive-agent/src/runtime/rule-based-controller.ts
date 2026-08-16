import type { TaskBudgetFacts } from "./adaptive-task-budget.ts";
import type { BeliefState } from "./belief-state.ts";
import type { ExactSamplingVariant } from "./harness-v4-contract.ts";
import type { LeafTurnCursor } from "./leaf-turn-executor.ts";
import type { PolicyBundleRef } from "./policy-bundle.ts";

/**
 * Rule-based Controller (Stage 8, S8.4): a pure function, no second LLM, no
 * coding tool calls. The decision basis is exactly the durable fingerprints
 * plus the bounded facts listed in ControllerInput; the same input always
 * yields the same decision.
 */

export type ControllerDecision =
	| { kind: "continue" }
	| { kind: "branch"; variants: ExactSamplingVariant[] }
	| { kind: "verify" }
	| { kind: "prune"; reason: string; budget?: "calls" | "tokens" | "time" | "candidates" }
	| { kind: "stop"; reason: string }
	| { kind: "suspend"; reason: string }
	| { kind: "fault"; reason: string };

export interface ControllerInput {
	graphRevision: number;
	candidateId: string;
	cursor: LeafTurnCursor | undefined;
	policyStateFingerprint: string;
	beliefFingerprint: string;
	budgetFingerprint: string;
	policyBundle: PolicyBundleRef;
	/** Run settlement of the last observed turn, when the run settled. */
	settled?: "completed" | "failed" | "aborted";
	/** The candidate ended its last turn in a typed suspension. */
	suspended?: boolean;
	/** Storage/projection/fingerprint fault observed for this candidate. */
	faulted?: string;
	belief: BeliefState;
	/** Failure fingerprints observed in the last turn. */
	lastTurnFailures: number;
	/** Redundant calls observed in the last turn. */
	lastTurnRedundancy: number;
	/** Deterministic branch variants (two siblings) precomputed by the runtime. */
	branchVariants: ExactSamplingVariant[];
	/** Slots are available for another exact branch. */
	canBranch: boolean;
	/** Another candidate is already eligible-verified. */
	eligibleVerifiedExists: boolean;
	/**
	 * Value of continuing this candidate, in basis points. The runtime passes
	 * 0 for an already-completed candidate and for any candidate once an
	 * eligible verified candidate exists (serial MVP: no parallel upside).
	 */
	continueValueBps: number;
	/** Redundancy threshold for the exact-branch rule. */
	redundancyThreshold: number;
	budget: TaskBudgetFacts;
	exhaustion?: { budget: "calls" | "tokens" | "time" | "candidates" };
}

/**
 * Rule precedence (first match wins):
 * 1. storage/projection/fingerprint fault -> fault the task, zero new effect;
 * 2. an eligible verified candidate exists and continuing value <= 0 -> stop;
 * 3. completed candidate without a final verifier -> verify;
 * 4. open post-turn with verifier fail/repeated failure/redundancy above
 *    threshold, and branch slots are available -> exact branch(2);
 * 5. candidate/path/task budget exhausted -> prune;
 * 6. failed/aborted/suspended non-recoverable candidate -> prune or typed
 *    task suspension;
 * 7. otherwise continue.
 */
export function decideController(input: ControllerInput): ControllerDecision {
	if (input.faulted !== undefined) {
		return { kind: "fault", reason: input.faulted };
	}
	if (input.eligibleVerifiedExists && input.continueValueBps <= 0) {
		return { kind: "stop", reason: "an eligible verified candidate exists and continuing has no value" };
	}
	if (input.settled === "completed" && input.belief.verifierStatus === "none") {
		return { kind: "verify" };
	}
	if (
		input.settled === undefined &&
		input.cursor !== undefined &&
		(input.belief.verifierStatus === "fail" ||
			input.lastTurnFailures > 0 ||
			input.lastTurnRedundancy >= input.redundancyThreshold) &&
		input.canBranch
	) {
		return { kind: "branch", variants: input.branchVariants.map((variant) => ({ ...variant })) };
	}
	if (input.exhaustion !== undefined) {
		return {
			kind: "prune",
			reason: `task budget ${input.exhaustion.budget} exhausted`,
			budget: input.exhaustion.budget,
		};
	}
	if (input.settled === "failed" || input.settled === "aborted") {
		return { kind: "prune", reason: `run ${input.settled}` };
	}
	if (
		input.settled === "completed" &&
		(input.belief.verifierStatus === "fail" || input.belief.verifierStatus === "interrupted")
	) {
		return { kind: "prune", reason: `final verifier ${input.belief.verifierStatus}` };
	}
	if (input.suspended === true) {
		return { kind: "suspend", reason: "candidate run suspended" };
	}
	return { kind: "continue" };
}
