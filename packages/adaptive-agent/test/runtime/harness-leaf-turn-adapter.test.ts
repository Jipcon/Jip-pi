import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import {
	type AdaptiveToolBatchClearance,
	type AdaptiveToolClearanceDecision,
	type AdaptiveToolClearanceInput,
	AgentHarness,
	InMemorySessionRepo,
	type LaneConfiguration,
	type Operation,
	type RunState,
} from "../../../agent/src/harness-v4.ts";
import { type V4SessionRepo, v4Backends } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import { createOriginCapsule, PermissiveToolPolicyAdapter, PROJECTOR_VERSION } from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import type { LeafTurnCursor } from "../../src/runtime/leaf-turn-executor.ts";
import {
	createAssistantMessage,
	createDeferred,
	describeLeafTurnSemanticContract,
	type LeafTurnSemanticFixtureOptions,
} from "./leaf-turn-semantic-contract.ts";
import { type BundleFixtures, createBundleFixtures, originSnapshot } from "./stage5-fixtures.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function basis(sessionId: string, fixtures: BundleFixtures): HarnessV4LeafTurnBasis {
	return {
		schemaVersion: 1,
		taskId: "task",
		candidateId: "candidate",
		policyBundle: fixtures.permissive,
		projectorVersion: PROJECTOR_VERSION,
		inheritedPolicyState: createOriginCapsule({
			taskId: "task",
			candidateId: "candidate",
			sessionId,
			lane: "main",
			policyBundle: fixtures.permissive,
			snapshot: originSnapshot(fixtures.permissiveBundle),
		}),
		start: { kind: "prompt" },
	};
}

async function createAdapterWithRepo(repo: V4SessionRepo, drive: "automatic" | "manual" = "automatic") {
	const faux = fauxProvider({ provider: `adapter-${drive}`, api: `adapter-${drive}-api` });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const session = await repo.create({ id: `adapter-${drive}` });
	const fixtures = await createBundleFixtures();
	const { harness } = await AgentHarness.create({ session, models, model, drive });
	const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
	return { adapter, faux, harness, model, models, repo, session, fixtures };
}

async function createAdapter(drive: "automatic" | "manual" = "automatic") {
	return createAdapterWithRepo(new InMemorySessionRepo({ now: () => 1_900_000_000_000 }), drive);
}

