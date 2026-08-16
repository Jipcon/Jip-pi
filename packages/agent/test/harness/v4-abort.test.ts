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
	type AdaptiveToolBatchClearance,
	AgentHarness,
	InMemorySessionRepo,
	type LaneConfiguration,
	type Operation,
	type RunState,
	type Session,
	type Transaction,
} from "../../src/harness-v4.ts";
import type { AgentMessage } from "../../src/types.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function createDeferred<T = void>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

const CONFIGURATION: LaneConfiguration = {
	model: { provider: "abort-provider", modelId: "faux-1" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createRuntime(options: { drive?: "automatic" | "manual"; id?: string } = {}) {
	const faux = fauxProvider({ provider: "abort-provider", api: "abort-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	const repo = new InMemorySessionRepo({ now: () => 2_200_000_000_000 });
	const session = await repo.create({ id: options.id ?? `abort-${options.drive ?? "automatic"}` });
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
	});
	return { faux, harness, model, models, repo, session };
}

/** Blocks the provider request until the operation signal aborts and a manual release fires. */
function blockingProviderStep(firstRequest: Deferred, release?: Deferred) {
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
		firstRequest.resolve();
		return new Promise<AssistantMessage>((resolve) => {
			const finish = () => {
				(release === undefined ? Promise.resolve() : release.promise).then(() => resolve(fauxAssistantMessage("")));
			};
			if (options?.signal?.aborted) {
				finish();
				return;
			}
			options?.signal?.addEventListener("abort", finish, { once: true });
		});
	};
}

async function waitForTerminal(session: Session, operationId: string): Promise<void> {
	await vi.waitFor(async () => {
		expect(await session.getRegister("op.state", operationId)).toBeUndefined();
	});
}

interface SuspendedFixture {
	session: Session;
	operationId: string;
	promptEntryId: string;
}

/** Builds a durable open Run in a specific phase without driving it. */
async function createSuspendedRun(
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
	const session = await new InMemorySessionRepo({ now: () => 2_300_000_000_000 }).create({ id });
	const promptEntryId = await session.appendMessage(userMessage("hello"));
	let parentId = promptEntryId;
	for (const entry of extra?.assistantEntries ?? []) {
		// Drop undefined-valued optional fields (faux emits them) so the
		// transaction passes JSON validation.
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
	return { session, operationId, promptEntryId };
}

function readTool(name: string, execute: AgentHarnessTool<undefined>["execute"]): AgentHarnessTool<undefined> {
	return {
		name,
		description: `${name} tool`,
		label: name,
		parameters: Type.Object({ path: Type.String() }),
		execute,
	};
}

function textOf(message: unknown): string {
	const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

describe("Harness v4 R6 abort basics", () => {
	it("rejects an idle abort with NoActiveOperation", async () => {
		const { harness } = await createRuntime();
		await expect(harness.abort()).resolves.toMatchObject({ ok: false, error: { _tag: "NoActiveOperation" } });
		await harness.close();
	});

	it("first abort commits the durable marker before the live effect reconciles", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;

		const aborted = await harness.abort();
		expect(aborted).toMatchObject({ ok: true, value: { steer: [], followUp: [] } });
		const runId = aborted.ok ? aborted.value.runId : "";
		// The marker is durable while the live effect is still pending.
		const state = await session.getRegister("op.state", runId);
		expect(state?.value).toMatchObject({
			kind: "run",
			control: { status: "cancel_requested", drainedSteer: [], drainedFollowUp: [] },
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});

		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted", runId } });
		expect(faux.state.callCount).toBe(1);
		const final = await session.getRegister("lane.lastResult", "main");
		expect(final?.value).toMatchObject({ operationId: runId, outcome: "aborted", kind: "run" });
		expect(final?.value.finalAssistantEntryId).toEqual(expect.any(String));
		expect(await session.getRegister("op.state", runId)).toBeUndefined();
		expect(await session.getRegister("op.meta", runId)).toBeUndefined();
		await harness.close();
	});

	it("repeated abort returns the first saved payload with zero writes and no duplicate events", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const runAbortEvents: unknown[] = [];
		harness.events.on("run_abort", (event) => {
			runAbortEvents.push(event);
		});

		const first = await harness.abort();
		const stateAfterFirst = await session.getRegister("op.state", first.ok ? first.value.runId : "");
		const seqAfterFirst = stateAfterFirst?.seq;
		const second = await harness.abort();
		expect(second).toEqual(first);
		const stateAfterSecond = await session.getRegister("op.state", first.ok ? first.value.runId : "");
		expect(stateAfterSecond?.seq).toBe(seqAfterFirst);
		expect(runAbortEvents).toHaveLength(1);

		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		await harness.close();
	});

	it("atomically drains steer and follow-up while keeping their pending entries until terminal", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const steerResult = await harness.steer("steer one");
		const followUpResult = await harness.followUp("follow one");
		const steerId = steerResult.ok ? steerResult.value.entryId : "";
		const followUpId = followUpResult.ok ? followUpResult.value.entryId : "";

		const aborted = await harness.abort();
		expect(aborted.ok && aborted.value.steer.map(textOf)).toEqual(["steer one"]);
		expect(aborted.ok && aborted.value.followUp.map(textOf)).toEqual(["follow one"]);
		const runId = aborted.ok ? aborted.value.runId : "";
		const state = await session.getRegister("op.state", runId);
		expect(state?.value).toMatchObject({
			inbox: { steer: [], followUp: [], writes: [] },
			control: { drainedSteer: [steerId], drainedFollowUp: [followUpId] },
		});
		// Drained pending entries survive until the aborted terminal.
		expect(await session.getRegister("pending.entry", steerId)).toBeDefined();
		expect(await session.getRegister("pending.entry", followUpId)).toBeDefined();

		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(await session.getRegister("pending.entry", steerId)).toBeUndefined();
		expect(await session.getRegister("pending.entry", followUpId)).toBeUndefined();
		await harness.close();
	});

	it("rejects steer and follow-up on a cancelled operation but still accepts writes and configuration", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		await harness.abort();

		expect(await harness.steer("too late")).toMatchObject({ ok: false, error: { _tag: "NoActiveRun" } });
		expect(await harness.followUp("too late")).toMatchObject({ ok: false, error: { _tag: "NoActiveRun" } });
		const writeId = await harness.session.appendMessage(userMessage("accepted write"));
		await harness.setThinkingLevel("high");

		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		// The accepted tree write was applied before the terminal transaction.
		expect(await session.getEntry(writeId)).toMatchObject({ type: "message" });
		expect(await session.getRegister("lane.config", "main")).toMatchObject({
			value: { thinkingLevel: "high" },
		});
		await harness.close();
	});

	it("applies pending writes during the cancellation checkpoint before the aborted terminal", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const writeId = await harness.session.appendMessage(userMessage("checkpoint write"));
		await harness.abort();

		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		const entry = await session.getEntry(writeId);
		expect(entry).toMatchObject({ type: "message" });
		// The deferred write was materialized as a placed tree entry.
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		await harness.close();
	});

	it("never starts a provider request, retry, or hook from a cancelled ready state", async () => {
		const { faux, model, models } = await createRuntime();
		const { session, operationId } = await createSuspendedRun("abort-ready", (promptEntryId) => ({
			kind: "assistant",
			generation: {
				status: "ready",
				context: {
					stepId: "step",
					triggerEntryId: promptEntryId,
					configuration: CONFIGURATION,
					streamOptions: {},
					retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
					overflowRecoveryUsed: false,
				},
				nextAttempt: 1,
			},
		}));
		const { harness } = await AgentHarness.create({ session, models, model });
		const events: string[] = [];
		harness.events.on("run_abort", () => {
			events.push("run_abort");
		});
		harness.events.on("run_end", () => {
			events.push("run_end");
		});
		const aborted = await harness.abort();
		expect(aborted).toMatchObject({ ok: true });
		await waitForTerminal(session, operationId);
		expect(faux.state.callCount).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		expect(events).toEqual(["run_abort", "run_end"]);
		await harness.close();
	});

	it("finishes a cancelled retry_wait without sleeping or retrying", async () => {
		const { faux, model, models } = await createRuntime();
		const { session, operationId } = await createSuspendedRun("abort-retry-wait", (promptEntryId) => ({
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
		}));
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.callCount).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("settles a restored assistant effect_pending with a synthetic aborted response and zero usage", async () => {
		const { faux, model, models } = await createRuntime();
		const responseEntryId = "reserved-response";
		const usageId = "reserved-usage";
		const { session, operationId } = await createSuspendedRun("abort-restored-assistant", (promptEntryId) => ({
			kind: "assistant",
			generation: {
				status: "effect_pending",
				context: {
					stepId: "step",
					triggerEntryId: promptEntryId,
					configuration: CONFIGURATION,
					streamOptions: {},
					retryPolicy: { maxAttempts: 3, baseDelayMs: 100 },
					overflowRecoveryUsed: false,
				},
				attempt: 1,
				responseEntryId,
				usageId,
				intendedOutputLimit: 4_096,
				contextWindow: 128_000,
			},
		}));
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.callCount).toBe(0);
		const entry = await session.getEntry(responseEntryId);
		expect(entry).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "aborted" } });
		const usageRows = await session.scanUsage({ entryIds: [responseEntryId] });
		expect(usageRows).toHaveLength(1);
		expect(usageRows[0]?.usage.totalTokens).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted", finalAssistantEntryId: responseEntryId },
		});
		await harness.close();
	});

	it("normalizes a live aborted response keeping its reserved id and live usage", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		const aborted = await harness.abort();
		const runId = aborted.ok ? aborted.value.runId : "";
		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		const finalEntryId = result.ok ? (result.value as { finalEntryId?: string }).finalEntryId : undefined;
		expect(finalEntryId).toEqual(expect.any(String));
		const entry = finalEntryId === undefined ? undefined : await session.getEntry(finalEntryId);
		expect(entry).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "aborted" } });
		const usageRows = await session.scanUsage({ entryIds: finalEntryId === undefined ? [] : [finalEntryId] });
		expect(usageRows).toHaveLength(1);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId: runId, outcome: "aborted", finalAssistantEntryId: finalEntryId },
		});
		await harness.close();
	});

	it("never persists an aborted provider response under a running control", async () => {
		const { faux, harness, session } = await createRuntime();
		faux.setResponses([
			fauxAssistantMessage("bogus aborted", { stopReason: "aborted", errorMessage: "provider aborted itself" }),
		]);
		const result = await harness.prompt("hello");
		expect(result).toMatchObject({ ok: true, value: { kind: "failed" } });
		const entries = await session.findEntries({ type: "message" });
		expect(
			entries.some(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			),
		).toBe(false);
		await harness.close();
	});

	it("cancels a live assistant effect started before the abort", async () => {
		const { faux, harness, session } = await createRuntime();
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await firstRequest.promise;
		await harness.abort();
		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(faux.state.callCount).toBe(1);
		const lastResult = await session.getRegister("lane.lastResult", "main");
		expect(lastResult?.value.outcome).toBe("aborted");
		await harness.close();
	});

	it("aborts before the effect start: intent commits but the provider is never called", async () => {
		const { faux, harness } = await createRuntime();
		const hookEntered = createDeferred();
		const releaseHook = createDeferred();
		harness.hooks.on("before_request", async () => {
			hookEntered.resolve();
			await releaseHook.promise;
			return undefined;
		});
		faux.setResponses([fauxAssistantMessage("must not run")]);
		const run = harness.prompt("hello");
		await hookEntered.promise;
		await harness.abort();
		releaseHook.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(faux.state.callCount).toBe(0);
		await harness.close();
	});

	it("runs the before_request hook when it already started before the abort", async () => {
		const { faux, harness } = await createRuntime();
		const hooksRan: string[] = [];
		harness.hooks.on("before_request", async () => {
			hooksRan.push("before_request");
			return undefined;
		});
		const firstRequest = createDeferred();
		const release = createDeferred();
		faux.setResponses([blockingProviderStep(firstRequest, release)]);
		const run = harness.prompt("hello");
		await vi.waitFor(() => expect(hooksRan).toEqual(["before_request"]));
		await firstRequest.promise;
		await harness.abort();
		release.resolve();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(hooksRan).toEqual(["before_request"]);
		await harness.close();
	});
});

