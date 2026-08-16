import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AdaptiveTaskBudget,
	type BeliefState,
	CandidateGraph,
	type CandidateNode,
	type CandidatePolicyStateRef,
	type ControllerDecision,
	compareEligibleCandidates,
	deterministicActionId,
	type FoldedTaskGraph,
	initialBelief,
	JsonlTaskJournal,
	MemoryTaskJournal,
	reconcileTaskGraph,
	TaskGraphFault,
	type TaskJournalEvent,
	TaskJournalFault,
} from "../../src/index.ts";
import { DEFAULT_ADAPTIVE_PROFILE } from "../../src/runtime/adaptive-runtime.ts";
import type { ContinuationJournalEvent } from "../../src/runtime/continuation-journal.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function tempFile(name: string): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-s8-graph-"));
	cleanupDirectories.add(directory);
	return join(directory, name);
}

const TASK = "task-1";
const ROOT = "root-candidate";
const BUDGET: AdaptiveTaskBudget = {
	maxProviderCalls: 20,
	maxTotalTokens: 100_000,
	maxWallClockMs: 60_000,
	maxBranchFanout: 2,
	maxActiveCandidates: 4,
	maxTotalCandidates: 7,
	maxBranchDepth: 2,
};
const BUNDLE = { version: "bundle-v1", fingerprint: "a".repeat(64) };
const POLICY_REF: CandidatePolicyStateRef = {
	basis: {
		taskId: TASK,
		candidateId: ROOT,
		sessionId: "root-session",
		lane: "main",
		operationId: "task-origin",
		cursor: { kind: "task_origin" },
		policyBundle: BUNDLE,
		projectorVersion: "candidate-state-projector-v1",
		inheritedStateFingerprint: "b".repeat(64),
	},
	fingerprint: "b".repeat(64),
};
const CURSOR = { operationId: "op-1", assistantEntryId: "assist-1", leafId: "leaf-1" };
const BELIEF: BeliefState = initialBelief();

function planned(): TaskJournalEvent {
	return {
		type: "task_planned",
		taskId: TASK,
		revision: 1,
		actionId: deterministicActionId({ taskId: TASK, revision: 1, type: "task_planned", target: TASK }),
		at: 1,
		policyBundle: BUNDLE,
		frozenModel: { provider: "faux", modelId: "faux-1" },
		budget: BUDGET,
		workspace: { sourceRoot: "/foreground", logicalRoot: "/w" },
		systemPrompt: "system",
		profile: DEFAULT_ADAPTIVE_PROFILE,
		coverageThreshold: 100,
		redundancyThreshold: 1,
		deadlineMs: 100,
		rootCandidateId: ROOT,
		rootSessionId: "root-session",
		rootPolicyStateRef: POLICY_REF,
	};
}

function at(type: TaskJournalEvent["type"], revision: number, target: string): string {
	return deterministicActionId({ taskId: TASK, revision, type, target });
}

function rootSessionReady(revision: number): TaskJournalEvent {
	return {
		type: "root_session_ready",
		taskId: TASK,
		revision,
		actionId: at("root_session_ready", revision, `candidate:${ROOT}`),
		at: revision,
		candidateId: ROOT,
		sessionId: "root-session",
		lane: "main",
	};
}

function rootWorkspaceReady(revision: number): TaskJournalEvent {
	return {
		type: "root_workspace_ready",
		taskId: TASK,
		revision,
		actionId: at("root_workspace_ready", revision, `candidate:${ROOT}`),
		at: revision,
		candidateId: ROOT,
		snapshotId: "s".repeat(64),
		snapshotFingerprint: "f".repeat(64),
		leaseId: "l".repeat(64),
	};
}

function rootRunAccepted(revision: number): TaskJournalEvent {
	return {
		type: "root_run_accepted",
		taskId: TASK,
		revision,
		actionId: at("root_run_accepted", revision, `candidate:${ROOT}`),
		at: revision,
		candidateId: ROOT,
		operationId: CURSOR.operationId,
		basisEntryId: "basis-1",
	};
}

function turnObserved(revision: number, settlement?: "completed" | "failed" | "aborted"): TaskJournalEvent {
	return {
		type: "candidate_turn_observed",
		taskId: TASK,
		revision,
		actionId: at("candidate_turn_observed", revision, `candidate:${ROOT}`),
		at: revision,
		candidateId: ROOT,
		operationId: CURSOR.operationId,
		cursor: CURSOR,
		policyStateRef: POLICY_REF,
		belief: BELIEF,
		cost: { providerCalls: 1, totalTokens: 10 },
		evidence: {
			phase: "working",
			steps: 0,
			verificationAttempts: 0,
			verificationSuccesses: 0,
			verificationDebt: 0,
			coverage: 0,
			redundantCalls: 0,
			failureFingerprints: [],
		},
		...(settlement === undefined ? {} : { settlement }),
	};
}

