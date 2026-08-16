import {
	type Api,
	type Context,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type AdaptiveRunBasisInput, AgentHarness } from "../../../agent/src/harness-v4.ts";
import type { V4SessionRepo } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import { v4Backends } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import {
	computeToolCatalogFingerprint,
	createOriginCapsule,
	PermissiveToolPolicyAdapter,
	PROJECTOR_VERSION,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import { ADAPTIVE_RUN_BASIS_CUSTOM_TYPE } from "../../src/runtime/harness-v4-contract.ts";
import { type BundleFixtures, createBundleFixtures, makeFixedTools, originSnapshot } from "./stage5-fixtures.ts";

function exactBasis(
	sessionId: string,
	fixtures: BundleFixtures,
	tools: ReturnType<typeof makeFixedTools>,
): HarnessV4LeafTurnBasis {
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
		start: {
			kind: "exact_continuation",
			source: {
				parentSessionId: "parent-session",
				sourceCursor: { operationId: "source-op", assistantEntryId: "source-assistant", leafId: "source-leaf" },
			},
			contextFingerprint: "a".repeat(64),
			requestFingerprint: "b".repeat(64),
			fixedToolCatalogFingerprint: computeToolCatalogFingerprint(tools),
			sampling: { id: "v1" },
		},
	};
}

interface RecoveryStack {
	repo: V4SessionRepo;
	faux: FauxProviderHandle;
	open(): Promise<{ harness: AgentHarness<undefined>; adapter: HarnessV4LeafTurnAdapter; sessionId: string }>;
}

/** Cloneable projection of a provider context (tools carry functions). */
function projectContext(context: Context): {
	systemPrompt?: string;
	messages: Context["messages"];
	toolNames: string[];
} {
	return {
		...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
		messages: structuredClone(context.messages),
		toolNames: context.tools?.map((tool) => tool.name) ?? [],
	};
}

async function createStack(backend: ReturnType<typeof v4Backends>[number]): Promise<RecoveryStack> {
	const repo = backend.create({ now: () => 3_500_000_000_000 });
	const session = await repo.create({ id: `recovery-${backend.name}` });
	const faux = fauxProvider({ provider: `recovery-${backend.name}`, api: `recovery-${backend.name}-api` });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const tools = makeFixedTools();
	const fixtures = await createBundleFixtures();
	const basis = exactBasis(session.metadata.id, fixtures, tools);
	const { harness } = await AgentHarness.create<undefined>({
		session,
		models,
		model,
		tools,
		activeToolNames: tools.map((tool) => tool.name),
		adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
	});
	const admitted = await harness.acceptAdaptiveContinuation(basis as unknown as AdaptiveRunBasisInput, {
		systemPromptOverride: "pinned-system",
	});
	if (!admitted.ok) throw new Error(`admission failed: ${admitted.error._tag}`);
	await harness.close();
	return {
		repo,
		faux,
		open: async () => {
			const metadata = await repo.list();
			const reopenedSession = await repo.open(metadata[0]!);
			const { harness: reopened } = await AgentHarness.create<undefined>({
				session: reopenedSession,
				models,
				model,
				tools,
				activeToolNames: tools.map((tool) => tool.name),
				adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
					registry: fixtures.registry,
					session: reopenedSession,
				}),
			});
			return {
				harness: reopened,
				adapter: new HarnessV4LeafTurnAdapter({ lane: reopened, basis }),
				sessionId: metadata[0]!.id,
			};
		},
	};
}

describe.each(v4Backends())("v4 exact-continuation recovery ($name backend)", (backend) => {
	it("recovers after admission without re-admitting, appending prompts, or duplicating the basis", async () => {
		const stack = await createStack(backend);
		const { harness, adapter, sessionId } = await stack.open();
		const session = harness.durableSession;
		stack.faux.setResponses([fauxAssistantMessage("recovered reply")]);
		const advanced = await adapter.execute({ kind: "advance" });
		expect(advanced).toMatchObject({
			ok: true,
			value: { kind: "turn", turn: { message: { content: [{ text: "recovered reply" }] } } },
		});
		expect(stack.faux.state.callCount).toBe(1);
		const basisEntries = await session.findEntries({ type: "custom", customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE });
		expect(basisEntries).toHaveLength(1);
		const messages = await session.findEntries({ type: "message" });
		expect(messages.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(0);
		expect(messages.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(
			1,
		);
		expect(sessionId).toBe(harness.durableSession.metadata.id);
		await harness.close();
	});

	it("resumes an open continuation across crash boundaries with exactly one dispatch per turn", async () => {
		const stack = await createStack(backend);
		const contexts: Array<{ systemPrompt?: string; messages: Context["messages"]; toolNames: string[] }> = [];
		const first = await stack.open();
		stack.faux.setResponses([
			(context) => {
				contexts.push(projectContext(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: "b.txt" })], { stopReason: "toolUse" });
			},
		]);
		const firstTurn = await first.adapter.execute({ kind: "advance" });
		expect(firstTurn).toMatchObject({
			ok: true,
			value: { kind: "turn", turn: { toolResults: [{ toolName: "read", isError: false }] }, run: { kind: "open" } },
		});
		expect(stack.faux.state.callCount).toBe(1);
		await first.harness.close();

		// Crash boundary: the open Run survives in the durable session.
		const second = await stack.open();
		stack.faux.setResponses([
			(context) => {
				contexts.push(projectContext(context));
				return fauxAssistantMessage("finished after tool");
			},
		]);
		const secondTurn = await second.adapter.execute({ kind: "advance" });
		expect(secondTurn).toMatchObject({
			ok: true,
			value: { kind: "turn", run: { kind: "settled", result: { kind: "completed" } } },
		});
		expect(stack.faux.state.callCount).toBe(2);

		// The second request carried the complete committed prefix: tool call
		// plus its result, with no re-admission prompt in between.
		expect(contexts).toHaveLength(2);
		const secondContext = contexts[1]!;
		const toolResults = secondContext.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		const basisEntries = await second.harness.durableSession.findEntries({
			type: "custom",
			customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
		});
		expect(basisEntries).toHaveLength(1);
		const messages = await second.harness.durableSession.findEntries({ type: "message" });
		expect(messages.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(0);
		await second.harness.close();
	});

	it("recovers idempotently when reopened twice before any dispatch", async () => {
		const stack = await createStack(backend);
		const first = await stack.open();
		await first.harness.close();
		const second = await stack.open();
		await second.harness.close();
		const third = await stack.open();
		stack.faux.setResponses([fauxAssistantMessage("only once")]);
		const advanced = await third.adapter.execute({ kind: "advance" });
		expect(advanced).toMatchObject({ ok: true, value: { kind: "turn" } });
		expect(stack.faux.state.callCount).toBe(1);
		const basisEntries = await third.harness.durableSession.findEntries({
			type: "custom",
			customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
		});
		expect(basisEntries).toHaveLength(1);
		await third.harness.close();
	});
});
