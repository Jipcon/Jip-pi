import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { describe, expect, it } from "vitest";
import {
	DeterministicStepEvaluator,
	DeterministicTurnEvaluator,
	evaluateTask,
	initialCandidateState,
	reduceStep,
	reduceTurn,
	type ToolStepFacts,
	type TurnFacts,
} from "../../src/index.ts";

const RULES = { commandPatterns: ["^npm test$"] };

function step(overrides: Partial<ToolStepFacts> = {}): ToolStepFacts {
	return {
		toolName: "read",
		decision: "allow",
		args: { path: "a.ts" } as Record<string, JsonValue>,
		isError: false,
		seq: 1,
		timestamp: 10,
		...overrides,
	};
}

function turn(overrides: Partial<TurnFacts> = {}): TurnFacts {
	return {
		assistantEntryId: "assistant",
		seq: 1,
		timestamp: 10,
		steps: [],
		usageTokens: 120,
		...overrides,
	};
}

describe("deterministic step reducer", () => {
	it("counts decisions, outcomes and per-tool stats", () => {
		let state = initialCandidateState(8, 16, 100_000);
		const reduced = reduceStep(state, step({ toolName: "write", decision: "guard", isError: true }), RULES, false);
		state = reduced.state;
		expect(state.tools.guard).toBe(1);
		expect(state.tools.failure).toBe(1);
		expect(state.tools.byTool.write).toMatchObject({ guard: 1, failure: 1 });
		expect(state.files.mutated).toHaveLength(0); // failed mutation does not count
		const second = reduceStep(state, step({ toolName: "write", decision: "allow" }), RULES, false);
		expect(second.state.files.mutated).toEqual([
			{ path: "a.ts", reads: 0, writes: 1, edits: 0, lastMutationSeq: 1, lastMutationTimestamp: 10 },
		]);
		expect(second.state.files.totalMutations).toBe(1);
		expect(second.evidence.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it("tracks reads and bounded recent fingerprints", () => {
		let state = initialCandidateState(8, 16, 100_000);
		state = reduceStep(state, step({ toolName: "read" }), RULES, false).state;
		expect(state.files.totalReads).toBe(1);
		for (let index = 0; index < 12; index++) {
			state = reduceStep(state, step({ seq: index + 1 }), RULES, false).state;
		}
		expect(state.recent).toHaveLength(8);
		expect(state.recent[7]!.seq).toBe(12);
	});

	it("counts duplicates only when flagged by the turn scope", () => {
		const state = initialCandidateState(8, 16, 100_000);
		const reduced = reduceStep(state, step(), RULES, true);
		expect(reduced.state.tools.duplicate).toBe(1);
	});
});

describe("deterministic turn reducer", () => {
	it("aggregates steps, usage and phase", () => {
		const state = initialCandidateState(8, 16, 100_000);
		const reduced = reduceTurn(
			state,
			turn({
				steps: [step(), step({ toolName: "write" })],
			}),
			RULES,
		);
		expect(reduced.state.turns).toBe(1);
		expect(reduced.state.budgets.turns.used).toBe(1);
		expect(reduced.state.budgets.tokens.used).toBe(120);
		expect(reduced.state.steps).toBe(2);
		expect(reduced.evidence.phase).toBe("working");
	});

	it("derives answering for a no-tool final answer", () => {
		const reduced = reduceTurn(initialCandidateState(8, 16, 100_000), turn(), RULES);
		expect(reduced.state.phase).toBe("answering");
	});

	it("derives verifying phases and verification debt from bash verification runs", () => {
		let state = initialCandidateState(8, 16, 100_000);
		state = reduceTurn(
			state,
			turn({
				steps: [step({ toolName: "write", decision: "allow", isError: false })],
			}),
			RULES,
		).state;
		expect(state.verification.debt).toBe(1);
		const verified = reduceTurn(
			state,
			turn({
				seq: 2,
				steps: [
					{
						toolName: "bash",
						decision: "allow",
						args: { command: "npm test" } as Record<string, JsonValue>,
						isError: false,
						seq: 3,
						timestamp: 30,
					},
				],
			}),
			RULES,
		);
		expect(verified.state.verification).toMatchObject({
			attempts: 1,
			successes: 1,
			failures: 0,
			debt: 0,
			coverage: 100,
		});
		expect(verified.state.phase).toBe("verifying");
		expect(verified.evidence.verificationAttempts).toBe(1);
	});

	it("flags repeated identical calls in one turn as redundant", () => {
		const reduced = reduceTurn(
			initialCandidateState(8, 16, 100_000),
			turn({ steps: [step(), step(), step()] }),
			RULES,
		);
		expect(reduced.evidence.redundantCalls).toBe(2);
		expect(reduced.state.tools.duplicate).toBe(2);
	});
});

describe("evaluator classes", () => {
	it("share the same pure reducers", () => {
		const state = initialCandidateState(8, 16, 100_000);
		const stepEvaluator = new DeterministicStepEvaluator(RULES);
		const turnEvaluator = new DeterministicTurnEvaluator(RULES);
		const viaStep = stepEvaluator.evaluate(state, step(), false);
		const viaReduce = reduceStep(state, step(), RULES, false);
		expect(viaStep).toEqual(viaReduce);
		const turnState = turnEvaluator.evaluate(state, turn({ steps: [step()] }));
		const turnReduce = reduceTurn(state, turn({ steps: [step()] }), RULES);
		expect(turnState).toEqual(turnReduce);
	});
});

describe("TaskEvaluator", () => {
	it("never reports a plain final answer as verified success", () => {
		const state = initialCandidateState(8, 16, 100_000);
		expect(evaluateTask({ settlement: "completed", state })).toEqual({
			kind: "unknown",
			reason: "no verifier evidence",
		});
		expect(evaluateTask({ state })).toEqual({ kind: "unknown", reason: "task did not settle" });
	});

	it("reports verified only with a passing verifier", () => {
		const state = initialCandidateState(8, 16, 100_000);
		expect(evaluateTask({ settlement: "completed", state, verifier: { ok: true, coverage: 80 } })).toEqual({
			kind: "verified",
			coverage: 80,
		});
		expect(evaluateTask({ settlement: "completed", state, verifier: { ok: false, error: "tests failed" } })).toEqual({
			kind: "failed",
			reason: "tests failed",
		});
	});

	it("reports aborted and failed runs as failed", () => {
		const state = initialCandidateState(8, 16, 100_000);
		expect(evaluateTask({ settlement: "aborted", state })).toEqual({ kind: "failed", reason: "run aborted" });
		expect(evaluateTask({ settlement: "failed", state })).toEqual({ kind: "failed", reason: "run failed" });
	});
});