function decide(revision: number, decision: ControllerDecision = { kind: "continue" }): TaskJournalEvent {
	return {
		type: "controller_decided",
		taskId: TASK,
		revision,
		actionId: at("controller_decided", revision, `candidate:${ROOT}`),
		at: revision,
		candidateId: ROOT,
		decision,
		basis: {
			policyStateFingerprint: "p".repeat(64),
			beliefFingerprint: "q".repeat(64),
			budgetFingerprint: "r".repeat(64),
			policyBundle: BUNDLE,
		},
	};
}

function taskTerminal(revision: number): TaskJournalEvent {
	return {
		type: "task_terminal",
		taskId: TASK,
		revision,
		actionId: at("task_terminal", revision, TASK),
		at: revision,
		outcome: { kind: "no_verified_candidate", reason: "test" },
	};
}

async function foldOfAsync(events: TaskJournalEvent[]): Promise<FoldedTaskGraph> {
	const journal = new MemoryTaskJournal();
	for (const event of events) await journal.append(event);
	const graph = await CandidateGraph.open(journal);
	return graph.snapshot();
}

describe("CandidateGraph fold", () => {
	it("plans a task and provisions the root into active through the three stage events", async () => {
		const graph = await foldOfAsync([planned(), rootSessionReady(2), rootWorkspaceReady(3), rootRunAccepted(4)]);
		expect(graph.status).toBe("running");
		expect(graph.revision).toBe(4);
		const root = graph.nodes.get(ROOT);
		expect(root).toMatchObject({
			id: ROOT,
			depth: 0,
			status: "active",
			conversation: { sessionId: "root-session", lane: "main", operationId: "op-1" },
			workspace: { snapshotId: "s".repeat(64), leaseId: "l".repeat(64) },
		});
	});

	it("replays an identical event as a no-op and faults on conflicting content", async () => {
		const journal = new MemoryTaskJournal();
		const graph = await CandidateGraph.open(journal);
		const first = planned();
		await graph.append(first);
		const replay = planned();
		await expect(graph.append(replay)).resolves.toBe(1);
		// A timestamp-only difference is the same durable event (the wall-clock
		// "at" is not content); a real content difference must fault.
		const sameContent = { ...planned(), at: 999 } as TaskJournalEvent;
		await expect(graph.append(sameContent)).resolves.toBe(1);
		const conflicting = { ...planned(), systemPrompt: "other system" } as TaskJournalEvent;
		await expect(graph.append(conflicting)).rejects.toBeInstanceOf(TaskGraphFault);
	});

	it("faults on a non-deterministic action id", async () => {
		const journal = new MemoryTaskJournal();
		const graph = await CandidateGraph.open(journal);
		const broken = { ...planned(), actionId: "z".repeat(64) } as TaskJournalEvent;
		await expect(graph.append(broken)).rejects.toBeInstanceOf(TaskGraphFault);
	});

	it("faults on an out-of-order revision", async () => {
		const journal = new MemoryTaskJournal();
		const graph = await CandidateGraph.open(journal);
		await graph.append(planned());
		await expect(graph.append(rootSessionReady(5))).rejects.toBeInstanceOf(TaskGraphFault);
	});

	it("tracks observed turns, decisions, terminal events and task terminal", async () => {
		const graph = await foldOfAsync([
			planned(),
			rootSessionReady(2),
			rootWorkspaceReady(3),
			rootRunAccepted(4),
			turnObserved(5),
			decide(6),
			taskTerminal(7),
		]);
		expect(graph.nodes.get(ROOT)).toMatchObject({ cost: { providerCalls: 1, totalTokens: 10 } });
		expect(graph.lastDecisions.get(ROOT)?.decision).toEqual({ kind: "continue" });
		expect(graph.status).toBe("terminal");
		expect(graph.outcome).toEqual({ kind: "no_verified_candidate", reason: "test" });
	});

	it("commits an exact branch: source becomes a permanent branch_origin and children provision", async () => {
		const groupId = "g".repeat(64);
		const childIds = ["child-1", "child-2"];
		const events: TaskJournalEvent[] = [
			planned(),
			rootSessionReady(2),
			rootWorkspaceReady(3),
			rootRunAccepted(4),
			turnObserved(5),
			decide(6, { kind: "branch", variants: [{ id: "v1" }, { id: "v2" }] }),
			{
				type: "branch_committed",
				taskId: TASK,
				revision: 7,
				actionId: at("branch_committed", 7, `branch:${ROOT}:${groupId}`),
				at: 7,
				candidateId: ROOT,
				groupId,
				snapshotId: "s2".padStart(64, "0"),
				snapshotFingerprint: "f2".padStart(64, "0"),
				logicalRoot: "/w",
				contentFingerprint: "f2".padStart(64, "0"),
				cursor: CURSOR,
				contextFingerprint: "c".repeat(64),
				requestFingerprint: "d".repeat(64),
				policyStateFingerprint: "p".repeat(64),
				variants: [{ id: "v1" }, { id: "v2" }],
				childIds,
			},
		];
		const graph = await foldOfAsync(events);
		expect(graph.nodes.get(ROOT)?.status).toBe("branch_origin");
		const group = graph.groups.get(groupId);
		expect(group).toMatchObject({ sourceId: ROOT, variants: [{ id: "v1" }, { id: "v2" }], childIds });
		for (const childId of childIds) {
			expect(graph.nodes.get(childId)).toMatchObject({
				parentId: ROOT,
				depth: 1,
				status: "provisioning",
				conversation: { continuationGroupId: groupId },
			});
		}
		const provisioned: TaskJournalEvent = {
			type: "candidate_provisioned",
			taskId: TASK,
			revision: 8,
			actionId: at("candidate_provisioned", 8, `candidate:child-1`),
			at: 8,
			candidateId: "child-1",
			parentId: ROOT,
			depth: 1,
			continuationGroupId: groupId,
			sessionId: "child-session-1",
			lane: "main",
			snapshotId: "s2".padStart(64, "0"),
			leaseId: "lease-1",
			operationId: "child-op-1",
			basisEntryId: "child-basis-1",
			cursor: CURSOR,
			policyStateRef: POLICY_REF,
			belief: BELIEF,
		};
		const provisionedGraph = await foldOfAsync([...events, provisioned]);
		expect(provisionedGraph.nodes.get("child-1")).toMatchObject({ status: "active" });
	});

	it("settles verification: pass+coverage -> verified, fail -> failed, mutation -> failed", async () => {
		const base = [
			planned(),
			rootSessionReady(2),
			rootWorkspaceReady(3),
			rootRunAccepted(4),
			turnObserved(5, "completed"),
		];
		const verify = (revision: number): TaskJournalEvent => ({
			type: "controller_decided",
			taskId: TASK,
			revision,
			actionId: at("controller_decided", revision, `candidate:${ROOT}`),
			at: revision,
			candidateId: ROOT,
			decision: { kind: "verify" },
			basis: {
				policyStateFingerprint: "p".repeat(64),
				beliefFingerprint: "q".repeat(64),
				budgetFingerprint: "r".repeat(64),
				policyBundle: BUNDLE,
			},
		});
		const passBelief: BeliefState = { ...BELIEF, verifierStatus: "pass", evidenceCoverage: 100 };
		const settle = (
			revision: number,
			extra: Partial<TaskJournalEvent & { type: "verifier_settled" }> = {},
		): TaskJournalEvent => ({
			type: "verifier_settled",
			taskId: TASK,
			revision,
			actionId: at("verifier_settled", revision, `candidate:${ROOT}`),
			at: revision,
			candidateId: ROOT,
			attemptId: "attempt-1",
			status: "pass",
			coverage: 100,
			durationMs: 1,
			summary: { hash: "", length: 0, prefix: "" },
			workspaceFingerprint: "w".repeat(64),
			belief: passBelief,
			...extra,
		});
		const verified = await foldOfAsync([...base, verify(6), settle(7)]);
		expect(verified.nodes.get(ROOT)?.status).toBe("verified");

		const failedBelief: BeliefState = { ...BELIEF, verifierStatus: "fail" };
		const failed = await foldOfAsync([
			...base,
			verify(6),
			settle(7, { status: "fail", coverage: 0, belief: failedBelief }),
		]);
		expect(failed.nodes.get(ROOT)?.status).toBe("failed");

		const mutated = await foldOfAsync([
			...base,
			verify(6),
			settle(7, { workspaceMutation: { kind: "both", detail: "mutated" } }),
		]);
		expect(mutated.nodes.get(ROOT)?.status).toBe("failed");
		expect(mutated.nodes.get(ROOT)?.terminalReason).toContain("mutated");
	});

	it("selects a winner and demotes it when promotion fails, freeing the winner slot", async () => {
		const base = [
			planned(),
			rootSessionReady(2),
			rootWorkspaceReady(3),
			rootRunAccepted(4),
			turnObserved(5, "completed"),
		];
		const verify: TaskJournalEvent = {
			type: "controller_decided",
			taskId: TASK,
			revision: 6,
			actionId: at("controller_decided", 6, `candidate:${ROOT}`),
			at: 6,
			candidateId: ROOT,
			decision: { kind: "verify" },
			basis: {
				policyStateFingerprint: "p".repeat(64),
				beliefFingerprint: "q".repeat(64),
				budgetFingerprint: "r".repeat(64),
				policyBundle: BUNDLE,
			},
		};
		const passBelief: BeliefState = { ...BELIEF, verifierStatus: "pass", evidenceCoverage: 100 };
		const settle: TaskJournalEvent = {
			type: "verifier_settled",
			taskId: TASK,
			revision: 7,
			actionId: at("verifier_settled", 7, `candidate:${ROOT}`),
			at: 7,
			candidateId: ROOT,
			attemptId: "attempt-1",
			status: "pass",
			coverage: 100,
			durationMs: 1,
			summary: { hash: "", length: 0, prefix: "" },
			workspaceFingerprint: "w".repeat(64),
			belief: passBelief,
		};
		const winnerSelected: TaskJournalEvent = {
			type: "winner_selected",
			taskId: TASK,
			revision: 8,
			actionId: at("winner_selected", 8, "promotion:attempt-9"),
			at: 8,
			winnerId: ROOT,
			promotionAttemptId: "attempt-9",
		};
		const selected = await foldOfAsync([...base, verify, settle, winnerSelected]);
		expect(selected.nodes.get(ROOT)?.status).toBe("winner");
		expect(selected.winnerId).toBe(ROOT);

		const terminal: TaskJournalEvent = {
			type: "candidate_terminal",
			taskId: TASK,
			revision: 9,
			actionId: at("candidate_terminal", 9, `candidate:${ROOT}`),
			at: 9,
			candidateId: ROOT,
			status: "failed",
			reason: "promotion rolled back",
		};
		const demoted = await foldOfAsync([...base, verify, settle, winnerSelected, terminal]);
		expect(demoted.nodes.get(ROOT)?.status).toBe("failed");
		expect(demoted.winnerId).toBeUndefined();
	});

	it("reconciles against session/workspace/continuation facts fail-closed", async () => {
		const groupId = "g".repeat(64);
		const events: TaskJournalEvent[] = [
			planned(),
			rootSessionReady(2),
			rootWorkspaceReady(3),
			rootRunAccepted(4),
			turnObserved(5),
			decide(6, { kind: "branch", variants: [{ id: "v1" }, { id: "v2" }] }),
			{
				type: "branch_committed",
				taskId: TASK,
				revision: 7,
				actionId: at("branch_committed", 7, `branch:${ROOT}:${groupId}`),
				at: 7,
				candidateId: ROOT,
				groupId,
				snapshotId: "s2".padStart(64, "0"),
				snapshotFingerprint: "f2".padStart(64, "0"),
				logicalRoot: "/w",
				contentFingerprint: "f2".padStart(64, "0"),
				cursor: CURSOR,
				contextFingerprint: "c".repeat(64),
				requestFingerprint: "d".repeat(64),
				policyStateFingerprint: "p".repeat(64),
				variants: [{ id: "v1" }, { id: "v2" }],
				childIds: ["child-1", "child-2"],
			},
		];
		const graph = await foldOfAsync(events);
		const facts = {
			sessionExists: async (sessionId: string) => sessionId === "root-session",
			workspaceSnapshot: async () => ({ fingerprint: "f".repeat(64) }),
			snapshotReleased: async () => false,
			leaseStatus: async () => "ready",
			continuationEvents: async (): Promise<ContinuationJournalEvent[]> => [],
		};
		await expect(reconcileTaskGraph(graph, facts)).rejects.toBeInstanceOf(TaskGraphFault);
		await expect(
			reconcileTaskGraph(graph, {
				...facts,
				sessionExists: async () => false,
				continuationEvents: async (): Promise<ContinuationJournalEvent[]> => [{ type: "group_ready", groupId }],
			}),
		).rejects.toBeInstanceOf(TaskGraphFault);
		await expect(
			reconcileTaskGraph(graph, {
				sessionExists: async () => true,
				workspaceSnapshot: async () => ({ fingerprint: "f".repeat(64) }),
				snapshotReleased: async () => false,
				leaseStatus: async () => "ready",
				continuationEvents: async (): Promise<ContinuationJournalEvent[]> => [
					{ type: "group_ready", groupId },
					{
						type: "child_session_forked",
						groupId,
						childId: "child-1",
						sampleIndex: 0,
						sessionId: "child-session-1",
						lane: "main",
					},
					{
						type: "child_workspace_ready",
						groupId,
						childId: "child-1",
						sampleIndex: 0,
						leaseId: "lease-1",
						snapshotId: "s2".padStart(64, "0"),
					},
					{
						type: "child_run_accepted",
						groupId,
						childId: "child-1",
						sampleIndex: 0,
						operationId: "child-op-1",
						basisEntryId: "child-basis-1",
					},
				],
			}),
		).rejects.toBeInstanceOf(TaskGraphFault);
	});
});

