import {
	type Api,
	type AssistantMessage,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type CommitResult,
	HarnessFaultError,
	type Session,
	type Transaction,
} from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";
import { type V4SessionRepo, v4Backends } from "./fixtures/v4-jsonl-backends.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

async function createRuntimeWithRepo(
	repo: V4SessionRepo,
	options: { drive?: "automatic" | "manual"; instrument?: boolean } = {},
) {
	const faux = fauxProvider({ provider: "close-provider", api: "close-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const raw = await repo.create({ id: "close" });
	const session = options.instrument === true ? new InstrumentedSession(raw) : raw;
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
	});
	return { faux, harness, model, models, repo, session };
}

/** Blocks the provider until the operation signal aborts or a manual release fires. */
function blockingProviderStep(
	firstRequest: { promise: Promise<void>; resolve: () => void },
	release?: { promise: Promise<void>; resolve: () => void },
) {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
		firstRequest.resolve();
		return new Promise<AssistantMessage>((resolve) => {
			const finish = () => resolve(fauxAssistantMessage(""));
			if (options?.signal?.aborted) {
				(release === undefined ? Promise.resolve() : release.promise).then(finish);
				return;
			}
			options?.signal?.addEventListener(
				"abort",
				() => {
					(release === undefined ? Promise.resolve() : release.promise).then(finish);
				},
				{ once: true },
			);
			// External-finalization tests release without pulling the signal.
			release?.promise.then(() => {
				if (!options?.signal?.aborted) finish();
			});
		});
	};
}

class FailingSession extends InstrumentedSession {
	private readonly failAt: number;
	private commitCount = 0;

	constructor(inner: Session, failAt: number) {
		super(inner);
		this.failAt = failAt;
	}

	override async commit(transaction: Transaction): Promise<CommitResult> {
		this.commitCount++;
		if (this.commitCount >= this.failAt) throw new Error("storage boom");
		return super.commit(transaction);
	}
}

describe.each(v4Backends())("Harness v4 R6 close and fault ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 2_700_000_000_000 }), options);
	}

	it("performs zero durable writes during close", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		faux.setResponses([fauxAssistantMessage("done")]);
		await harness.prompt("hello");
		const instrumented = session as InstrumentedSession;
		const before = instrumented.commits().length;
		await harness.close();
		expect(instrumented.commits().length).toBe(before);
	});

	it("rejects unaccepted Result APIs after close with Closed", async () => {
		const { harness } = await createRuntime();
		await harness.close();
		expect(await harness.prompt("late")).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(await harness.steer("late")).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(await harness.nextRun("late")).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(await harness.abort()).toMatchObject({ ok: false, error: { _tag: "Closed" } });
	});

	it("rejects an accepted in-flight promise when close lands before settlement", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime();
		const firstRequest = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const closed = await Promise.all([harness.close(), run]).then(([, result]) => result);
		expect(closed).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		const metadata = structuredClone(session.metadata);
		const reopenedSession = await repo.open(metadata);

		// Close wrote no cancel marker and no terminal result: the durable
		// state remains effect_pending under a running control.
		const laneState = await reopenedSession.getRegister("lane.state", "main");
		expect(laneState?.value.currentOperationId).toEqual(expect.any(String));
		const state = await reopenedSession.getRegister("op.state", laneState?.value.currentOperationId ?? "");
		expect(state?.value).toMatchObject({
			control: { status: "running" },
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});
		expect(await reopenedSession.getRegister("lane.lastResult", "main")).toBeUndefined();

		// Reopen walks unknown-effect recovery without replaying the provider.
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		const resumed = await reopened.resume();
		expect(resumed).toMatchObject({ ok: true, value: { operation: "run", kind: "failed" } });
		expect(faux.state.callCount).toBe(1);
		await reopened.close();
	});

	it("allows a settlement admitted before close to commit normally", async () => {
		const { faux, harness, session } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("settled")]);
		const result = await harness.prompt("hello");
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { outcome: "completed" },
		});
		await harness.close();
	});

	it("rejects parked manual actions on close", async () => {
		const { faux, harness } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("manual")]);
		const run = harness.prompt("hello");
		await vi.waitFor(async () => {
			expect(await harness.peekAction()).toBeDefined();
		});
		const closed = await Promise.all([harness.close(), run]).then(([, result]) => result);
		expect(closed).toMatchObject({ ok: false, error: { _tag: "Closed" } });
	});

	it("close is idempotent", async () => {
		const { harness } = await createRuntime();
		const first = harness.close();
		const second = harness.close();
		expect(second).toBe(first);
		await first;
		await expect(harness.close()).resolves.toBeUndefined();
	});

	it("faults on a failed storage commit and propagates HarnessFault", async () => {
		const faux = fauxProvider({ provider: "fault-provider", api: "fault-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_710_000_000_000 });
		const raw = await repo.create({ id: "fault" });
		const session = new FailingSession(raw, 2);
		const { harness } = await AgentHarness.create({ session, models, model });
		const faults: unknown[] = [];
		harness.events.on("fault", (event) => {
			faults.push(event);
		});
		await expect(harness.prompt("hello")).rejects.toBeInstanceOf(HarnessFaultError);
		expect(faults).toHaveLength(1);
		await expect(harness.prompt("again")).rejects.toBeInstanceOf(HarnessFaultError);
		await harness.close();
	});
});

