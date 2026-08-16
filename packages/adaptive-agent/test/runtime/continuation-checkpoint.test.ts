import { type Api, createModels, fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentHarness, InMemorySessionRepo } from "../../../agent/src/harness-v4.ts";
import {
	computeToolCatalogFingerprint,
	MemoryWorkspaceAdapter,
	MissingIdentitiesError,
	NonDeterministicRequestPolicyError,
	NotBranchableCheckpointError,
	PermissiveToolPolicyAdapter,
	SourceCheckpointChangedError,
} from "../../src/index.ts";
import {
	type CaptureCheckpointInput,
	captureContinuationCheckpoint,
} from "../../src/runtime/continuation-checkpoint.ts";
import {
	UnsupportedWorkspaceError,
	type WorkspaceContinuationPort,
	workspaceSnapshotId,
} from "../../src/runtime/execution-environment.ts";
import { HarnessV4LeafTurnAdapter } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import { InMemoryPolicyRegistry } from "../../src/runtime/policy-registry.ts";
import { CandidateStateProjector } from "../../src/runtime/state-projector.ts";
import { createBundleFixtures, makeFixedTools } from "./stage5-fixtures.ts";
import {
	createStage6Source,
	DEFAULT_PROFILE,
	promptBasis,
	userMessage,
	WORKSPACE_METADATA,
} from "./stage6-fixtures.ts";