describe.each(v4Backends())("HarnessV4LeafTurnAdapter R2 ($name backend)", (backend) => {
	async function createAdapter(drive: "automatic" | "manual" = "automatic") {
		return createAdapterWithRepo(backend.create({ now: () => 1_900_000_000_000 }), drive);
	}

	it("returns only after the assistant entry and usage row form a durable cursor", async () => {
		const { adapter, faux, harness, session } = await createAdapter();
		faux.setResponses([fauxAssistantMessage("leaf response")]);

		const result = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: {
					beforeLeafId: null,
					afterLeafId: expect.any(String),
					assistantEntryId: expect.any(String),
					toolResultEntryIds: [],
					usageRowIds: [expect.any(String)],
					message: { role: "assistant", content: [{ text: "leaf response" }] },
				},
				run: { kind: "settled", result: { kind: "completed" } },
			},
		});
		if (!result.ok || result.value.kind !== "turn") throw new Error("Expected a durable turn");
		expect(result.value.turn.cursor).toEqual({
			operationId: result.value.turn.operationId,
			assistantEntryId: result.value.turn.assistantEntryId,
			leafId: result.value.turn.afterLeafId,
		});
		const commit = await harness.session.getTurnCommit({
			assistantEntryId: result.value.turn.assistantEntryId,
			leafId: result.value.turn.afterLeafId,
		});
		expect(commit?.usageRows.map((row) => row.id)).toEqual(result.value.turn.usageRowIds);
		expect(result.value.turn.usage).toEqual(commit?.usageRows[0]?.usage);
		expect(faux.state.callCount).toBe(1);
		const runBasis = await session.findEntry({ type: "custom", customType: "adaptive.run_basis" });
		expect(runBasis).toMatchObject({
			type: "custom",
			data: { operationId: result.value.turn.operationId, taskId: "task", candidateId: "candidate" },
		});

		const settledAdvance = await adapter.execute({ kind: "advance", afterCursor: result.value.turn.cursor });
		expect(settledAdvance).toMatchObject({ ok: false, error: { kind: "nothing_to_resume" } });
		const staleAdvance = await adapter.execute({
			kind: "advance",
			afterCursor: { ...result.value.turn.cursor, leafId: "stale" },
		});
		expect(staleAdvance).toMatchObject({
			ok: false,
			error: { kind: "checkpoint_mismatch", actual: result.value.turn.cursor },
		});
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("drives a manual Harness without starting a second provider request", async () => {
		const { adapter, faux, harness } = await createAdapter("manual");
		faux.setResponses([fauxAssistantMessage("manual leaf")]);

		const result = await adapter.execute({ kind: "start", prompt: userMessage("manual work") });
		expect(result).toMatchObject({
			ok: true,
			value: { kind: "turn", turn: { message: { content: [{ text: "manual leaf" }] } } },
		});
		expect(faux.state.callCount).toBe(1);
		expect(await harness.peekAction()).toBeUndefined();
		await harness.close();
	});

	it("rejects a concurrent driver while the first provider request is live", async () => {
		const { adapter, faux, harness } = await createAdapter();
		let release: ((message: AssistantMessage) => void) | undefined;
		const response = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => response]);

		const first = adapter.execute({ kind: "start", prompt: userMessage("first") });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await expect(adapter.execute({ kind: "start", prompt: userMessage("second") })).resolves.toMatchObject({
			ok: false,
			error: { kind: "driver_busy" },
		});
		release?.(fauxAssistantMessage("released"));
		await expect(first).resolves.toMatchObject({ ok: true, value: { kind: "turn" } });
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("reconstructs terminal cursor guards after close and reopen", async () => {
		const { adapter, faux, harness, model, models, repo, session, fixtures } = await createAdapter();
		faux.setResponses([fauxAssistantMessage("persisted")]);
		const first = await adapter.execute({ kind: "start", prompt: userMessage("persist") });
		if (!first.ok || first.value.kind !== "turn") throw new Error("Expected a durable turn");
		const cursor = first.value.turn.cursor;
		const metadata = structuredClone(session.metadata);
		await harness.close();

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const reopenedAdapter = new HarnessV4LeafTurnAdapter({ lane: reopened, basis: basis(metadata.id, fixtures) });
		await expect(reopenedAdapter.execute({ kind: "advance", afterCursor: cursor })).resolves.toMatchObject({
			ok: false,
			error: { kind: "nothing_to_resume" },
		});
		await reopened.close();
	});
});

