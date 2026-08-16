import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness, type RunResult } from "../../src/harness-v4.ts";
import type { AgentMessage } from "../../src/types.ts";
import { type V4SessionRepo, v4Backends } from "./fixtures/v4-jsonl-backends.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function textOf(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	if (typeof message.content === "string") return message.content;
	const part = message.content.find((candidate) => candidate.type === "text");
	return part?.type === "text" ? part.text : undefined;
}

async function createRuntimeWithRepo(
	repo: V4SessionRepo,
	options: { drive?: "automatic" | "manual"; steeringMode?: "all" | "one-at-a-time" } = {},
) {
	const faux = fauxProvider({ provider: "r5-recovery", api: "r5-recovery-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const session = await repo.create({ id: `r5-recovery-${Math.random().toString(36).slice(2, 8)}` });
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
	});
	return { faux, harness, model, models, repo, session };
}

type SettledRunValue = Exclude<Extract<RunResult, { ok: true }>["value"], { kind: "suspended" }>;

function requireSuccess(result: RunResult): SettledRunValue {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R5 Run");
	return result.value;
}

function requireResumeSuccess(
	result: Awaited<ReturnType<AgentHarness["resume"]>>,
): Exclude<Extract<Awaited<ReturnType<AgentHarness["resume"]>>, { ok: true }>["value"], { kind: "suspended" }> {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R5 resume");
	return result.value;
}

async function executeUntil(harness: AgentHarness, kind: string): Promise<void> {
	await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe(kind));
	expect((await harness.executeAction())?.kind).toBe(kind);
}