describe("captureContinuationCheckpoint", () => {
	it("captures an immutable branchable checkpoint at the post-tool-batch boundary", async () => {
		const source = await createStage6Source();
		const checkpoint = source.checkpoint;
		expect(checkpoint.sourceSessionId).toBe(source.session.metadata.id);
		expect(checkpoint.sourceLane).toBe("main");
		expect(checkpoint.cursor).toEqual(source.turn.cursor);
		expect(checkpoint.workspaceSnapshotId).toBe(workspaceSnapshotId("/workspace", WORKSPACE_METADATA));
		expect(checkpoint.logicalWorkspace).toEqual({
			root: "/workspace",
			contentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(checkpoint.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(checkpoint.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(checkpoint.requestFingerprint).not.toBe(checkpoint.contextFingerprint);
		expect(checkpoint.fixedToolCatalogFingerprint).toBe(computeToolCatalogFingerprint(source.tools));
		expect(checkpoint.policyState.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(checkpoint.policyState.basis.cursor).toEqual({ kind: "post_turn", cursor: source.turn.cursor });
		expect(checkpoint.model).toEqual({ provider: "stage6", modelId: "faux-1" });
		expect(checkpoint.resolvedSystemPrompt).toBe("stage6-system");
		expect(checkpoint.profile).toEqual(DEFAULT_PROFILE);
		await source.harness.close();
	});

	it("rejects a settled no-tool leaf as not branchable", async () => {
		const repo = new InMemorySessionRepo({ now: () => 3_150_000_000_000 });
		const session = await repo.create({ id: "settled-source" });
		const faux = fauxProvider({ provider: "settled", api: "settled-api" });
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
			systemPrompt: "settled-system",
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({
			lane: harness,
			basis: promptBasis(session.metadata.id, fixtures),
		});
		faux.setResponses([fauxAssistantMessage("all done, no tools")]);
		const started = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(started).toMatchObject({ ok: true, value: { kind: "turn", run: { kind: "settled" } } });
		const captured = await captureContinuationCheckpoint({
			lane: harness,
			session,
			projector: new CandidateStateProjector({ registry: fixtures.registry }),
			workspacePort: new MemoryWorkspaceAdapter(),
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools,
			systemPrompt: "settled-system",
			streamOptions: await harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(NotBranchableCheckpointError);
		await harness.close();
	});

	it("rejects a deferred suspension as not branchable", async () => {
		const repo = new InMemorySessionRepo({ now: () => 3_150_000_000_000 });
		const session = await repo.create({ id: "deferred-source" });
		const faux = fauxProvider({ provider: "deferred", api: "deferred-api" });
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
			systemPrompt: "deferred-system",
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
		});
		const adapter = new HarnessV4LeafTurnAdapter({
			lane: harness,
			basis: promptBasis(session.metadata.id, fixtures),
		});
		faux.setResponses([
			fauxAssistantMessage("later", {
				stopReason: "deferred",
				deferred: { provider: "deferred", modelId: "faux-1", api: "deferred-api", id: "deferred-id" },
			}),
		]);
		const started = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		expect(started).toMatchObject({ ok: true, value: { kind: "suspended" } });
		const captured = await captureContinuationCheckpoint({
			lane: harness,
			session,
			projector: new CandidateStateProjector({ registry: fixtures.registry }),
			workspacePort: new MemoryWorkspaceAdapter(),
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools,
			systemPrompt: "deferred-system",
			streamOptions: await harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(NotBranchableCheckpointError);
		await harness.close();
	});

	it("rejects a checkpoint with pending queue input", async () => {
		const source = await createStage6Source();
		await source.harness.steer(userMessage("extra input"));
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: source.workspacePort,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(NotBranchableCheckpointError);
		await source.harness.close();
	});

	it("fails closed on custom message transforms and custom entry projectors", async () => {
		const source = await createStage6Source();
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: source.workspacePort,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
			customMessageTransform: true,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(NonDeterministicRequestPolicyError);

		const projected = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: source.workspacePort,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
			entryProjectors: { custom: () => undefined },
		});
		expect(projected.ok).toBe(false);
		if (projected.ok) return;
		expect(projected.error).toBeInstanceOf(NonDeterministicRequestPolicyError);
		await source.harness.close();
	});

	it("rejects when the workspace cannot be isolated", async () => {
		const source = await createStage6Source();
		const unsupported: WorkspaceContinuationPort = {
			snapshot: async () => {
				throw new UnsupportedWorkspaceError("no isolation capability");
			},
			fork: async () => {
				throw new UnsupportedWorkspaceError("no isolation capability");
			},
		};
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: unsupported,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(NotBranchableCheckpointError);
		await source.harness.close();
	});

	it("returns SourceCheckpointChanged when the source cursor changes during capture", async () => {
		const source = await createStage6Source();
		const racyPort = new MemoryWorkspaceAdapter();
		const originalSnapshot = racyPort.snapshot.bind(racyPort);
		racyPort.snapshot = async (metadata, logicalRoot) => {
			// A concurrent writer commits an op.state write mid-capture: the
			// durable seq moves while the capture callback is still running.
			const state = await source.session.getRegister("op.state", source.turn.cursor.operationId);
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
			return originalSnapshot(metadata, logicalRoot);
		};
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: racyPort,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(SourceCheckpointChangedError);
		await source.harness.close();
	});

	it("rejects missing policy identities with MissingIdentities", async () => {
		const source = await createStage6Source();
		const emptyProjector = new CandidateStateProjector({ registry: new InMemoryPolicyRegistry() });
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: emptyProjector,
			workspacePort: source.workspacePort,
			workspaceMetadata: WORKSPACE_METADATA,
			logicalRoot: "/workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		} satisfies CaptureCheckpointInput);
		expect(captured.ok).toBe(false);
		if (captured.ok) return;
		expect(captured.error).toBeInstanceOf(MissingIdentitiesError);
		await source.harness.close();
	});

	it("captures a different context fingerprint for a different logical workspace", async () => {
		const source = await createStage6Source({ id: "stage6-source-ws" });
		const captured = await captureContinuationCheckpoint({
			lane: source.harness,
			session: source.session,
			projector: source.projector,
			workspacePort: source.workspacePort,
			workspaceMetadata: { files: [] },
			logicalRoot: "/other-workspace",
			tools: source.tools,
			systemPrompt: source.systemPrompt,
			streamOptions: await source.harness.getStreamOptions(),
			profile: DEFAULT_PROFILE,
		});
		expect(captured.ok).toBe(true);
		if (!captured.ok) return;
		expect(captured.value.contextFingerprint).not.toBe(source.checkpoint.contextFingerprint);
		expect(captured.value.logicalWorkspace.root).toBe("/other-workspace");
		await source.harness.close();
	});
});
