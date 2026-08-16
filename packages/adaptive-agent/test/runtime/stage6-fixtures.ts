import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import {
	AgentHarness,
	type AgentHarnessOptions,
	InMemorySessionRepo,
	type Session,
} from "../../../agent/src/harness-v4.ts";
import type { V4SessionRepo } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import {
	BranchContinuation,
	type BranchContinuationOptions,
	type ContinuationCheckpoint,
	type CreateChildHarness,
	createOriginCapsule,
	type ExactRequestProfile,
	MemoryWorkspaceAdapter,
	PermissiveToolPolicyAdapter,
	PROJECTOR_VERSION,
} from "../../src/index.ts";
import type { WorkspaceMetadata } from "../../src/runtime/candidate-policy-state.ts";
import {
	type CaptureCheckpointInput,
	captureContinuationCheckpoint,
} from "../../src/runtime/continuation-checkpoint.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import type { LeafTurnResult } from "../../src/runtime/leaf-turn-executor.ts";
import { CandidateStateProjector } from "../../src/runtime/state-projector.ts";
import { type BundleFixtures, createBundleFixtures, makeFixedTools, originSnapshot } from "./stage5-fixtures.ts";

export function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export const DEFAULT_PROFILE: ExactRequestProfile = {
	hookProfileVersion: "hooks-v1",
	resourceProfileVersion: "resources-v1",
	sampling: { temperature: 0.7, topP: 0.9, maxTokens: 4096 },
	seedCapable: false,
	contextPolicy: { version: "context-v1", projectionPolicy: "no-custom-projectors", compactionState: "none" },
};

export const WORKSPACE_METADATA: WorkspaceMetadata = {
	files: [
		{ path: "readme.md", size: 10, mtimeMs: 1000, hash: "a".repeat(64) },
		{ path: "src/main.ts", size: 42, mtimeMs: 2000, hash: "b".repeat(64) },
	],
};

export function promptBasis(sessionId: string, fixtures: BundleFixtures): HarnessV4LeafTurnBasis {
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

export interface Stage6Source {
	repo: V4SessionRepo;
	session: Session;
	harness: AgentHarness<undefined>;
	faux: FauxProviderHandle;
	models: Models;
	model: Model<Api>;
	tools: AgentTool[];
	fixtures: BundleFixtures;
	turn: LeafTurnResult;
	checkpoint: ContinuationCheckpoint;
	workspacePort: MemoryWorkspaceAdapter;
	projector: CandidateStateProjector;
	systemPrompt: string;
}

export interface Stage6SourceOptions {
	id?: string;
	systemPrompt?: string;
	profile?: ExactRequestProfile;
	tools?: AgentTool[];
	activeToolNames?: string[];
	repo?: V4SessionRepo;
	response?: ReturnType<typeof fauxAssistantMessage>;
}

/** Drives one adaptive tool turn, then captures a branchable checkpoint. */
export async function createStage6Source(options: Stage6SourceOptions = {}): Promise<Stage6Source> {
	const now = (): number => 3_100_000_000_000;
	const repo = options.repo ?? new InMemorySessionRepo({ now });
	const session = await repo.create({ id: options.id ?? "stage6-source" });
	const faux = fauxProvider({ provider: "stage6", api: "stage6-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const tools = options.tools ?? makeFixedTools();
	const fixtures = await createBundleFixtures();
	const systemPrompt = options.systemPrompt ?? "stage6-system";
	const { harness } = await AgentHarness.create<undefined>({
		session,
		models,
		model,
		tools,
		activeToolNames: options.activeToolNames ?? tools.map((tool) => tool.name),
		systemPrompt,
		adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
	});
	const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: promptBasis(session.metadata.id, fixtures) });
	faux.setResponses([
		options.response ?? fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
	]);
	const started = await adapter.execute({ kind: "start", prompt: userMessage("read a.txt") });
	if (!started.ok || started.value.kind !== "turn") {
		throw new Error(`Source turn did not yield: ${started.ok ? started.value.kind : started.error.kind}`);
	}
	const turn = started.value.turn;
	const projector = new CandidateStateProjector({ registry: fixtures.registry });
	const workspacePort = new MemoryWorkspaceAdapter();
	const captured = await captureContinuationCheckpoint({
		lane: harness,
		session: harness.durableSession,
		projector,
		workspacePort,
		workspaceMetadata: WORKSPACE_METADATA,
		logicalRoot: "/workspace",
		tools,
		systemPrompt,
		streamOptions: await harness.getStreamOptions(),
		profile: options.profile ?? DEFAULT_PROFILE,
		entryProjectors: {},
	} satisfies CaptureCheckpointInput);
	if (!captured.ok) {
		const name = "name" in captured.error ? captured.error.name : captured.error.kind;
		throw new Error(`Checkpoint capture failed: ${name}: ${captured.error.message}`);
	}
	return {
		repo,
		session,
		harness,
		faux,
		models,
		model,
		tools,
		fixtures,
		turn,
		checkpoint: captured.value,
		workspacePort,
		projector,
		systemPrompt,
	};
}

export interface ChildHarnessFactoryOptions {
	models: Models;
	model: Model<Api>;
	tools: AgentTool[];
	registry: BundleFixtures["registry"];
	extraOptions?: (session: Session) => Partial<AgentHarnessOptions<undefined>>;
	afterCreate?: (
		harness: AgentHarness<undefined>,
		session: Session,
		variant: { id: string; seed?: number },
	) => void | Promise<void>;
}

export function createChildHarnessFactory(options: ChildHarnessFactoryOptions): CreateChildHarness {
	return async ({ session, checkpoint, environment, gate, variant }) => {
		void environment;
		const { harness } = await AgentHarness.create<undefined>({
			session,
			models: options.models,
			model: options.model,
			tools: options.tools,
			activeToolNames: options.tools.map((tool) => tool.name),
			systemPrompt: checkpoint.resolvedSystemPrompt,
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: options.registry, session }),
			exactContinuationDispatchGate: gate,
			...(options.extraOptions?.(session) ?? {}),
		});
		try {
			await options.afterCreate?.(harness, session, variant);
		} catch (error) {
			await harness.close().catch(() => undefined);
			throw error;
		}
		return { lane: harness, close: () => harness.close() };
	};
}

export function createBranchContinuation(
	options: Omit<BranchContinuationOptions, "createChildHarness"> & {
		childHarness: ChildHarnessFactoryOptions;
	},
): BranchContinuation {
	return new BranchContinuation({
		journal: options.journal,
		workspacePort: options.workspacePort,
		sessionRepo: options.sessionRepo,
		createChildHarness: createChildHarnessFactory(options.childHarness),
	});
}
