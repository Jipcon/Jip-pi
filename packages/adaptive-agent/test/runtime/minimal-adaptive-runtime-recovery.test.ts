import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSessionRepo } from "../../../agent/src/harness-v4.ts";
import {
	type AdaptiveTaskBudget,
	type AdaptiveTaskOutcome,
	JsonlContinuationJournal,
	JsonlTaskJournal,
	MinimalAdaptiveRuntime,
	SimulatedProcessCrash,
	TaskGraphFault,
	TempDirectoryWorkspaceManager,
} from "../../src/index.ts";
import type { TaskJournalEvent } from "../../src/runtime/task-journal.ts";
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

interface RecoveryCase {
	foreground: string;
	stateRoot: string;
	journalPath: string;
	continuationDir: string;
	sessionDir: string;
	verifier: ReturnType<typeof createStage8Verifier>;
	fixtures: BundleFixtures;
	factories: Stage8HarnessFactories[];
	journal: JsonlTaskJournal;
}

async function createRecoveryCase(options?: {
	verifierReplay?: "safe" | "never";
	rootResponses?: () => FauxResponseStep[];
	childResponses?: (variantId: string) => FauxResponseStep[];
}): Promise<RecoveryCase> {
	const foreground = mkdtempSync(join(tmpdir(), "pi-s8-rec-fg-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-s8-rec-st-"));
	const sessionDir = mkdtempSync(join(tmpdir(), "pi-s8-rec-sess-"));
	const continuationDir = join(stateRoot, "continuations");
	cleanupDirectories.add(foreground);
	cleanupDirectories.add(stateRoot);
	cleanupDirectories.add(sessionDir);
	mkdirSync(continuationDir, { recursive: true });
	writeFileSync(join(foreground, "readme.md"), "original" + "\n");
	const fixtures = await createBundleFixtures();
	const verifier = createStage8Verifier({ marker: "good.txt", replay: options?.verifierReplay ?? "safe" });
	const factories = createStage8HarnessFactories({
		registry: fixtures.registry,
		rootResponses: options?.rootResponses,
		childResponses: options?.childResponses,
	});
	return {
		foreground,
		stateRoot,
		journalPath: join(stateRoot, "task.jsonl"),
		continuationDir,
		sessionDir,
		verifier,
		fixtures,
		factories: [factories],
		journal: new JsonlTaskJournal({ filePath: join(stateRoot, "task.jsonl") }),
	};
}

function buildRuntime(
	c: RecoveryCase,
	afterEvent?: (event: TaskJournalEvent) => "crash" | undefined,
): Promise<MinimalAdaptiveRuntime> {
	const factories = createStage8HarnessFactories({
		registry: c.fixtures.registry,
		rootResponses: () => branchRootResponses(),
		childResponses: (variantId) => branchChildResponses(variantId),
	});
	c.factories.push(factories);
	return MinimalAdaptiveRuntime.reopen({
		input: {
			taskId: "recovery-task",
			prompt: userMessage("work"),
			policyBundle: c.fixtures.permissive,
			frozenModel: { provider: "stage8", modelId: "faux-1" },
			budget: BUDGET,
			verifier: c.verifier,
			systemPrompt: "stage8-system",
			logicalRoot: "/w",
		},
		registry: c.fixtures.registry,
		tools: makeFixedTools(),
		sessionRepo: new JsonlSessionRepo({ directory: c.sessionDir }),
		workspaceManager: new TempDirectoryWorkspaceManager({ stateRoot: c.stateRoot }),
		workspaceSourceRoot: c.foreground,
		taskJournal: new JsonlTaskJournal({ filePath: c.journalPath }),
		continuationJournal: (groupId) =>
			new JsonlContinuationJournal({ filePath: join(c.continuationDir, `${groupId}.jsonl`) }),
		createRootHarness: factories.createRootHarness,
		createChildHarness: factories.createChildHarness,
		now: () => 4_000_000_000_000,
		afterEvent,
	});
}

function branchRootResponses(): FauxResponseStep[] {
	return [fauxAssistantMessage([fauxToolCall("bash", { command: "fail now" })], { stopReason: "toolUse" })];
}

