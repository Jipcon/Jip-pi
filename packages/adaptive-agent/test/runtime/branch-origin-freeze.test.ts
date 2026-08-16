import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core/harness-v4";
import { describe, expect, it } from "vitest";
import { jsonlRepoFixture } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import {
	BranchContinuation,
	BranchOriginConflictError,
	BranchOriginFrozenError,
	branchOriginRegisterKey,
	HarnessV4LeafTurnAdapter,
	MemoryContinuationJournal,
	PermissiveToolPolicyAdapter,
	PROJECTOR_VERSION,
	SessionRegisterBranchOriginRegistry,
} from "../../src/index.ts";
import { createStage6Source } from "./stage6-fixtures.ts";

describe("branch-origin freeze", () => {
	it("freeze writes a durable marker, assertAvailable throws, and unfreeze restores", async () => {
		const repo = new InMemorySessionRepo({ now: () => 3_100_000_000_000 });
		const session = await repo.create({ id: "origin-source" });
		const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
		const record = await registry.freeze({
			session,
			lane: "main",
			operationId: "op-1",
			groupId: "group-1",
		});
		expect(record.groupId).toBe("group-1");
		expect((await registry.get({ session, lane: "main" }))?.groupId).toBe("group-1");
		await expect(registry.assertAvailable({ session, lane: "main" })).rejects.toBeInstanceOf(BranchOriginFrozenError);
		// Re-freezing the same group is idempotent; a different group faults.
		await registry.freeze({ session, lane: "main", operationId: "op-1", groupId: "group-1" });
		await expect(
			registry.freeze({ session, lane: "main", operationId: "op-1", groupId: "group-2" }),
		).rejects.toBeInstanceOf(BranchOriginConflictError);
		await registry.unfreeze({ session, lane: "main" });
		await expect(registry.get({ session, lane: "main" })).resolves.toBeUndefined();
		await expect(registry.assertAvailable({ session, lane: "main" })).resolves.toBeUndefined();
		await session.close();
	});

	it("the marker survives close/reopen on the JSONL backend", async () => {
		const repo = jsonlRepoFixture({ now: () => 3_100_000_000_000 });
		const session = await repo.create({ id: "origin-jsonl" });
		const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
		await registry.freeze({ session, lane: "main", operationId: "op-1", groupId: "group-1" });
		const metadata = session.metadata;
		await session.close();
		// Reopen: the frozen state must be recovered from the durable marker.
		const reopened = await repo.open(metadata);
		const recovered = await registry.get({ session: reopened, lane: "main" });
		expect(recovered?.groupId).toBe("group-1");
		expect(recovered?.operationId).toBe("op-1");
		await expect(registry.assertAvailable({ session: reopened, lane: "main" })).rejects.toBeInstanceOf(
			BranchOriginFrozenError,
		);
		await reopened.close();
	});

	it("the register key is lane-scoped and does not leak across lanes", async () => {
		const repo = new InMemorySessionRepo({ now: () => 3_100_000_000_000 });
		const session = await repo.create({ id: "origin-lanes" });
		const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
		await registry.freeze({ session, lane: "main", operationId: "op-1", groupId: "g" });
		await expect(registry.assertAvailable({ session, lane: "main" })).rejects.toBeInstanceOf(BranchOriginFrozenError);
		await expect(registry.assertAvailable({ session, lane: "other" })).resolves.toBeUndefined();
		expect(branchOriginRegisterKey("main")).not.toBe(branchOriginRegisterKey("other"));
		await session.close();
	});

	it("the LeafTurn adapter guard blocks advance on a frozen source lane", async () => {
		const source = await createStage6Source({ id: "origin-guard-source" });
		try {
			const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
			await registry.freeze({
				session: source.harness.durableSession,
				lane: "main",
				operationId: source.checkpoint.cursor.operationId,
				groupId: "group-1",
			});
			const adapter = new HarnessV4LeafTurnAdapter({
				lane: source.harness,
				basis: {
					schemaVersion: 1,
					taskId: "task",
					candidateId: "candidate",
					policyBundle: source.fixtures.permissive,
					projectorVersion: PROJECTOR_VERSION,
					inheritedPolicyState: source.checkpoint.policyState,
					start: { kind: "prompt" },
				},
				originGuard: () => registry.assertAvailable({ session: source.harness.durableSession, lane: "main" }),
			});
			await expect(
				adapter.execute({ kind: "advance", afterCursor: source.checkpoint.cursor }),
			).rejects.toBeInstanceOf(BranchOriginFrozenError);
			await registry.unfreeze({ session: source.harness.durableSession, lane: "main" });
		} finally {
			await source.harness.close();
		}
	});

	it("BranchContinuation freezes the source at group_planned and keeps it frozen after group_ready", async () => {
		const source = await createStage6Source({ id: "origin-cont-source" });
		try {
			const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
			const journal = new MemoryContinuationJournal();
			const workspacePort = source.workspacePort;
			const continuation = new BranchContinuation({
				journal,
				workspacePort,
				sessionRepo: source.repo,
				originRegistry: registry,
				sourceSession: source.harness.durableSession,
				createChildHarness: async ({ session, checkpoint, environment, gate, variant }) => {
					void environment;
					void variant;
					const { harness } = await AgentHarness.create<undefined>({
						session,
						models: source.models,
						model: source.model,
						tools: source.tools,
						activeToolNames: source.tools.map((tool) => tool.name),
						systemPrompt: checkpoint.resolvedSystemPrompt,
						adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
							registry: source.fixtures.registry,
							session,
						}),
						exactContinuationDispatchGate: gate,
					});
					return { lane: harness, close: () => harness.close() };
				},
			});
			const forked = await continuation.forkExact(source.checkpoint, [{ id: "v1" }]);
			expect(forked.ok).toBe(true);
			if (forked.ok) {
				const frozen = await registry.get({ session: source.harness.durableSession, lane: "main" });
				expect(frozen?.groupId).toBeDefined();
				await expect(
					registry.assertAvailable({ session: source.harness.durableSession, lane: "main" }),
				).rejects.toBeInstanceOf(BranchOriginFrozenError);
				for (const candidate of forked.value) {
					await candidate.close();
					await candidate.workspaceLease.release();
				}
			}
		} finally {
			await source.harness.close();
		}
	});

	it("a failed fork with no dispatch releases the freeze", async () => {
		const source = await createStage6Source({ id: "origin-fail-source" });
		try {
			const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
			// A typed mid-group rejection: the workspace port projects a
			// different logical root, which must fault the child workspace.
			const mismatchedPort = {
				async snapshot() {
					throw new Error("unused");
				},
				async fork(snapshotId: string, childId: string) {
					return {
						id: `${snapshotId}:${childId}`,
						snapshotId,
						environment: {
							physicalRoot: "memory://mismatch",
							logicalWorkspace: {
								root: "/WRONG-ROOT",
								contentFingerprint: source.checkpoint.logicalWorkspace.contentFingerprint,
							},
							toPhysicalPath: (path: string) => path,
						},
						release: async () => {},
					};
				},
			};
			const continuation = new BranchContinuation({
				journal: new MemoryContinuationJournal(),
				workspacePort: mismatchedPort,
				sessionRepo: source.repo,
				originRegistry: registry,
				sourceSession: source.harness.durableSession,
				createChildHarness: async ({ session, gate }) => {
					const { harness } = await AgentHarness.create<undefined>({
						session,
						models: source.models,
						model: source.model,
						tools: source.tools,
						activeToolNames: source.tools.map((tool) => tool.name),
						systemPrompt: source.checkpoint.resolvedSystemPrompt,
						adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
							registry: source.fixtures.registry,
							session,
						}),
						exactContinuationDispatchGate: gate,
					});
					return { lane: harness, close: () => harness.close() };
				},
			});
			const forked = await continuation.forkExact(source.checkpoint, [{ id: "v1" }]);
			expect(forked.ok).toBe(false);
			await expect(registry.get({ session: source.harness.durableSession, lane: "main" })).resolves.toBeUndefined();
		} finally {
			await source.harness.close();
		}
	});

	it("reopening the source after a frozen group restores the same frozen state", async () => {
		const repo = jsonlRepoFixture({ now: () => 3_100_000_000_000 });
		const source = await createStage6Source({ id: "origin-reopen-source", repo });
		try {
			const registry = new SessionRegisterBranchOriginRegistry({ now: () => 3_100_000_000_000 });
			await registry.freeze({
				session: source.harness.durableSession,
				lane: "main",
				operationId: source.checkpoint.cursor.operationId,
				groupId: "group-1",
			});
			const metadata = source.session.metadata;
			await source.harness.close();
			const reopened = await repo.open(metadata);
			await expect(registry.get({ session: reopened, lane: "main" })).resolves.toMatchObject({
				groupId: "group-1",
			});
			await reopened.close();
		} finally {
			await source.harness.close().catch(() => undefined);
		}
	});
});
