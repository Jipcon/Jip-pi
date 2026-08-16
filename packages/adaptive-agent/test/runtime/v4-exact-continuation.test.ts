import { type Api, createModels, fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AdaptiveRunBasisInput,
	AgentHarness,
	InMemorySessionRepo,
	type Session,
} from "../../../agent/src/harness-v4.ts";
import {
	computeToolCatalogFingerprint,
	createOriginCapsule,
	PermissiveToolPolicyAdapter,
	PROJECTOR_VERSION,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import type { LeafTurnCursor } from "../../src/runtime/leaf-turn-executor.ts";
import { type BundleFixtures, createBundleFixtures, makeFixedTools, originSnapshot } from "./stage5-fixtures.ts";
import { createStage6Source, userMessage } from "./stage6-fixtures.ts";

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

interface FreshStack {
	repo: InMemorySessionRepo;
	session: Session;
	faux: ReturnType<typeof fauxProvider>;
	models: ReturnType<typeof createModels>;
	model: Model<Api>;
	tools: ReturnType<typeof makeFixedTools>;
	fixtures: BundleFixtures;
	harness: AgentHarness<undefined>;
	basis: HarnessV4LeafTurnBasis;
}

/** Fresh harness with an idle lane; admission is up to the test. */
async function createFresh(id: string): Promise<FreshStack> {
	const repo = new InMemorySessionRepo({ now: () => 3_200_000_000_000 });
	const session = await repo.create({ id });
	const faux = fauxProvider({ provider: "admission", api: "admission-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const tools = makeFixedTools();
	const fixtures = await createBundleFixtures();
	const { harness } = await AgentHarness.create<undefined>({
		session,
		models,
		model,
		tools,
		activeToolNames: tools.map((tool) => tool.name),
		systemPrompt: "admission-system",
		adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
	});
	const basis = exactBasis(session.metadata.id, fixtures, tools);
	return { repo, session, faux, models, model, tools, fixtures, harness, basis };
}

describe("v4 zero-prompt exact-continuation admission", () => {
	it("atomically accepts a Run with empty promptEntryIds and no provider dispatch", async () => {
		const stack = await createFresh("admitted");
		const admitted = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput, {
			systemPromptOverride: "pinned-system",
		});
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) return;
		expect(admitted.value.runId).toBe(admitted.value.operationId);
		const operation = await stack.session.getRegister("op.meta", admitted.value.operationId);
		const intent = operation?.value.intent;
		expect(intent?.kind === "run" ? intent.promptEntryIds : undefined).toEqual([]);
		expect(intent?.kind === "run" ? intent.systemPromptOverride : undefined).toBe("pinned-system");
		const state = await stack.session.getRegister("op.state", admitted.value.operationId);
		expect(state?.value.kind === "run" ? state.value.phase : undefined).toMatchObject({
			kind: "checkpoint",
			continuation: { kind: "need_assistant" },
			triggerEntryId: admitted.value.basisEntryId,
		});
		const basisEntry = (await stack.session.getEntries([admitted.value.basisEntryId])).get(
			admitted.value.basisEntryId,
		);
		const basisData = basisEntry?.type === "custom" ? basisEntry.data : undefined;
		expect((basisData as { operationId?: string } | undefined)?.operationId).toBe(admitted.value.operationId);
		expect((basisData as { start?: unknown } | undefined)?.start).toMatchObject({ kind: "exact_continuation" });
		// No prompt entry was appended; the basis entry is the initial trigger.
		const messages = await stack.session.findEntries({ type: "message" });
		expect(messages).toHaveLength(0);
		expect(await stack.session.scanUsage({})).toEqual([]);
		expect(stack.faux.state.callCount).toBe(0);
		const open = await stack.harness.getOpenOperation();
		expect(open).toMatchObject({ operationId: admitted.value.operationId, kind: "run", turnCursor: null });
		await stack.harness.close();
	});

	it("dispatches exactly one provider request when the accepted Run advances", async () => {
		const stack = await createFresh("admitted-advance");
		const admitted = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput, {
			systemPromptOverride: "pinned-system",
		});
		if (!admitted.ok) throw new Error("admission failed");
		const adapter = new HarnessV4LeafTurnAdapter({ lane: stack.harness, basis: stack.basis });
		stack.faux.setResponses([fauxAssistantMessage("continuation reply")]);
		const advanced = await adapter.execute({ kind: "advance" });
		expect(advanced).toMatchObject({
			ok: true,
			value: {
				kind: "turn",
				turn: { message: { content: [{ text: "continuation reply" }] } },
				run: { kind: "settled", result: { kind: "completed" } },
			},
		});
		expect(stack.faux.state.callCount).toBe(1);
		const messages = await stack.session.findEntries({ type: "message" });
		expect(messages.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(0);
		expect(messages.filter((entry) => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(
			1,
		);
		expect(await stack.session.scanUsage({})).toHaveLength(1);
		await stack.harness.close();
	});

	it("rejects prompt starts and double admission", async () => {
		const stack = await createFresh("rejections");
		const promptStart = await stack.harness.acceptAdaptiveContinuation({
			...structuredClone(stack.basis),
			start: { kind: "prompt" },
		} as unknown as AdaptiveRunBasisInput);
		expect(promptStart).toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });

		const admitted = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput);
		expect(admitted.ok).toBe(true);
		const second = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput);
		expect(second).toMatchObject({ ok: false, error: { _tag: "LaneBusy" } });
		await stack.harness.close();
	});

	it("rejects admission over pending next-run queue items", async () => {
		const stack = await createFresh("queued");
		await stack.harness.nextRun(userMessage("queued work"));
		const admitted = await stack.harness.acceptAdaptiveContinuation(
			structuredClone(stack.basis) as unknown as AdaptiveRunBasisInput,
		);
		expect(admitted).toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });
		await stack.harness.close();
	});

	it("keeps a stable turn cursor guard across close and reopen", async () => {
		const stack = await createFresh("cursor-guard");
		const admitted = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput, {
			systemPromptOverride: "pinned-system",
		});
		if (!admitted.ok) throw new Error("admission failed");
		stack.faux.setResponses([fauxAssistantMessage("guarded reply")]);
		const metadata = structuredClone(stack.session.metadata);
		await stack.harness.close();

		const reopenedSession = await stack.repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create<undefined>({
			session: reopenedSession,
			models: stack.models,
			model: stack.model,
			tools: stack.tools,
			activeToolNames: stack.tools.map((tool) => tool.name),
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
				registry: stack.fixtures.registry,
				session: reopenedSession,
			}),
		});
		const reopenedAdapter = new HarnessV4LeafTurnAdapter({ lane: reopened, basis: stack.basis });
		const advanced = await reopenedAdapter.execute({ kind: "advance" });
		expect(advanced).toMatchObject({ ok: true, value: { kind: "turn" } });
		expect(stack.faux.state.callCount).toBe(1);
		if (!advanced.ok || advanced.value.kind !== "turn") throw new Error("expected a turn");
		const cursor: LeafTurnCursor = advanced.value.turn.cursor;
		const again = await reopenedAdapter.execute({ kind: "advance", afterCursor: cursor });
		expect(again).toMatchObject({ ok: false, error: { kind: "nothing_to_resume" } });
		await reopened.close();
	});
});

