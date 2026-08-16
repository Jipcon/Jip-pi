import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentHarness, InMemorySessionRepo, type RunResult, type Session } from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function textOf(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	if (typeof message.content === "string") return message.content;
	const part = message.content.find((candidate) => candidate.type === "text");
	return part?.type === "text" ? part.text : undefined;
}

async function createRuntime(
	options: {
		drive?: "automatic" | "manual";
		instrument?: boolean;
		steeringMode?: "all" | "one-at-a-time";
		followUpMode?: "all" | "one-at-a-time";
		entryProjectors?: Record<string, (entry: { type: "custom"; customType: string }) => AgentMessage[] | undefined>;
	} = {},
) {
	const faux = fauxProvider({ provider: "r5-provider", api: "r5-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 2_000_000_000_000 });
	const raw = await repo.create({
		id: `r5-inbox-${options.drive ?? "automatic"}-${Math.random().toString(36).slice(2, 8)}`,
	});
	const session: Session = options.instrument === true ? new InstrumentedSession(raw) : raw;
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
		...(options.followUpMode === undefined ? {} : { followUpMode: options.followUpMode }),
		...(options.entryProjectors === undefined ? {} : { entryProjectors: options.entryProjectors }),
	});
	return { faux, harness, model, models, repo, session };
}

type SettledRunValue = Exclude<Extract<RunResult, { ok: true }>["value"], { kind: "suspended" }>;

function requireSuccess(result: RunResult): SettledRunValue {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R5 Run");
	return result.value;
}

function expectPendingExclusive(session: Session, id: string): void {
	const instrumented = session as InstrumentedSession;
	for (const commit of instrumented.commits()) {
		const hasEntry = commit.writes.some((write) => write.kind === "entry" && write.entry.id === id);
		const hasRegister = commit.writes.some(
			(write) =>
				write.kind === "register" && write.namespace === "pending.entry" && write.op === "set" && write.key === id,
		);
		expect(hasEntry && hasRegister).toBe(false);
	}
}

async function executeUntil(harness: AgentHarness, kind: string): Promise<void> {
	await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe(kind));
	expect((await harness.executeAction())?.kind).toBe(kind);
}

