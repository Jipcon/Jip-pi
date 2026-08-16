import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHarnessTool } from "../../../agent/src/harness/types.ts";
import {
	type AdaptiveToolClearanceInput,
	AgentHarness,
	InMemorySessionRepo,
	type JsonValue,
	type MessageEntry,
	type Session,
} from "../../../agent/src/harness-v4.ts";
import {
	AdaptiveToolPolicyAdapter,
	CandidateStateProjector,
	canonicalizeWorkspacePath,
	computeToolCatalogFingerprint,
	createOriginCapsule,
	MemoryProjectionCache,
	PermissiveToolPolicyAdapter,
	type PolicyBundle,
	type PolicyRegistry,
	PROJECTOR_VERSION,
} from "../../src/index.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "../../src/runtime/harness-leaf-turn-adapter.ts";
import {
	adaptiveBundle,
	type BundleFixtures,
	createBundleFixtures,
	makeFixedTools,
	originSnapshot,
} from "./stage5-fixtures.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-tool-policy-"));
	cleanupDirectories.add(directory);
	return directory;
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function fixedTools(options?: { record?: (name: string, args: Record<string, unknown>) => void }): AgentTool[] {
	return makeFixedTools(options);
}

interface ClearanceFixture {
	session: Session;
	fixtures: BundleFixtures;
	input: AdaptiveToolClearanceInput;
	basisEntryId: string;
	operationId: string;
}

async function makeClearanceFixture(
	repo: InMemorySessionRepo,
	options: {
		id?: string;
		fixtures?: BundleFixtures;
		bundle?: PolicyBundle;
		refOverride?: { version: string; fingerprint: string };
		calls: Array<{ name: string; args: Record<string, JsonValue> }>;
	} = { calls: [] },
): Promise<ClearanceFixture> {
	const session = await repo.create({ id: options.id ?? "clearance" });
	const fixtures = options.fixtures ?? (await createBundleFixtures());
	const bundle = options.bundle ?? fixtures.permissiveBundle;
	const ref =
		options.refOverride ??
		(options.bundle === undefined ? fixtures.permissive : await fixtures.registry.publish(options.bundle));
	const capsule = createOriginCapsule({
		taskId: "task",
		candidateId: "candidate",
		sessionId: session.metadata.id,
		lane: "main",
		policyBundle: ref,
		snapshot: originSnapshot(bundle),
	});
	const callList = options.calls.map((call, index) => fauxToolCall(call.name, call.args, { id: `call-${index}` }));
	const assistant = fauxAssistantMessage(callList, {
		stopReason: callList.length > 0 ? "toolUse" : "stop",
		timestamp: 1,
	}) as AssistantMessage & {
		deferred?: unknown;
		errorMessage?: unknown;
		responseId?: unknown;
	};
	delete assistant.deferred;
	delete assistant.errorMessage;
	delete assistant.responseId;
	await session.commit({
		writes: [
			{
				kind: "entry",
				entry: {
					id: "basis",
					parentId: null,
					type: "custom",
					customType: "adaptive.run_basis",
					data: {
						schemaVersion: 1,
						operationId: "op",
						taskId: "task",
						candidateId: "candidate",
						policyBundle: ref,
						projectorVersion: PROJECTOR_VERSION,
						inheritedPolicyState: capsule,
						start: { kind: "prompt" },
					} as unknown as JsonValue,
				},
			},
			{ kind: "entry", entry: { id: "prompt", parentId: "basis", type: "message", message: userMessage("work") } },
			{ kind: "entry", entry: { id: "assistant", parentId: "prompt", type: "message", message: assistant } },
		],
	});
	const assistantEntry: MessageEntry = {
		id: "assistant",
		parentId: "prompt",
		seq: 3,
		timestamp: 1,
		type: "message",
		message: assistant,
	};
	const input: AdaptiveToolClearanceInput = {
		batch: {
			assistantEntryId: "assistant",
			configuration: {
				model: { provider: "p", modelId: "m" },
				thinkingLevel: "off",
				activeToolNames: ["read", "write", "edit", "bash"],
			},
			turnId: "turn",
			argumentAuthority: { kind: "adaptive_pending" },
			calls: options.calls.map((_, index) => ({
				status: "planned",
				sourceIndex: index,
				resultEntryId: `result-${index}`,
			})),
		},
		assistantEntry,
		calls: options.calls.map((call, index) => ({
			sourceIndex: index,
			call: { type: "toolCall" as const, id: `call-${index}`, name: call.name, arguments: call.args },
		})),
		tools: fixedTools(),
		sessionId: session.metadata.id,
		lane: "main",
		operationId: "op",
		basisEntryId: "basis",
	};
	return { session, fixtures, input, basisEntryId: "basis", operationId: "op" };
}