describe("v4 post-turn capture seam", () => {
	it("rejects capture without an open Run and for settled runs", async () => {
		const stack = await createFresh("capture-seam");
		const idle = await stack.harness.capturePostTurnCheckpoint(async () => "must not run");
		expect(idle).toMatchObject({ ok: false, error: { _tag: "NoActiveOperation" } });

		// A settled no-tool Run has no open operation: not branchable.
		const metadata = structuredClone(stack.session.metadata);
		await stack.harness.close();
		const reopenedSession = await stack.repo.open(metadata);
		const { harness: tooled } = await AgentHarness.create<undefined>({
			session: reopenedSession,
			models: stack.models,
			model: stack.model,
			tools: stack.tools,
			activeToolNames: stack.tools.map((tool) => tool.name),
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
				registry: stack.fixtures.registry,
				session: reopenedSession,
			}),
		});
		const tooledAdapter = new HarnessV4LeafTurnAdapter({ lane: tooled, basis: stack.basis });
		stack.faux.setResponses([fauxAssistantMessage([])]);
		const started = await tooledAdapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(started).toMatchObject({ ok: true, value: { kind: "turn", run: { kind: "settled" } } });
		const settled = await tooled.capturePostTurnCheckpoint(async () => "must not run");
		expect(settled).toMatchObject({ ok: false, error: { _tag: "NoActiveOperation" } });
		await tooled.close();
	});

	it("rejects capture when pending queue input exists", async () => {
		const stack = await createFresh("capture-queue");
		const admitted = await stack.harness.acceptAdaptiveContinuation(stack.basis as unknown as AdaptiveRunBasisInput);
		if (!admitted.ok) throw new Error("admission failed");
		await stack.harness.steer(userMessage("pending"));
		const captured = await stack.harness.capturePostTurnCheckpoint(async () => "must not run");
		expect(captured).toMatchObject({ ok: false, error: { _tag: "NotPostTurnCheckpoint" } });
		await stack.harness.close();
	});

	it("returns CheckpointChanged when the durable checkpoint moves during the callback", async () => {
		const source = await createStage6Source({ id: "stage6-changed" });
		const captured = await source.harness.capturePostTurnCheckpoint(async (info) => {
			// Simulate a concurrent writer bumping the operation state.
			const state = await source.session.getRegister("op.state", info.operationId);
			if (state !== undefined) {
				await source.session.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: state.key,
							value: structuredClone(state.value),
						},
					],
				});
			}
			return "captured";
		});
		expect(captured).toMatchObject({ ok: false, error: { _tag: "CheckpointChanged" } });
		await source.harness.close();
	});

	it("runs the callback under the lease and returns its value when nothing changed", async () => {
		const source = await createStage6Source({ id: "stage6-stable" });
		const captured = await source.harness.capturePostTurnCheckpoint(async (info) => ({
			operationId: info.operationId,
			leafId: info.turnCursor.leafId,
		}));
		expect(captured).toMatchObject({
			ok: true,
			value: { operationId: source.turn.cursor.operationId, leafId: source.turn.cursor.leafId },
		});
		await source.harness.close();
	});
});
