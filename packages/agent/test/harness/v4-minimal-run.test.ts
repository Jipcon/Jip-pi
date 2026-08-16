import {
	type Api,
	type AssistantMessage,
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type AdaptiveRunBasisInput,
	AgentHarness,
	InMemorySessionRepo,
	type Resources,
	type RunResult,
	type SettledAssistantMessage,
} from "../../src/harness-v4.ts";
import { InstrumentedSession } from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

async function createRuntime(
	options: { drive?: "automatic" | "manual"; instrument?: boolean; resources?: Resources } = {},
) {
	const faux = fauxProvider({ provider: "r2-provider", api: "r2-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 1_800_000_000_000 });
	const raw = await repo.create({
		id: `r2-${options.drive ?? "automatic"}-${options.instrument === true ? "instrumented" : "plain"}`,
	});
	const session = options.instrument === true ? new InstrumentedSession(raw) : raw;
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(options.resources === undefined ? {} : { resources: options.resources }),
	});
	return { faux, harness, model, models, repo, session };
}

type SettledRunValue = Exclude<Extract<RunResult, { ok: true }>["value"], { kind: "suspended" }>;

function requireSuccess(result: RunResult): SettledRunValue {
	if (!result.ok) throw result.error;
	if (result.value.kind === "suspended") throw new Error("Expected a settled R2 Run");
	return result.value;
}