class CountingProjector extends CandidateStateProjector {
	count = 0;

	override async project(
		basis: Parameters<CandidateStateProjector["project"]>[0],
		facts: Parameters<CandidateStateProjector["project"]>[1],
		observeTurn?: Parameters<CandidateStateProjector["project"]>[2],
	): ReturnType<CandidateStateProjector["project"]> {
		this.count += 1;
		return super.project(basis, facts, observeTurn);
	}
}

describe("AdaptiveToolPolicyAdapter", () => {
	it("allows validated calls with the tool's replay declaration", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_000_000_000_000 });
		const { session, fixtures, input } = await makeClearanceFixture(repo, {
			calls: [{ name: "read", args: { path: "a.ts" } }],
		});
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const result = await policy.clearBatch(input);
		expect(result.decisions).toEqual([
			{
				kind: "allow",
				sourceIndex: 0,
				toolCallId: "call-0",
				toolName: "read",
				effectiveArgs: { path: "a.ts" },
				replay: "never",
			},
		]);
		expect(result.policyStateFingerprint).toMatch(/^[0-9a-f]{64}$/);
		await session.close();
	});

	it("guards only with equivalent path canonicalization", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_010_000_000_000 });
		const fixtures = await createBundleFixtures();
		const { session, input } = await makeClearanceFixture(repo, {
			fixtures,
			bundle: fixtures.adaptiveBundle,
			calls: [
				{ name: "read", args: { path: "sub/../a.ts" } },
				{ name: "bash", args: { command: "echo hi" } },
			],
		});
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const result = await policy.clearBatch(input);
		expect(result.decisions[0]).toMatchObject({
			kind: "argument_guard",
			toolCallId: "call-0",
			effectiveArgs: { path: "a.ts" },
			replay: "never",
		});
		// Non-path arguments of other tools are untouched.
		expect(result.decisions[1]).toMatchObject({
			kind: "allow",
			toolCallId: "call-1",
			effectiveArgs: { command: "echo hi" },
		});
		// One projection, one fingerprint for the whole batch.
		expect(result.decisions.every((decision) => decision.kind !== "block")).toBe(true);
		await session.close();
	});

	it("blocks rule violations, schema-invalid calls and workspace escapes with zero effects", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_020_000_000_000 });
		const root = workspace();
		const fixtures = await createBundleFixtures();
		const { session, input } = await makeClearanceFixture(repo, {
			fixtures,
			bundle: fixtures.adaptiveBundle,
			calls: [
				{ name: "write", args: { path: "out.txt", content: "x" } },
				{ name: "read", args: { offset: 1 } },
				{ name: "read", args: { path: "../escape.txt" } },
				{ name: "read", args: { path: `${root}/inside.txt` } },
			],
		});
		const policy = new AdaptiveToolPolicyAdapter({ registry: fixtures.registry, session, workspaceRoot: root });
		const result = await policy.clearBatch(input);
		expect(result.decisions.map((decision) => decision.kind)).toEqual(["block", "block", "block", "argument_guard"]);
		expect(result.decisions[0]).toMatchObject({ reason: "writes are disabled by policy" });
		expect(result.decisions[1]).toMatchObject({ reason: "Tool arguments are schema-invalid" });
		expect(result.decisions[2]).toMatchObject({ reason: expect.stringContaining("escapes") });
		expect(result.decisions[3]).toMatchObject({ effectiveArgs: { path: "inside.txt" } });
		await session.close();
	});

	it("blocks a batch when matching rules conflict", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_030_000_000_000 });
		const conflicting = adaptiveBundle(computeToolCatalogFingerprint(fixedTools()), {
			toolRules: [
				{ id: "allow-reads", toolName: "read", decision: { kind: "allow", reasonCodes: [] } },
				{ id: "block-reads", toolName: "read", decision: { kind: "block", reason: "reads off", reasonCodes: [] } },
			],
		});
		const { session, fixtures, input } = await makeClearanceFixture(repo, {
			id: "conflict",
			bundle: conflicting,
			calls: [{ name: "read", args: { path: "a.ts" } }],
		});
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const result = await policy.clearBatch(input);
		expect(result.decisions[0]).toMatchObject({
			kind: "block",
			reason: "Conflicting policy rules matched the tool call",
		});
		await session.close();
	});

	it("blocks the whole batch when the tool budget is exhausted", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_040_000_000_000 });
		const tight = adaptiveBundle(computeToolCatalogFingerprint(fixedTools()), {
			budgets: { maxTurns: 8, maxToolCalls: 1, maxTokens: 100_000 },
			toolRules: [],
		});
		const { session, fixtures, input } = await makeClearanceFixture(repo, {
			id: "budget",
			bundle: tight,
			calls: [
				{ name: "read", args: { path: "a" } },
				{ name: "read", args: { path: "b" } },
			],
		});
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const result = await policy.clearBatch(input);
		expect(result.decisions.every((decision) => decision.kind === "block")).toBe(true);
		expect(result.decisions[0]).toMatchObject({ reason: expect.stringContaining("budget exhausted") });
		await session.close();
	});

	it("projects once per batch, independent of call count", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_050_000_000_000 });
		const { session, fixtures, input } = await makeClearanceFixture(repo, {
			calls: [
				{ name: "read", args: { path: "a" } },
				{ name: "read", args: { path: "b" } },
				{ name: "read", args: { path: "c" } },
			],
		});
		const projector = new CountingProjector({ registry: fixtures.registry, cache: new MemoryProjectionCache() });
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
			projector,
		});
		await policy.clearBatch(input);
		expect(projector.count).toBe(1);
		await session.close();
	});

	it("fails closed on catalog drift, missing bundles and timeouts", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_060_000_000_000 });

		// Catalog drift: tools that no longer match the pinned catalog.
		const drifted = await makeClearanceFixture(repo, { id: "drift", calls: [{ name: "read", args: { path: "a" } }] });
		const driftInput: AdaptiveToolClearanceInput = {
			...drifted.input,
			tools: [{ ...fixedTools()[0]!, description: "changed description" }, ...fixedTools().slice(1)],
		};
		const driftPolicy = new AdaptiveToolPolicyAdapter({
			registry: drifted.fixtures.registry,
			session: drifted.session,
			workspaceRoot: workspace(),
		});
		await expect(driftPolicy.clearBatch(driftInput)).rejects.toMatchObject({ name: "PolicyProjectionFault" });
		await drifted.session.close();

		// Missing bundle: the pinned ref resolves to nothing.
		const missing = await makeClearanceFixture(repo, {
			id: "missing-bundle",
			refOverride: { version: "ghost", fingerprint: "f".repeat(64) },
			calls: [{ name: "read", args: { path: "a" } }],
		});
		const missingPolicy = new AdaptiveToolPolicyAdapter({
			registry: missing.fixtures.registry,
			session: missing.session,
			workspaceRoot: workspace(),
		});
		await expect(missingPolicy.clearBatch(missing.input)).rejects.toMatchObject({ name: "PolicyProjectionFault" });
		await missing.session.close();

		// Timeout: a registry that answers slower than the policy budget.
		const slow = await makeClearanceFixture(repo, { id: "timeout", calls: [{ name: "read", args: { path: "a" } }] });
		const slowRegistry = {
			resolve: async (ref: { version: string; fingerprint: string }) => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return slow.fixtures.registry.resolve(ref);
			},
			publish: slow.fixtures.registry.publish.bind(slow.fixtures.registry),
			list: slow.fixtures.registry.list.bind(slow.fixtures.registry),
			close: slow.fixtures.registry.close.bind(slow.fixtures.registry),
		} satisfies PolicyRegistry;
		const slowPolicy = new AdaptiveToolPolicyAdapter({
			registry: slowRegistry,
			session: slow.session,
			workspaceRoot: workspace(),
			policyTimeoutMs: 5,
		});
		await expect(slowPolicy.clearBatch(slow.input)).rejects.toMatchObject({ name: "PolicyProjectionFault" });
		await slow.session.close();
	});

	it("caps replay declarations at the tool's own declaration", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_070_000_000_000 });
		const tools = fixedTools();
		const safeTool = { ...tools[0]!, replay: "safe" as const };
		const catalog = [safeTool, ...tools.slice(1)];
		const fingerprint = computeToolCatalogFingerprint(catalog);
		const bundle = adaptiveBundle(fingerprint, {
			toolRules: [
				{ id: "allow-safe", toolName: "read", decision: { kind: "allow", reasonCodes: [], replay: "safe" } },
			],
		});
		const { session, fixtures, input } = await makeClearanceFixture(repo, {
			id: "replay-cap",
			bundle,
			calls: [{ name: "read", args: { path: "a" } }],
		});
		input.tools = catalog;
		const policy = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const result = await policy.clearBatch(input);
		expect(result.decisions[0]).toMatchObject({ kind: "allow", replay: "safe" });
		await session.close();
	});

	it("permissive baseline shares the projection but skips adaptive rules", async () => {
		const repo = new InMemorySessionRepo({ now: () => 4_080_000_000_000 });
		const fixtures = await createBundleFixtures();
		const { session, input } = await makeClearanceFixture(repo, {
			fixtures,
			bundle: fixtures.adaptiveBundle,
			calls: [
				{ name: "write", args: { path: "out.txt", content: "x" } },
				{ name: "read", args: { path: "sub/../a" } },
			],
		});
		const permissive = new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session });
		const adaptive = new AdaptiveToolPolicyAdapter({
			registry: fixtures.registry,
			session,
			workspaceRoot: workspace(),
		});
		const permissiveResult = await permissive.clearBatch(input);
		const adaptiveResult = await adaptive.clearBatch(input);
		// Same projection basis: same real state fingerprint, no fixed fake.
		expect(permissiveResult.policyStateFingerprint).toBe(adaptiveResult.policyStateFingerprint);
		expect(permissiveResult.policyStateFingerprint).toMatch(/^[0-9a-f]{64}$/);
		// Permissive allows the write and leaves the read args untouched.
		expect(permissiveResult.decisions).toEqual([
			{
				kind: "allow",
				sourceIndex: 0,
				toolCallId: "call-0",
				toolName: "write",
				effectiveArgs: { path: "out.txt", content: "x" },
				replay: "never",
			},
			{
				kind: "allow",
				sourceIndex: 1,
				toolCallId: "call-1",
				toolName: "read",
				effectiveArgs: { path: "sub/../a" },
				replay: "never",
			},
		]);
		expect(adaptiveResult.decisions.map((decision) => decision.kind)).toEqual(["block", "argument_guard"]);
		await session.close();
	});
});

