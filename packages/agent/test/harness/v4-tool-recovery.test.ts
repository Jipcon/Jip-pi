import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	AdaptiveToolPolicyAdapter,
	computeToolCatalogFingerprint,
	createOriginCapsule,
	fingerprintState,
	InMemoryPolicyRegistry,
	PermissiveToolPolicyAdapter,
	PROJECTOR_VERSION,
} from "../../../adaptive-agent/src/index.ts";
import {
	adaptiveBundle,
	type BundleFixtures,
	createBundleFixtures,
	originSnapshot,
} from "../../../adaptive-agent/test/runtime/stage5-fixtures.ts";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import {
	type AdaptiveRunBasisInput,
	type AdaptiveToolBatchClearance,
	AgentHarness,
	type AgentToolResult,
	type Session,
} from "../../src/harness-v4.ts";
import type { AgentMessage } from "../../src/types.ts";
import { type V4SessionRepo, v4Backends } from "./fixtures/v4-jsonl-backends.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function okResult(text: string, extra: Partial<AgentToolResult<unknown>> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {}, ...extra };
}

function makeTool(
	name: string,
	options: {
		replay?: "never" | "safe";
		execute?: (params: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
	} = {},
): AgentHarnessTool<undefined> {
	return {
		name,
		description: `${name} tool`,
		label: name,
		parameters: Type.Object({ path: Type.String() }),
		...(options.replay === undefined ? {} : { replay: options.replay }),
		execute: options.execute
			? async (_id, params) => options.execute!(params as Record<string, unknown>)
			: async () => okResult(`${name} ran`),
	};
}

function basis(sessionId: string, fixtures: BundleFixtures): AdaptiveRunBasisInput {
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
	} as unknown as AdaptiveRunBasisInput;
}

async function createRuntimeWithRepo(
	repo: V4SessionRepo,
	options: {
		drive?: "automatic" | "manual";
		tools?: AgentHarnessTool<undefined>[];
		activeToolNames?: string[];
		adaptive?: boolean;
		policy?: (session: Session) => AdaptiveToolBatchClearance;
		id?: string;
	} = {},
) {
	const faux = fauxProvider({ provider: "r4r-provider", api: "r4r-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const session = await repo.create({ id: options.id ?? `r4r-${options.drive ?? "auto"}` });
	const tools = options.tools ?? [];
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(tools.length === 0 ? {} : { tools }),
		...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
		...(options.policy === undefined ? {} : { adaptiveToolPolicy: options.policy(session) }),
	});
	return { faux, harness, model, models, repo, session };
}

function settledValue<TValue>(result: { ok: true; value: TValue } | { ok: false; error: unknown }): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

interface ManualHarness {
	peekAction(): Promise<{ kind: string } | undefined>;
	executeAction(): Promise<{ kind: string } | undefined>;
}

async function advance(harness: ManualHarness, kinds: string[]): Promise<void> {
	for (const kind of kinds) {
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe(kind));
		expect((await harness.executeAction())?.kind).toBe(kind);
	}
}

