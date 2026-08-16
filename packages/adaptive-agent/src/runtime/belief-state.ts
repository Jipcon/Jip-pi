import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { fingerprintOfJson } from "./policy-bundle.ts";

/**
 * Simple rule-based belief fusion (Stage 8, S8.3). All quantities are
 * integers in basis points (1/100 of a percent, 0..10000) so the canonical
 * fingerprint never depends on floating point representation. Fusion is a
 * pure deterministic reducer: identical state + evidence always produce the
 * identical fingerprint, and the documented monotonicity invariants hold.
 */

export type BeliefVerifierStatus = "none" | "planned" | "pass" | "fail" | "interrupted";

export interface BeliefState {
	/** Success probability interval, basis points, low <= high. */
	successProbability: { low: number; high: number };
	/** Current path value interval, basis points, low <= high. */
	pathValue: { low: number; high: number };
	/** Uncertainty, basis points 0..10000. */
	uncertainty: number;
	/** Evidence coverage percent 0..100 (integer). */
	evidenceCoverage: number;
	/** Verification debt: unverified mutations since the last verified state. */
	verificationDebt: number;
	/** Failure posterior, basis points 0..10000. */
	failurePosterior: number;
	verifierStatus: BeliefVerifierStatus;
	/** Number of verification runs requested for this candidate. */
	requestedEvidence: number;
}

export const MAX_BPS = 10_000;

export function initialBelief(): BeliefState {
	return {
		successProbability: { low: 0, high: 5_000 },
		pathValue: { low: 3_000, high: 7_000 },
		uncertainty: 5_000,
		evidenceCoverage: 0,
		verificationDebt: 0,
		failurePosterior: 0,
		verifierStatus: "none",
		requestedEvidence: 0,
	};
}

/** Deterministic fingerprint over the canonical belief object. */
export function fingerprintBelief(belief: BeliefState): string {
	return fingerprintOfJson(belief as unknown as JsonValue);
}

export function validateBeliefState(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return "belief must be an object";
	const belief = value as Record<string, unknown>;
	const interval = (field: string): string | undefined => {
		const candidate = belief[field];
		if (typeof candidate !== "object" || candidate === null) return `belief.${field} must be an interval`;
		const low = (candidate as { low?: unknown }).low;
		const high = (candidate as { high?: unknown }).high;
		if (typeof low !== "number" || !Number.isSafeInteger(low) || low < 0 || low > MAX_BPS)
			return `belief.${field}.low must be basis points`;
		if (typeof high !== "number" || !Number.isSafeInteger(high) || high < 0 || high > MAX_BPS)
			return `belief.${field}.high must be basis points`;
		if (low > high) return `belief.${field} has low > high`;
		return undefined;
	};
	for (const field of ["successProbability", "pathValue"]) {
		const invalid = interval(field);
		if (invalid !== undefined) return invalid;
	}
	for (const field of ["uncertainty", "failurePosterior"]) {
		const candidate = belief[field];
		if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0 || candidate > MAX_BPS)
			return `belief.${field} must be basis points`;
	}
	for (const field of ["verificationDebt", "requestedEvidence"]) {
		const candidate = belief[field];
		if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)
			return `belief.${field} must be a count`;
	}
	const coverage = belief.evidenceCoverage;
	if (typeof coverage !== "number" || !Number.isSafeInteger(coverage) || coverage < 0 || coverage > 100)
		return "belief.evidenceCoverage must be an integer percent 0-100";
	const status = belief.verifierStatus;
	if (status !== "none" && status !== "planned" && status !== "pass" && status !== "fail" && status !== "interrupted")
		return "belief.verifierStatus is invalid";
	return undefined;
}

export interface BeliefEvidence {
	/** Post-turn evidence of the observed turn. */
	turn?: {
		redundantCalls: number;
		failureFingerprints: string[];
		verificationAttempts: number;
		verificationSuccesses: number;
	};
	/** Settled hard-verifier outcome (workspace mutation counts as an effective failure). */
	verifier?: {
		effectiveStatus: "pass" | "fail" | "interrupted";
		coverage: number;
	};
	/** Current verification debt carried over from the policy state. */
	verificationDebt?: number;
	/** A verification run was planned for this candidate. */
	requestedEvidence?: boolean;
}