describe("JSONL task journal", () => {
	it("recovers a torn tail and faults on a corrupt complete line", async () => {
		const path = tempFile("journal.jsonl");
		writeFileSync(path, `${JSON.stringify(planned())}\n${JSON.stringify(rootSessionReady(2))}\n{"truncated":`);
		const torn = new JsonlTaskJournal({ filePath: path });
		const events = await torn.events();
		expect(events).toHaveLength(2);

		const corruptPath = tempFile("corrupt.jsonl");
		writeFileSync(corruptPath, `not-json\n${JSON.stringify(planned())}\n`);
		const corrupt = new JsonlTaskJournal({ filePath: corruptPath });
		await expect(corrupt.events()).rejects.toBeInstanceOf(TaskJournalFault);
	});

	it("conforms with the memory journal (same events, same fold)", async () => {
		const events = [planned(), rootSessionReady(2), rootWorkspaceReady(3), rootRunAccepted(4), turnObserved(5)];
		const path = tempFile("conform.jsonl");
		const jsonl = new JsonlTaskJournal({ filePath: path });
		for (const event of events) await jsonl.append(event);
		const jsonlGraph = await CandidateGraph.open(jsonl);
		const memoryGraph = await CandidateGraph.open(new MemoryTaskJournal());
		for (const event of events) await memoryGraph.append(event);
		const left = jsonlGraph.snapshot();
		const right = memoryGraph.snapshot();
		expect(left.revision).toBe(right.revision);
		expect(left.status).toBe(right.status);
		expect([...left.nodes.entries()].map(([id, node]) => [id, node.status])).toEqual(
			[...right.nodes.entries()].map(([id, node]) => [id, node.status]),
		);
	});
});