describe("Harness v4 R6 tools cancellation", () => {
	const abortingTool = (executions: string[]): AgentHarnessTool<undefined> =>
		readTool("read", async (_id: string, args: { path: string }, signal: AbortSignal | undefined) => {
			executions.push(args.path);
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("tool aborted"));
					return;
				}
				signal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true });
			});
			return { content: [{ type: "text", text: "must not complete" }], details: {} };
		});

	it("waits for a live aborted tool, keeps its result, and forces terminate false", async () => {
		const { faux, harness, session } = await createRuntime();
		const executions: string[] = [];
		await harness.setTools([abortingTool(executions)]);
		await harness.setActiveTools(["read"]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const run = harness.prompt("hello");
		await vi.waitFor(() => expect(executions).toEqual(["x"]));
		const aborted = await harness.abort();
		expect(aborted).toMatchObject({ ok: true });
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(faux.state.callCount).toBe(1);
		const lastResult = await session.getRegister("lane.lastResult", "main");
		expect(lastResult?.value).toMatchObject({ outcome: "aborted" });
		expect(lastResult?.value.runCompletion).toBeUndefined();
		const toolResults = (await session.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		const message =
			toolResults[0]?.type === "message" && toolResults[0].message.role === "toolResult"
				? toolResults[0].message
				: undefined;
		expect(message?.isError).toBe(true);
		expect(textOf(message)).toBe("tool aborted");
		await harness.close();
	});

	it("settles planned calls with aborted synthetics without prepare or execution", async () => {
		const { faux, model, models } = await createRuntime();
		const assistantId = "tool-assistant";
		const { session, operationId } = await createSuspendedRun(
			"abort-tools-planned",
			(_promptEntryId) => ({
				kind: "tools",
				batch: {
					assistantEntryId: assistantId,
					configuration: { ...CONFIGURATION, activeToolNames: ["read"] },
					turnId: "turn",
					argumentAuthority: { kind: "standard_tool_args_registers" },
					calls: [
						{ status: "planned", sourceIndex: 0, resultEntryId: "result-0" },
						{ status: "planned", sourceIndex: 1, resultEntryId: "result-1" },
					],
				},
			}),
			{
				assistantEntries: [
					{
						id: assistantId,
						message: fauxAssistantMessage(
							[
								fauxToolCall("read", { path: "a" }, { id: "call-0" }),
								fauxToolCall("read", { path: "b" }, { id: "call-1" }),
							],
							{ stopReason: "toolUse" },
						),
					},
				],
				latestAssistantEntryId: assistantId,
			},
		);
		let executions = 0;
		const tool = readTool("read", async () => {
			executions++;
			return { content: [{ type: "text", text: "ran" }], details: {} };
		});
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
		});
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(executions).toBe(0);
		expect(faux.state.callCount).toBe(0);
		const results = (await session.findEntries({ type: "message", order: "asc" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results.map((entry) => (entry.type === "message" ? entry.id : ""))).toEqual(["result-0", "result-1"]);
		for (const entry of results) {
			const message = entry.type === "message" && entry.message.role === "toolResult" ? entry.message : undefined;
			expect(message?.isError).toBe(true);
			expect(textOf(message)).toContain("was not executed: the Run was aborted");
			expect(message?.usage).toBeUndefined();
		}
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted", finalAssistantEntryId: assistantId },
		});
		await harness.close();
	});

	it("never replays restored effect_pending tools: interrupted synthetics", async () => {
		const { model, models } = await createRuntime();
		const assistantId = "tool-assistant";
		const { session, operationId } = await createSuspendedRun(
			"abort-tools-restored",
			(_promptEntryId) => ({
				kind: "tools",
				batch: {
					assistantEntryId: assistantId,
					configuration: { ...CONFIGURATION, activeToolNames: ["read"] },
					turnId: "turn",
					argumentAuthority: { kind: "standard_tool_args_registers" },
					calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId: "result-0", replay: "safe" }],
				},
			}),
			{
				assistantEntries: [
					{
						id: assistantId,
						message: fauxAssistantMessage([fauxToolCall("read", { path: "a" }, { id: "call-0" })], {
							stopReason: "toolUse",
						}),
					},
				],
				latestAssistantEntryId: assistantId,
			},
		);
		// The effect_pending call owns a durable tool_args register.
		await session.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.tool_args",
					key: `${operationId}:turn:0`,
					value: { path: "a" },
				},
			],
		});
		let executions = 0;
		const tool = {
			...readTool("read", async () => {
				executions++;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			}),
			replay: "safe" as const,
		};
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
		});
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(executions).toBe(0);
		const result = await session.getEntry("result-0");
		const message = result?.type === "message" && result.message.role === "toolResult" ? result.message : undefined;
		expect(message?.isError).toBe(true);
		expect(textOf(message)).toContain("was interrupted before settlement");
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("keeps completed tool results verbatim and aborts the remaining mixed batch", async () => {
		const { model, models } = await createRuntime();
		const assistantId = "tool-assistant";
		const completedId = "result-done";
		const { session, operationId } = await createSuspendedRun(
			"abort-tools-mixed",
			(_promptEntryId) => ({
				kind: "tools",
				batch: {
					assistantEntryId: assistantId,
					configuration: { ...CONFIGURATION, activeToolNames: ["read"] },
					turnId: "turn",
					argumentAuthority: { kind: "standard_tool_args_registers" },
					calls: [
						{ status: "completed", sourceIndex: 0, resultEntryId: completedId, terminate: false },
						{ status: "planned", sourceIndex: 1, resultEntryId: "result-1" },
					],
				},
			}),
			{
				assistantEntries: [
					{
						id: assistantId,
						message: fauxAssistantMessage(
							[
								fauxToolCall("read", { path: "a" }, { id: "call-0" }),
								fauxToolCall("read", { path: "b" }, { id: "call-1" }),
							],
							{ stopReason: "toolUse" },
						),
					},
				],
				latestAssistantEntryId: assistantId,
			},
		);
		// The completed result entry must exist for restore validation.
		await session.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: completedId,
						parentId: assistantId,
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "call-0",
							toolName: "read",
							content: [{ type: "text", text: "real completed result" }],
							isError: false,
							timestamp: 1,
						} as never,
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: completedId },
			],
		});
		const tool = readTool("read", async () => ({ content: [{ type: "text", text: "ran" }], details: {} }));
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
		});
		await harness.abort();
		await waitForTerminal(session, operationId);
		const completed = await session.getEntry(completedId);
		const message =
			completed?.type === "message" && completed.message.role === "toolResult" ? completed.message : undefined;
		expect(textOf(message)).toBe("real completed result");
		expect(message?.isError).toBe(false);
		const planned = await session.getEntry("result-1");
		expect(planned?.type === "message" && planned.message.role === "toolResult" && planned.message.isError).toBe(
			true,
		);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("does not run adaptive clearance for a cancelled adaptive pending batch", async () => {
		const { model, models } = await createRuntime();
		const assistantId = "tool-assistant";
		const { session, operationId } = await createSuspendedRun(
			"abort-tools-adaptive",
			(_promptEntryId) => ({
				kind: "tools",
				batch: {
					assistantEntryId: assistantId,
					configuration: { ...CONFIGURATION, activeToolNames: ["read"] },
					turnId: "turn",
					argumentAuthority: { kind: "adaptive_pending" },
					calls: [{ status: "planned", sourceIndex: 0, resultEntryId: "result-0" }],
				},
			}),
			{
				assistantEntries: [
					{
						id: assistantId,
						message: fauxAssistantMessage([fauxToolCall("read", { path: "a" }, { id: "call-0" })], {
							stopReason: "toolUse",
						}),
					},
				],
				latestAssistantEntryId: assistantId,
			},
		);
		let clearances = 0;
		const policy: AdaptiveToolBatchClearance = {
			clearBatch: async (input) => {
				clearances++;
				void input;
				return { policyStateFingerprint: "fp", decisions: [] };
			},
		};
		const tool = readTool("read", async () => ({ content: [{ type: "text", text: "ran" }], details: {} }));
		const { harness } = await AgentHarness.create({
			session,
			models,
			model,
			tools: [tool],
			activeToolNames: ["read"],
			adaptiveToolPolicy: policy,
		});
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(clearances).toBe(0);
		const result = await session.getEntry("result-0");
		expect(result?.type === "message" && result.message.role === "toolResult" && result.message.isError).toBe(true);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("keeps tool abort independent from the aborted outcome and does not start a second provider request", async () => {
		const { faux, harness, session } = await createRuntime();
		const executions: string[] = [];
		await harness.setTools([abortingTool(executions)]);
		await harness.setActiveTools(["read"]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("second provider request"),
		]);
		const run = harness.prompt("hello");
		await vi.waitFor(() => expect(executions).toEqual(["x"]));
		await harness.abort();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(faux.state.callCount).toBe(1);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { outcome: "aborted" },
		});
		await harness.close();
	});

	it("aborts a live tool batch settled in manual mode", async () => {
		const { faux, harness, session } = await createRuntime({ drive: "manual" });
		const executions: string[] = [];
		await harness.setTools([abortingTool(executions)]);
		await harness.setActiveTools(["read"]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not run"),
		]);
		const run = harness.prompt("hello");
		await vi.waitFor(async () => {
			const action = await harness.peekAction();
			if (action !== undefined) await harness.executeAction();
			expect(executions).toEqual(["x"]);
		});
		const aborted = await harness.abort();
		expect(aborted).toMatchObject({ ok: true });
		await harness.runToCompletion();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		expect(faux.state.callCount).toBe(1);
		const toolResults = (await session.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		await harness.close();
	});

	it("aborts before tool intent in manual mode: the parked intent replans into aborted synthetics", async () => {
		const { faux, harness, session } = await createRuntime({ drive: "manual" });
		const tool = readTool("read", async () => ({ content: [{ type: "text", text: "ran" }], details: {} }));
		await harness.setTools([tool]);
		await harness.setActiveTools(["read"]);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" })]);
		const run = harness.prompt("hello");
		// Drive step by step until the tool intent parks behind the manual gate.
		for (;;) {
			const action = await vi.waitFor(async () => {
				const candidate = await harness.peekAction();
				expect(candidate).toBeDefined();
				return candidate as NonNullable<typeof candidate>;
			});
			if (action.kind === "commit_tool_intent") break;
			await harness.executeAction();
		}
		await harness.abort();
		await harness.runToCompletion();
		const result = await run;
		expect(result).toMatchObject({ ok: true, value: { kind: "aborted" } });
		const toolResults = (await session.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(1);
		const message =
			toolResults[0]?.type === "message" && toolResults[0].message.role === "toolResult"
				? toolResults[0].message
				: undefined;
		expect(textOf(message)).toContain("was not executed: the Run was aborted");
		await harness.close();
	});
});