function clampBps(value: number): number {
	return Math.min(MAX_BPS, Math.max(0, value));
}

/**
 * Pure deterministic fusion. Monotonicity invariants (S8.3):
 * - a verifier failure can never raise the success belief;
 * - a verifier pass can never lower the evidence coverage;
 * - debt, repeated calls and failures can only lower the path value;
 * - a verifier pass clears the verification debt (whole-workspace coverage);
 * - no "pass" state is ever produced without a real verifier pass.
 */
export function fuseBelief(state: BeliefState, evidence: BeliefEvidence): BeliefState {
	const next = structuredClone(state);
	// A hard-verifier pass verifies the whole candidate workspace and clears
	// the accumulated debt; anything else keeps the debt monotone.
	if (evidence.verifier?.effectiveStatus === "pass") {
		next.verificationDebt = 0;
	} else {
		next.verificationDebt = Math.max(next.verificationDebt, evidence.verificationDebt ?? 0);
	}

	if (evidence.verifier !== undefined) {
		const { effectiveStatus, coverage } = evidence.verifier;
		if (effectiveStatus === "pass") {
			next.evidenceCoverage = Math.max(next.evidenceCoverage, Math.min(100, Math.max(0, coverage)));
			next.successProbability.low = Math.max(
				next.successProbability.low,
				clampBps(5_000 + 30 * next.evidenceCoverage),
			);
			next.successProbability.high = Math.max(next.successProbability.high, next.successProbability.low);
			next.pathValue.high = Math.max(next.pathValue.low, clampBps(next.pathValue.high + 20 * next.evidenceCoverage));
			next.uncertainty = Math.max(0, next.uncertainty - 2_000);
			next.verifierStatus = "pass";
		} else if (effectiveStatus === "fail") {
			next.successProbability.high = Math.min(
				next.successProbability.high,
				Math.max(next.successProbability.low, 3_000),
			);
			next.failurePosterior = Math.max(next.failurePosterior, 6_000);
			next.uncertainty = Math.min(MAX_BPS, next.uncertainty + 2_000);
			next.pathValue.high = Math.max(next.pathValue.low, next.pathValue.high - 3_000);
			next.verifierStatus = "fail";
		} else {
			if (next.verifierStatus === "none" || next.verifierStatus === "planned") {
				next.verifierStatus = "interrupted";
			}
			next.uncertainty = Math.min(MAX_BPS, next.uncertainty + 1_000);
			next.pathValue.high = Math.max(next.pathValue.low, next.pathValue.high - 1_000);
		}
	}

	if (evidence.turn !== undefined) {
		const { redundantCalls, failureFingerprints, verificationAttempts, verificationSuccesses } = evidence.turn;
		const penalty = redundantCalls * 300 + failureFingerprints.length * 200;
		if (penalty > 0) next.pathValue.high = Math.max(next.pathValue.low, next.pathValue.high - penalty);
		if (failureFingerprints.length > 0) {
			next.failurePosterior = Math.max(next.failurePosterior, clampBps(1_500 * failureFingerprints.length));
		}
		next.uncertainty = Math.min(MAX_BPS, next.uncertainty + 100 * redundantCalls);
		if (verificationAttempts > 0) {
			const attemptCoverage = Math.round((100 * verificationSuccesses) / verificationAttempts);
			next.evidenceCoverage = Math.max(next.evidenceCoverage, attemptCoverage);
		}
	}
	if (next.verificationDebt > 0) {
		next.pathValue.high = Math.max(
			next.pathValue.low,
			next.pathValue.high - Math.min(next.verificationDebt, 20) * 100,
		);
	}
	if (evidence.requestedEvidence === true) next.requestedEvidence += 1;

	return next;
}

/** Winner eligibility: a real verifier pass, sufficient coverage, zero debt. */
export function isEligibleVerified(belief: BeliefState, requiredCoverage: number): boolean {
	return (
		belief.verifierStatus === "pass" && belief.evidenceCoverage >= requiredCoverage && belief.verificationDebt === 0
	);
}
