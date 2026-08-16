import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySessionRepo } from "../../../agent/src/harness-v4.ts";
import {
	type AdaptiveTaskBudget,
	InMemoryTrajectoryStore,
	MemoryContinuationJournal,
	MemoryTaskJournal,
	MinimalAdaptiveRuntime,
	sha256Hex,
	TempDirectoryWorkspaceManager,
	type TrajectoryStore,
} from "../../src/index.ts";
import type { AdaptiveTaskOutcome } from "../../src/runtime/task-journal.ts";
import { type BundleFixtures, createBundleFixtures, makeFixedTools } from "./stage5-fixtures.ts";
import {
	createStage8HarnessFactories,
	createStage8Verifier,
	type Stage8HarnessFactories,
	userMessage,
} from "./stage8-fixtures.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

const BUDGET: AdaptiveTaskBudget = {
	maxProviderCalls: 20,
	maxTotalTokens: 100_000,
	maxWallClockMs: 600_000,
	maxBranchFanout: 2,
	maxActiveCandidates: 4,
	maxTotalCandidates: 7,
	maxBranchDepth: 2,
};

const NOW = (): number => 4_000_000_000_000;

interface RuntimeCase {
	foreground: string;
	stateRoot: string;
	journal: MemoryTaskJournal;
	factories: Stage8HarnessFactories;
	verifier: ReturnType<typeof createStage8Verifier>;
	fixtures: BundleFixtures;
	taskId: string;
}

async function createRuntimeCase(options?: {
	taskId?: string;
	rootResponses?: () => FauxResponseStep[];
	childResponses?: (variantId: string) => FauxResponseStep[];
	verifier?: ReturnType<typeof createStage8Verifier>;
	budget?: AdaptiveTaskBudget;
}): Promise<RuntimeCase> {
	const foreground = mkdtempSync(join(tmpdir(), "pi-s8-foreground-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-s8-state-"));
	cleanupDirectories.add(foreground);
	cleanupDirectories.add(stateRoot);
	writeFileSync(join(foreground, "readme.md"), "original" + "\n");
	const fixtures = await createBundleFixtures();
	const taskId = options?.taskId ?? "task-1";
	const verifier = options?.verifier ?? createStage8Verifier({ marker: "good.txt" });
	const factories = createStage8HarnessFactories({
		registry: fixtures.registry,
		rootResponses: options?.rootResponses,
		childResponses: options?.childResponses,
	});
	return { foreground, stateRoot, journal: new MemoryTaskJournal(), factories, verifier, fixtures, taskId };
}

function runTask(
	c: RuntimeCase,
	options?: { trajectory?: TrajectoryStore; budget?: AdaptiveTaskBudget },
): Promise<AdaptiveTaskOutcome> {
	const repo = new InMemorySessionRepo({ now: NOW });
	const manager = new TempDirectoryWorkspaceManager({ stateRoot: c.stateRoot });
	return MinimalAdaptiveRuntime.reopen({
		input: {
			taskId: c.taskId,
			prompt: userMessage("work"),
			policyBundle: c.fixtures.permissive,
			frozenModel: { provider: "stage8", modelId: "faux-1" },
			budget: options?.budget ?? BUDGET,
			verifier: c.verifier,
			systemPrompt: "stage8-system",
			logicalRoot: "/w",
		},
		registry: c.fixtures.registry,
		tools: makeFixedTools(),
		sessionRepo: repo,
		workspaceManager: manager,
		workspaceSourceRoot: c.foreground,
		taskJournal: c.journal,
		continuationJournal: () => new MemoryContinuationJournal(),
		createRootHarness: c.factories.createRootHarness,
		createChildHarness: c.factories.createChildHarness,
		trajectory: options?.trajectory,
		now: NOW,
	}).then((runtime) => runtime.run());
}

function readForeground(c: RuntimeCase, path: string): string {
	return readFileSync(join(c.foreground, path), "utf8");
}