function branchChildResponses(variantId: string): FauxResponseStep[] {
	return variantId.endsWith(":v1")
		? [fauxAssistantMessage("bad answer")]
		: [
				fauxAssistantMessage([fauxToolCall("write", { path: "good.txt", content: "ok" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			];
}

/** Runs with up to two simulated crashes at the target event, recovering each time. */
async function runWithTwoCrashes(c: RecoveryCase, crashType: TaskJournalEvent["type"]): Promise<AdaptiveTaskOutcome> {
	let crashBudget = 2;
	while (true) {
		const runtime = await buildRuntime(c, (event) => {
			if (event.type === crashType && crashBudget > 0) {
				crashBudget -= 1;
				return "crash";
			}
			return undefined;
		});
		try {
			return await runtime.run();
		} catch (error) {
			if (error instanceof SimulatedProcessCrash) continue;
			throw error;
		}
	}
}

const CRASH_POINTS: TaskJournalEvent["type"][] = [
	"task_planned",
	"root_session_ready",
	"root_workspace_ready",
	"root_run_accepted",
	"candidate_turn_observed",
	"controller_decided",
	"branch_committed",
	"candidate_provisioned",
	"verifier_planned",
	"verifier_settled",
	"candidate_terminal",
	"winner_selected",
	"promotion_started",
	"promotion_settled",
	"task_terminal",
	"snapshot_released",
];

describe("minimal adaptive runtime crash recovery", () => {
	for (const crashType of CRASH_POINTS) {
		it(`recovers twice at ${crashType} with no twins, no duplicate effects and no duplicate promotion`, async () => {
			const c = await createRecoveryCase({});
			const outcome = await runWithTwoCrashes(c, crashType);
			const calls = c.factories.reduce((total, factories) => total + factories.totalCallCount(), 0);
			expect(outcome).toMatchObject({ kind: "promoted", touchedPaths: ["good.txt"] });
			// Foreground: exactly the promoted winner state.
			expect(readFileSync(join(c.foreground, "good.txt"), "utf8")).toBe("ok");
			expect(readFileSync(join(c.foreground, "readme.md"), "utf8")).toBe("original" + "\n");
			expect(existsSync(join(c.foreground, "bad.txt"))).toBe(false);
			// No twin sessions: root + two children only.
			const sessions = readdirSync(c.sessionDir);
			expect(sessions.length).toBe(3);
			// No duplicate provider effects across every recovered run.
			expect(calls).toBe(4);
			// Verifier effects: candidate v1 + candidate v2 + winner re-run + final.
			expect(c.verifier.effectCount()).toBe(4);
			// Exactly one closed promotion receipt.
			const promotionJournals = readdirSync(join(c.stateRoot, "promotions")).filter((name) =>
				name.endsWith(".jsonl"),
			);
			expect(promotionJournals.length).toBe(1);
		}, 30_000);
	}

	it("a replay-never verifier settles as interrupted after a planned-effect crash", async () => {
		const c = await createRecoveryCase({ verifierReplay: "never" });
		const outcome = await runWithTwoCrashes(c, "verifier_planned");
		expect(outcome).toMatchObject({ kind: "no_verified_candidate" });
		expect(c.verifier.effectCount()).toBe(0);
		expect(readFileSync(join(c.foreground, "readme.md"), "utf8")).toBe("original" + "\n");
	});

	it("authority mismatches fail closed before any new effect", async () => {
		// ContinuationJournal mismatch: crash after branch_committed, drop the
		// group journal, and the reopen must fault before any child dispatch.
		{
			const c = await createRecoveryCase({});
			const beforeCalls = c.factories.reduce((total, factories) => total + factories.totalCallCount(), 0);
			await expect(
				runWithAuthorityCorruption(c, "candidate_provisioned", () => {
					for (const file of readdirSync(c.continuationDir)) {
						rmSync(join(c.continuationDir, file), { force: true });
					}
				}),
			).rejects.toBeInstanceOf(TaskGraphFault);
			// The crashed build's root turn (one call) preceded the corruption;
			// the faulted reopen adds zero new provider effects.
			const afterCalls = c.factories.reduce((total, factories) => total + factories.totalCallCount(), 0);
			expect(afterCalls).toBe(beforeCalls + 1);
		}
		// Workspace manifest mismatch: crash after root_workspace_ready, drop
		// the manifest, and the reopen must fault before the first provider
		// request.
		{
			const c = await createRecoveryCase({});
			const beforeCalls = c.factories.reduce((total, factories) => total + factories.totalCallCount(), 0);
			await expect(
				runWithAuthorityCorruption(c, "root_workspace_ready", () => {
					rmSync(join(c.stateRoot, "manifest.jsonl"), { force: true });
				}),
			).rejects.toBeInstanceOf(TaskGraphFault);
			const afterCalls = c.factories.reduce((total, factories) => total + factories.totalCallCount(), 0);
			expect(afterCalls).toBe(beforeCalls);
		}
	});
});

async function runWithAuthorityCorruption(
	c: RecoveryCase,
	crashType: TaskJournalEvent["type"],
	corrupt: () => void,
): Promise<AdaptiveTaskOutcome> {
	let corrupted = false;
	let crashed = false;
	while (true) {
		const runtime = await buildRuntime(c, (event) => {
			if (event.type === crashType && !crashed) {
				crashed = true;
				return "crash";
			}
			return undefined;
		});
		try {
			return await runtime.run();
		} catch (error) {
			if (error instanceof SimulatedProcessCrash) {
				if (!corrupted) {
					corrupted = true;
					corrupt();
				}
				continue;
			}
			throw error;
		}
	}
}