describe("Harness v4 R6 deferred and failure-drain cancellation", () => {
	it("runs one best-effort cancel_deferred and waits for it before the aborted terminal", async () => {
		const { faux, model, models } = await createRuntime();
		const sourceEntryId = "deferred-source";
		const { session, operationId } = await createSuspendedRun(
			"abort-deferred",
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
							deferred: { provider: "abort-provider", modelId: "faux-1", api: "abort-api", id: "deferred-id" },
						}),
					},
				],
			},
		);
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.cancelledDeferred).toHaveLength(1);
		expect(faux.state.cancelledDeferred[0]).toMatchObject({ id: "deferred-id" });
		expect(faux.state.callCount).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("skips the deferred cancellation call without a captured provider identity and still finishes aborted", async () => {
		const { faux, model, models } = await createRuntime();
		const sourceEntryId = "deferred-source";
		const { session, operationId } = await createSuspendedRun(
			"abort-deferred-missing",
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
							deferred: {
								provider: "missing-provider",
								modelId: "missing",
								api: "missing-api",
								id: "deferred-id",
							},
						}),
					},
				],
			},
		);
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.cancelledDeferred).toHaveLength(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("applies accepted writes at a cancelled failure_drain and finishes aborted, not failed", async () => {
		const { faux, model, models } = await createRuntime();
		const responseId = "failed-response";
		const writeId = "failure-write";
		const { session, operationId } = await createSuspendedRun(
			"abort-failure-drain",
			(_promptEntryId) => ({
				kind: "failure_drain",
				error: { code: "provider_error", message: "provider failed" },
				provenance: { kind: "response", entryId: responseId },
			}),
			{
				assistantEntries: [
					{
						id: responseId,
						message: fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
					},
				],
				inbox: { steer: [], followUp: [], writes: [writeId] },
				pendingEntries: [{ id: writeId, message: userMessage("accepted before abort") }],
			},
		);
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.callCount).toBe(0);
		const write = await session.getEntry(writeId);
		expect(write).toMatchObject({ type: "message" });
		expect(await session.getRegister("pending.entry", writeId)).toBeUndefined();
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted" },
		});
		await harness.close();
	});

	it("never runs before_run_end on a cancelled may_finish checkpoint", async () => {
		const { model, models } = await createRuntime();
		const responseId = "final-response";
		const { session, operationId } = await createSuspendedRun(
			"abort-may-finish",
			(_promptEntryId) => ({
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseId,
			}),
			{
				assistantEntries: [{ id: responseId, message: fauxAssistantMessage("done") }],
				latestAssistantEntryId: responseId,
			},
		);
		let hooks = 0;
		const { harness } = await AgentHarness.create({ session, models, model });
		harness.hooks.on("before_run_end", async () => {
			hooks++;
			return undefined;
		});
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(hooks).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted", finalAssistantEntryId: responseId },
		});
		await harness.close();
	});
});