const ADAPTER_CONFIGURATION: LaneConfiguration = {
	model: { provider: "adapter-open", modelId: "faux-1" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createOpenRunSession(
	id: string,
	phaseFactory: (promptEntryId: string) => RunState["phase"],
	configuration: LaneConfiguration = ADAPTER_CONFIGURATION,
) {
	const faux = fauxProvider({ provider: "adapter-open", api: "adapter-open-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 2_000_000_000_000 });
	const session = await repo.create({ id });
	const promptEntryId = await session.appendMessage(userMessage("work"));
	const operationId = "operation";
	const operation: Operation = {
		operationId,
		lane: "main",
		sourceLeafId: null,
		startedAt: 10,
		intent: { kind: "run", promptEntryIds: [promptEntryId] },
	};
	const state: RunState = {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		phase: phaseFactory(promptEntryId),
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
	await session.commit({
		writes: [
			{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: operationId, pendingNextRun: [] },
			},
			{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
			{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
		],
	});
	return { faux, models, model, repo, session };
}

describe("HarnessV4LeafTurnAdapter R3", () => {
	it("returns a durable deferred suspension from start and resumes it from advance", async () => {
		const { adapter, faux, harness } = await createAdapter();
		faux.setResponses([
			fauxAssistantMessage("later", {
				stopReason: "deferred",
				deferred: { provider: "x", modelId: "faux-1", api: "x-api", id: "deferred-id" },
			}),
		]);

		const first = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(first).toMatchObject({
			ok: true,
			value: {
				kind: "suspended",
				operation: {
					kind: "run",
					reason: "deferred",
					deferred: expect.objectContaining({ id: "deferred-id" }),
				},
			},
		});
		if (!first.ok || first.value.kind !== "suspended") throw new Error("Expected a suspension");
		expect(faux.state.callCount).toBe(1);

		const second = await adapter.execute({ kind: "advance" });
		expect(second).toMatchObject({
			ok: true,
			value: {
				kind: "suspended",
				operation: {
					operationId: first.value.operation.operationId,
					reason: "deferred",
				},
			},
		});
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("guards advance cursors against the open deferred turn and recovers across reopen", async () => {
		const { adapter, faux, harness, model, models, repo, session, fixtures } = await createAdapter();
		faux.setResponses([
			fauxAssistantMessage("later", {
				stopReason: "deferred",
				deferred: { provider: "x", modelId: "faux-1", api: "x-api", id: "deferred-id" },
			}),
		]);
		const first = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		if (!first.ok || first.value.kind !== "suspended") throw new Error("Expected a suspension");
		const branch = await harness.session.findEntriesOnBranch({ order: "newestFirst" });
		const leafId = await harness.getLeafId();
		const response = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (response?.type !== "message" || leafId === null) throw new Error("Expected a deferred leaf");
		const cursor: LeafTurnCursor = {
			operationId: first.value.operation.operationId,
			assistantEntryId: response.id,
			leafId,
		};
		const stale = await adapter.execute({
			kind: "advance",
			afterCursor: { ...cursor, leafId: "stale" },
		});
		expect(stale).toMatchObject({
			ok: false,
			error: { kind: "checkpoint_mismatch", actual: cursor },
		});
		const matching = await adapter.execute({ kind: "advance", afterCursor: cursor });
		expect(matching).toMatchObject({ ok: true, value: { kind: "suspended" } });
		const metadata = structuredClone(session.metadata);
		await harness.close();

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const reopenedAdapter = new HarnessV4LeafTurnAdapter({ lane: reopened, basis: basis(metadata.id, fixtures) });
		expect(faux.state.callCount).toBe(1);
		const resumed = await reopenedAdapter.execute({ kind: "advance", afterCursor: cursor });
		expect(resumed).toMatchObject({ ok: true, value: { kind: "suspended", operation: { reason: "deferred" } } });
		expect(faux.state.callCount).toBe(1);
		await reopened.close();
	});

	it("advances an open checkpoint Run through resume without a second admission", async () => {
		const { faux, model, models, session } = await createOpenRunSession(
			"adapter-open-checkpoint",
			(promptEntryId) => ({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: promptEntryId,
			}),
		);
		faux.setResponses([fauxAssistantMessage("open run turn")]);
		const { harness } = await AgentHarness.create({ session, models, model });
		const fixtures = await createBundleFixtures();
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		const result = await adapter.execute({ kind: "advance" });
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: { message: { content: [{ text: "open run turn" }] } },
				run: { kind: "settled", result: { kind: "completed" } },
			},
		});
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});

	it("maps a ready state with missing identities into a typed rejection", async () => {
		const { faux, model, models, session } = await createOpenRunSession(
			"adapter-missing-identity",
			(promptEntryId) => ({
				kind: "assistant",
				generation: {
					status: "ready",
					context: {
						stepId: "step",
						triggerEntryId: promptEntryId,
						configuration: {
							model: { provider: "missing-provider", modelId: "missing-model" },
							thinkingLevel: "off",
							activeToolNames: [],
						},
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 100 },
						overflowRecoveryUsed: false,
					},
					nextAttempt: 1,
				},
			}),
			{
				model: { provider: "missing-provider", modelId: "missing-model" },
				thinkingLevel: "off",
				activeToolNames: [],
			},
		);
		const { harness } = await AgentHarness.create({ session, models, model });
		const fixtures = await createBundleFixtures();
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		const result = await adapter.execute({ kind: "advance" });
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "missing_identities", models: ["missing-provider/missing-model"] },
		});
		expect(faux.state.callCount).toBe(0);
		await harness.close();
	});
});

describe.each(v4Backends())("HarnessV4LeafTurnAdapter R4 post-turn ($name backend)", (backend) => {
	it("yields after a complete tool batch without starting the next provider request", async () => {
		const faux = fauxProvider({ provider: "r4-adapter", api: "r4-adapter-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_100_000_000_000 });
		const session = await repo.create({ id: "r4-adapter" });
		const tool: import("../../../agent/src/harness/types.ts").AgentHarnessTool<undefined> = {
			name: "read",
			description: "read tool",
			label: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "read ran" }], details: {} }),
		};
		const fixtures = await createBundleFixtures();
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("next turn"),
		]);

		const first = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(first).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: {
					message: { stopReason: "toolUse" },
					toolResults: [{ toolName: "read", isError: false }],
					usageRowIds: [expect.any(String)],
				},
				run: { kind: "open" },
			},
		});
		expect(faux.state.callCount).toBe(1);
		if (!first.ok || first.value.kind !== "turn") throw new Error("Expected an open turn");
		expect(await harness.getOpenOperation()).toMatchObject({
			kind: "run",
			turnCursor: {
				assistantEntryId: first.value.turn.assistantEntryId,
				leafId: first.value.turn.afterLeafId,
			},
		});

		const second = await adapter.execute({ kind: "advance", afterCursor: first.value.turn.cursor });
		expect(second).toMatchObject({
			ok: true,
			value: { kind: "turn", turn: { message: { content: [{ text: "next turn" }] } } },
		});
		expect(faux.state.callCount).toBe(2);
		await harness.close();
	});

	it("returns a settled turn for terminated_tools without a final assistant entry", async () => {
		const faux = fauxProvider({ provider: "r4-stop", api: "r4-stop-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_110_000_000_000 });
		const session = await repo.create({ id: "r4-stop" });
		const tool: import("../../../agent/src/harness/types.ts").AgentHarnessTool<undefined> = {
			name: "stop",
			description: "stop tool",
			label: "stop",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({
				content: [{ type: "text", text: "stopped" }],
				details: {},
				terminate: true,
			}),
		};
		const fixtures = await createBundleFixtures();
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["stop"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		faux.setResponses([fauxAssistantMessage([fauxToolCall("stop", { path: "x" })], { stopReason: "toolUse" })]);

		const result = await adapter.execute({ kind: "start", prompt: userMessage("stop now") });
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: { toolResults: [{ toolName: "stop", isError: false }] },
				run: { kind: "settled", result: { kind: "completed" } },
			},
		});
		expect(faux.state.callCount).toBe(1);
		expect(await harness.getLastResult()).toMatchObject({
			outcome: "completed",
			runCompletion: "terminated_tools",
		});
		await harness.close();
	});

	it("reopens an open post-turn Run and advances from its durable cursor", async () => {
		const faux = fauxProvider({ provider: "r4-reopen", api: "r4-reopen-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_120_000_000_000 });
		const session = await repo.create({ id: "r4-reopen" });
		const tool: import("../../../agent/src/harness/types.ts").AgentHarnessTool<undefined> = {
			name: "read",
			description: "read tool",
			label: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "read ran" }], details: {} }),
		};
		const fixtures = await createBundleFixtures();
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("after reopen"),
		]);
		const first = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		if (!first.ok || first.value.kind !== "turn") throw new Error("Expected an open turn");
		const cursor = first.value.turn.cursor;
		const metadata = structuredClone(session.metadata);
		await harness.close();

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session: reopenedSession }),
		});
		const reopenedAdapter = new HarnessV4LeafTurnAdapter({ lane: reopened, basis: basis(metadata.id, fixtures) });
		expect(faux.state.callCount).toBe(1);
		const second = await reopenedAdapter.execute({ kind: "advance", afterCursor: cursor });
		expect(second).toMatchObject({
			ok: true,
			value: { kind: "turn", turn: { message: { content: [{ text: "after reopen" }] } } },
		});
		expect(faux.state.callCount).toBe(2);
		await reopened.close();
	});
});