describe("Harness v4 R5 deferred lane writes", () => {
	it("places an idle lane write immediately in one transaction", async () => {
		const { harness, session } = await createRuntime({ instrument: true });
		const beforeLeaf = await harness.session.getLeafId();
		const id = await harness.session.appendMessage(userMessage("idle note"));
		const entry = await harness.session.getEntry(id);
		expect(entry).toMatchObject({
			id,
			parentId: beforeLeaf,
			type: "message",
			message: userMessage("idle note"),
		});
		expect(await harness.session.getLeafId()).toBe(id);
		expect(await session.getRegister("pending.entry", id)).toBeUndefined();
		await harness.close();
	});

	it("defers open-Run message writes through pending.entry and projects them at the drain", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const contexts: Context[] = [];
		faux.setResponses([
			() => blocked,
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("after write");
			},
		]);
		const pendingEvents: string[] = [];
		harness.events.on("write_pending", (event) => {
			pendingEvents.push(event.entryId);
		});

		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const writeId = await harness.session.appendMessage(userMessage("mid-run note"));
		expect(await session.getRegister("pending.entry", writeId)).toMatchObject({
			value: { type: "message", payload: userMessage("mid-run note") },
		});
		// Deferred writes are not tree-visible before placement.
		expect(await harness.session.getEntry(writeId)).toBeUndefined();
		expectPendingExclusive(session, writeId);
		await vi.waitFor(() => expect(pendingEvents).toEqual([writeId]));

		release?.(fauxAssistantMessage("first"));
		expect(requireSuccess(await pendingRun)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "after write" }] },
		});
		expect(faux.state.callCount).toBe(2);
		// Placement reused the reserved id.
		expect(await harness.session.getEntry(writeId)).toMatchObject({
			type: "message",
			message: userMessage("mid-run note"),
		});
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"hello",
			"first",
			"mid-run note",
		]);
		await harness.close();
	});

	it("keeps unprojected custom writes out of provider context and moves the leaf", async () => {
		const { faux, harness, session } = await createRuntime();
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => blocked]);
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const writeId = await harness.session.appendCustomEntry("app.note", { text: "internal" });
		release?.(fauxAssistantMessage("done"));
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({ kind: "completed" });
		expect(faux.state.callCount).toBe(1);
		const entry = await harness.session.getEntry(writeId);
		expect(entry).toMatchObject({ type: "custom", customType: "app.note", data: { text: "internal" } });
		expect(await harness.session.getLeafId()).toBe(writeId);
		expect(value.leafId).toBe(writeId);
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		await harness.close();
	});

	it("projects custom writes whose type has a registered projector", async () => {
		const { faux, harness } = await createRuntime({
			entryProjectors: {
				"app.note": (entry) => [
					{
						role: "user",
						content: [{ type: "text", text: `projected: ${JSON.stringify((entry as { data?: unknown }).data)}` }],
						timestamp: 1,
					},
				],
			},
		});
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const contexts: Context[] = [];
		faux.setResponses([
			() => blocked,
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("after custom");
			},
		]);
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await harness.session.appendCustomEntry("app.note", { text: "internal" });
		release?.(fauxAssistantMessage("first"));
		expect(requireSuccess(await pendingRun)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "after custom" }] },
		});
		expect(faux.state.callCount).toBe(2);
		expect(textOf(contexts[0]!.messages[2] as unknown as AgentMessage)).toBe('projected: {"text":"internal"}');
		await harness.close();
	});

	it("consumes follow-up only after the assistant continuation is exhausted", async () => {
		const { faux, harness } = await createRuntime();
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		const contexts: Context[] = [];
		faux.setResponses([
			() => blocked,
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("after follow-up");
			},
		]);
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await harness.followUp(userMessage("follow-up input"));
		release?.(fauxAssistantMessage("first"));
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "after follow-up" }] },
		});
		expect(faux.state.callCount).toBe(2);
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"hello",
			"first",
			"follow-up input",
		]);
		await harness.close();
	});

	it("defers tree writes while a Run is suspended without resuming it", async () => {
		const { faux, harness, session } = await createRuntime();
		faux.setResponses([
			fauxAssistantMessage("later", {
				stopReason: "deferred",
				deferred: { provider: "r5-provider", modelId: "faux-1", api: "r5-api", id: "deferred-id" },
			}),
		]);
		const value = await harness.prompt("hello");
		expect(value).toMatchObject({ ok: true, value: { kind: "suspended", reason: "deferred" } });
		const writeId = await harness.session.appendCustomEntry("app.note", { pending: true });
		expect(await session.getRegister("pending.entry", writeId)).toMatchObject({
			value: { type: "custom", customType: "app.note" },
		});
		// Resume does not drain the deferred phase; the write stays pending.
		const resumed = await harness.resume();
		expect(resumed).toMatchObject({ ok: true, value: { kind: "suspended", reason: "deferred" } });
		expect(await session.getRegister("pending.entry", writeId)).toBeDefined();
		await harness.close();
	});
});

describe("Harness v4 R5 before_run_end", () => {
	it("extends the Run with a born-placed follow-up that triggers the next generation", async () => {
		const { faux, harness } = await createRuntime();
		const contexts: Context[] = [];
		faux.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("second");
			},
		]);
		const hookCalls: number[] = [];
		harness.hooks.on("before_run_end", ({ runId, messages }) => {
			hookCalls.push(messages.length);
			void runId;
			return hookCalls.length === 1 ? { followUp: "keep going" } : undefined;
		});
		const value = requireSuccess(await harness.prompt("hello"));
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "second" }] } });
		expect(faux.state.callCount).toBe(2);
		expect(hookCalls).toHaveLength(2);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const followUp = branch.find((entry) => entry.type === "message" && textOf(entry.message) === "keep going");
		expect(followUp).toBeDefined();
		// Born placed: no pending register ever existed for the follow-up entry.
		expect(await harness.durableSession.getRegister("pending.entry", followUp!.id)).toBeUndefined();
		expect(textOf(contexts[0]!.messages[2] as unknown as AgentMessage)).toBe("keep going");
		await harness.close();
	});

	it("discards a stale hook result when queue input arrived while the hook ran", async () => {
		const { faux, harness } = await createRuntime();
		let releaseHook: ((value: { followUp: string }) => void) | undefined;
		const hookGate = new Promise<{ followUp: string }>((resolve) => {
			releaseHook = resolve;
		});
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		let hookCalls = 0;
		harness.hooks.on("before_run_end", async () => {
			hookCalls++;
			if (hookCalls === 1) return hookGate;
			return undefined;
		});
		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(hookCalls).toBe(1));
		await harness.steer(userMessage("steered during hook"));
		releaseHook?.({ followUp: "stale follow-up" });
		const value = requireSuccess(await pendingRun);
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "second" }] } });
		expect(faux.state.callCount).toBe(2);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch.some((entry) => entry.type === "message" && textOf(entry.message) === "stale follow-up")).toBe(
			false,
		);
		expect(branch.some((entry) => entry.type === "message" && textOf(entry.message) === "steered during hook")).toBe(
			true,
		);
		await harness.close();
	});
});