describe.each(v4Backends())("Harness v4 R6 external finalization ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 2_700_000_000_000 }), options);
	}

	it("stops a live driver, discards process output, and resolves from lane.lastResult", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const open = await harness.getOpenOperation();
		const operationId = open?.operationId ?? "";
		expect(operationId).not.toBe("");
		const runEnds: unknown[] = [];
		harness.events.on("run_end", (event) => {
			runEnds.push(event);
		});
		// External writer finalizes the operation without the harness.
		await session.commit({
			writes: [
				{ kind: "register", op: "delete", namespace: "op.meta", key: operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: operationId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.lastResult",
					key: "main",
					value: {
						operationId,
						kind: "run",
						leafId: null,
						outcome: "completed",
						runCompletion: "assistant",
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		});
		const instrumented = session as InstrumentedSession;
		const before = instrumented.commits().length;
		// The live provider effect completes after the external terminal; its
		// process-local output must be discarded without any write.
		release.resolve();

		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		// No additional durable writes and exactly one end event.
		expect(instrumented.commits().length).toBe(before);
		expect(runEnds).toHaveLength(1);
		// The operation is not rebuilt.
		expect(await harness.getOpenOperation()).toBeNull();
		await harness.close();
	});

	it("returns NothingToResume for a suspended operation that was externally finalized", async () => {
		const { model, models, session } = await createRuntime();
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const operationId = "operation";
		await session.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: operationId, pendingNextRun: [] },
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.meta",
					key: operationId,
					value: {
						operationId,
						lane: "main",
						sourceLeafId: null,
						startedAt: 10,
						intent: { kind: "run", promptEntryIds: [promptEntryId] },
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: {
						kind: "run",
						control: { status: "running" },
						settings: {
							compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
							steeringMode: "one-at-a-time",
							followUpMode: "one-at-a-time",
							toolExecution: "parallel",
						},
						phase: {
							kind: "checkpoint",
							continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId: promptEntryId,
						},
						inbox: { steer: [], followUp: [], writes: [] },
						latestAssistantEntryId: null,
					},
				},
			],
		});
		const { harness } = await AgentHarness.create({ session, models, model });
		// External terminal of the suspended operation.
		await session.commit({
			writes: [
				{ kind: "register", op: "delete", namespace: "op.meta", key: operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: operationId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.lastResult",
					key: "main",
					value: { operationId, kind: "run", leafId: promptEntryId, outcome: "aborted" },
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		});
		expect(await harness.resume()).toMatchObject({ ok: false, error: { _tag: "NothingToResume" } });
		expect(await harness.getLastResult()).toMatchObject({ operationId, outcome: "aborted" });
		await harness.close();
	});

	it("treats a vanished operation without a matching lastResult as durable corruption", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const operationId = (await harness.getOpenOperation())?.operationId ?? "";
		await session.commit({
			writes: [
				{ kind: "register", op: "delete", namespace: "op.meta", key: operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: operationId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.lastResult",
					key: "main",
					value: { operationId: "someone-else", kind: "run", leafId: null, outcome: "aborted" },
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		});
		release.resolve();
		await expect(run).rejects.toMatchObject({ code: "corruption" });
		await harness.close();
	});
});