describe.each(v4Backends())("HarnessV4LeafTurnAdapter R6 abort ($name backend)", (backend) => {
	async function createAdapter(drive: "automatic" | "manual" = "automatic") {
		return createAdapterWithRepo(backend.create({ now: () => 1_900_000_000_000 }), drive);
	}

	it("aborts a running provider turn and returns the durable finalization", async () => {
		const { adapter, faux, harness, session } = await createAdapter();
		const firstRequest = createDeferred();
		faux.setResponses([
			(_context, options: { signal?: AbortSignal } | undefined) => {
				firstRequest.resolve();
				return new Promise<AssistantMessage>((resolve) => {
					const finish = () => resolve(fauxAssistantMessage(""));
					if (options?.signal?.aborted) {
						finish();
						return;
					}
					options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
			fauxAssistantMessage("must not run"),
		]);
		const execution = adapter.execute({ kind: "start", prompt: userMessage("work") });
		await firstRequest.promise;

		const aborted = await adapter.abort();
		expect(aborted).toMatchObject({ ok: true, value: { steer: [], followUp: [] } });
		const operationId = aborted.ok ? aborted.value.operationId : "";

		const result = await execution;
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				run: { kind: "settled", result: { kind: "aborted" } },
			},
		});
		expect(faux.state.callCount).toBe(1);
		expect(await harness.getLastResult()).toMatchObject({ operationId, outcome: "aborted" });
		expect(await session.getRegister("op.state", operationId)).toBeUndefined();
		await harness.close();
	});

	it("waits for a running aborted tool to finalize durably before returning", async () => {
		const faux = fauxProvider({ provider: "abort-tool-adapter", api: "abort-tool-adapter-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_130_000_000_000 });
		const session = await repo.create({ id: "abort-tool-adapter" });
		const toolStarted = createDeferred();
		const tool: import("../../../agent/src/harness/types.ts").AgentHarnessTool<undefined> = {
			name: "wait",
			description: "wait tool",
			label: "wait",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, _args, signal) => {
				toolStarted.resolve();
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("tool aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "must not complete" }], details: {} };
			},
		};
		const fixtures = await createBundleFixtures();
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["wait"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const execution = adapter.execute({ kind: "start", prompt: userMessage("work") });
		await toolStarted.promise;

		const aborted = await adapter.abort();
		expect(aborted).toMatchObject({ ok: true });

		const result = await execution;
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: {
					toolResults: [{ toolName: "wait", isError: true }],
				},
				run: { kind: "settled", result: { kind: "aborted" } },
			},
		});
		expect(faux.state.callCount).toBe(1);
		expect(await harness.getLastResult()).toMatchObject({ outcome: "aborted" });
		await harness.close();
	});

	it("rejects abort with no active operation", async () => {
		const { adapter, harness } = await createAdapter();
		await expect(adapter.abort()).resolves.toMatchObject({
			ok: false,
			error: { kind: "no_active_operation", lane: "main" },
		});
		await harness.close();
	});

	it("abort never starts a second provider request after the first turn", async () => {
		const { adapter, faux, harness } = await createAdapter();
		const firstRequest = createDeferred();
		faux.setResponses([
			(_context, options: { signal?: AbortSignal } | undefined) => {
				firstRequest.resolve();
				return new Promise<AssistantMessage>((resolve) => {
					const finish = () => resolve(fauxAssistantMessage(""));
					if (options?.signal?.aborted) {
						finish();
						return;
					}
					options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
			fauxAssistantMessage("must not run"),
			fauxAssistantMessage("must not run either"),
		]);
		const execution = adapter.execute({ kind: "start", prompt: userMessage("work") });
		await firstRequest.promise;
		await adapter.abort();
		await execution;
		expect(faux.state.callCount).toBe(1);
		await harness.close();
	});
});

interface SemanticFixtureRuntime {
	harness: AgentHarness<object | undefined>;
	adapter: HarnessV4LeafTurnAdapter;
}

function createHarnessV4SemanticFixture(options: LeafTurnSemanticFixtureOptions) {
	const faux = fauxProvider({ provider: "semantic-v4", api: "semantic-v4-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const firstProviderRequest = createDeferred();
	let providerRequests = 0;
	const steps = options.providerSteps;
	faux.setResponses(
		steps.map((step) => (_context, streamOptions: { signal?: AbortSignal } | undefined) => {
			providerRequests++;
			firstProviderRequest.resolve();
			if (step.kind === "throw") throw step.error;
			if (step.kind === "message") return step.message;
			return new Promise<AssistantMessage>((resolve) => {
				const finish = () => resolve(createAssistantMessage(""));
				if (streamOptions?.signal?.aborted) {
					finish();
					return;
				}
				streamOptions?.signal?.addEventListener("abort", finish, { once: true });
			});
		}),
	);

	let ready: Promise<SemanticFixtureRuntime> | undefined;
	const resolveReady = (): Promise<SemanticFixtureRuntime> => {
		if (ready !== undefined) return ready;
		const created = (async (): Promise<SemanticFixtureRuntime> => {
			const repo = new InMemorySessionRepo({ now: () => 2_140_000_000_000 });
			const session = await repo.create({ id: "semantic-v4" });
			const fixtures = await createBundleFixtures();
			const tools = (options.tools ?? []) as unknown as AgentHarnessTool<undefined>[];
			// The semantic contract's beforeToolCall block seam maps onto the
			// Adaptive clearance decisions of the Harness v4 tool batch.
			const policy: AdaptiveToolBatchClearance = {
				clearBatch: async (input: AdaptiveToolClearanceInput) => {
					const decisions: AdaptiveToolClearanceDecision[] = [];
					for (const { sourceIndex, call } of input.calls) {
						const result = await options.beforeToolCall?.(
							call as never,
							structuredClone(call.arguments) as never,
						);
						if (result?.block !== undefined) {
							decisions.push({
								kind: "block",
								sourceIndex,
								toolCallId: call.id,
								toolName: call.name,
								replay: "never",
								reason: String((result as { reason?: string }).reason ?? "blocked"),
							});
						} else {
							decisions.push({
								kind: "allow",
								sourceIndex,
								toolCallId: call.id,
								toolName: call.name,
								effectiveArgs: structuredClone(call.arguments) as never,
								replay: "never",
							});
						}
					}
					return { policyStateFingerprint: "semantic", decisions };
				},
			};
			const { harness } = await AgentHarness.create<object | undefined>({
				session,
				models,
				model,
				tools,
				activeToolNames: tools.map((tool) => tool.name),
				toolExecution: options.toolExecution,
				adaptiveToolPolicy: policy,
			});
			const adapter = new HarnessV4LeafTurnAdapter({
				lane: harness,
				basis: basis("semantic-v4", fixtures),
			});
			return { harness, adapter };
		})();
		ready = created;
		return created;
	};

	return {
		executor: {
			execute: async (prompt: AgentMessage | AgentMessage[]) => {
				const { adapter } = await resolveReady();
				const result = await adapter.execute({ kind: "start", prompt });
				if (!result.ok) throw result.error;
				const value = result.value;
				if (value.kind === "suspended") throw new Error("Unexpected suspension in the semantic contract");
				const turn = value.turn;
				return {
					message: turn.message,
					toolResults: turn.toolResults,
					usage: turn.usage,
				};
			},
			abort: () => {
				void resolveReady().then(({ adapter }) => adapter.abort());
			},
		},
		providerRequestCount: () => providerRequests,
		firstProviderRequest: firstProviderRequest.promise,
	};
}

describeLeafTurnSemanticContract("HarnessV4LeafTurnAdapter semantic contract", createHarnessV4SemanticFixture);