describe("Harness v4 R5 usage adjustment", () => {
	it("appends an adjustment row, emits usage with totals, and never faults on invalid input", async () => {
		const { faux, harness } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("done")]);
		requireSuccess(await harness.prompt("hello"));
		const rowsBefore = (await harness.durableSession.scanUsage({})).length;

		const events: Array<{ rowId: string; totals: number }> = [];
		harness.events.on("usage", (event) => {
			events.push({ rowId: event.row.id, totals: event.totals.totalTokens });
		});
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const targetEntry = branch[0]!;
		const adjustment = {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
		};
		const result = await harness.recordUsage(adjustment, { entryId: targetEntry.id, details: { note: "manual" } });
		expect(result).toMatchObject({
			ok: true,
			value: { usageId: expect.any(String), totals: expect.objectContaining({ totalTokens: expect.any(Number) }) },
		});
		const rows = await harness.durableSession.scanUsage({ order: "asc" });
		expect(rows).toHaveLength(rowsBefore + 1);
		const row = rows.at(-1)!;
		expect(row).toMatchObject({ adjustment: true, entryId: targetEntry.id, details: { note: "manual" } });
		expect(row.usage).toEqual(adjustment);
		await vi.waitFor(() => expect(events).toHaveLength(1));
		const stats = await harness.durableSession.getStats();
		expect(events[0]).toEqual({ rowId: row.id, totals: stats.usage.totalTokens });

		// Invalid adjustments are caller defects: typed storage rejection, no fault.
		await expect(harness.recordUsage({ ...adjustment, input: Number.NaN })).rejects.toMatchObject({
			code: "invalid_payload",
		});
		await expect(harness.recordUsage(adjustment, { entryId: "missing-entry" })).rejects.toMatchObject({
			code: "invalid_payload",
		});
		faux.setResponses([fauxAssistantMessage("still alive")]);
		expect(requireSuccess(await harness.prompt("second"))).toMatchObject({ kind: "completed" });
		await harness.close();
	});
});

