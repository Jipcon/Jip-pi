import {
	type Api,
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import {
	AgentHarness,
	type LaneConfiguration,
	type Operation,
	type RunState,
	type Session,
	type Transaction,
} from "../../src/harness-v4.ts";
import type { AgentMessage } from "../../src/types.ts";
import { type V4SessionRepo, v4Backends } from "./fixtures/v4-jsonl-backends.ts";

const CONFIGURATION: LaneConfiguration = {
	model: { provider: "recovery-provider", modelId: "faux-1" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function textOf(message: unknown): string {
	const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function createRuntimeWithRepo(repo: V4SessionRepo) {
	const faux = fauxProvider({ provider: "recovery-provider", api: "recovery-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const session = await repo.create({ id: "recovery" });
	const { harness } = await AgentHarness.create({ session, models, model });
	return { faux, harness, model, models, repo, session };
}

/** Blocks the provider until the operation signal aborts, then resolves. */
function blockingProviderStep(firstRequest: { promise: Promise<void>; resolve: () => void }) {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
		firstRequest.resolve();
		return new Promise<AssistantMessage>((resolve) => {
			const finish = () => resolve(fauxAssistantMessage(""));
			if (options?.signal?.aborted) {
				finish();
				return;
			}
			options?.signal?.addEventListener("abort", finish, { once: true });
		});
	};
}

interface SuspendedFixture {
	session: Session;
	operationId: string;
}

async function createSuspendedRunBase(
	repo: V4SessionRepo,
	id: string,
	phaseFactory: (promptEntryId: string) => RunState["phase"],
	extra?: {
		inbox?: RunState["inbox"];
		pendingEntries?: Array<{ id: string; message: AgentMessage }>;
		assistantEntries?: Array<{ id: string; message: AssistantMessage }>;
		latestAssistantEntryId?: string | null;
		control?: RunState["control"];
	},
): Promise<SuspendedFixture> {
	const session = await repo.create({ id });
	const promptEntryId = await session.appendMessage(userMessage("hello"));
	let parentId = promptEntryId;
	for (const entry of extra?.assistantEntries ?? []) {
		const message = JSON.parse(JSON.stringify(entry.message)) as AssistantMessage;
		await session.commit({
			writes: [{ kind: "entry", entry: { id: entry.id, parentId, type: "message", message: message as never } }],
		});
		parentId = entry.id;
	}
	const operationId = "operation";
	const operation: Operation = {
		operationId,
		lane: "main",
		sourceLeafId: null,
		startedAt: 10,
		intent: { kind: "run", promptEntryIds: [promptEntryId] },
	};
	const state: RunState = {
		kind: "run",
		control: extra?.control ?? { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			toolExecution: "parallel",
		},
		phase: phaseFactory(promptEntryId),
		inbox: extra?.inbox ?? { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: extra?.latestAssistantEntryId === undefined ? null : extra?.latestAssistantEntryId,
	};
	const writes: Transaction["writes"] = [
		{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: CONFIGURATION },
		{
			kind: "register",
			op: "set",
			namespace: "lane.state",
			key: "main",
			value: { currentOperationId: operationId, pendingNextRun: [] },
		},
		{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
		{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
	];
	for (const entry of extra?.pendingEntries ?? []) {
		writes.push({
			kind: "register",
			op: "set",
			namespace: "pending.entry",
			key: entry.id,
			value: { type: "message", payload: entry.message as never },
		});
	}
	await session.commit({ writes });
	return { session, operationId };
}

describe.each(v4Backends())("Harness v4 R6 abort recovery ($name backend)", (backend) => {
	async function createRuntime() {
		return createRuntimeWithRepo(backend.create({ now: () => 2_500_000_000_000 }));
	}

	async function createSuspendedRun(
		id: string,
		phaseFactory: (promptEntryId: string) => RunState["phase"],
		extra?: Parameters<typeof createSuspendedRunBase>[3],
	): Promise<SuspendedFixture> {
		return createSuspendedRunBase(backend.create({ now: () => 2_600_000_000_000 }), id, phaseFactory, extra);
	}

	it("reopens a cancelled live assistant effect without replaying the provider and settles the reserved ids", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const aborted = await harness.abort();
		const runId = aborted.ok ? aborted.value.runId : "";
		// Durable: cancelled control with the effect still pending.
		const state = await session.getRegister("op.state", runId);
		expect(state?.value).toMatchObject({
			control: { status: "cancel_requested" },
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});
		// Close lands before the settlement: the caller observes the closed
		// error and the settlement never commits.
		const closedResult = await Promise.all([harness.close(), run]).then(([, result]) => result);
		expect(closedResult).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		const metadata = structuredClone(session.metadata);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted", runId } });
		expect(faux.state.callCount).toBe(1);
		const finalEntryId = resumed.ok ? (resumed.value as { finalEntryId?: string }).finalEntryId : undefined;
		expect(finalEntryId).toEqual(expect.any(String));
		const entry = finalEntryId === undefined ? undefined : await reopenedSession.getEntry(finalEntryId);
		expect(entry).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "aborted" } });
		expect(await reopenedSession.getRegister("op.state", runId)).toBeUndefined();
		await reopened.close();
	});

	it("reopens a cancelled live tool batch and settles interrupted synthetics without replay", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const executions: string[] = [];
		const tool: AgentHarnessTool<undefined> = {
			name: "read",
			description: "read tool",
			label: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_id: string, args: { path: string }, signal: AbortSignal | undefined) => {
				executions.push(args.path);
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("tool aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
				});
				return { content: [{ type: "text", text: "must not complete" }], details: {} };
			},
		};
		await harness.setTools([tool]);
		await harness.setActiveTools(["read"]);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })]);
		const run = harness.prompt("hello");
		await vi.waitFor(() => expect(executions).toEqual(["x"]));
		await harness.abort();
		await Promise.all([harness.close(), run]).then(([, result]) => {
			expect(result).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		});
		const metadata = structuredClone(session.metadata);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(executions).toEqual(["x"]);
		const toolResults = (await reopenedSession.findEntries({ type: "message", order: "asc" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		const message = toolResults[0]?.type === "message" ? toolResults[0].message : undefined;
		expect(textOf(message)).toContain("was interrupted before settlement");
		await reopened.close();
	});

	it("keeps drained queue entries across the crash and deletes them only at the reopened terminal", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const steerResult = await harness.steer("queued before abort");
		const steerId = steerResult.ok ? steerResult.value.entryId : "";
		const aborted = await harness.abort();
		expect(aborted.ok && aborted.value.steer.map(textOf)).toEqual(["queued before abort"]);
		// The drained pending register survives the crash.
		expect(await session.getRegister("pending.entry", steerId)).toBeDefined();
		await Promise.all([harness.close(), run]).then(([, result]) => {
			expect(result).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		});
		const metadata = structuredClone(session.metadata);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(await reopenedSession.getRegister("pending.entry", steerId)).toBeUndefined();
		expect(await reopenedSession.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { outcome: "aborted" },
		});
		await reopened.close();
	});

	it("applies writes accepted before the crash at the reopened cancellation checkpoint", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const writeId = await harness.session.appendMessage(userMessage("pre-crash write"));
		await harness.abort();
		await Promise.all([harness.close(), run]).then(([, result]) => {
			expect(result).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		});
		const metadata = structuredClone(session.metadata);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(await reopenedSession.getEntry(writeId)).toMatchObject({ type: "message" });
		expect(await reopenedSession.getRegister("pending.entry", writeId)).toBeUndefined();
		await reopened.close();
	});

	it("rejects new steering against a cancelled operation restored from storage", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		await harness.abort();
		await Promise.all([harness.close(), run]).then(([, result]) => {
			expect(result).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		});
		const metadata = structuredClone(session.metadata);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		expect(await reopened.steer("after crash")).toMatchObject({ ok: false, error: { _tag: "NoActiveRun" } });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		await reopened.close();
	});

	it("finishes an aborted restored retry_wait without re-sleeping after reopen", async () => {
		const { faux, model, models } = await createRuntime();
		const { session } = await createSuspendedRun(
			"recovery-retry-wait",
			(promptEntryId) => ({
				kind: "assistant",
				generation: {
					status: "retry_wait",
					context: {
						stepId: "step",
						triggerEntryId: promptEntryId,
						configuration: CONFIGURATION,
						streamOptions: {},
						retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
						overflowRecoveryUsed: false,
					},
					nextAttempt: 2,
					notBefore: Date.now() + 60_000,
					errorMessage: "transient",
				},
			}),
			{ control: { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] } },
		);
		const { harness } = await AgentHarness.create({ session, models, model });
		const resumed = await harness.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(faux.state.callCount).toBe(0);
		await harness.close();
	});

	it("allows a fresh runtime to retry the best-effort deferred cancellation after a crashed attempt", async () => {
		const { faux, model, models } = await createRuntime();
		const deferredHandle = {
			provider: "recovery-provider",
			modelId: "faux-1",
			api: "recovery-api",
			id: "deferred-id",
		};
		const makeFixture = async (id: string) => {
			const sourceEntryId = `${id}-source`;
			return createSuspendedRun(
				id,
				(_promptEntryId) => ({
					kind: "deferred",
					deferred: {
						status: "suspended",
						stepId: "step",
						sourceEntryId,
						poll: 0,
						configuration: CONFIGURATION,
						streamOptions: {},
					},
				}),
				{
					assistantEntries: [
						{
							id: sourceEntryId,
							message: fauxAssistantMessage("later", {
								stopReason: "deferred",
								deferred: structuredClone(deferredHandle),
							}),
						},
					],
					control: { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] },
				},
			);
		};
		// Each process-local runtime performs at most one best-effort attempt;
		// a fresh runtime (reopen) is allowed to try again.
		const firstFixture = await makeFixture("recovery-deferred-one");
		const { harness: firstHarness } = await AgentHarness.create({ session: firstFixture.session, models, model });
		const first = await firstHarness.resume();
		expect(first).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(faux.state.cancelledDeferred).toHaveLength(1);
		await firstHarness.close();

		const secondFixture = await makeFixture("recovery-deferred-two");
		const { harness: secondHarness } = await AgentHarness.create({ session: secondFixture.session, models, model });
		const second = await secondHarness.resume();
		expect(second).toMatchObject({ ok: true, value: { operation: "run", kind: "aborted" } });
		expect(faux.state.cancelledDeferred).toHaveLength(2);
		expect(faux.state.callCount).toBe(0);
		await secondHarness.close();
	});
});
