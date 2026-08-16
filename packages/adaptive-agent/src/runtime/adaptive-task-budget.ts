import type { JsonValue, Session } from "@earendil-works/pi-agent-core/harness-v4";
import { fingerprintOfJson } from "./policy-bundle.ts";

/**
 * Task-level adaptive budget (Stage 8, S8.4). Structure caps are frozen for
 * the MVP; provider call/token/time limits have no defaults and must be
 * provided explicitly by the task admission caller.
 */

export interface AdaptiveTaskBudget {
	maxProviderCalls: number;
	maxTotalTokens: number;
	maxWallClockMs: number;
	maxBranchFanout: number;
	maxActiveCandidates: number;
	maxTotalCandidates: number;
	maxBranchDepth: number;
}

export const FROZEN_BUDGET_CAPS = {
	/** Candidate drives execute strictly serially in the MVP. */
	maxConcurrentCandidateDrives: 1,
	maxBranchFanout: 2,
	maxActiveCandidates: 4,
	maxTotalCandidates: 7,
	maxBranchDepth: 2,
} as const;

/** Validates a caller-supplied budget against the frozen structural caps. */
export function validateAdaptiveTaskBudget(budget: AdaptiveTaskBudget): string | undefined {
	if (typeof budget !== "object" || budget === null) return "budget must be an object";
	for (const field of ["maxProviderCalls", "maxTotalTokens", "maxWallClockMs"] as const) {
		const value = budget[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			return `budget.${field} must be a positive safe integer`;
		}
	}
	if (budget.maxBranchFanout !== FROZEN_BUDGET_CAPS.maxBranchFanout) {
		return `budget.maxBranchFanout must be ${FROZEN_BUDGET_CAPS.maxBranchFanout} (exact branch of two)`;
	}
	for (const field of ["maxActiveCandidates", "maxTotalCandidates", "maxBranchDepth"] as const) {
		const value = budget[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
			return `budget.${field} must be a positive safe integer`;
		}
		if (value > FROZEN_BUDGET_CAPS[field]) {
			return `budget.${field} ${value} exceeds the frozen cap ${FROZEN_BUDGET_CAPS[field]}`;
		}
	}
	return undefined;
}

/** Budget facts observed at a decision point (derived from durable rows). */
export interface TaskBudgetFacts {
	providerCalls: number;
	totalTokens: number;
	wallClockUsedMs: number;
	activeCandidates: number;
	totalCandidates: number;
	deadlineMs: number;
	limits: AdaptiveTaskBudget;
}

/** Deterministic fingerprint of the durable budget facts (excludes wall clock). */
export function taskBudgetFingerprint(facts: TaskBudgetFacts): string {
	const { wallClockUsedMs: _wall, ...durable } = facts;
	void _wall;
	return fingerprintOfJson(durable as unknown as JsonValue);
}

export type BudgetExhaustion =
	| { budget: "calls"; used: number; limit: number }
	| { budget: "tokens"; used: number; limit: number }
	| { budget: "time"; used: number; limit: number }
	| { budget: "candidates"; used: number; limit: number };

/**
 * Exhaustion facts. Token accounting allows the currently in-flight serial
 * request one unpredictable overshoot; the caller is responsible for not
 * dispatching a new provider request once calls/time are exhausted.
 */
export function budgetExhaustion(facts: TaskBudgetFacts): BudgetExhaustion | undefined {
	if (facts.providerCalls >= facts.limits.maxProviderCalls) {
		return { budget: "calls", used: facts.providerCalls, limit: facts.limits.maxProviderCalls };
	}
	if (facts.totalTokens >= facts.limits.maxTotalTokens) {
		return { budget: "tokens", used: facts.totalTokens, limit: facts.limits.maxTotalTokens };
	}
	if (facts.wallClockUsedMs >= facts.limits.maxWallClockMs) {
		return { budget: "time", used: facts.wallClockUsedMs, limit: facts.limits.maxWallClockMs };
	}
	if (facts.totalCandidates >= facts.limits.maxTotalCandidates) {
		return { budget: "candidates", used: facts.totalCandidates, limit: facts.limits.maxTotalCandidates };
	}
	return undefined;
}

export interface CandidateUsageLedger {
	providerCalls: number;
	totalTokens: number;
}

/**
 * Per-candidate usage ledger rebuilt from the candidate session's usage rows
 * only. Provider calls count rows associated with an assistant entry; tokens
 * sum every row of this session exactly once. Forked child sessions carry no
 * source rows, so the source cost is never double-billed by entry fork.
 */
export async function scanCandidateUsage(session: Session): Promise<CandidateUsageLedger> {
	const rows = await session.scanUsage({ order: "asc" });
	let totalTokens = 0;
	const entryIds = new Set<string>();
	for (const row of rows) {
		totalTokens += row.usage.totalTokens;
		if (row.entryId !== undefined && row.entryId !== null) entryIds.add(row.entryId);
	}
	let providerCalls = 0;
	if (entryIds.size > 0) {
		const entries = await session.getEntries([...entryIds]);
		for (const row of rows) {
			if (row.entryId === undefined || row.entryId === null || row.adjustment) continue;
			const entry = entries.get(row.entryId);
			if (entry?.type === "message" && entry.message.role === "assistant") providerCalls += 1;
		}
	}
	return { providerCalls, totalTokens };
}

export function zeroBudgetFacts(limits: AdaptiveTaskBudget, deadlineMs: number): TaskBudgetFacts {
	return {
		providerCalls: 0,
		totalTokens: 0,
		wallClockUsedMs: 0,
		activeCandidates: 0,
		totalCandidates: 0,
		deadlineMs,
		limits,
	};
}