describe.each(v4Backends())("Harness v4 R4 tool recovery ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 1_950_000_000_000 }), options);
	}

	it("re-prepares a restored planned call without replaying any side effect", async () => {
		const executed: string[] = [];
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [
				makeTool("read", {
					execute: async () => {
						executed.push("read");
						return okResult("read ran");
					},
				}),
			],
			activeToolNames: ["read"],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		// checkpoint -> ready
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		// ready -> effect_pending (generation intent)
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		await harness.executeAction();
		// generation effect
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		await harness.executeAction();
		// generation settlement parks; the durable state is the tools phase with a planned call
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_effect_settlement"));
		await harness.executeAction();
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_tool_intent"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(executed).toEqual([]);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [
				makeTool("read", {
					execute: async () => {
						executed.push("read");
						return okResult("read ran");
					},
				}),
			],
			activeToolNames: ["read"],
		});
		expect(executed).toEqual([]);
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "done" }] } });
		expect(executed).toEqual(["read"]);
		await reopened.close();
	});

	it("writes a synthetic interrupted result for a restored effect_pending call with replay never", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [makeTool("read")],
			activeToolNames: ["read"],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await advance(harness, [
			"commit_transition",
			"commit_transition",
			"assistant",
			"commit_effect_settlement",
			"commit_tool_intent",
		]);
		// effect_pending durable with the tool effect parked: crash before dispatch completes
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("tool"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [makeTool("read")],
			activeToolNames: ["read"],
		});
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "done" }] } });
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const interrupted = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.content as { text: string }[])[0]?.text.includes("interrupted before settlement"),
		);
		expect(interrupted).toBeDefined();
		await reopened.close();
	});

	it("replays a safe/safe effect under the original reserved result id", async () => {
		const executed: string[] = [];
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [
				makeTool("read", {
					replay: "safe",
					execute: async () => {
						executed.push("read");
						return okResult("read ran");
					},
				}),
			],
			activeToolNames: ["read"],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await advance(harness, [
			"commit_transition",
			"commit_transition",
			"assistant",
			"commit_effect_settlement",
			"commit_tool_intent",
		]);
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("tool"));
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId as string;
		const opState = await harness.durableSession.getRegister("op.state", operationId);
		const calls =
			opState?.value.kind === "run" && opState.value.phase.kind === "tools" ? opState.value.phase.batch.calls : [];
		const pendingCall = calls.find((call) => call.status === "effect_pending");
		if (pendingCall?.status !== "effect_pending") throw new Error("Expected an effect_pending call");
		const reservedId = pendingCall.resultEntryId;
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [
				makeTool("read", {
					replay: "safe",
					execute: async () => {
						executed.push("read");
						return okResult("read ran");
					},
				}),
			],
			activeToolNames: ["read"],
		});
		const events: string[] = [];
		reopened.events.on("tool_start", (event) => {
			if (event.recovery === true) events.push("tool_start");
		});
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "completed" });
		expect(executed).toEqual(["read"]);
		await vi.waitFor(() => expect(events).toEqual(["tool_start"]));
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]?.id).toBe(reservedId);
		await reopened.close();
	});

	it("refuses replay when the current declaration changed to never", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [makeTool("read", { replay: "safe" })],
			activeToolNames: ["read"],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await advance(harness, [
			"commit_transition",
			"commit_transition",
			"assistant",
			"commit_effect_settlement",
			"commit_tool_intent",
		]);
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("tool"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		// Declaration changed: safe -> never. No replay.
		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [makeTool("read", { replay: "never" })],
			activeToolNames: ["read"],
		});
		const resumed = settledValue(await reopened.resume());
		expect(resumed).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "done" }] } });
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const interrupted = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.content as { text: string }[])[0]?.text.includes("interrupted before settlement"),
		);
		expect(interrupted).toBeDefined();
		await reopened.close();
	});

	it("keeps the original turnId and recovery flag on replayed tool events", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [makeTool("read", { replay: "safe" })],
			activeToolNames: ["read"],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.prompt("hello");
		await advance(harness, [
			"commit_transition",
			"commit_transition",
			"assistant",
			"commit_effect_settlement",
			"commit_tool_intent",
		]);
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("tool"));
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId as string;
		const opState = await harness.durableSession.getRegister("op.state", operationId);
		const turnId =
			opState?.value.kind === "run" && opState.value.phase.kind === "tools"
				? opState.value.phase.batch.turnId
				: undefined;
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [makeTool("read", { replay: "safe" })],
			activeToolNames: ["read"],
		});
		const observed: Array<{ turnId: string; recovery: boolean | undefined }> = [];
		reopened.events.on("tool_start", (event) => {
			observed.push({ turnId: event.turnId, recovery: event.recovery });
		});
		settledValue(await reopened.resume());
		await vi.waitFor(() => expect(observed).toEqual([{ turnId, recovery: true }]));
		await reopened.close();
	});
});

