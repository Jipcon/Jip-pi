import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import { AgentHarness, InMemorySessionRepo } from "../../../agent/src/harness-v4.ts";
import {
	AdaptiveToolPolicyAdapter,
	CandidateStateProjector,
	type ComparisonStrategyOptions,
	PermissiveToolPolicyAdapter,
	runStrategyComparison,
	SingleCandidateAdaptiveToolLoop,
	type TaskVerifier,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import { createBundleFixtures, makeFixedTools } from "./stage5-fixtures.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

interface StrategyProbe {
	roots: string[];
	executed: string[];
}

function createStrategy(
	name: string,
	options: {
		policy: "permissive" | "adaptive";
		responses: Array<AssistantMessage>;
		verifier?: TaskVerifier;
		workspaceFactory?: () => Promise<{ root: string; cleanup(): Promise<void> }>;
	},
	probe: StrategyProbe,
): ComparisonStrategyOptions {
	const workspaceFactory =
		options.workspaceFactory ??
		(async () => {
			const root = mkdtempSync(join(tmpdir(), `pi-comparison-${name}-`));
			cleanupDirectories.add(root);
			probe.roots.push(root);
			return { root, cleanup: async () => rmSync(root, { recursive: true, force: true }) };
		});
	return {
		name,
		workspaceFactory,
		create: async ({ root }) => {
			const faux = fauxProvider({ provider: `comparison-${name}`, api: `comparison-${name}-api` });
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel() as Model<Api>;
			const repo = new InMemorySessionRepo({ now: () => 6_000_000_000_000 });
			const session = await repo.create({ id: `comparison-${name}` });
			const fixtures = await createBundleFixtures();
			const executed = probe.executed;
			const tools = makeFixedTools({
				record: (toolName) => executed.push(`${name}:${toolName}`),
			}) as unknown as AgentHarnessTool<undefined>[];
			const adaptiveToolPolicy =
				options.policy === "adaptive"
					? new AdaptiveToolPolicyAdapter({ registry: fixtures.registry, session, workspaceRoot: root })
					: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session });
			const { harness } = await AgentHarness.create<undefined>({
				session,
				models,
				model,
				tools,
				activeToolNames: ["read", "write", "edit", "bash"],
				adaptiveToolPolicy,
			});
			faux.setResponses(options.responses);
			const loop = new SingleCandidateAdaptiveToolLoop({
				session,
				lane: harness,
				registry: fixtures.registry,
				projector: new CandidateStateProjector({ registry: fixtures.registry }),
				executorFactory: (basis: HarnessV4LeafTurnBasis) => new HarnessV4LeafTurnAdapter({ lane: harness, basis }),
				tools: tools as unknown as AgentTool[],
				workspaceRoot: root,
				task: {
					taskId: "task",
					candidateId: "candidate",
					policyBundle: options.policy === "adaptive" ? fixtures.adaptive : fixtures.permissive,
					frozenModel: { provider: model.provider, modelId: model.id },
					...(options.verifier === undefined ? {} : { verifier: options.verifier }),
				},
			});
			return { loop, close: async () => harness.close() };
		},
	};
}

const PASSING_VERIFIER: TaskVerifier = { id: "verifier", verify: async () => ({ ok: true, coverage: 90 }) };

describe("runStrategyComparison", () => {
	it("compares permissive and adaptive strategies over the same scripted input", async () => {
		const probe: StrategyProbe = { roots: [], executed: [] };
		const responses = [
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "out.txt", content: "x" }), fauxToolCall("read", { path: "a" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		];
		const report = await runStrategyComparison({
			strategies: [
				createStrategy("permissive", { policy: "permissive", responses, verifier: PASSING_VERIFIER }, probe),
				createStrategy("adaptive", { policy: "adaptive", responses, verifier: PASSING_VERIFIER }, probe),
			],
			prompt: userMessage("work"),
		});
		const [permissive, adaptive] = report.strategies;
		expect(permissive).toMatchObject({ name: "permissive", outcome: "completed", verifiedSuccess: true });
		expect(adaptive).toMatchObject({ name: "adaptive", outcome: "completed", verifiedSuccess: true });
		// The adaptive policy blocks the write; the permissive baseline does not.
		expect(permissive.toolBlocks).toBe(0);
		expect(permissive.toolErrors).toBe(0);
		expect(adaptive.toolBlocks).toBe(1);
		expect(adaptive.toolErrors).toBe(0);
		// Both keep source-ordered results with the same first read call.
		expect(permissive.turns[0]?.results.map((result) => result.toolName)).toEqual(["write", "read"]);
		expect(adaptive.turns[0]?.results.map((result) => result.toolName)).toEqual(["write", "read"]);
		expect(permissive.turns[0]?.results[0]?.isError).toBe(false);
		expect(adaptive.turns[0]?.results[0]?.isError).toBe(true);
		// Metrics: latency, tokens and coverage are present on both sides.
		expect(permissive.latencyMs.perTurn.length).toBe(2);
		expect(adaptive.latencyMs.perTurn.length).toBe(2);
		expect(permissive.tokens.totalTokens).toBeGreaterThan(0);
		expect(adaptive.tokens.totalTokens).toBeGreaterThan(0);
		expect(permissive.verificationCoverage).toBe(0);
		expect(adaptive.verificationCoverage).toBe(0);
		// The strategies ran in distinct disposable workspaces.
		expect(probe.roots).toHaveLength(2);
		expect(probe.roots[0]).not.toBe(probe.roots[1]);
		for (const root of probe.roots) expect(root.startsWith(tmpdir())).toBe(true);
		expect(probe.executed).toEqual(["permissive:write", "permissive:read", "adaptive:read"]);
	});

	it("reports redundancy, errors and unverified outcomes honestly", async () => {
		const probe: StrategyProbe = { roots: [], executed: [] };
		const responses = [
			fauxAssistantMessage([fauxToolCall("read", { path: "a" }), fauxToolCall("read", { path: "a" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		];
		const report = await runStrategyComparison({
			strategies: [
				createStrategy("permissive", { policy: "permissive", responses }, probe),
				createStrategy("adaptive", { policy: "adaptive", responses }, probe),
			],
			prompt: userMessage("work"),
		});
		const [permissive, adaptive] = report.strategies;
		// Two identical reads in one batch: the deterministic turn reducer
		// flags the second one as redundant on both sides.
		expect(permissive.redundantCalls).toBe(1);
		expect(adaptive.redundantCalls).toBe(1);
		// No verifier: a plain final answer is never reported as success.
		expect(permissive.verifiedSuccess).toBe(false);
		expect(adaptive.verifiedSuccess).toBe(false);
		expect(permissive.outcome).toBe("completed");
	});

	it("refuses to run a strategy on a non-disposable workspace", async () => {
		const probe: StrategyProbe = { roots: [], executed: [] };
		let cleaned = false;
		const foreground = {
			workspaceFactory: async () => ({
				root: process.cwd(),
				cleanup: async () => {
					cleaned = true;
				},
			}),
			name: "foreground",
			create: async () => {
				throw new Error("must not create");
			},
		} satisfies ComparisonStrategyOptions;
		await expect(
			runStrategyComparison({
				strategies: [
					foreground,
					createStrategy("adaptive", { policy: "adaptive", responses: [fauxAssistantMessage("done")] }, probe),
				],
				prompt: userMessage("work"),
			}),
		).rejects.toThrow(/disposable temp workspace/);
		expect(cleaned).toBe(true);
		// The second strategy never ran: no workspace was created for it.
		expect(probe.roots).toHaveLength(0);
	});
});
