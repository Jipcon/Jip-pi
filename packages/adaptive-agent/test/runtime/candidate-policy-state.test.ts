import { describe, expect, it } from "vitest";
import {
	createOriginCapsule,
	fingerprintState,
	initialCandidateState,
	MAX_MUTATED_FILES,
	MAX_RECENT_FINGERPRINTS,
	validateCandidatePolicyState,
	workspaceFingerprint,
} from "../../src/index.ts";
import { createBundleFixtures, originSnapshot } from "./stage5-fixtures.ts";

describe("CandidatePolicyState", () => {
	it("builds a deterministic initial state with bundle budgets", async () => {
		const fixtures = await createBundleFixtures();
		const state = initialCandidateState(8, 16, 100_000);
		expect(state).toMatchObject({
			phase: "origin",
			turns: 0,
			steps: 0,
			budgets: {
				tokens: { used: 0, limit: 100_000 },
				tools: { used: 0, limit: 16 },
				turns: { used: 0, limit: 8 },
			},
			verification: { attempts: 0, successes: 0, failures: 0, lastVerifiedSeq: 0, debt: 0, coverage: 0 },
		});
		expect(state).toEqual(initialCandidateState(8, 16, 100_000));
		void fixtures;
	});

	it("keeps the fingerprint stable under key order and excludes the workspace section", () => {
		const state = initialCandidateState(8, 16, 100);
		const withWorkspace = structuredClone(state);
		withWorkspace.workspace = {
			fingerprint: workspaceFingerprint({ files: [{ path: "a.ts", size: 1, mtimeMs: 2 }] }),
			files: [{ path: "a.ts", size: 1, mtimeMs: 2 }],
		};
		expect(fingerprintState(withWorkspace)).toBe(fingerprintState(state));
		expect(fingerprintState(state)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("validates reconstructed snapshots strictly", () => {
		expect(validateCandidatePolicyState(initialCandidateState(1, 1, 1))).toBeUndefined();
		expect(validateCandidatePolicyState(undefined)).toBeDefined();
		expect(validateCandidatePolicyState({ phase: "nope" })).toBeDefined();
		const bad = initialCandidateState(1, 1, 1);
		(bad.tools as { allow: number }).allow = -1;
		expect(validateCandidatePolicyState(bad)).toBeDefined();
		const oversized = initialCandidateState(1, 1, 1);
		for (let index = 0; index < MAX_RECENT_FINGERPRINTS + 1; index++) {
			oversized.recent.push({ kind: "action", seq: index, hash: "a".repeat(64) });
		}
		expect(validateCandidatePolicyState(oversized)).toBeDefined();
		const oversizedFiles = initialCandidateState(1, 1, 1);
		for (let index = 0; index < MAX_MUTATED_FILES + 1; index++) {
			oversizedFiles.files.mutated.push({
				path: `f${index}.ts`,
				reads: 0,
				writes: 1,
				edits: 0,
				lastMutationSeq: index,
				lastMutationTimestamp: index,
			});
		}
		expect(validateCandidatePolicyState(oversizedFiles)).toBeDefined();
	});

	it("creates repeatable task-origin capsules", async () => {
		const fixtures = await createBundleFixtures();
		const input = {
			taskId: "task",
			candidateId: "candidate",
			sessionId: "session",
			lane: "main",
			policyBundle: fixtures.permissive,
			snapshot: originSnapshot(fixtures.permissiveBundle),
		};
		const first = createOriginCapsule(input);
		const second = createOriginCapsule(structuredClone(input));
		expect(first).toEqual(second);
		expect(first.basis.cursor).toEqual({ kind: "task_origin" });
		expect(first.basis.operationId).toBe("task-origin");
		expect(first.basis.inheritedStateFingerprint).toBe(first.fingerprint);
		expect(fingerprintState(first.snapshot)).toBe(first.fingerprint);
	});
});
