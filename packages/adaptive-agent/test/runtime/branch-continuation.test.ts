import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionRepo } from "../../../agent/src/harness-v4.ts";
import {
	type ContinuationCheckpoint,
	ContinuationGroupFault,
	exactContinuationGroupId,
	MemoryContinuationJournal,
	NotBranchableCheckpointError,
	StateProjectionMismatch,
	UnsupportedSamplingControlError,
	WorkspaceSnapshotMismatchError,
} from "../../src/index.ts";
import type { WorkspaceContinuationPort } from "../../src/runtime/execution-environment.ts";
import { ADAPTIVE_RUN_BASIS_CUSTOM_TYPE } from "../../src/runtime/harness-v4-contract.ts";
import {
	createBranchContinuation,
	createStage6Source,
	DEFAULT_PROFILE,
	type Stage6Source,
	userMessage,
} from "./stage6-fixtures.ts";

function tamper(source: Stage6Source, mutate: (checkpoint: ContinuationCheckpoint) => void): ContinuationCheckpoint {
	const checkpoint = structuredClone(source.checkpoint);
	mutate(checkpoint);
	return checkpoint;
}

function customDataOf(entry: unknown): Record<string, unknown> {
	if (typeof entry !== "object" || entry === null || (entry as { type?: unknown }).type !== "custom") {
		throw new Error("expected a custom entry");
	}
	return ((entry as { data?: unknown }).data ?? {}) as Record<string, unknown>;
}

interface BasisRecordView {
	start?: {
		sampling?: { id?: string; seed?: number };
		contextFingerprint?: string;
		requestFingerprint?: string;
	};
	inheritedPolicyState?: { fingerprint?: string };
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

describe("session fork seam with a source lane", () => {
	it("forks an entries-only idle child from a non-main source lane", async () => {
		const repo = new InMemorySessionRepo({ now: () => 3_600_000_000_000 });
		const session = await repo.create({ id: "lane-source" });
		await session.commit({
			writes: [
				{
					kind: "entry",
					entry: { id: "side-root", parentId: null, type: "message", message: userMessage("side work") },
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "side", value: "side-root" },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "side",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "side",
					value: {
						model: { provider: "stage6", modelId: "faux-1" },
						thinkingLevel: "off",
						activeToolNames: ["read"],
					},
				},
				{ kind: "register", op: "set", namespace: "fact.label", key: "side-root", value: "side-label" },
			],
		});
		const child = await repo.fork(session.metadata, {
			scope: "branch",
			lane: "side",
			entryId: "side-root",
			position: "at",
			id: "lane-child",
		});
		expect(await child.getRegister("lane.leaf", "side")).toMatchObject({ value: "side-root" });
		expect(await child.getRegister("lane.state", "side")).toMatchObject({
			value: { currentOperationId: null, pendingNextRun: [] },
		});
		expect(await child.getRegister("lane.config", "side")).toBeDefined();
		expect(await child.getRegister("lane.config", "main")).toBeUndefined();
		expect(await child.getEntry("side-root")).toMatchObject({ type: "message" });
		expect(await child.getLabel("side-root")).toBe("side-label");
		expect(await child.scanUsage({})).toEqual([]);
		// The main lane stays the fresh initial lane, untouched by the fork.
		expect(await child.getLeafId()).toBeNull();
		await session.close();
		await child.close();
	});
});