describe.each(v4Backends())("Harness v4 R5 drain recovery ($name backend)", (backend) => {
	async function createRuntime(options: Parameters<typeof createRuntimeWithRepo>[1] = {}) {
		return createRuntimeWithRepo(backend.create({ now: () => 2_100_000_000_000 }), options);
	}

	it("does not double-consume after a one-at-a-time drain crash before generation", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({
			drive: "manual",
			steeringMode: "one-at-a-time",
		});
		const contexts: Context[] = [];
		faux.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("second");
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("third");
			},
		]);

		const pending = harness.prompt("hello");
		await executeUntil(harness, "commit_transition");
		const steerOne = await harness.steer(userMessage("steer one"));
		const steerTwo = await harness.steer(userMessage("steer two"));
		const steerOneId = (steerOne as { ok: true; value: { entryId: string } }).value.entryId;
		const steerTwoId = (steerTwo as { ok: true; value: { entryId: string } }).value.entryId;

		// Steer admissions invalidated the planned transition; the drive replans.
		await executeUntil(harness, "commit_transition");
		await executeUntil(harness, "commit_transition");
		await executeUntil(harness, "assistant");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await executeUntil(harness, "commit_effect_settlement");
		await executeUntil(harness, "commit_inbox_drain");
		// Crash boundary: drain consumed only the oldest steer and set
		// skipInboxOnce; generation has not started.
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(1);
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			drive: "manual",
		});
		const laneState = await reopenedSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId;
		expect(operationId).not.toBeNull();
		const operationState = await reopenedSession.getRegister("op.state", operationId!);
		expect(operationState?.value).toMatchObject({
			kind: "run",
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant" },
				skipInboxOnce: true,
			},
			inbox: { steer: [steerTwoId], followUp: [], writes: [] },
		});
		expect(await reopenedSession.getEntry(steerOneId)).toBeDefined();
		expect(await reopenedSession.getRegister("pending.entry", steerOneId)).toBeUndefined();
		expect(await reopenedSession.getRegister("pending.entry", steerTwoId)).toBeDefined();

		// The resumed drive starts generation directly: the drained steer is
		// never re-consumed and steer two waits for the next boundary.
		const resumed = reopened.resume();
		await vi.waitFor(async () => expect((await reopened.peekAction())?.kind).toBe("commit_transition"));
		await reopened.runToCompletion();
		expect(requireResumeSuccess(await resumed)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "third" }] },
		});
		expect(faux.state.callCount).toBe(3);
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"hello",
			"first",
			"steer one",
		]);
		expect(contexts[1]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"hello",
			"first",
			"steer one",
			"second",
			"steer two",
		]);
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const steerOneEntries = branch.filter((entry) => entry.id === steerOneId);
		expect(steerOneEntries).toHaveLength(1);
		await reopened.close();
	});

	it("applies a deferred write after close and reopen with its reserved id", async () => {
		const faux = fauxProvider({ provider: "r5-write-recovery", api: "r5-write-recovery-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const repo = backend.create({ now: () => 2_110_000_000_000 });
		const session = await repo.create({ id: "r5-write-recovery" });
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const firstResponse: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "first" }],
			api: "r5-write-recovery-api",
			provider: "r5-write-recovery",
			model: "faux-1",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		};
		const responseEntryId = await session.appendMessage(firstResponse);
		const writeId = session.idGenerator.next();
		const operationId = "operation";
		await session.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "main",
					value: {
						model: { provider: "r5-write-recovery", modelId: "faux-1" },
						thinkingLevel: "off",
						activeToolNames: [],
					},
				},
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
						startedAt: 1,
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
							continuation: { kind: "may_finish", includeFinalAssistant: true },
							triggerEntryId: responseEntryId,
						},
						inbox: { steer: [], followUp: [], writes: [writeId] },
						latestAssistantEntryId: responseEntryId,
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: writeId,
					value: { type: "message", payload: userMessage("deferred note") },
				},
			],
		});

		// Crash boundary: the deferred write survived in inbox + pending register.
		const { harness, suspended } = await AgentHarness.create({ session, models, model });
		expect(suspended).toHaveLength(1);
		expect(await session.getRegister("pending.entry", writeId)).toBeDefined();

		faux.setResponses([fauxAssistantMessage("final")]);
		const value = requireResumeSuccess(await harness.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "final" }] } });
		expect(faux.state.callCount).toBe(1);
		const entry = await session.getEntry(writeId);
		expect(entry).toMatchObject({ type: "message", message: userMessage("deferred note") });
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		await harness.close();
	});

	it("re-runs before_run_end only at new finish boundaries after a crash", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		let hookCalls = 0;
		harness.hooks.on("before_run_end", () => {
			hookCalls++;
			return hookCalls === 1 ? { followUp: "keep going" } : undefined;
		});
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const pending = harness.prompt("hello");
		await executeUntil(harness, "commit_transition");
		await executeUntil(harness, "commit_transition");
		await executeUntil(harness, "assistant");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await executeUntil(harness, "commit_effect_settlement");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("hook"));
		await executeUntil(harness, "hook");
		await vi.waitFor(() => expect(hookCalls).toBe(1));
		await executeUntil(harness, "commit_effect_settlement");
		// Crash boundary: follow-up committed with need_assistant + skipInboxOnce.
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(1);
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened } = await AgentHarness.create({ session: reopenedSession, models, model });
		let reopenedHookCalls = 0;
		reopened.hooks.on("before_run_end", () => {
			reopenedHookCalls++;
			return undefined;
		});
		expect(hookCalls).toBe(1);
		const value = requireResumeSuccess(await reopened.resume());
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "second" }] } });
		expect(faux.state.callCount).toBe(2);
		expect(hookCalls).toBe(1);
		expect(reopenedHookCalls).toBe(1);
		const branch = await reopened.session.findEntriesOnBranch({ order: "oldestFirst" });
		const followUps = branch.filter((entry) => entry.type === "message" && textOf(entry.message) === "keep going");
		expect(followUps).toHaveLength(1);
		await reopened.close();
	});

	it("produces equivalent durable results in automatic and manual mode with queue input", async () => {
		const outcomes: Array<{
			lastResult: unknown;
			entries: unknown[];
			usage: unknown[];
		}> = [];
		for (const drive of ["automatic", "manual"] as const) {
			const { faux, harness } = await createRuntime({ drive });
			let release: ((message: AssistantMessage) => void) | undefined;
			const blocked = new Promise<AssistantMessage>((resolve) => {
				release = resolve;
			});
			faux.setResponses([() => blocked, fauxAssistantMessage("after steer")]);
			const pending = harness.prompt("hello");
			if (drive === "manual") {
				await executeUntil(harness, "commit_transition");
				await executeUntil(harness, "commit_transition");
				await executeUntil(harness, "assistant");
			}
			await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
			await harness.steer(userMessage("steer input"));
			release?.(fauxAssistantMessage("first"));
			if (drive === "manual") {
				await harness.runToCompletion();
			}
			const value = requireSuccess(await pending);
			expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "after steer" }] } });
			const entries = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
			const lastResult = await harness.getLastResult();
			outcomes.push({
				lastResult: lastResult && {
					kind: lastResult.kind,
					outcome: lastResult.outcome,
				},
				entries: entries.map((entry) =>
					entry.type === "message"
						? {
								type: entry.type,
								role: entry.message.role,
								text: textOf(entry.message),
								stopReason: entry.message.role === "assistant" ? entry.message.stopReason : undefined,
							}
						: { type: entry.type, customType: entry.customType },
				),
				usage: (await harness.durableSession.scanUsage({ order: "asc" })).map((row) => ({
					totalTokens: row.usage.totalTokens,
					adjustment: row.adjustment,
				})),
			});
			await harness.close();
		}
		expect(outcomes[1]).toEqual(outcomes[0]);
	});
});