describe("Harness v4 R2 minimal no-tool Run", () => {
	it("commits acceptance, request intent, response/usage, and terminal cleanup in order", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		faux.setResponses([fauxAssistantMessage("done", { timestamp: 10 })]);
		const events: string[] = [];
		for (const type of [
			"run_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"entry_added",
			"usage",
			"turn_end",
			"run_end",
		] as const) {
			harness.events.on(type, () => {
				events.push(type);
			});
		}

		const value = requireSuccess(await harness.prompt("hello"));
		expect(value.finalMessage?.errorMessage).toBeUndefined();
		expect(value).toMatchObject({ kind: "completed", finalMessage: { role: "assistant", stopReason: "stop" } });
		expect(value.finalEntryId).toBe(value.leafId);
		expect(faux.state.callCount).toBe(1);

		await vi.waitFor(() => expect(events.at(-1)).toBe("run_end"));
		expect(events).toEqual([
			"run_start",
			"message_start",
			"message_end",
			"entry_added",
			"turn_start",
			"message_start",
			"message_update",
			"message_update",
			"message_update",
			"message_end",
			"entry_added",
			"usage",
			"turn_end",
			"run_end",
		]);

		const instrumented = session as InstrumentedSession;
		const commits = instrumented.commits().slice(1);
		expect(commits).toHaveLength(5);
		expect(commits.map((commit) => commit.writes.map((write) => write.kind))).toEqual([
			["entry", "register", "register", "register", "register"],
			["register"],
			["register"],
			["entry", "register", "usage", "register"],
			["register", "register", "register", "register"],
		]);
		expect(commits[0]?.writes.slice(1).map((write) => (write.kind === "register" ? write.namespace : ""))).toEqual([
			"lane.leaf",
			"op.meta",
			"op.state",
			"lane.state",
		]);
		expect(
			commits[4]?.writes.map((write) => (write.kind === "register" ? `${write.op}:${write.namespace}` : "")),
		).toEqual(["delete:op.meta", "delete:op.state", "set:lane.lastResult", "set:lane.state"]);
		expect(await session.getRegister("op.meta", value.runId)).toBeUndefined();
		expect(await session.getRegister("op.state", value.runId)).toBeUndefined();
		expect(await session.getRegister("lane.state", "main")).toMatchObject({
			value: { currentOperationId: null, pendingNextRun: [] },
		});
		expect(await harness.getLastResult()).toEqual({
			operationId: value.runId,
			kind: "run",
			leafId: value.leafId,
			outcome: "completed",
			finalAssistantEntryId: value.finalEntryId,
			runCompletion: "assistant",
		});
		const turn = await harness.session.getTurnCommit({
			assistantEntryId: value.finalEntryId!,
			leafId: value.leafId,
		});
		expect(turn?.usageRows).toHaveLength(1);
		await harness.close();
	});

	it("atomically admits adaptive provenance without projecting it into provider context", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		let observed: Context | undefined;
		faux.setResponses([
			(context) => {
				observed = structuredClone(context);
				return fauxAssistantMessage("adaptive done");
			},
		]);
		const basis = {
			schemaVersion: 1,
			taskId: "task",
			candidateId: "candidate",
			policyBundle: { version: "v1", fingerprint: "policy" },
			projectorVersion: "p1",
			inheritedPolicyState: { snapshot: {}, fingerprint: "state", basis: { cursor: { kind: "task_origin" } } },
			start: { kind: "prompt" },
		} satisfies AdaptiveRunBasisInput;

		const value = requireSuccess(await harness.promptAdaptive(userMessage("adaptive"), basis));
		const instrumented = session as InstrumentedSession;
		const acceptance = instrumented.commits()[1]!;
		const entries = acceptance.writes.filter((write) => write.kind === "entry").map((write) => write.entry);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: "adaptive.run_basis",
			data: { operationId: value.runId, taskId: "task" },
		});
		expect(entries[1]).toMatchObject({ type: "message", parentId: entries[0]?.id });
		const metaWrite = acceptance.writes.find((write) => write.kind === "register" && write.namespace === "op.meta");
		expect(metaWrite).toMatchObject({ value: { intent: { adaptive: { basisEntryId: entries[0]?.id } } } });
		expect(observed?.messages).toHaveLength(1);
		expect(observed?.messages[0]).toMatchObject({ role: "user" });
		await harness.close();
	});

	it("places captured next-run payloads before the new prompt in the acceptance transaction", async () => {
		const faux = fauxProvider({ provider: "capture-provider", api: "capture-api" });
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		const raw = await new InMemorySessionRepo({ now: () => 1_810_000_000_000 }).create({ id: "r2-capture" });
		const pendingId = raw.idGenerator.next();
		await raw.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: pendingId,
					value: { type: "message", payload: userMessage("queued") as never },
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [pendingId] },
				},
			],
		});
		const session = new InstrumentedSession(raw);
		const { harness } = await AgentHarness.create({ session, models, model });
		let providerMessages: Context["messages"] = [];
		faux.setResponses([
			(context) => {
				providerMessages = structuredClone(context.messages);
				return fauxAssistantMessage("captured");
			},
		]);

		requireSuccess(await harness.prompt("new"));
		const acceptanceEntries = session.commits()[1]?.writes.filter((write) => write.kind === "entry") ?? [];
		expect(acceptanceEntries.map((write) => write.entry.id)).toEqual([pendingId, expect.any(String)]);
		expect(acceptanceEntries[1]?.entry).toMatchObject({ parentId: pendingId });
		expect(await session.getRegister("pending.entry", pendingId)).toBeUndefined();
		expect(providerMessages).toHaveLength(2);
		expect(providerMessages).toEqual([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "user" }),
		]);
		await harness.close();
	});

	it("expands skills and prompt templates before admission and rejects unknown resources without writes", async () => {
		const { faux, harness, session } = await createRuntime({
			instrument: true,
			resources: {
				skills: [
					{
						name: "review",
						description: "Review a change",
						content: "Inspect the change carefully.",
						filePath: "C:\\skills\\review\\SKILL.md",
					},
				],
				promptTemplates: [{ name: "summarize", content: "Summarize $1 with $ARGUMENTS" }],
			},
		});
		const visibleRequests: string[] = [];
		faux.setResponses([
			(context) => {
				visibleRequests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("skill done");
			},
			(context) => {
				visibleRequests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("template done");
			},
		]);

		expect(await harness.skill("missing")).toMatchObject({ ok: false, error: { _tag: "UnknownSkill" } });
		requireSuccess(await harness.skill("review", "Focus on correctness."));
		requireSuccess(await harness.promptFromTemplate("summarize", ["change.ts", "briefly"]));
		expect(visibleRequests[0]).toContain('<skill name=\\"review\\"');
		expect(visibleRequests[0]).toContain("Focus on correctness.");
		expect(visibleRequests[1]).toContain("Summarize change.ts");
		expect(faux.state.callCount).toBe(2);
		expect((session as InstrumentedSession).commits()).toHaveLength(11);
		await harness.close();
	});

	it("isolates invalid caller, provider, and hook outputs before durable storage", async () => {
		const { faux, harness, session } = await createRuntime({ instrument: true });
		const invalidCaller = {
			role: "user",
			content: [{ type: "text", text: 1 }],
			timestamp: 1,
		} as unknown as AgentMessage;
		const rejected = await harness.prompt(invalidCaller);
		expect(rejected).toMatchObject({ ok: false, error: { _tag: "InvalidMessage" } });
		expect((session as InstrumentedSession).commits()).toHaveLength(1);
		expect(faux.state.callCount).toBe(0);

		const handlerErrors: string[] = [];
		harness.events.on("handler_error", (event) => {
			if (event.kind === "hook") handlerErrors.push(event.hook);
		});
		harness.hooks.on("before_run", () => ({ messages: [invalidCaller], resumeData: { invalid: 1n } as never }), {
			id: "invalid-before-run",
		});
		harness.hooks.on("after_response", ({ message }) => ({
			message: { ...message, content: [{ type: "text", text: 1 }] } as unknown as SettledAssistantMessage,
		}));
		faux.setResponses([fauxAssistantMessage("valid response")]);
		const valid = requireSuccess(await harness.prompt("valid caller"));
		expect(valid).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "valid response" }] } });

		faux.setResponses([() => ({ ...fauxAssistantMessage("bad role"), role: "user" }) as unknown as AssistantMessage]);
		const invalidProvider = requireSuccess(await harness.prompt("provider check"));
		expect(invalidProvider).toMatchObject({
			kind: "failed",
			finalMessage: { stopReason: "error", errorMessage: expect.stringContaining("Invalid provider response") },
		});
		await vi.waitFor(() => expect(handlerErrors).toEqual(["before_run", "after_response", "before_run"]));
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(
			branch.some(
				(entry) =>
					entry.type === "message" &&
					(entry.message.role === "user" ||
						entry.message.role === "assistant" ||
						entry.message.role === "toolResult") &&
					Array.isArray(entry.message.content) &&
					entry.message.content.some((part) => part.type === "text" && typeof part.text !== "string"),
			),
		).toBe(false);
		await harness.close();
	});

	it("parks every post-acceptance effect in manual mode and reaches the same terminal shape", async () => {
		const { faux, harness } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("manual")]);
		const pending = harness.prompt("hello");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(0);
		expect((await harness.executeAction())?.kind).toBe("commit_transition");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		expect(faux.state.callCount).toBe(0);
		expect((await harness.executeAction())?.kind).toBe("commit_transition");
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("assistant"));
		const laneState = await harness.durableSession.getRegister("lane.state", "main");
		const operationId = laneState?.value.currentOperationId;
		if (operationId === null || operationId === undefined) throw new Error("Expected an open Run");
		expect(await harness.durableSession.getRegister("op.state", operationId)).toMatchObject({
			value: { phase: { kind: "assistant", generation: { status: "effect_pending" } } },
		});
		expect(faux.state.callCount).toBe(0);
		await harness.runToCompletion();
		const value = requireSuccess(await pending);
		expect(value).toMatchObject({ kind: "completed", finalMessage: { content: [{ text: "manual" }] } });
		expect(faux.state.callCount).toBe(1);
		expect(await harness.peekAction()).toBeUndefined();
		expect(await harness.getLastResult()).toMatchObject({
			operationId: value.runId,
			leafId: value.leafId,
			outcome: "completed",
		});
		await harness.close();
	});

	it("turns close at a parked boundary into a typed Closed result and leaves a restorable prefix", async () => {
		const { faux, harness, model, models, repo, session } = await createRuntime({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("must not run")]);
		const pending = harness.prompt(userMessage("close me"));
		await vi.waitFor(async () => expect((await harness.peekAction())?.kind).toBe("commit_transition"));
		const metadata = structuredClone(session.metadata);
		await harness.close();
		await expect(pending).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(faux.state.callCount).toBe(0);

		const reopenedSession = await repo.open(metadata);
		const { harness: reopened, suspended } = await AgentHarness.create({
			session: reopenedSession,
			models,
			model,
			drive: "manual",
		});
		expect(suspended).toEqual([
			expect.objectContaining({ lane: "main", kind: "run", reason: "crash", prompt: [userMessage("close me")] }),
		]);
		await reopened.close();
	});
});
