import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import {
	type AdaptiveToolBatchClearance,
	AgentHarness,
	InMemorySessionRepo,
	type Session,
} from "../../../agent/src/harness-v4.ts";
import {
	AdaptiveToolPolicyAdapter,
	CandidateStateProjector,
	PermissiveToolPolicyAdapter,
	type PolicyBundleRef,
	SingleCandidateAdaptiveToolLoop,
	type TaskVerifier,
	type TrajectoryStore,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import type { LeafTurnExecutor } from "../../src/runtime/leaf-turn-executor.ts";
import { type BundleFixtures, createBundleFixtures, makeFixedTools } from "./stage5-fixtures.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-loop-"));
	cleanupDirectories.add(directory);
	return directory;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

interface LoopFixture {
	faux: ReturnType<typeof fauxProvider>;
	harness: AgentHarness<undefined>;
	session: Session;
	fixtures: BundleFixtures;
	tools: AgentHarnessTool<undefined>[];
	model: Model<Api>;
	executed: string[];
	root: string;
}

async function createLoopFixture(
	options: {
		id?: string;
		policy?: "permissive" | "adaptive";
		policyFactory?: (session: Session, fixtures: BundleFixtures) => AdaptiveToolBatchClearance;
	} = {},
): Promise<LoopFixture> {
	const faux = fauxProvider({ provider: "loop-provider", api: "loop-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 5_000_000_000_000 });
	const session = await repo.create({ id: options.id ?? "loop" });
	const fixtures = await createBundleFixtures();
	const executed: string[] = [];
	const tools = makeFixedTools({ record: (name) => executed.push(name) }) as unknown as AgentHarnessTool<undefined>[];
	const root = workspace();
	const adaptiveToolPolicy =
		options.policyFactory !== undefined
			? options.policyFactory(session, fixtures)
			: options.policy === "adaptive"
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
	return { faux, harness, session, fixtures, tools, model, executed, root };
}

function createLoop(
	item: LoopFixture,
	options: {
		policyBundle?: PolicyBundleRef;
		verifier?: TaskVerifier;
		trajectory?: TrajectoryStore;
		tools?: AgentHarnessTool<undefined>[];
	} = {},
): SingleCandidateAdaptiveToolLoop {
	const projector = new CandidateStateProjector({ registry: item.fixtures.registry });
	const executorFactory = (loopBasis: HarnessV4LeafTurnBasis): LeafTurnExecutor =>
		new HarnessV4LeafTurnAdapter({ lane: item.harness, basis: loopBasis });
	return new SingleCandidateAdaptiveToolLoop({
		session: item.session,
		lane: item.harness,
		registry: item.fixtures.registry,
		projector,
		executorFactory,
		tools: (options.tools ?? item.tools) as unknown as AgentTool[],
		workspaceRoot: item.root,
		trajectory: options.trajectory,
		task: {
			taskId: "task",
			candidateId: "candidate",
			policyBundle: options.policyBundle ?? item.fixtures.permissive,
			frozenModel: { provider: item.model.provider, modelId: item.model.id },
			...(options.verifier === undefined ? {} : { verifier: options.verifier }),
		},
	});
}

describe("SingleCandidateAdaptiveToolLoop admission", () => {
	it("rejects model drift before any provider request", async () => {
		const item = await createLoopFixture();
		const loop = createLoop(item);
		const drifted = fauxProvider({ provider: "drifted", api: "drifted-api" });
		const driftedModels = createModels();
		driftedModels.setProvider(drifted.provider);
		await item.harness.setModel(drifted.getModel() as Model<Api>);
		const step = await loop.start(userMessage("work"));
		expect(step).toMatchObject({ kind: "model_drift" });
		expect(item.faux.state.callCount).toBe(0);
		await item.harness.close();
	});

	it("rejects tool catalog drift before any provider request", async () => {
		const item = await createLoopFixture();
		const loop = createLoop(item, { tools: item.tools.slice().reverse() });
		const step = await loop.start(userMessage("work"));
		expect(step).toMatchObject({ kind: "rejected", message: expect.stringContaining("catalog_drift") });
		expect(item.faux.state.callCount).toBe(0);
		await item.harness.close();
	});

	it("rejects an unresolvable pinned bundle before any provider request", async () => {
		const item = await createLoopFixture();
		const ghost: PolicyBundleRef = { version: "ghost", fingerprint: "a".repeat(64) };
		const loop = createLoop(item, { policyBundle: ghost });
		const step = await loop.start(userMessage("work"));
		expect(step).toMatchObject({ kind: "rejected", message: expect.stringContaining("corrupt_bundle") });
		expect(item.faux.state.callCount).toBe(0);
		await item.harness.close();
	});
});

describe("SingleCandidateAdaptiveToolLoop execution", () => {
	it("drives turns with post-turn projection before the next provider request", async () => {
		const item = await createLoopFixture();
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const loop = createLoop(item);
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({
			kind: "completed",
			evaluation: { kind: "unknown", reason: "no verifier evidence" },
		});
		expect(result.metrics).toMatchObject({ providerRequests: 2, turns: 2, toolErrors: 0 });
		expect(item.faux.state.callCount).toBe(2);
		expect(item.executed).toEqual(["read"]);
		if (result.kind !== "completed") throw new Error("expected completion");
		expect(result.state.snapshot.turns).toBe(2);
		expect(result.state.snapshot.steps).toBe(1);
		await item.harness.close();
	});

	it("reports verified success only through the hard verifier", async () => {
		const item = await createLoopFixture();
		item.faux.setResponses([fauxAssistantMessage("done")]);
		const loop = createLoop(item, {
			verifier: { id: "verifier", verify: async () => ({ ok: true, coverage: 75 }) },
		});
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({ kind: "completed", evaluation: { kind: "verified", coverage: 75 } });
		await item.harness.close();
	});

	it("reports a failing verifier as failed", async () => {
		const item = await createLoopFixture();
		item.faux.setResponses([fauxAssistantMessage("done")]);
		const loop = createLoop(item, {
			verifier: { id: "verifier", verify: async () => ({ ok: false, error: "tests red" }) },
		});
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({ kind: "completed", evaluation: { kind: "failed", reason: "tests red" } });
		await item.harness.close();
	});

	it("stops with a typed budget exhaustion and no further provider request", async () => {
		const item = await createLoopFixture({ id: "loop-budget" });
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const tight = await item.fixtures.registry.publish({
			schemaVersion: 1,
			version: "tight-v1",
			rules: {
				toolRules: [],
				verification: { commandPatterns: [] },
				budgets: { maxTurns: 1, maxToolCalls: 16, maxTokens: 100_000 },
				toolCatalogFingerprint: item.fixtures.catalogFingerprint,
			},
		});
		const loop = createLoop(item, { policyBundle: tight });
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({ kind: "budget_exhausted", budget: "turns" });
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});

	it("returns a typed suspension for deferred runs", async () => {
		const item = await createLoopFixture();
		item.faux.setResponses([
			fauxAssistantMessage("later", {
				stopReason: "deferred",
				deferred: { provider: "x", modelId: "faux-1", api: "x-api", id: "deferred-id" },
			}),
		]);
		const loop = createLoop(item);
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({ kind: "suspended", operation: { reason: "deferred" } });
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});

	it("stops on a ToolPolicy fault with zero effects and a sticky fault", async () => {
		const item = await createLoopFixture({
			id: "loop-fault",
			policyFactory: () => ({
				clearBatch: async () => {
					throw new Error("policy exploded");
				},
			}),
		});
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const loop = createLoop(item);
		const step = await loop.start(userMessage("work"));
		expect(step).toMatchObject({ kind: "policy_fault" });
		expect(item.executed).toHaveLength(0);
		expect(item.faux.state.callCount).toBe(1);
		// The fault is sticky: further advances never start another request.
		const again = await loop.advance();
		expect(again).toMatchObject({ kind: "policy_fault" });
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});

	it("fails closed with projection_mismatch when a stored fingerprint disagrees", async () => {
		const item = await createLoopFixture({
			id: "loop-mismatch",
			policyFactory: (session, fixtures) => {
				const policy = new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session });
				const original = policy.clearBatch.bind(policy);
				policy.clearBatch = async (input) => {
					const result = await original(input);
					return { ...result, policyStateFingerprint: "c".repeat(64) };
				};
				return policy;
			},
		});
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const loop = createLoop(item);
		const result = await loop.run(userMessage("work"));
		expect(result).toMatchObject({ kind: "projection_fault", code: "projection_mismatch" });
		// Only the first turn ran: the mismatch stops the next provider request.
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});

	it("inherits the previous post-turn capsule into the next Run basis", async () => {
		const item = await createLoopFixture({ id: "loop-inherit" });
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const first = createLoop(item);
		const firstResult = await first.run(userMessage("work"));
		expect(firstResult.kind).toBe("completed");
		const inherited = first.nextRunBasis();
		if (inherited === undefined) throw new Error("expected an inherited basis");
		if (inherited.inheritedPolicyState.basis.cursor.kind !== "post_turn")
			throw new Error("expected a post_turn capsule");
		expect(inherited.inheritedPolicyState.basis.operationId).toBe(
			inherited.inheritedPolicyState.basis.cursor.cursor.operationId,
		);

		item.faux.setResponses([fauxAssistantMessage("second run done")]);
		const second = createLoop(item);
		const secondResult = await second.run(userMessage("continue"), { inheritedBasis: inherited });
		expect(secondResult).toMatchObject({ kind: "completed" });
		expect(item.faux.state.callCount).toBe(3);
		// The new run basis durably persists the previous post-turn capsule.
		const runBases = await item.session.findEntries({
			type: "custom",
			customType: "adaptive.run_basis",
			order: "asc",
		});
		expect(runBases).toHaveLength(2);
		const secondBasis = runBases[1];
		const data =
			secondBasis?.type === "custom"
				? (secondBasis.data as {
						inheritedPolicyState: { fingerprint: string; basis: { cursor: { kind: string } } };
					})
				: undefined;
		expect(data?.inheritedPolicyState.fingerprint).toBe(inherited.inheritedPolicyState.fingerprint);
		expect(data?.inheritedPolicyState.basis.cursor.kind).toBe("post_turn");
		await item.harness.close();
	});

	it("keeps execution identical when the TrajectoryStore is failing", async () => {
		const failing: TrajectoryStore = {
			append: async () => {
				throw new Error("store offline");
			},
			query: async () => [],
			setPaused: () => undefined,
			close: async () => undefined,
		};
		const run = async (trajectory?: TrajectoryStore): Promise<{ fingerprint: string; calls: number }> => {
			const item = await createLoopFixture({
				id: `loop-trajectory-${trajectory === undefined ? "clean" : "faulty"}`,
			});
			item.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const loop = createLoop(item, { ...(trajectory === undefined ? {} : { trajectory }) });
			const result = await loop.run(userMessage("work"));
			const calls = item.faux.state.callCount;
			const state = result.kind === "completed" ? result.state : undefined;
			await item.harness.close();
			return { fingerprint: state === undefined ? "" : state.fingerprint, calls };
		};
		const clean = await run(undefined);
		const faulty = await run(failing);
		expect(faulty).toEqual(clean);
	});

	it("aborts an in-flight turn into a typed aborted outcome", async () => {
		const item = await createLoopFixture({ id: "loop-abort" });
		const release = createDeferred();
		item.faux.setResponses([
			(_context, options: { signal?: AbortSignal } | undefined) => {
				release.resolve();
				return new Promise<AssistantMessage>((resolve) => {
					const finish = () => resolve(fauxAssistantMessage(""));
					if (options?.signal?.aborted) {
						finish();
						return;
					}
					options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		const loop = createLoop(item);
		const running = loop.run(userMessage("work"));
		await release.promise;
		await loop.abort();
		const result = await running;
		expect(result).toMatchObject({ kind: "aborted" });
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});

	it("detects model drift between turns before the next provider request", async () => {
		const item = await createLoopFixture({ id: "loop-drift" });
		item.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const loop = createLoop(item);
		const first = await loop.start(userMessage("work"));
		expect(first).toMatchObject({ kind: "turn", decision: { kind: "continue" } });
		const drifted = fauxProvider({ provider: "drifted-mid", api: "drifted-mid-api" });
		const driftedModels = createModels();
		driftedModels.setProvider(drifted.provider);
		await item.harness.setModel(drifted.getModel() as Model<Api>);
		const step = await loop.advance();
		expect(step).toMatchObject({ kind: "model_drift" });
		expect(item.faux.state.callCount).toBe(1);
		await item.harness.close();
	});
});

describe("adaptive loop policy behavior", () => {
	it("blocks writes per policy while permissive allows them", async () => {
		const adaptive = await createLoopFixture({ id: "loop-adaptive", policy: "adaptive" });
		adaptive.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "out.txt", content: "x" }), fauxToolCall("read", { path: "a" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const adaptiveLoop = createLoop(adaptive, { policyBundle: adaptive.fixtures.adaptive });
		const adaptiveResult = await adaptiveLoop.run(userMessage("work"));
		expect(adaptiveResult.kind).toBe("completed");
		expect(adaptive.executed).toEqual(["read"]);
		const adaptiveState = adaptiveResult.kind === "completed" ? adaptiveResult.state.snapshot : undefined;
		expect(adaptiveState?.tools.block).toBe(1);
		await adaptive.harness.close();

		const permissive = await createLoopFixture({ id: "loop-permissive", policy: "permissive" });
		permissive.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "out.txt", content: "x" }), fauxToolCall("read", { path: "a" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const permissiveLoop = createLoop(permissive);
		const permissiveResult = await permissiveLoop.run(userMessage("work"));
		expect(permissiveResult.kind).toBe("completed");
		expect(permissive.executed).toEqual(["write", "read"]);
		await permissive.harness.close();
	});
});