describe("minimal adaptive runtime functional closure", () => {
	it("verifies a single root candidate and promotes it strictly", async () => {
		const c = await createRuntimeCase({
			rootResponses: () => [
				fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "content-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
			verifier: createStage8Verifier({ marker: "out.txt" }),
		});
		const outcome = await runTask(c);
		const rootCandidateId = sha256Hex(`${c.taskId}:candidate:root`);
		expect(outcome).toEqual({ kind: "promoted", winnerId: rootCandidateId, touchedPaths: ["out.txt"] });
		expect(readForeground(c, "out.txt")).toBe("content-1");
		expect(readForeground(c, "readme.md")).toBe("original" + "\n");
		expect(c.factories.totalCallCount()).toBe(2);
		// candidate verify + winner workspace re-run + foreground final
		expect(c.verifier.effectCount()).toBe(3);
	});

	it("branches an open root turn into two siblings with identical first requests and promotes the verified winner", async () => {
		const c = await createRuntimeCase({
			rootResponses: () => [
				fauxAssistantMessage([fauxToolCall("bash", { command: "fail now" })], { stopReason: "toolUse" }),
			],
			childResponses: (variantId) =>
				variantId.endsWith(":v1")
					? [fauxAssistantMessage("bad answer")]
					: [
							fauxAssistantMessage([fauxToolCall("write", { path: "good.txt", content: "ok" })], {
								stopReason: "toolUse",
							}),
							fauxAssistantMessage("done"),
						],
		});
		const outcome = await runTask(c);
		expect(outcome.kind).toBe("promoted");
		if (outcome.kind !== "promoted") throw new Error("expected promotion");
		const rootCandidateId = sha256Hex(`${c.taskId}:candidate:root`);
		expect(outcome.winnerId).not.toBe(rootCandidateId);
		expect(readForeground(c, "good.txt")).toBe("ok");
		expect(existsSync(join(c.foreground, "bad.txt"))).toBe(false);
		expect(readForeground(c, "readme.md")).toBe("original" + "\n");

		// Sibling first provider requests must be model-visible identical.
		const siblingRequests = c.factories.requests.filter(
			(request) => request.kind.endsWith(":v1") || request.kind.endsWith(":v2"),
		);
		expect(siblingRequests).toHaveLength(2);
		expect(siblingRequests[0]?.context).toEqual(siblingRequests[1]?.context);

		// The source never dispatched a second request after branching.
		const rootRequests = c.factories.requests.filter((request) => request.kind === "root");
		expect(rootRequests).toHaveLength(1);
		// Root: 1 turn; loser child: 1 turn; winner child: 2 turns.
		expect(c.factories.totalCallCount()).toBe(4);
	});

	it("promotes the full origin-to-winner lineage after branching from a dirty source", async () => {
		// S0 foreground -> root writes ancestor.txt (S1) -> exact branch ->
		// child writes winner.txt (S2) -> promote: both mutations must land.
		const c = await createRuntimeCase({
			verifier: createStage8Verifier({ marker: "winner.txt" }),
			rootResponses: () => [
				fauxAssistantMessage([fauxToolCall("write", { path: "ancestor.txt", content: "ancestor" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxToolCall("bash", { command: "fail now" })], { stopReason: "toolUse" }),
			],
			childResponses: (variantId) =>
				variantId.endsWith(":v1")
					? [fauxAssistantMessage("bad answer")]
					: [
							fauxAssistantMessage([fauxToolCall("write", { path: "winner.txt", content: "winner" })], {
								stopReason: "toolUse",
							}),
							fauxAssistantMessage("done"),
						],
		});
		const outcome = await runTask(c);
		expect(outcome).toMatchObject({
			kind: "promoted",
			touchedPaths: ["ancestor.txt", "winner.txt"],
		});
		expect(readForeground(c, "ancestor.txt")).toBe("ancestor");
		expect(readForeground(c, "winner.txt")).toBe("winner");
		expect(readForeground(c, "readme.md")).toBe("original" + "\n");
		// root: 2 turns; loser child: 1; winner child: 2.
		expect(c.factories.totalCallCount()).toBe(5);
	});

	it("stops new provider calls once the call budget is exhausted", async () => {
		const c = await createRuntimeCase({
			rootResponses: () => [
				fauxAssistantMessage([fauxToolCall("write", { path: "x.txt", content: "x" })], { stopReason: "toolUse" }),
			],
		});
		const outcome = await runTask(c, {
			budget: { ...BUDGET, maxProviderCalls: 1 },
		});
		expect(outcome).toMatchObject({ kind: "budget_exhausted", budget: "calls" });
		expect(c.factories.totalCallCount()).toBe(1);
		expect(existsSync(join(c.foreground, "x.txt"))).toBe(false);
		expect(readForeground(c, "readme.md")).toBe("original" + "\n");
	});

	it("keeps the foreground byte-identical when no candidate verifies", async () => {
		const c = await createRuntimeCase({
			rootResponses: () => [fauxAssistantMessage("final answer without work")],
		});
		const before = readFileSync(join(c.foreground, "readme.md"), "utf8");
		const outcome = await runTask(c);
		expect(outcome).toMatchObject({ kind: "no_verified_candidate" });
		expect(readFileSync(join(c.foreground, "readme.md"), "utf8")).toBe(before);
		expect(existsSync(join(c.foreground, "good.txt"))).toBe(false);
	});

	it("a failing or paused TrajectoryStore never changes the graph, winner or files", async () => {
		const run = async (
			trajectory?: TrajectoryStore,
		): Promise<{ outcome: AdaptiveTaskOutcome; events: unknown[]; calls: number }> => {
			const c = await createRuntimeCase({
				taskId: "trajectory-task",
				rootResponses: () => [
					fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "content-1" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				],
				verifier: createStage8Verifier({ marker: "out.txt" }),
			});
			const outcome = await runTask(c, { trajectory });
			// Deterministic projection: per-run identities (session/lease/snapshot
			// ids, entry ids, cursors) differ across independent runs, while the
			// decision sequence, belief, cost and outcome must not.
			const events = (await c.journal.events()).map((event) => {
				const base = { type: event.type, revision: event.revision };
				switch (event.type) {
					case "controller_decided":
						return { ...base, decision: event.decision };
					case "candidate_turn_observed":
						return { ...base, settlement: event.settlement, belief: event.belief, cost: event.cost };
					case "verifier_settled":
						return { ...base, status: event.status, belief: event.belief };
					case "verifier_planned":
						return { ...base, replay: event.replay };
					case "winner_selected":
						return { ...base };
					case "promotion_settled":
						return { ...base, status: event.status, touchedPaths: event.touchedPaths };
					case "task_terminal":
						return { ...base, outcome: event.outcome };
					default:
						return base;
				}
			});
			return { outcome, events, calls: c.factories.totalCallCount() };
		};
		const failing: TrajectoryStore = {
			append: async () => {
				throw new Error("store offline");
			},
			query: async () => [],
			setPaused: () => undefined,
			close: async () => undefined,
		};
		const clean = await run();
		const faulty = await run(failing);
		const pausedStore = new InMemoryTrajectoryStore();
		pausedStore.setPaused(true);
		const pausedRun = await run(pausedStore);
		expect(faulty.outcome).toEqual(clean.outcome);
		expect(faulty.events).toEqual(clean.events);
		expect(faulty.calls).toBe(clean.calls);
		expect(pausedRun.outcome).toEqual(clean.outcome);
		expect(pausedRun.events).toEqual(clean.events);
		expect(pausedRun.calls).toBe(clean.calls);
	});
});
