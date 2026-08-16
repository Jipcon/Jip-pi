import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import { AgentHarness, InMemorySessionRepo, type JsonValue, type Session } from "../../../agent/src/harness-v4.ts";
import { type V4SessionRepo, v4Backends } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import {
	type CandidatePolicyStateCapsule,
	CandidateStateProjector,
	canonicalJson,
	createOriginCapsule,
	fingerprintState,
	MemoryProjectionCache,
	PermissiveToolPolicyAdapter,
	PolicyProjectionFault,
	PROJECTOR_VERSION,
	type ProjectionBasis,
	StateProjectionMismatch,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import type { LeafTurnCursor } from "../../src/runtime/leaf-turn-executor.ts";
import { type BundleFixtures, createBundleFixtures, originSnapshot } from "./stage5-fixtures.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
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

interface BuiltRun {
	faux: ReturnType<typeof fauxProvider>;
	harness: AgentHarness<undefined>;
	adapter: HarnessV4LeafTurnAdapter;
	repo: V4SessionRepo;
	session: Session;
	fixtures: BundleFixtures;
	turns: Array<{ cursor: LeafTurnCursor; settlement?: "completed" | "failed" | "aborted" }>;
	readTool: AgentHarnessTool<undefined>;
}

async function buildAdaptiveRun(
	repo: V4SessionRepo,
	options: {
		id: string;
		responses: Array<AssistantMessage>;
		toolExecution?: "sequential" | "parallel";
	},
): Promise<BuiltRun> {
	const faux = fauxProvider({ provider: "projector-provider", api: "projector-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const session = await repo.create({ id: options.id });
	const fixtures = await createBundleFixtures();
	const readTool: AgentHarnessTool<undefined> = {
		name: "read",
		description: "read tool",
		label: "read",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "read ran" }], details: {} }),
	};
	const { harness } = await AgentHarness.create<undefined>({
		session,
		models,
		model,
		tools: [readTool],
		activeToolNames: ["read"],
		toolExecution: options.toolExecution ?? "parallel",
		adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
	});
	const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis: basis(session.metadata.id, fixtures) });
	faux.setResponses(options.responses);
	return { faux, harness, adapter, repo, session, fixtures, turns: [], readTool };
}

async function startTurn(run: BuiltRun): Promise<LeafTurnCursor> {
	const result = await run.adapter.execute({ kind: "start", prompt: userMessage("work") });
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("unexpected suspension");
	const turn = result.value.turn;
	run.turns.push({
		cursor: turn.cursor,
		...(result.value.run.kind === "settled" ? { settlement: result.value.run.result.kind } : {}),
	});
	return turn.cursor;
}

async function driveTurn(run: BuiltRun, cursor: LeafTurnCursor): Promise<LeafTurnCursor> {
	const result = await run.adapter.execute({ kind: "advance", afterCursor: cursor });
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("unexpected suspension");
	const turn = result.value.turn;
	run.turns.push({
		cursor: turn.cursor,
		...(result.value.run.kind === "settled" ? { settlement: result.value.run.result.kind } : {}),
	});
	return turn.cursor;
}

async function runBasisEntry(session: Session): Promise<{ entryId: string; data: Record<string, JsonValue> }> {
	const entry = await session.findEntry({ type: "custom", customType: "adaptive.run_basis" });
	if (entry === undefined || entry.type !== "custom" || entry.data === undefined)
		throw new Error("no run basis entry");
	return { entryId: entry.id, data: entry.data as Record<string, JsonValue> };
}

function projectionBasis(
	run: { session: Session; fixtures: BundleFixtures },
	basisEntry: { entryId: string; data: Record<string, JsonValue> },
	cursor: ProjectionBasis["cursor"],
): ProjectionBasis {
	const inherited = basisEntry.data.inheritedPolicyState as unknown as CandidatePolicyStateCapsule;
	return {
		taskId: "task",
		candidateId: "candidate",
		sessionId: run.session.metadata.id,
		lane: "main",
		operationId: basisEntry.data.operationId as string,
		cursor,
		policyBundle: { version: run.fixtures.permissive.version, fingerprint: run.fixtures.permissive.fingerprint },
		projectorVersion: PROJECTOR_VERSION,
		inheritedStateFingerprint: inherited.fingerprint,
	};
}