describe.each(v4Backends())("Harness v4 R4 adaptive tool batches ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 1_950_000_000_000 }), options);
	}

	it("stores clearance and effective args in one adaptive.tool_batch entry without op.tool_args", async () => {
		const fixtures = await createBundleFixtures();
		const { faux, harness, session } = await createRuntime({
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptive: true,
			policy: (policySession) =>
				new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session: policySession }),
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const value = settledValue(
			await harness.promptAdaptive(userMessage("hello"), basis(session.metadata.id, fixtures)),
		);
		expect(value).toMatchObject({ kind: "completed" });
		const batchEntry = await session.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
		expect(batchEntry).toMatchObject({
			type: "custom",
			customType: "adaptive.tool_batch",
			data: {
				schemaVersion: 1,
				policyStateFingerprint: fingerprintState(originSnapshot(fixtures.permissiveBundle)),
				decisions: [
					{
						kind: "allow",
						sourceIndex: 0,
						toolName: "read",
						effectiveArgs: { path: "x" },
						replay: "never",
					},
				],
			},
		});
		expect(await harness.durableSession.listRegisters("op.tool_args")).toHaveLength(0);
		expect(batchEntry?.parentId).toBeDefined();
		await harness.close();
	});

	it("executes guarded effective args and blocks per the adaptive policy", async () => {
		const executed: string[] = [];
		const tools = [
			makeTool("read", {
				execute: async (params) => {
					executed.push(`read:${params.path}`);
					return okResult(`read ${params.path}`);
				},
			}),
			makeTool("write"),
			makeTool("edit"),
			makeTool("bash"),
		];
		const catalogFingerprint = computeToolCatalogFingerprint(tools as unknown as AgentTool[]);
		const registry = new InMemoryPolicyRegistry();
		const bundle = adaptiveBundle(catalogFingerprint);
		const ref = await registry.publish(bundle);
		const fixtures: BundleFixtures = {
			registry,
			permissive: ref,
			adaptive: ref,
			permissiveBundle: bundle,
			adaptiveBundle: bundle,
			catalogFingerprint,
		};
		const { faux, harness, session } = await createRuntime({
			tools,
			activeToolNames: ["read", "write", "edit", "bash"],
			adaptive: true,
			policy: (policySession) =>
				new AdaptiveToolPolicyAdapter({
					registry,
					session: policySession,
					workspaceRoot: "C:/pi-adaptive-workspace",
				}),
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "sub/../a" }), fauxToolCall("write", { path: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.promptAdaptive(userMessage("hello"), basis(session.metadata.id, fixtures)));
		expect(executed).toEqual(["read:a"]);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ message: { toolName: "read", isError: false } });
		expect(results[1]).toMatchObject({
			message: { toolName: "write", isError: true, content: [{ text: "writes are disabled by policy" }] },
		});
		expect(await harness.durableSession.listRegisters("op.tool_args")).toHaveLength(0);
		await harness.close();
	});

	it("fails closed with blocked results when no clearance adapter is configured", async () => {
		const fixtures = await createBundleFixtures();
		const { faux, harness, session } = await createRuntime({
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptive: true,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		settledValue(await harness.promptAdaptive(userMessage("hello"), basis(session.metadata.id, fixtures)));
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const results = branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			message: { isError: true, content: [{ text: expect.stringContaining("clearance adapter") }] },
		});
		expect(faux.state.callCount).toBe(2);
		await harness.close();
	});

	it("re-runs clearance after a crash before the entry commit and never after it", async () => {
		const fixtures = await createBundleFixtures();
		let clearances = 0;
		const countingPolicy = (policySession: Session): AdaptiveToolBatchClearance => {
			const policy = new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session: policySession });
			const original = policy.clearBatch.bind(policy);
			policy.clearBatch = async (input) => {
				clearances++;
				return original(input);
			};
			return policy;
		};
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptive: true,
			policy: countingPolicy,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.promptAdaptive(userMessage("hello"), basis(session.metadata.id, fixtures));
		await advance(harness, ["commit_transition", "commit_transition", "assistant", "commit_effect_settlement"]);
		// clearance parked next: crash before the entry commit
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("hook"));
		expect(clearances).toBe(0);
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptiveToolPolicy: countingPolicy(reopenedSession),
		});
		settledValue(await reopened.resume());
		expect(clearances).toBe(1);
		const batchEntry = await reopenedSession.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
		expect(batchEntry).toBeDefined();
		await reopened.close();

		// Reopen once more: the committed entry must be read, not re-cleared.
		const finalSession = await repo.open(structuredClone(session.metadata));
		const { harness: finalHarness } = await AgentHarness.create({
			session: finalSession,
			models,
			model,
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptiveToolPolicy: countingPolicy(finalSession),
		});
		await finalHarness.resume();
		expect(clearances).toBe(1);
		await finalHarness.close();
	});

	it("interrupts adaptive effects with replay never across reopen", async () => {
		const fixtures = await createBundleFixtures();
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptive: true,
			policy: (policySession) =>
				new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session: policySession }),
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const pending = harness.promptAdaptive(userMessage("hello"), basis(session.metadata.id, fixtures));
		await advance(harness, [
			"commit_transition",
			"commit_transition",
			"assistant",
			"commit_effect_settlement",
			"hook",
			"commit_adaptive_batch",
		]);
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("tool"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			tools: [makeTool("read")],
			activeToolNames: ["read"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session: reopenedSession }),
		});
		settledValue(await reopened.resume());
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const interrupted = branch.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.content as { text: string }[])[0]?.text.includes("interrupted before settlement"),
		);
		expect(interrupted).toBeDefined();
		await reopened.close();
	});
});