describe("Harness v4 R5 queue admission and cancellation", () => {
	it("accepts nextRun on an idle lane and captures it in the next acceptance transaction", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		const queued = await harness.nextRun(userMessage("queued first"));
		expect(queued).toMatchObject({ ok: true });
		const pendingId = (queued as { ok: true; value: { entryId: string } }).value.entryId;
		expect(await session.getRegister("pending.entry", pendingId)).toMatchObject({
			value: { type: "message", payload: userMessage("queued first") },
		});
		expectPendingExclusive(session, pendingId);

		const contexts: Context[] = [];
		faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const value = requireSuccess(await harness.prompt("new prompt"));
		expect(value).toMatchObject({ kind: "completed" });
		// Placement used the reserved id and deleted the register in the same transaction.
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch[0]).toMatchObject({ id: pendingId, message: { content: [{ text: "queued first" }] } });
		expect(await session.getRegister("pending.entry", pendingId)).toBeUndefined();
		expect(contexts[0]?.messages.map((message) => textOf(message as unknown as AgentMessage))).toEqual([
			"queued first",
			"new prompt",
		]);
		await harness.close();
	});

	it("accepts nextRun during an open Run and keeps it lane-owned across the terminal", async () => {
		const { faux, harness, session } = await createRuntime();
		let release: ((message: AssistantMessage) => void) | undefined;
		const response = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => response]);

		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const queued = await harness.nextRun(userMessage("next run input"));
		expect(queued).toMatchObject({ ok: true });
		const pendingId = (queued as { ok: true; value: { entryId: string } }).value.entryId;
		release?.(fauxAssistantMessage("done"));
		expect(await pendingRun).toMatchObject({ ok: true, value: { kind: "completed" } });

		// Terminal cleanup must not delete the lane-owned next-run queue.
		const laneState = await session.getRegister("lane.state", "main");
		expect(laneState).toMatchObject({ value: { currentOperationId: null, pendingNextRun: [pendingId] } });
		expect(await session.getRegister("pending.entry", pendingId)).toBeDefined();
		await harness.close();
	});

	it("rejects steer and followUp on an idle lane with NoActiveRun and zero writes", async () => {
		const { harness, session } = await createRuntime({ instrument: true });
		const commitsBefore = (session as InstrumentedSession).commits().length;
		await expect(harness.steer(userMessage("steer"))).resolves.toMatchObject({
			ok: false,
			error: { _tag: "NoActiveRun" },
		});
		await expect(harness.followUp(userMessage("follow"))).resolves.toMatchObject({
			ok: false,
			error: { _tag: "NoActiveRun" },
		});
		expect((session as InstrumentedSession).commits()).toHaveLength(commitsBefore);
		await harness.close();
	});

	it("rejects invalid queue messages with InvalidMessage and zero writes", async () => {
		const { harness, session } = await createRuntime({ instrument: true });
		const invalid = {
			role: "user",
			content: [{ type: "text", text: 1 }],
			timestamp: 1,
		} as unknown as AgentMessage;
		const commitsBefore = (session as InstrumentedSession).commits().length;
		await expect(harness.nextRun(invalid)).resolves.toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });
		await expect(harness.steer(invalid)).resolves.toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });
		await expect(harness.followUp(invalid)).resolves.toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });
		expect((session as InstrumentedSession).commits()).toHaveLength(commitsBefore);
		await harness.close();
	});

	it("triages cancelQueued into cancelled, already_consumed, and stable not_found", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		const queued = await harness.nextRun(userMessage("queued"));
		const pendingId = (queued as { ok: true; value: { entryId: string } }).value.entryId;
		expect(await harness.cancelQueued(pendingId)).toMatchObject({ ok: true, value: { kind: "cancelled" } });
		expect(await session.getRegister("pending.entry", pendingId)).toBeUndefined();
		expect(await harness.cancelQueued(pendingId)).toMatchObject({ ok: true, value: { kind: "not_found" } });
		expect(await harness.cancelQueued("missing-id")).toMatchObject({ ok: true, value: { kind: "not_found" } });

		faux.setResponses([fauxAssistantMessage("done")]);
		requireSuccess(await harness.prompt("hello"));
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const promptEntry = branch[0];
		expect(promptEntry?.type).toBe("message");
		expect(await harness.cancelQueued(promptEntry!.id)).toMatchObject({
			ok: true,
			value: { kind: "already_consumed" },
		});
		await harness.close();
	});

	it("ships consumed input before a later cancel and cancels before a parked drain", async () => {
		// Automatic order: consumption wins; cancel sees already_consumed.
		const automatic = await createRuntime();
		let releaseAutomatic: ((message: AssistantMessage) => void) | undefined;
		const blockedAutomatic = new Promise<AssistantMessage>((resolve) => {
			releaseAutomatic = resolve;
		});
		automatic.faux.setResponses([() => blockedAutomatic, fauxAssistantMessage("after steer")]);
		const automaticRun = automatic.harness.prompt("hello");
		await vi.waitFor(() => expect(automatic.faux.state.callCount).toBe(1));
		const steerResult = await automatic.harness.steer(userMessage("steer input"));
		const steerId = (steerResult as { ok: true; value: { entryId: string } }).value.entryId;
		releaseAutomatic?.(fauxAssistantMessage("first"));
		expect(requireSuccess(await automaticRun)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "after steer" }] },
		});
		expect(automatic.faux.state.callCount).toBe(2);
		expect(await automatic.harness.cancelQueued(steerId)).toMatchObject({
			ok: true,
			value: { kind: "already_consumed" },
		});
		await automatic.harness.close();

		// Manual order: cancel wins before the parked drain executes.
		const manual = await createRuntime({ drive: "manual" });
		let releaseManual: ((message: AssistantMessage) => void) | undefined;
		const blockedManual = new Promise<AssistantMessage>((resolve) => {
			releaseManual = resolve;
		});
		manual.faux.setResponses([() => blockedManual]);
		const manualRun = manual.harness.prompt("hello");
		await executeUntil(manual.harness, "commit_transition");
		await executeUntil(manual.harness, "commit_transition");
		await executeUntil(manual.harness, "assistant");
		await vi.waitFor(() => expect(manual.faux.state.callCount).toBe(1));
		const manualSteer = await manual.harness.steer(userMessage("must be cancelled"));
		const manualSteerId = (manualSteer as { ok: true; value: { entryId: string } }).value.entryId;
		releaseManual?.(fauxAssistantMessage("first"));
		await executeUntil(manual.harness, "commit_effect_settlement");
		// The drain is planned and parked but not yet executed; cancelling now
		// wins over consumption.
		await vi.waitFor(async () => expect((await manual.harness.peekAction())?.kind).toBe("commit_inbox_drain"));
		expect(await manual.harness.cancelQueued(manualSteerId)).toMatchObject({
			ok: true,
			value: { kind: "cancelled" },
		});
		await manual.harness.runToCompletion();
		expect(requireSuccess(await manualRun)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "first" }] },
		});
		expect(manual.faux.state.callCount).toBe(1);
		const branch = await manual.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch.some((entry) => entry.id === manualSteerId)).toBe(false);
		expect(await manual.session.getRegister("pending.entry", manualSteerId)).toBeUndefined();
		await manual.harness.close();
	});

	it("emits queue_update after admission, consumption, and cancellation", async () => {
		const { faux, harness } = await createRuntime();
		let release: ((message: AssistantMessage) => void) | undefined;
		const blocked = new Promise<AssistantMessage>((resolve) => {
			release = resolve;
		});
		faux.setResponses([() => blocked, fauxAssistantMessage("after")]);
		const updates: Array<{ steer: number; followUp: number; nextRun: number }> = [];
		harness.events.on("queue_update", (event) => {
			updates.push({ steer: event.steer.length, followUp: event.followUp.length, nextRun: event.nextRun.length });
		});

		const pendingRun = harness.prompt("hello");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		const next = await harness.nextRun(userMessage("queued"));
		const nextId = (next as { ok: true; value: { entryId: string } }).value.entryId;
		await harness.steer(userMessage("steer"));
		await harness.cancelQueued(nextId);
		release?.(fauxAssistantMessage("first"));
		await pendingRun;
		await vi.waitFor(() => expect(updates).toHaveLength(5));
		expect(updates).toEqual([
			{ steer: 0, followUp: 0, nextRun: 0 },
			{ steer: 0, followUp: 0, nextRun: 1 },
			{ steer: 1, followUp: 0, nextRun: 1 },
			{ steer: 1, followUp: 0, nextRun: 0 },
			{ steer: 0, followUp: 0, nextRun: 0 },
		]);
		await harness.close();
	});

	it("honours all and one-at-a-time steering modes at the drain", async () => {
		for (const steeringMode of ["all", "one-at-a-time"] as const) {
			const { faux, harness } = await createRuntime({ steeringMode });
			let release: ((message: AssistantMessage) => void) | undefined;
			const blocked = new Promise<AssistantMessage>((resolve) => {
				release = resolve;
			});
			const contexts: Context[] = [];
			faux.setResponses([
				() => blocked,
				(context) => {
					contexts.push(structuredClone(context));
					return fauxAssistantMessage("second");
				},
				(context) => {
					contexts.push(structuredClone(context));
					return fauxAssistantMessage("third");
				},
			]);
			const pendingRun = harness.prompt("hello");
			await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
			await harness.steer(userMessage("steer one"));
			await harness.steer(userMessage("steer two"));
			release?.(fauxAssistantMessage("first"));
			requireSuccess(await pendingRun);
			const texts = contexts.map((context) => context.messages.map((m) => textOf(m as unknown as AgentMessage)));
			if (steeringMode === "all") {
				expect(faux.state.callCount).toBe(2);
				expect(texts[0]).toEqual(["hello", "first", "steer one", "steer two"]);
			} else {
				expect(faux.state.callCount).toBe(3);
				expect(texts[0]).toEqual(["hello", "first", "steer one"]);
				expect(texts[1]).toEqual(["hello", "first", "steer one", "second", "steer two"]);
			}
			await harness.close();
		}
	});
});