describe.each(v4Backends())("CandidateStateProjector ($name backend)", (backend) => {
	it("projects the task-origin capsule deterministically", async () => {
		const fixtures = await createBundleFixtures();
		const projector = new CandidateStateProjector({ registry: fixtures.registry });
		const snapshot = originSnapshot(fixtures.permissiveBundle);
		const repo = backend.create({ now: () => 3_000_000_000_000 });
		const session = await repo.create({ id: "projector-origin" });
		const basisValue: ProjectionBasis = {
			taskId: "task",
			candidateId: "candidate",
			sessionId: session.metadata.id,
			lane: "main",
			operationId: "task-origin",
			cursor: { kind: "task_origin" },
			policyBundle: fixtures.permissive,
			projectorVersion: PROJECTOR_VERSION,
			inheritedStateFingerprint: fingerprintState(snapshot),
		};
		const capsule = await projector.project(basisValue, { session, originSnapshot: snapshot });
		expect(capsule.fingerprint).toBe(fingerprintState(snapshot));
		await expect(
			projector.project(
				{ ...basisValue, inheritedStateFingerprint: "a".repeat(64) },
				{ session, originSnapshot: snapshot },
			),
		).rejects.toBeInstanceOf(StateProjectionMismatch);
		await session.close();
	});

	it("reconstructs tool_batch_start excluding every result of that batch", async () => {
		const repo = backend.create({ now: () => 3_010_000_000_000 });
		const run = await buildAdaptiveRun(repo, {
			id: "projector-batch-start",
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("read", { path: "b" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		let cursor = await startTurn(run); // turn 1, results durable
		cursor = await driveTurn(run, cursor); // turn 2, results durable
		await driveTurn(run, cursor); // final answer, run settles
		const projector = new CandidateStateProjector({ registry: run.fixtures.registry });
		const basisEntry = await runBasisEntry(run.session);
		const assistants = (await run.session.findEntries({ type: "message", order: "asc" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		const firstAssistant = assistants[0];
		const secondAssistant = assistants[1];
		if (firstAssistant?.type !== "message" || secondAssistant?.type !== "message")
			throw new Error("missing assistant entries");

		// Batch-start projection for the FIRST batch: origin state only, even
		// though the batch results are already durable.
		const firstBatchStart = await projector.project(
			projectionBasis(run, basisEntry, { kind: "tool_batch_start", assistantEntryId: firstAssistant.id }),
			{ session: run.session, basisEntryId: basisEntry.entryId },
		);
		expect(firstBatchStart.snapshot.steps).toBe(0);
		expect(firstBatchStart.snapshot.turns).toBe(0);
		expect(firstBatchStart.fingerprint).toBe(fingerprintState(originSnapshot(run.fixtures.permissiveBundle)));

		// Batch-start projection for the SECOND batch: exactly one completed
		// turn; the second batch's own durable results must not leak in.
		const secondBatchStart = await projector.project(
			projectionBasis(run, basisEntry, { kind: "tool_batch_start", assistantEntryId: secondAssistant.id }),
			{ session: run.session, basisEntryId: basisEntry.entryId },
		);
		expect(secondBatchStart.snapshot.turns).toBe(1);
		expect(secondBatchStart.snapshot.steps).toBe(1);
		expect(secondBatchStart.snapshot.tools.success).toBe(1);
		expect(secondBatchStart.fingerprint).not.toBe(firstBatchStart.fingerprint);
		await run.harness.close();
	});

	it("projects post_turn states and cross-checks stored batch fingerprints", async () => {
		const repo = backend.create({ now: () => 3_020_000_000_000 });
		const run = await buildAdaptiveRun(repo, {
			id: "projector-post-turn",
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		const firstCursor = await startTurn(run);
		const finalCursor = await driveTurn(run, firstCursor);
		const projector = new CandidateStateProjector({ registry: run.fixtures.registry });
		const basisEntry = await runBasisEntry(run.session);
		const capsule = await projector.project(
			projectionBasis(run, basisEntry, { kind: "post_turn", cursor: finalCursor, terminalOutcome: "completed" }),
			{ session: run.session },
		);
		expect(capsule.snapshot.turns).toBe(2);
		expect(capsule.snapshot.steps).toBe(1);
		expect(capsule.snapshot.phase).toBe("answering");
		expect(capsule.snapshot.budgets.tokens.used).toBeGreaterThan(0);
		expect(capsule.fingerprint).toBe(fingerprintState(capsule.snapshot));

		// Same basis again: identical capsule, also through the cache.
		const cached = new CandidateStateProjector({
			registry: run.fixtures.registry,
			cache: new MemoryProjectionCache(),
		});
		const basisValue = projectionBasis(run, basisEntry, {
			kind: "post_turn",
			cursor: finalCursor,
			terminalOutcome: "completed",
		});
		const first = await cached.project(basisValue, { session: run.session });
		const second = await cached.project(basisValue, { session: run.session });
		expect(second).toEqual(first);
		cached.clearCache();
		const recomputed = await cached.project(basisValue, { session: run.session });
		expect(recomputed).toEqual(first);
		await run.harness.close();
	});

	it("detects a tampered stored batch fingerprint as StateProjectionMismatch", async () => {
		const fixtures = await createBundleFixtures();
		const repo = backend.create({ now: () => 3_030_000_000_000 });
		const session = await repo.create({ id: "projector-mismatch" });
		const capsule = createOriginCapsule({
			taskId: "task",
			candidateId: "candidate",
			sessionId: session.metadata.id,
			lane: "main",
			policyBundle: fixtures.permissive,
			snapshot: originSnapshot(fixtures.permissiveBundle),
		});
		const call = fauxToolCall("read", { path: "a" }, { id: "call-1" });
		const assistantMessage = fauxAssistantMessage([call], {
			stopReason: "toolUse",
			timestamp: 1,
		}) as AssistantMessage & {
			deferred?: unknown;
			errorMessage?: unknown;
			responseId?: unknown;
		};
		delete assistantMessage.deferred;
		delete assistantMessage.errorMessage;
		delete assistantMessage.responseId;
		await session.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: "basis-1",
						parentId: null,
						type: "custom",
						customType: "adaptive.run_basis",
						data: {
							schemaVersion: 1,
							operationId: "op-1",
							taskId: "task",
							candidateId: "candidate",
							policyBundle: fixtures.permissive,
							projectorVersion: PROJECTOR_VERSION,
							inheritedPolicyState: capsule,
							start: { kind: "prompt" },
						} as unknown as JsonValue,
					},
				},
				{
					kind: "entry",
					entry: { id: "prompt-1", parentId: "basis-1", type: "message", message: userMessage("work") },
				},
				{
					kind: "entry",
					entry: {
						id: "assistant-1",
						parentId: "prompt-1",
						type: "message",
						message: assistantMessage,
					},
				},
				{
					kind: "entry",
					entry: {
						id: "batch-1",
						parentId: "assistant-1",
						type: "custom",
						customType: "adaptive.tool_batch",
						data: {
							schemaVersion: 1,
							policyStateFingerprint: "b".repeat(64),
							decisions: [
								{
									kind: "allow",
									sourceIndex: 0,
									toolCallId: "call-1",
									toolName: "read",
									effectiveArgs: { path: "a" },
									replay: "never",
								},
							],
						},
					},
				},
				{
					kind: "entry",
					entry: {
						id: "result-1",
						parentId: "batch-1",
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "call-1",
							toolName: "read",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: 1,
						},
					},
				},
			],
		});
		await session.commit({
			writes: [
				{ kind: "usage", row: { id: "usage-1", entryId: "assistant-1", usage: ZERO_USAGE, adjustment: false } },
			],
		});
		const projector = new CandidateStateProjector({ registry: fixtures.registry });
		const basisValue: ProjectionBasis = {
			taskId: "task",
			candidateId: "candidate",
			sessionId: session.metadata.id,
			lane: "main",
			operationId: "op-1",
			cursor: {
				kind: "post_turn",
				cursor: { operationId: "op-1", assistantEntryId: "assistant-1", leafId: "result-1" },
			},
			policyBundle: fixtures.permissive,
			projectorVersion: PROJECTOR_VERSION,
			inheritedStateFingerprint: capsule.fingerprint,
		};
		await expect(projector.project(basisValue, { session })).rejects.toBeInstanceOf(StateProjectionMismatch);
		await session.close();
	});

	it("fails closed on missing or mismatched run-basis identity", async () => {
		const repo = backend.create({ now: () => 3_040_000_000_000 });
		const run = await buildAdaptiveRun(repo, {
			id: "projector-basis-guards",
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		const firstCursor = await startTurn(run);
		const projector = new CandidateStateProjector({ registry: run.fixtures.registry });
		const basisEntry = await runBasisEntry(run.session);
		const valid = projectionBasis(run, basisEntry, { kind: "post_turn", cursor: firstCursor });
		await expect(
			projector.project({ ...valid, operationId: "other-operation" }, { session: run.session }),
		).rejects.toBeInstanceOf(PolicyProjectionFault);
		await expect(
			projector.project(
				{ ...valid, policyBundle: { version: "x", fingerprint: "c".repeat(64) } },
				{ session: run.session },
			),
		).rejects.toBeInstanceOf(PolicyProjectionFault);
		await expect(
			projector.project({ ...valid, projectorVersion: "ancient-v0" }, { session: run.session }),
		).rejects.toBeInstanceOf(PolicyProjectionFault);
		await expect(
			projector.project(
				projectionBasis(run, basisEntry, { kind: "tool_batch_start", assistantEntryId: "unknown-entry" }),
				{ session: run.session, basisEntryId: basisEntry.entryId },
			),
		).rejects.toBeInstanceOf(PolicyProjectionFault);
		await run.harness.close();
	});

	it("keeps identical state and fingerprint across close/reopen and cache deletion", async () => {
		const repo = backend.create({ now: () => 3_050_000_000_000 });
		const run = await buildAdaptiveRun(repo, {
			id: "projector-reopen",
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		const firstCursor = await startTurn(run);
		const projector = new CandidateStateProjector({
			registry: run.fixtures.registry,
			cache: new MemoryProjectionCache(),
		});
		const basisEntry = await runBasisEntry(run.session);
		const basisValue = projectionBasis(run, basisEntry, {
			kind: "post_turn",
			cursor: firstCursor,
			terminalOutcome: "completed",
		});
		const beforeClose = await projector.project(basisValue, { session: run.session });
		const metadata = structuredClone(run.session.metadata);
		await run.harness.close();

		const reopenedSession = await repo.open(metadata);
		const reopenedProjector = new CandidateStateProjector({
			registry: run.fixtures.registry,
			cache: new MemoryProjectionCache(),
		});
		const afterReopen = await reopenedProjector.project(basisValue, { session: reopenedSession });
		expect(afterReopen).toEqual(beforeClose);
		reopenedProjector.clearCache();
		expect(await reopenedProjector.project(basisValue, { session: reopenedSession })).toEqual(beforeClose);
		// A corrupt cached capsule is dropped and recomputed, never trusted.
		const corruptCache = new MemoryProjectionCache();
		corruptCache.put(canonicalJson(basisValue as unknown as JsonValue), {
			...structuredClone(beforeClose),
			fingerprint: "e".repeat(64),
		});
		const corruptProjector = new CandidateStateProjector({ registry: run.fixtures.registry, cache: corruptCache });
		expect(await corruptProjector.project(basisValue, { session: reopenedSession })).toEqual(beforeClose);
		await reopenedSession.close();
	});

	it("verifies an inherited post-turn capsule when a new Run starts", async () => {
		const repo = backend.create({ now: () => 3_060_000_000_000 });
		const run = await buildAdaptiveRun(repo, {
			id: "projector-inherit",
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		const firstCursor = await startTurn(run);
		const finalCursor = await driveTurn(run, firstCursor); // final answer settles the run
		const projector = new CandidateStateProjector({ registry: run.fixtures.registry });
		const firstBasisEntry = await runBasisEntry(run.session);
		const inheritedCapsule = await projector.project(
			projectionBasis(run, firstBasisEntry, {
				kind: "post_turn",
				cursor: finalCursor,
				terminalOutcome: "completed",
			}),
			{ session: run.session },
		);
		// Start a second Run on the same lane with the inherited capsule.
		const inheritedBasis: HarnessV4LeafTurnBasis = {
			schemaVersion: 1,
			taskId: "task",
			candidateId: "candidate",
			policyBundle: run.fixtures.permissive,
			projectorVersion: PROJECTOR_VERSION,
			inheritedPolicyState: structuredClone(inheritedCapsule),
			start: { kind: "prompt" },
		};
		const secondAdapter = new HarnessV4LeafTurnAdapter({ lane: run.harness, basis: inheritedBasis });
		run.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "b" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("all done"),
		]);
		const secondStart = await secondAdapter.execute({ kind: "start", prompt: userMessage("continue") });
		if (!secondStart.ok || secondStart.value.kind !== "turn") {
			throw new Error(`expected a turn: ${JSON.stringify(secondStart)}`);
		}
		const secondRunBasis = (
			await run.session.findEntries({ type: "custom", customType: "adaptive.run_basis", order: "asc" })
		).at(-1);
		if (secondRunBasis?.type !== "custom" || secondRunBasis.data === undefined)
			throw new Error("missing second run basis");
		const secondCapsule = await projector.project(
			projectionBasis(
				run,
				{ entryId: secondRunBasis.id, data: secondRunBasis.data as Record<string, JsonValue> },
				{
					kind: "tool_batch_start",
					assistantEntryId: secondStart.value.turn.assistantEntryId,
				},
			),
			{ session: run.session, basisEntryId: secondRunBasis.id },
		);
		// The second run seeds from the inherited capsule: both turns of run 1
		// are visible before the new batch executes.
		expect(secondCapsule.snapshot.turns).toBe(2);
		expect(secondCapsule.snapshot.steps).toBe(1);
		expect(secondCapsule.fingerprint).toBe(fingerprintState(inheritedCapsule.snapshot));

		// Finish the second run so the lane is idle for the tampered attempt.
		const secondDone = await secondAdapter.execute({ kind: "advance", afterCursor: secondStart.value.turn.cursor });
		expect(secondDone.ok).toBe(true);

		// A tampered inherited capsule cannot be reconstructed: the clearance
		// of the second run's first batch fails closed before any effect.
		const tampered: HarnessV4LeafTurnBasis = {
			...structuredClone(inheritedBasis),
			inheritedPolicyState: { ...structuredClone(inheritedCapsule), fingerprint: "d".repeat(64) },
		};
		run.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "c" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("x"),
		]);
		const tamperedAdapter = new HarnessV4LeafTurnAdapter({ lane: run.harness, basis: tampered });
		const tamperedStart = await tamperedAdapter.execute({ kind: "start", prompt: userMessage("tampered") });
		if (!tamperedStart.ok || tamperedStart.value.kind !== "turn") throw new Error("expected a turn");
		expect(tamperedStart.value.turn.toolResults).toHaveLength(1);
		expect(tamperedStart.value.turn.toolResults[0]).toMatchObject({ isError: true });
		expect(
			((tamperedStart.value.turn.toolResults[0]!.content as Array<{ text?: string }>)[0]?.text ?? "").includes(
				"ToolPolicy fault",
			),
		).toBe(true);
		await run.harness.close();
	});

	it("attaches workspace metadata without changing the state fingerprint", async () => {
		const fixtures = await createBundleFixtures();
		const repo = new InMemorySessionRepo({ now: () => 3_070_000_000_000 });
		const session = await repo.create({ id: "projector-workspace" });
		const snapshot = originSnapshot(fixtures.permissiveBundle);
		const metadata = { files: [{ path: "a.ts", size: 12, mtimeMs: 99 }] };
		const projector = new CandidateStateProjector({ registry: fixtures.registry });
		const plain: ProjectionBasis = {
			taskId: "task",
			candidateId: "candidate",
			sessionId: session.metadata.id,
			lane: "main",
			operationId: "task-origin",
			cursor: { kind: "task_origin" },
			policyBundle: fixtures.permissive,
			projectorVersion: PROJECTOR_VERSION,
			inheritedStateFingerprint: fingerprintState(snapshot),
		};
		const withWorkspace: ProjectionBasis = { ...plain, workspaceMetadata: metadata };
		const plainCapsule = await projector.project(plain, { session, originSnapshot: snapshot });
		const workspaceCapsule = await projector.project(withWorkspace, { session, originSnapshot: snapshot });
		expect(workspaceCapsule.fingerprint).toBe(plainCapsule.fingerprint);
		expect(workspaceCapsule.snapshot.workspace).toMatchObject({ files: [{ path: "a.ts", size: 12, mtimeMs: 99 }] });
		expect(workspaceCapsule.snapshot.workspace?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		await session.close();
	});
});