describe("path canonicalization", () => {
	it("resolves, normalizes and rejects escapes lexically", () => {
		const root = "C:/ws/project";
		expect(canonicalizeWorkspacePath("a/b.txt", root)).toEqual({ kind: "inside", path: "a/b.txt" });
		expect(canonicalizeWorkspacePath("./a/../b.txt", root)).toEqual({ kind: "inside", path: "b.txt" });
		expect(canonicalizeWorkspacePath("a\\b\\..\\c.txt", root)).toEqual({ kind: "inside", path: "a/c.txt" });
		expect(canonicalizeWorkspacePath(`${root}/inner/deep.txt`, root)).toEqual({
			kind: "inside",
			path: "inner/deep.txt",
		});
		expect(canonicalizeWorkspacePath("../outside.txt", root).kind).toBe("escape");
		expect(canonicalizeWorkspacePath("a/../../outside.txt", root).kind).toBe("escape");
		expect(canonicalizeWorkspacePath("C:/elsewhere/x.txt", root).kind).toBe("escape");
		expect(canonicalizeWorkspacePath(`${root}/../outside.txt`, root).kind).toBe("escape");
		expect(canonicalizeWorkspacePath("", root)).toEqual({ kind: "inside", path: "." });
	});
});

describe.each(["sequential", "parallel"] as const)("adaptive clearance in a $execution harness", (execution) => {
	it("stores one fingerprint per batch and keeps source-ordered decisions", async () => {
		const faux = fauxProvider({ provider: `policy-${execution}`, api: `policy-${execution}-api` });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 4_090_000_000_000 });
		const session = await repo.create({ id: `policy-${execution}` });
		const fixtures = await createBundleFixtures();
		const executed: string[] = [];
		const tools = fixedTools({ record: (name) => executed.push(name) }) as unknown as AgentHarnessTool<undefined>[];
		const { harness } = await AgentHarness.create<undefined>({
			session,
			models,
			model,
			tools,
			activeToolNames: ["read", "write", "edit", "bash"],
			toolExecution: execution,
			adaptiveToolPolicy: new AdaptiveToolPolicyAdapter({
				registry: fixtures.registry,
				session,
				workspaceRoot: workspace(),
			}),
		});
		const basis: HarnessV4LeafTurnBasis = {
			schemaVersion: 1,
			taskId: "task",
			candidateId: "candidate",
			policyBundle: fixtures.adaptive,
			projectorVersion: PROJECTOR_VERSION,
			inheritedPolicyState: createOriginCapsule({
				taskId: "task",
				candidateId: "candidate",
				sessionId: session.metadata.id,
				lane: "main",
				policyBundle: fixtures.adaptive,
				snapshot: originSnapshot(fixtures.adaptiveBundle),
			}),
			start: { kind: "prompt" },
		};
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" }), fauxToolCall("bash", { command: "echo hi" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const start = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		if (!start.ok || start.value.kind !== "turn") throw new Error("expected a turn");
		expect(start.value.turn.toolResults.map((result) => result.toolName)).toEqual(["read", "bash"]);
		const batchEntry = await session.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
		const data =
			batchEntry?.type === "custom"
				? (batchEntry.data as { policyStateFingerprint?: string; decisions?: unknown[] })
				: undefined;
		expect(data?.policyStateFingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(data?.decisions).toHaveLength(2);
		await harness.close();
	});

	it("keeps the same batch fingerprint for sequential and parallel batches", async () => {
		const fingerprints: string[] = [];
		for (const mode of ["sequential", "parallel"] as const) {
			const faux = fauxProvider({ provider: `fingerprint-${mode}`, api: `fingerprint-${mode}-api` });
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel() as Model<Api>;
			const repo = new InMemorySessionRepo({ now: () => 4_095_000_000_000 });
			const session = await repo.create({ id: `fingerprint-${mode}` });
			const fixtures = await createBundleFixtures();
			const tools = fixedTools() as unknown as AgentHarnessTool<undefined>[];
			const { harness } = await AgentHarness.create<undefined>({
				session,
				models,
				model,
				tools,
				activeToolNames: ["read", "write", "edit", "bash"],
				toolExecution: mode,
				adaptiveToolPolicy: new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session }),
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
			const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const start = await adapter.execute({ kind: "start", prompt: userMessage("work") });
			if (!start.ok || start.value.kind !== "turn") throw new Error("expected a turn");
			const batchEntry = await session.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
			const data =
				batchEntry?.type === "custom" ? (batchEntry.data as { policyStateFingerprint?: string }) : undefined;
			fingerprints.push(data?.policyStateFingerprint ?? "");
			await harness.close();
		}
		expect(fingerprints[0]).toBe(fingerprints[1]);
	});

	it("reports a policy fault as blocked results with zero effects", async () => {
		const faux = fauxProvider({ provider: "policy-fault", api: "policy-fault-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = new InMemorySessionRepo({ now: () => 4_100_000_000_000 });
		const session = await repo.create({ id: "policy-fault" });
		const fixtures = await createBundleFixtures();
		const executed: string[] = [];
		const tools = fixedTools({ record: (name) => executed.push(name) }) as unknown as AgentHarnessTool<undefined>[];
		const { harness } = await AgentHarness.create<undefined>({
			session,
			models,
			model,
			tools,
			activeToolNames: ["read", "write", "edit", "bash"],
			adaptiveToolPolicy: new AdaptiveToolPolicyAdapter({
				registry: fixtures.registry,
				session,
				workspaceRoot: workspace(),
			}),
		});
		// Basis pins a bundle that was never published: projection fault.
		const ghostRef = { version: "ghost", fingerprint: "a".repeat(64) };
		const basis: HarnessV4LeafTurnBasis = {
			schemaVersion: 1,
			taskId: "task",
			candidateId: "candidate",
			policyBundle: ghostRef,
			projectorVersion: PROJECTOR_VERSION,
			inheritedPolicyState: createOriginCapsule({
				taskId: "task",
				candidateId: "candidate",
				sessionId: session.metadata.id,
				lane: "main",
				policyBundle: ghostRef,
				snapshot: originSnapshot(fixtures.permissiveBundle),
			}),
			start: { kind: "prompt" },
		};
		const adapter = new HarnessV4LeafTurnAdapter({ lane: harness, basis });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const start = await adapter.execute({ kind: "start", prompt: userMessage("work") });
		if (!start.ok || start.value.kind !== "turn") throw new Error("expected a turn");
		expect(start.value.turn.toolResults).toHaveLength(1);
		expect(start.value.turn.toolResults[0]).toMatchObject({ isError: true });
		expect(executed).toHaveLength(0);
		const batchEntry = await session.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
		const data = batchEntry?.type === "custom" ? (batchEntry.data as { policyStateFingerprint?: string }) : undefined;
		expect(data?.policyStateFingerprint).toBe("policy-fault");
		await harness.close();
	});
});
