import { describe, expect, it } from "vitest";
import {
	type AdaptiveTaskBudget,
	type ControllerInput,
	decideController,
	initialBelief,
	type TaskBudgetFacts,
} from "../../src/index.ts";

const BUDGET: AdaptiveTaskBudget = {
	maxProviderCalls: 10,
	maxTotalTokens: 100_000,
	maxWallClockMs: 60_000,
	maxBranchFanout: 2,
	maxActiveCandidates: 4,
	maxTotalCandidates: 7,
	maxBranchDepth: 2,
};

function facts(overrides?: Partial<TaskBudgetFacts>): TaskBudgetFacts {
	return {
		providerCalls: 0,
		totalTokens: 0,
		wallClockUsedMs: 0,
		activeCandidates: 1,
		totalCandidates: 1,
		deadlineMs: 60_000,
		limits: BUDGET,
		...overrides,
	};
}

function input(overrides?: Partial<ControllerInput>): ControllerInput {
	const belief = initialBelief();
	return {
		graphRevision: 1,
		candidateId: "candidate-1",
		cursor: { operationId: "op-1", assistantEntryId: "assist-1", leafId: "leaf-1" },
		policyStateFingerprint: "p".repeat(64),
		beliefFingerprint: "q".repeat(64),
		budgetFingerprint: "r".repeat(64),
		policyBundle: { version: "v1", fingerprint: "a".repeat(64) },
		belief,
		lastTurnFailures: 0,
		lastTurnRedundancy: 0,
		branchVariants: [{ id: "v1" }, { id: "v2" }],
		canBranch: true,
		eligibleVerifiedExists: false,
		continueValueBps: belief.pathValue.high,
		redundancyThreshold: 1,
		budget: facts(),
		...overrides,
	};
}

describe("rule-based controller precedence", () => {
	it("1. a storage/projection/fingerprint fault faults the task with zero new effect", () => {
		const decision = decideController(input({ faulted: "journal corrupt" }));
		expect(decision).toEqual({ kind: "fault", reason: "journal corrupt" });
	});

	it("2. an eligible verified candidate with no continuing value stops", () => {
		const decision = decideController(
			input({
				eligibleVerifiedExists: true,
				continueValueBps: 0,
				settled: "completed",
				belief: { ...initialBelief(), verifierStatus: "none" },
			}),
		);
		expect(decision).toMatchObject({ kind: "stop" });
	});

	it("3. a completed candidate without a final verifier verifies", () => {
		const decision = decideController(input({ settled: "completed" }));
		expect(decision).toEqual({ kind: "verify" });
	});

	it("4. an open post-turn with a failed verifier status branches exactly two variants", () => {
		const belief = { ...initialBelief(), verifierStatus: "fail" as const };
		const decision = decideController(input({ belief }));
		expect(decision).toEqual({ kind: "branch", variants: [{ id: "v1" }, { id: "v2" }] });
	});

	it("4. repeated failures branch; redundancy at threshold branches; below threshold continues", () => {
		expect(decideController(input({ lastTurnFailures: 1 }))).toMatchObject({ kind: "branch" });
		expect(decideController(input({ lastTurnRedundancy: 1 }))).toMatchObject({ kind: "branch" });
		expect(decideController(input({ lastTurnRedundancy: 0 }))).toMatchObject({ kind: "continue" });
	});

	it("4. without branch slots the same turn continues instead of branching", () => {
		const decision = decideController(input({ lastTurnFailures: 1, canBranch: false }));
		expect(decision).toMatchObject({ kind: "continue" });
	});

	it("4. a settled turn never branches", () => {
		const decision = decideController(input({ settled: "completed", lastTurnFailures: 3 }));
		expect(decision).toMatchObject({ kind: "verify" });
	});

	it("5. task budget exhaustion prunes with the budget tag, before failed/aborted handling", () => {
		const decision = decideController(input({ settled: "failed", exhaustion: { budget: "calls" } }));
		expect(decision).toMatchObject({ kind: "prune", budget: "calls" });
	});

	it("6. failed and aborted candidates prune; completed-with-failed-verifier prunes", () => {
		expect(decideController(input({ settled: "failed" }))).toMatchObject({ kind: "prune" });
		expect(decideController(input({ settled: "aborted" }))).toMatchObject({ kind: "prune" });
		const belief = { ...initialBelief(), verifierStatus: "fail" as const };
		expect(decideController(input({ settled: "completed", belief }))).toMatchObject({ kind: "prune" });
		const interrupted = { ...initialBelief(), verifierStatus: "interrupted" as const };
		expect(decideController(input({ settled: "completed", belief: interrupted }))).toMatchObject({
			kind: "prune",
		});
	});

	it("6. a suspended candidate yields a typed task suspension", () => {
		const decision = decideController(input({ suspended: true }));
		expect(decision).toMatchObject({ kind: "suspend" });
	});

	it("7. everything else continues", () => {
		expect(decideController(input({}))).toEqual({ kind: "continue" });
		expect(
			decideController(input({ settled: "completed", belief: { ...initialBelief(), verifierStatus: "pass" } })),
		).toEqual({
			kind: "continue",
		});
	});
});
