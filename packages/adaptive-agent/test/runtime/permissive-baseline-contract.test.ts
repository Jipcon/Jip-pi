import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import {
	type AdaptiveToolBatchClearance,
	type AdaptiveToolClearanceInput,
	type AdaptiveToolClearanceResult,
	AgentHarness,
	InMemorySessionRepo,
} from "../../../agent/src/harness-v4.ts";
import { createOriginCapsule, PermissiveToolPolicyAdapter, PROJECTOR_VERSION } from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import {
	createAssistantMessage,
	createDeferred,
	describeLeafTurnSemanticContract,
	type LeafTurnSemanticFixtureOptions,
} from "./leaf-turn-semantic-contract.ts";
import { createBundleFixtures, originSnapshot } from "./stage5-fixtures.ts";

/**
 * The permissive baseline runs the shared LeafTurn semantic contract through
 * the real Registry + CandidateStateProjector: no fixed fake fingerprint, but
 * the same model-visible execution semantics as the legacy path. The legacy
 * beforeToolCall block seam maps onto a clearance block, exactly like the
 * Harness v4 semantic fixture.
 */
function createPermissiveBaselineFixture(options: LeafTurnSemanticFixtureOptions) {
	const faux = fauxProvider({ provider: "permissive-v4", api: "permissive-v4-api" });
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

	let ready: Promise<HarnessV4LeafTurnAdapter> | undefined;
	const resolveReady = (): Promise<HarnessV4LeafTurnAdapter> => {
		if (ready !== undefined) return ready;
		const created = (async (): Promise<HarnessV4LeafTurnAdapter> => {
			const repo = new InMemorySessionRepo({ now: () => 2_150_000_000_000 });
			const session = await repo.create({ id: "permissive-v4" });
			const fixtures = await createBundleFixtures();
			const tools = (options.tools ?? []) as unknown as AgentHarnessTool<undefined>[];
			const permissive = new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session });
			const policy: AdaptiveToolBatchClearance = {
				clearBatch: async (input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult> => {
					const result = await permissive.clearBatch(input);
					for (const { sourceIndex, call } of input.calls) {
						const blocked = await options.beforeToolCall?.(
							call as never,
							structuredClone(call.arguments) as never,
						);
						if (blocked?.block !== undefined) {
							result.decisions[sourceIndex] = {
								kind: "block",
								sourceIndex,
								toolCallId: call.id,
								toolName: call.name,
								replay: "never",
								reason: String((blocked as { reason?: string }).reason ?? "blocked"),
							};
						}
					}
					return result;
				},
			};
			const { harness } = await AgentHarness.create<undefined>({
				session,
				models,
				model,
				tools,
				activeToolNames: tools.map((tool) => tool.name),
				toolExecution: options.toolExecution,
				adaptiveToolPolicy: policy,
			});
			const basis: HarnessV4LeafTurnBasis = {
				schemaVersion: 1,
				taskId: "task",
				candidateId: "candidate",
				policyBundle: fixtures.permissive,
				projectorVersion: PROJECTOR_VERSION,
				inheritedPolicyState: createOriginCapsule({
					taskId: "task",
					candidateId: "candidate",
					sessionId: session.metadata.id,
					lane: "main",
					policyBundle: fixtures.permissive,
					snapshot: originSnapshot(fixtures.permissiveBundle),
				}),
				start: { kind: "prompt" },
			};
			return new HarnessV4LeafTurnAdapter({ lane: harness, basis });
		})();
		ready = created;
		return created;
	};

	return {
		executor: {
			execute: async (prompt: AgentMessage | AgentMessage[]) => {
				const adapter = await resolveReady();
				const result = await adapter.execute({ kind: "start", prompt });
				if (!result.ok) throw result.error;
				const value = result.value;
				if (value.kind === "suspended") throw new Error("Unexpected suspension in the semantic contract");
				const turn = value.turn;
				return { message: turn.message, toolResults: turn.toolResults, usage: turn.usage };
			},
			abort: () => {
				void resolveReady().then((adapter) => adapter.abort());
			},
		},
		providerRequestCount: () => providerRequests,
		firstProviderRequest: firstProviderRequest.promise,
	};
}

describeLeafTurnSemanticContract(
	"PermissiveToolPolicyAdapter baseline semantic contract",
	createPermissiveBaselineFixture,
);