describe("winner tie-break", () => {
	function eligibleNode(id: string, coverage: number, debt: number, failures: number, tokens: number): CandidateNode {
		return {
			id,
			depth: 1,
			conversation: { sessionId: id, lane: "main" },
			workspace: { snapshotId: "s".repeat(64) },
			policyState: POLICY_REF,
			belief: {
				...BELIEF,
				verifierStatus: "pass",
				evidenceCoverage: coverage,
				verificationDebt: debt,
				failurePosterior: failures,
			},
			cost: { providerCalls: 1, totalTokens: tokens },
			status: "verified",
			released: false,
			lastEvidence: {
				phase: "working",
				steps: 0,
				verificationAttempts: 0,
				verificationSuccesses: 0,
				verificationDebt: 0,
				coverage: 0,
				redundantCalls: failures,
				failureFingerprints: [],
			},
		};
	}

	it("orders verified candidates by coverage, debt, failures, tokens, id", () => {
		const nodes = [
			eligibleNode("c", 90, 0, 0, 100),
			eligibleNode("a", 100, 2, 0, 100),
			eligibleNode("b", 100, 0, 0, 50),
			eligibleNode("d", 100, 0, 0, 50),
		];
		const sorted = [...nodes].sort(compareEligibleCandidates).map((node) => node.id);
		expect(sorted).toEqual(["b", "d", "a", "c"]);
	});

	it("orders a failing or indebted candidate after a clean one", () => {
		const good = eligibleNode("good", 100, 0, 0, 10);
		const low = eligibleNode("low", 50, 0, 0, 10);
		const debt = eligibleNode("debt", 100, 1, 0, 10);
		expect(compareEligibleCandidates(good, low)).toBeLessThan(0);
		expect(compareEligibleCandidates(good, debt)).toBeLessThan(0);
	});
});