describe("BranchContinuation.forkExact", () => {
	it("forks accepted-but-undispatched children with zero provider calls and identical exactness records", async () => {
		const source = await createStage6Source();
		const journal = new MemoryContinuationJournal();
		const branch = createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [{ id: "a" }, { id: "b" }]);
		expect(forked.ok).toBe(true);
		if (!forked.ok) return;
		expect(forked.value).toHaveLength(2);
		expect(source.faux.state.callCount).toBe(1);

		const groupId = exactContinuationGroupId(source.checkpoint, [{ id: "a" }, { id: "b" }]);
		const sessions = await source.repo.list();
		expect(sessions).toHaveLength(3);
		// Distinct physical roots, identical logical projection.
		const [left, right] = forked.value;
		expect(left!.environment.physicalRoot).not.toBe(right!.environment.physicalRoot);
		expect(left!.environment.logicalWorkspace).toEqual(right!.environment.logicalWorkspace);
		expect(left!.environment.logicalWorkspace).toEqual(source.checkpoint.logicalWorkspace);

		const basisRecords: Array<Record<string, unknown>> = [];
		for (const candidate of forked.value) {
			// Child usage ledger starts at zero; only its own rows accrue later.
			expect(await candidate.session.scanUsage({})).toEqual([]);
			// Open-operation and queue state never crosses the fork boundary:
			// the only op.meta is the child's own accepted Run.
			const operations = await candidate.session.listRegisters("op.meta");
			expect(operations).toHaveLength(1);
			expect(operations[0]?.key).toBe(candidate.acceptedRun.operationId);
			expect(await candidate.session.listRegisters("pending.entry")).toEqual([]);
			expect(await candidate.session.getRegister("lane.lastResult", "main")).toBeUndefined();
			// Exactly one child basis entry on top of the copied source basis.
			const basisEntries = await candidate.session.findEntries({
				type: "custom",
				customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
			});
			expect(basisEntries).toHaveLength(2);
			const branch = await candidate.session.findEntriesOnBranch({
				start: candidate.acceptedRun.basisEntryId,
				order: "oldestFirst",
			});
			// The child basis entry is the newest entry of the branch: it was
			// appended last and becomes the lane leaf before any dispatch.
			expect(branch.at(-1)).toMatchObject({ id: candidate.acceptedRun.basisEntryId, type: "custom" });
			// Zero-prompt: no hidden user/control entry beyond the copied prefix.
			const childMessages = branch.filter((entry) => entry.type === "message");
			expect(childMessages).toHaveLength(3); // user prompt, assistant, tool result
			const operation = await candidate.session.getRegister("op.meta", candidate.acceptedRun.operationId);
			const intent = operation?.value.intent;
			expect(intent?.kind === "run" ? intent.promptEntryIds : undefined).toEqual([]);
			expect(intent?.kind === "run" ? intent.systemPromptOverride : undefined).toBe(
				source.checkpoint.resolvedSystemPrompt,
			);
			basisRecords.push(customDataOf(branch.at(-1)));
		}
		const [first, second] = basisRecords.map((record) => record as unknown as BasisRecordView);
		expect(first?.start?.sampling).toEqual({ id: "a" });
		expect(second?.start?.sampling).toEqual({ id: "b" });
		expect(first?.start?.contextFingerprint).toBe(source.checkpoint.contextFingerprint);
		expect(first?.start?.contextFingerprint).toBe(second?.start?.contextFingerprint);
		expect(first?.start?.requestFingerprint).toBe(second?.start?.requestFingerprint);
		expect(first?.start?.requestFingerprint).toBe(source.checkpoint.requestFingerprint);
		expect(first?.inheritedPolicyState?.fingerprint).toBe(second?.inheritedPolicyState?.fingerprint);

		// Parent session is unchanged: same open Run, same leaf, same entries.
		const laneState = await source.session.getRegister("lane.state", "main");
		expect(laneState?.value.currentOperationId).toBe(source.turn.cursor.operationId);
		const leaf = await source.session.getRegister("lane.leaf", "main");
		expect(leaf?.value).toBe(source.turn.cursor.leafId);

		const events = await journal.events(groupId);
		expect(events.at(-1)).toMatchObject({ type: "group_ready", groupId });
		await Promise.all(forked.value.map((candidate) => candidate.close()));
		await source.harness.close();
	});

	it("dispatches identical first requests per sibling and never before group_ready", async () => {
		const source = await createStage6Source();
		const journal = new MemoryContinuationJournal();
		const branch = createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const contexts: Array<{
			systemPrompt?: string;
			messages: Context["messages"];
			toolNames: string[];
		}> = [];
		const forked = await branch.forkExact(source.checkpoint, [{ id: "a" }, { id: "b" }]);
		expect(forked.ok).toBe(true);
		if (!forked.ok) return;
		source.faux.setResponses([
			(context) => {
				contexts.push(projectContext(context));
				return fauxAssistantMessage("child reply");
			},
			(context) => {
				contexts.push(projectContext(context));
				return fauxAssistantMessage("child reply");
			},
		]);
		const [first, second] = forked.value;
		const firstResult = await first!.executor.execute({ kind: "advance" });
		expect(firstResult).toMatchObject({ ok: true, value: { kind: "turn", run: { kind: "settled" } } });
		expect(source.faux.state.callCount).toBe(2);
		const secondResult = await second!.executor.execute({ kind: "advance" });
		expect(secondResult).toMatchObject({ ok: true, value: { kind: "turn", run: { kind: "settled" } } });
		expect(source.faux.state.callCount).toBe(3);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]).toEqual(contexts[1]);
		expect(contexts[0]?.systemPrompt).toBe(source.checkpoint.resolvedSystemPrompt);
		expect(contexts[0]?.toolNames).toEqual(["read", "write", "edit", "bash"]);
		await Promise.all(forked.value.map((candidate) => candidate.close()));
		await source.harness.close();
	});

	it("rejects tool catalog drift before any provider dispatch", async () => {
		const source = await createStage6Source();
		const driftedTools: AgentTool[] = source.tools.map((tool) =>
			tool.name === "read" ? { ...tool, description: "drifted description" } : tool,
		);
		const branch = createBranchContinuation({
			journal: new MemoryContinuationJournal(),
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: driftedTools,
				registry: source.fixtures.registry,
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [{ id: "a" }]);
		expect(forked.ok).toBe(true);
		if (!forked.ok) return;
		source.faux.setResponses([fauxAssistantMessage("must not run")]);
		const result = await forked.value[0]!.executor.execute({ kind: "advance" });
		expect(result).toMatchObject({ ok: false, error: { kind: "request_fingerprint_mismatch" } });
		expect(source.faux.state.callCount).toBe(1);
		await forked.value[0]!.close();
		await source.harness.close();
	});

	it("rejects system prompt, temperature, and projection drift before any provider dispatch", async () => {
		const source = await createStage6Source();
		const cases: Array<{ mutate: (checkpoint: ContinuationCheckpoint) => void; label: string }> = [
			{
				label: "system prompt",
				mutate: (checkpoint) => {
					checkpoint.resolvedSystemPrompt = "drifted prompt";
				},
			},
			{
				label: "temperature",
				mutate: (checkpoint) => {
					checkpoint.profile.sampling.temperature = 0.1;
				},
			},
			{
				label: "context policy",
				mutate: (checkpoint) => {
					checkpoint.profile.contextPolicy.version = "drifted";
				},
			},
		];
		for (const drift of cases) {
			const journal = new MemoryContinuationJournal();
			const branch = createBranchContinuation({
				journal,
				workspacePort: source.workspacePort,
				sessionRepo: source.repo,
				childHarness: {
					models: source.models,
					model: source.model,
					tools: source.tools,
					registry: source.fixtures.registry,
				},
			});
			const forked = await branch.forkExact(tamper(source, drift.mutate), [{ id: "a" }]);
			expect(forked.ok, `${drift.label}: forkExact`).toBe(true);
			if (!forked.ok) continue;
			source.faux.setResponses([fauxAssistantMessage("must not run")]);
			const result = await forked.value[0]!.executor.execute({ kind: "advance" });
			expect(result, `${drift.label}: dispatch`).toMatchObject({
				ok: false,
				error: { kind: "request_fingerprint_mismatch" },
			});
			expect(source.faux.state.callCount, `${drift.label}: provider calls`).toBe(1);
			await forked.value[0]!.close();
		}
		await source.harness.close();
	});

	it("fails closed on non-deterministic hook registrations", async () => {
		const source = await createStage6Source();
		const branch = createBranchContinuation({
			journal: new MemoryContinuationJournal(),
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
				afterCreate: (harness) => {
					harness.hooks.on("before_request", async () => undefined);
				},
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [{ id: "a" }]);
		expect(forked.ok).toBe(true);
		if (!forked.ok) return;
		source.faux.setResponses([fauxAssistantMessage("must not run")]);
		const result = await forked.value[0]!.executor.execute({ kind: "advance" });
		expect(result).toMatchObject({ ok: false, error: { kind: "non_deterministic_request_policy" } });
		expect(source.faux.state.callCount).toBe(1);
		await forked.value[0]!.close();
		await source.harness.close();
	});

	it("rejects a workspace fork that does not project the checkpoint identity", async () => {
		const source = await createStage6Source();
		const lyingPort: WorkspaceContinuationPort = {
			snapshot: (metadata, logicalRoot) => source.workspacePort.snapshot(metadata, logicalRoot),
			fork: async (snapshotId, childId) => {
				const lease = await source.workspacePort.fork(snapshotId, childId);
				return {
					...lease,
					environment: {
						...lease.environment,
						logicalWorkspace: { root: "/other", contentFingerprint: "f".repeat(64) },
					},
				};
			},
		};
		const branch = createBranchContinuation({
			journal: new MemoryContinuationJournal(),
			workspacePort: lyingPort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [{ id: "a" }]);
		expect(forked.ok).toBe(false);
		if (forked.ok) return;
		expect(forked.error).toBeInstanceOf(WorkspaceSnapshotMismatchError);
		expect(source.faux.state.callCount).toBe(1);
		// A same-group retry reattaches to the durable group_failed outcome
		// instead of forking or admitting anything new.
		const retried = await branch.forkExact(source.checkpoint, [{ id: "a" }]);
		expect(retried.ok).toBe(false);
		if (retried.ok) return;
		expect(retried.error).toBeInstanceOf(WorkspaceSnapshotMismatchError);
		expect(source.faux.state.callCount).toBe(1);
		await source.harness.close();
	});

	it("records seeds in provenance and keeps fingerprints identical across seeded siblings", async () => {
		const source = await createStage6Source({ profile: { ...DEFAULT_PROFILE, seedCapable: true } });
		const journal = new MemoryContinuationJournal();
		const branch = createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [
			{ id: "seeded-a", seed: 1 },
			{ id: "seeded-b", seed: 2 },
		]);
		expect(forked.ok).toBe(true);
		if (!forked.ok) return;
		const samplings = await Promise.all(
			forked.value.map(async (candidate) => {
				const entry = (await candidate.session.getEntries([candidate.acceptedRun.basisEntryId])).get(
					candidate.acceptedRun.basisEntryId,
				);
				const data = customDataOf(entry) as { start?: { sampling?: { id?: string; seed?: number } } };
				return data.start?.sampling;
			}),
		);
		expect(samplings).toEqual([
			{ id: "seeded-a", seed: 1 },
			{ id: "seeded-b", seed: 2 },
		]);
		// Seeds never enter the fingerprint: sibling records stay identical.
		const fingerprints = await Promise.all(
			forked.value.map(async (candidate) => {
				const entry = (await candidate.session.getEntries([candidate.acceptedRun.basisEntryId])).get(
					candidate.acceptedRun.basisEntryId,
				);
				const data = customDataOf(entry) as { start?: { requestFingerprint?: string } };
				return data.start?.requestFingerprint;
			}),
		);
		expect(fingerprints[0]).toBe(fingerprints[1]);
		await Promise.all(forked.value.map((candidate) => candidate.close()));
		await source.harness.close();
	});

	it("returns UnsupportedSamplingControl for explicit seeds without provider capability", async () => {
		const source = await createStage6Source(); // DEFAULT_PROFILE.seedCapable === false
		const branch = createBranchContinuation({
			journal: new MemoryContinuationJournal(),
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const forked = await branch.forkExact(source.checkpoint, [{ id: "seeded", seed: 7 }]);
		expect(forked.ok).toBe(false);
		if (forked.ok) return;
		expect(forked.error).toBeInstanceOf(UnsupportedSamplingControlError);
		expect(source.faux.state.callCount).toBe(1);
		await source.harness.close();
	});

	it("rejects invalid variants and inconsistent checkpoints with typed errors", async () => {
		const source = await createStage6Source();
		const branch = createBranchContinuation({
			journal: new MemoryContinuationJournal(),
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
		const empty = await branch.forkExact(source.checkpoint, []);
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.error).toBeInstanceOf(NotBranchableCheckpointError);

		const duplicate = await branch.forkExact(source.checkpoint, [{ id: "a" }, { id: "a" }]);
		expect(duplicate.ok).toBe(false);
		if (duplicate.ok) return;
		expect(duplicate.error).toBeInstanceOf(NotBranchableCheckpointError);

		const inconsistent = await branch.forkExact(
			tamper(source, (checkpoint) => {
				checkpoint.policyState.basis.lane = "other-lane";
			}),
			[{ id: "a" }],
		);
		expect(inconsistent.ok).toBe(false);
		if (inconsistent.ok) return;
		expect(inconsistent.error).toBeInstanceOf(StateProjectionMismatch);
		await source.harness.close();
	});

	it("faults a partial sibling group without dispatching and reattaches on retry", async () => {
		const source = await createStage6Source();
		const journal = new MemoryContinuationJournal();
		const failingBranch = createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
				afterCreate: (harness, _session, variant) => {
					void harness;
					// The second child's harness creation faults the group.
					if (variant.id === "b") throw new ContinuationGroupFault("simulated child harness fault");
				},
			},
		});
		await expect(failingBranch.forkExact(source.checkpoint, [{ id: "a" }, { id: "b" }])).rejects.toBeInstanceOf(
			ContinuationGroupFault,
		);
		expect(source.faux.state.callCount).toBe(1);
		// No candidates were returned: no sibling can dispatch yet.
		const retried = await createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		}).forkExact(source.checkpoint, [{ id: "a" }, { id: "b" }]);
		expect(retried.ok).toBe(true);
		if (!retried.ok) return;
		expect(retried.value).toHaveLength(2);
		expect(await source.repo.list()).toHaveLength(3);
		await Promise.all(retried.value.map((candidate) => candidate.close()));
		await source.harness.close();
	});
});