describe("Harness v4 R6 structural scaffold cancellation", () => {
	it("aborts a not-started compaction operation without a summary request", async () => {
		const { faux, model, models } = await createRuntime();
		const session = await new InMemorySessionRepo({ now: () => 2_400_000_000_000 }).create({
			id: "abort-compaction",
		});
		const promptEntryId = await session.appendMessage(userMessage("hello"));
		const operationId = "compaction-operation";
		await session.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: CONFIGURATION },
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
						sourceLeafId: promptEntryId,
						startedAt: 10,
						intent: { kind: "compaction" },
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: {
						kind: "compaction",
						control: { status: "running" },
						structural: { taskId: "task", status: "deciding" },
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.preparation",
					key: `${operationId}:task`,
					value: {
						kind: "compaction",
						messagesToSummarize: [],
						turnPrefixMessages: [],
						retainedTail: [],
						isSplitTurn: false,
						tokensBefore: 0,
						fileOps: { read: [], written: [], edited: [] },
						settings: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
					},
				},
			],
		});
		const { harness } = await AgentHarness.create({ session, models, model });
		await harness.abort();
		await waitForTerminal(session, operationId);
		expect(faux.state.callCount).toBe(0);
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, outcome: "aborted", kind: "compaction" },
		});
		expect(await session.getRegister("op.preparation", `${operationId}:task`)).toBeUndefined();
		await harness.close();
	});
});
