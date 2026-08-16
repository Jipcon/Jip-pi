import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PermissiveToolPolicyAdapter } from "../../../adaptive-agent/src/runtime/tool-policy.ts";
import type { BundleFixtures } from "../../../adaptive-agent/test/runtime/stage5-fixtures.ts";
import { createBundleFixtures } from "../../../adaptive-agent/test/runtime/stage5-fixtures.ts";
import { type AdaptiveToolBatchClearance, AgentHarness, JsonlSessionRepo, type Session } from "../../src/harness-v4.ts";
import { CRASH_CATALOG_FINGERPRINT, canonicalSnapshot } from "./fixtures/v4-jsonl-crash-child.ts";

const CHILD_PATH = fileURLToPath(new URL("./fixtures/v4-jsonl-crash-child.ts", import.meta.url));
const CLOCK = 9_000_000_000_000;

const cleanupDirectories = new Set<string>();

afterEach(() => {
	for (const directory of cleanupDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

function okResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

type ParentResponse =
	| string
	| ((context: unknown, options: { signal?: AbortSignal } | undefined) => Promise<AssistantMessage>);

interface AckMessage {
	t: string;
	[k: string]: unknown;
}

class ChildHandle {
	readonly child: ChildProcess;
	private nextId = 1;
	private readonly pending = new Map<number, (value: AckMessage) => void>();
	private readonly events: AckMessage[] = [];
	private readonly eventWaiters: Array<{
		predicate: (event: AckMessage) => boolean;
		resolve: (event: AckMessage) => void;
	}> = [];

	constructor() {
		this.child = spawn(process.execPath, ["--no-warnings", CHILD_PATH], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
			env: { ...process.env, PI_JSONL_CRASH_CHILD: "1" },
		});
		this.child.on("message", (message: AckMessage) => {
			const id = message.__ack;
			if (typeof id === "number") {
				this.pending.get(id)?.(message);
				this.pending.delete(id);
				return;
			}
			this.events.push(message);
			for (const waiter of [...this.eventWaiters]) {
				if (waiter.predicate(message)) {
					this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
					waiter.resolve(message);
				}
			}
		});
		this.child.once("exit", () => {
			this.pending.clear();
		});
	}

	send(command: Record<string, unknown>): Promise<AckMessage> {
		const id = this.nextId++;
		return new Promise<AckMessage>((resolve) => {
			this.pending.set(id, resolve);
			this.child.send({ ...command, __ack: id });
		});
	}

	waitEvent(predicate: (event: AckMessage) => boolean, timeoutMs = 10_000): Promise<AckMessage> {
		const existing = this.events.findIndex(predicate);
		if (existing !== -1) {
			const [event] = this.events.splice(existing, 1);
			return Promise.resolve(event!);
		}
		return new Promise<AckMessage>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timed out waiting for a child event")), timeoutMs);
			this.eventWaiters.push({
				predicate,
				resolve: (event) => {
					clearTimeout(timer);
					resolve(event);
				},
			});
		});
	}

	/** Windows: forced termination; other platforms: SIGKILL. */
	async killNow(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill("SIGKILL");
		await exited;
	}

	async waitExit(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
	}
}

async function initChild(directory: string, seed: string): Promise<ChildHandle> {
	const child = new ChildHandle();
	strictEqual((await child.send({ c: "init", dir: directory, seed, clock: CLOCK })).t, "init");
	return child;
}

/** Wipes prior crash-run files so each child re-drives from a fresh publication. */
function resetDirectory(directory: string): void {
	for (const name of readdirSync(directory)) {
		rmSync(join(directory, name), { recursive: true, force: true });
	}
}

async function runSteps(
	child: ChildHandle,
	steps: Array<Record<string, unknown>>,
): Promise<Array<unknown | undefined>> {
	const snapshots: Array<unknown | undefined> = [];
	for (const step of steps) {
		const reply = await child.send(step);
		if (reply.t === "error") throw new Error(`Child step ${String(step.c)} failed: ${String(reply.message)}`);
		snapshots.push((reply.snapshot as unknown | undefined) ?? undefined);
	}
	return snapshots;
}

/** Runs a baseline (no crash) in its own directory and returns the per-step canonical snapshots. */
async function baseline(seed: string, steps: Array<Record<string, unknown>>): Promise<Array<unknown | undefined>> {
	const directory = mkdtempSync(join(tmpdir(), "pi-crash-baseline-"));
	cleanupDirectories.add(directory);
	try {
		const child = await initChild(directory, seed);
		const snapshots = await runSteps(child, steps);
		const finish = await child.send({ c: "finish" });
		if (finish.t === "error") throw new Error(`Child finish failed: ${String(finish.message)}`);
		snapshots.push(finish.snapshot as unknown);
		await child.waitExit();
		return snapshots;
	} finally {
		rmSync(directory, { recursive: true, force: true });
		cleanupDirectories.delete(directory);
	}
}

/** Kills the child mid-write of the given step; the torn tail is repaired on reopen. */
async function killMidWrite(
	child: ChildHandle,
	arm: { bytes: number; target?: "write" | "append" },
	step: Record<string, unknown>,
): Promise<void> {
	await child.send({ c: "armSplit", bytes: arm.bytes, ...(arm.target === undefined ? {} : { target: arm.target }) });
	const held = child.waitEvent((event) => event.t === "held");
	child.send(step).catch(() => {});
	await held;
	await child.killNow();
}

async function parentRepo(directory: string): Promise<JsonlSessionRepo> {
	return new JsonlSessionRepo({ directory, now: () => CLOCK });
}

function assertPrefixOrFull(
	recovered: unknown,
	snapshots: Array<unknown | undefined>,
	index: number,
	label: string,
): void {
	const before = snapshots[index - 1];
	const after = snapshots[index];
	const equalsBefore = tryEqual(recovered, before);
	const equalsAfter = tryEqual(recovered, after);
	if (!equalsBefore && !equalsAfter) {
		throw new Error(
			`${label}: recovered snapshot matches neither the old prefix (step ${index - 1}) nor the complete new transaction (step ${index})`,
		);
	}
}

function tryEqual(left: unknown, right: unknown): boolean {
	try {
		deepStrictEqual(left, right);
		return true;
	} catch {
		return false;
	}
}

async function createParentHarness(
	session: Session,
	options: {
		provider?: string;
		api?: string;
		responses?: ParentResponse[];
		tools?: Array<{ name: string; replay?: "never" | "safe"; record?: string[] }>;
		activeToolNames?: string[];
		policy?: AdaptiveToolBatchClearance;
		drive?: "automatic" | "manual";
		retry?: { maxAttempts: number; baseDelayMs: number };
		steeringMode?: "all" | "one-at-a-time";
	},
) {
	const faux = fauxProvider({ provider: options.provider ?? "parent-provider", api: options.api ?? "parent-api" });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel() as Model<Api>;
	faux.setResponses(
		(options.responses ?? []).map((response) =>
			typeof response === "string" ? fauxAssistantMessage(response) : response,
		),
	);
	const tools =
		options.tools?.map((spec) => ({
			name: spec.name,
			description: `${spec.name} tool`,
			label: spec.name,
			parameters: Type.Object({ path: Type.String() }),
			...(spec.replay === undefined ? {} : { replay: spec.replay }),
			execute: async () => {
				spec.record?.push(spec.name);
				return okResult(`${spec.name} ran`);
			},
		})) ?? [];
	const { harness } = await AgentHarness.create({
		session,
		models,
		model,
		drive: options.drive ?? "automatic",
		...(tools.length === 0 ? {} : { tools }),
		...(options.activeToolNames === undefined ? {} : { activeToolNames: options.activeToolNames }),
		...(options.policy === undefined ? {} : { adaptiveToolPolicy: options.policy }),
		...(options.retry === undefined
			? {}
			: {
					retry: {
						enabled: true,
						maxRetries: options.retry.maxAttempts - 1,
						baseDelayMs: options.retry.baseDelayMs,
					},
				}),
		...(options.steeringMode === undefined ? {} : { steeringMode: options.steeringMode }),
	});
	return { faux, harness, models, model };
}

function countingPolicy(fixtures: BundleFixtures): {
	attach: (session: Session) => AdaptiveToolBatchClearance;
	count: () => number;
} {
	let count = 0;
	const attach = (session: Session): AdaptiveToolBatchClearance => {
		const policy = new PermissiveToolPolicyAdapter({ registry: fixtures.registry, session });
		const original = policy.clearBatch.bind(policy);
		policy.clearBatch = async (input) => {
			count++;
			return original(input);
		};
		return policy;
	};
	return { attach, count: () => count };
}

function settledValue<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
	if (!result.ok) throw result.error as Error;
	return result.value;
}

function opState(session: Session, operationId: string): Promise<unknown> {
	return session.getRegister("op.state", operationId).then((register) => register?.value);
}

async function toolResults(session: Session): Promise<Array<{ id: string; text: string }>> {
	const entries = await session.findEntries({ type: "message", order: "asc" });
	return entries
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.map((entry) => ({
			id: entry.id,
			text:
				entry.type === "message"
					? ((entry.message as { content: Array<{ text: string }> }).content[0]?.text ?? "")
					: "",
		}));
}

async function waitForAction(harness: AgentHarness, kind: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const action = await harness.peekAction();
		if (action?.kind === kind) return;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for action ${kind}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("JSONL v1 process-crash matrix", () => {
	it("create publication: a crash before the rename leaves no session; after it the header and initial lane transaction are visible", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-create-"));
		cleanupDirectories.add(directory);
		const steps = [{ c: "create", id: "crash-create" }];
		const snapshots = await baseline("create", steps);

		const before = await initChild(directory, "create");
		await killMidWrite(before, { bytes: 24, target: "write" }, { c: "create", id: "crash-create" });

		const repo = await parentRepo(directory);
		deepStrictEqual(await repo.list(), []);
		await expect(repo.open({ id: "crash-create", createdAt: CLOCK, storageVersion: 1 })).rejects.toMatchObject({
			code: "not_found",
		});

		resetDirectory(directory);
		const after = await initChild(directory, "create");
		await after.send({ c: "create", id: "crash-create" });
		await after.killNow();

		const session = await repo.open({ id: "crash-create", createdAt: CLOCK, storageVersion: 1 });
		deepStrictEqual(await canonicalSnapshot(session), snapshots[0]);
		strictEqual((await session.getRegister("lane.leaf", "main"))?.value, null);
		strictEqual((await session.getRegister("lane.state", "main"))?.value.currentOperationId, null);
		await session.close();
	});

	it("fork publication: a crash before the rename leaves only the source; after it the child is complete and idle", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-fork-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-source" },
			{ c: "append", text: "root" },
			{ c: "append", text: "tail" },
			{ c: "setName", name: "Source" },
			{ c: "commitUsagePending" },
			{ c: "fork", id: "crash-fork" },
		];
		const snapshots = await baseline("fork", steps);

		const before = await initChild(directory, "fork");
		await runSteps(before, steps.slice(0, 5));
		await killMidWrite(before, { bytes: 16, target: "write" }, { c: "fork", id: "crash-fork" });

		const repo = await parentRepo(directory);
		deepStrictEqual(
			(await repo.list()).map((item) => item.id),
			["crash-source"],
		);
		await expect(repo.open({ id: "crash-fork", createdAt: CLOCK, storageVersion: 1 })).rejects.toMatchObject({
			code: "not_found",
		});
		const source = await repo.open({ id: "crash-source", createdAt: CLOCK, storageVersion: 1 });
		deepStrictEqual(await canonicalSnapshot(source), snapshots[4]);
		await source.close();

		resetDirectory(directory);
		const after = await initChild(directory, "fork");
		await runSteps(after, steps);
		await after.killNow();

		const child = await repo.open({ id: "crash-fork", createdAt: CLOCK, storageVersion: 1 });
		deepStrictEqual(await canonicalSnapshot(child), snapshots[5]);
		const entries = await child.findEntries({ order: "asc" });
		strictEqual(entries.length, 1);
		strictEqual(await child.getLeafId(), entries[0]!.id);
		strictEqual(await child.getName(), "Source");
		deepStrictEqual(await child.scanUsage({}), []);
		deepStrictEqual(await child.listRegisters("pending.entry"), []);
		strictEqual((await child.getRegister("lane.state", "main"))?.value.currentOperationId, null);
		strictEqual(child.metadata.parentSessionId, "crash-source");
		await child.close();
	});

	it("operation acceptance: a torn acceptance append leaves the lane idle; a complete one publishes prompt, basis, op, and lane together", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-accept-"));
		cleanupDirectories.add(directory);
		const config = {
			c: "harness",
			config: { provider: "accept-provider", api: "accept-api", responses: [{ kind: "text", text: "settled" }] },
		};
		const steps = [
			{ c: "create", id: "crash-accept" },
			config,
			{ c: "promptAdaptive", text: "hello" },
			{ c: "waitAcceptance" },
		];
		const snapshots = await baseline("accept", steps);
		const metadata = { id: "crash-accept", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "accept");
		await runSteps(before, steps.slice(0, 2));
		await killMidWrite(before, { bytes: 24, target: "append" }, { c: "promptAdaptive", text: "hello" });

		const repo = await parentRepo(directory);
		const recovered = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(recovered), snapshots[1]);
		strictEqual((await recovered.getRegister("lane.state", "main"))?.value.currentOperationId, null);
		deepStrictEqual(await recovered.findEntries(), []);
		deepStrictEqual(await recovered.listRegisters("op.meta"), []);
		deepStrictEqual(await recovered.listRegisters("op.state"), []);
		await recovered.setName("still writable");
		await recovered.close();
		const writable = await repo.open(metadata);
		strictEqual(await writable.getName(), "still writable");
		await writable.close();

		resetDirectory(directory);
		const after = await initChild(directory, "accept");
		await runSteps(after, steps);
		await after.killNow();

		const session = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(session), snapshots[3]);
		const promptEntries = (await session.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		strictEqual(promptEntries.length, 1);
		const basis = await session.findEntry({ type: "custom", customType: "adaptive.run_basis" });
		expect(basis?.type === "custom" ? basis.data : undefined).toMatchObject({
			taskId: "task",
			candidateId: "candidate",
		});
		const laneState = await session.getRegister("lane.state", "main");
		strictEqual(typeof laneState?.value.currentOperationId, "string");
		deepStrictEqual(
			await session.listRegisters("op.meta").then((registers) => registers.map((register) => register.key)),
			[laneState!.value.currentOperationId],
		);
		deepStrictEqual(
			await session.listRegisters("op.state").then((registers) => registers.map((register) => register.key)),
			[laneState!.value.currentOperationId],
		);
		await session.close();
	});

	it("provider intent: a torn intent commit keeps the generation ready; a complete one durably publishes effect_pending with reserved ids", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-intent-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-intent" },
			{
				c: "harness",
				config: {
					provider: "intent-provider",
					api: "intent-api",
					responses: [{ kind: "text", text: "intent-answer" }],
					retry: { maxAttempts: 2, baseDelayMs: 0 },
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "waitCall", n: 1 },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("intent", steps);
		const metadata = { id: "crash-intent", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "intent");
		await runSteps(before, steps.slice(0, 5));
		await killMidWrite(before, { bytes: 12, target: "append" }, { c: "step" });

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[4]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		expect(await opState(sessionA, laneA!.value.currentOperationId as string)).toMatchObject({
			phase: { kind: "assistant", generation: { status: "ready" } },
		});
		const { faux: fauxA, harness: harnessA } = await createParentHarness(sessionA, {
			provider: "intent-provider",
			api: "intent-api",
			responses: ["recovered"],
			drive: "manual",
			retry: { maxAttempts: 2, baseDelayMs: 0 },
		});
		const resumeA = harnessA.resume();
		await waitForAction(harnessA, "commit_transition");
		await harnessA.runToCompletion();
		expect(settledValue(await resumeA)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "recovered" }] },
		});
		strictEqual(fauxA.state.callCount, 1);
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "intent");
		await runSteps(after, steps.slice(0, 6));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[5]);
		const laneB = await sessionB.getRegister("lane.state", "main");
		const stateB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			phase: { generation: { status: string; attempt: number; responseEntryId: string; usageId: string } };
		};
		strictEqual(stateB.phase.generation.status, "effect_pending");
		strictEqual(stateB.phase.generation.attempt, 1);
		strictEqual(typeof stateB.phase.generation.responseEntryId, "string");
		strictEqual(typeof stateB.phase.generation.usageId, "string");
		const reservedId = stateB.phase.generation.responseEntryId;
		const { faux: fauxB, harness: harnessB } = await createParentHarness(sessionB, {
			provider: "intent-provider",
			api: "intent-api",
			responses: ["second attempt"],
			drive: "manual",
			retry: { maxAttempts: 2, baseDelayMs: 0 },
		});
		const resumeB = harnessB.resume();
		await waitForAction(harnessB, "commit_transition");
		await harnessB.executeAction();
		await harnessB.coordinator.gate.whenIdle();
		const readyB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			phase: { generation: { status: string; nextAttempt: number } };
		};
		strictEqual(readyB.phase.generation.status, "ready");
		strictEqual(readyB.phase.generation.nextAttempt, 2);
		await waitForAction(harnessB, "commit_transition");
		await harnessB.executeAction();
		await harnessB.coordinator.gate.whenIdle();
		const advanced = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			phase: { generation: { attempt: number } };
		};
		strictEqual(advanced.phase.generation.attempt, 2);
		await harnessB.runToCompletion();
		expect(settledValue(await resumeB)).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "second attempt" }] },
		});
		strictEqual(fauxB.state.callCount, 1);
		expect(await sessionB.getEntry(reservedId)).toBeUndefined();
		await harnessB.close();
	});

	it("tool intent: planned calls re-prepare after a torn commit; a complete commit persists op.tool_args with the effect state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-tool-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-tool" },
			{
				c: "harness",
				config: {
					provider: "tool-provider",
					api: "tool-api",
					responses: [
						{ kind: "toolUse", calls: [{ name: "read", args: { path: "x" }, id: "call-read" }] },
						{ kind: "text", text: "done" },
					],
					tools: [{ name: "read", replay: "safe" }],
					activeToolNames: ["read"],
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("tool", steps);
		const metadata = { id: "crash-tool", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "tool");
		await runSteps(before, steps.slice(0, 8));
		await killMidWrite(before, { bytes: 16, target: "append" }, { c: "step" });

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[7]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		const phaseA = (await opState(sessionA, laneA!.value.currentOperationId as string)) as {
			phase: { batch: { calls: Array<{ status: string }> } };
		};
		strictEqual(phaseA.phase.batch.calls[0]?.status, "planned");
		deepStrictEqual(await sessionA.listRegisters("op.tool_args"), []);
		const executedA: string[] = [];
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "tool-provider",
			api: "tool-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedA }],
			activeToolNames: ["read"],
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "done" }] },
		});
		deepStrictEqual(executedA, ["read"]);
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "tool");
		await runSteps(after, steps.slice(0, 9));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[8]);
		const toolArgs = await sessionB.listRegisters("op.tool_args");
		strictEqual(toolArgs.length, 1);
		const laneB = await sessionB.getRegister("lane.state", "main");
		const phaseB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			phase: { batch: { calls: Array<{ status: string; replay: string; resultEntryId: string }> } };
		};
		strictEqual(phaseB.phase.batch.calls[0]?.status, "effect_pending");
		strictEqual(phaseB.phase.batch.calls[0]?.replay, "safe");
		const reservedId = phaseB.phase.batch.calls[0]!.resultEntryId;

		const executedB: string[] = [];
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "tool-provider",
			api: "tool-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedB }],
			activeToolNames: ["read"],
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "done" }] },
		});
		deepStrictEqual(executedB, ["read"]);
		const resultsB = await toolResults(sessionB);
		strictEqual(resultsB.length, 1);
		strictEqual(resultsB[0]!.id, reservedId);
		await harnessB.close();
	});

	it("tool intent with an unsafe or changed declaration: zero effects and a synthetic interrupted result", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-tool-unsafe-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-tool-unsafe" },
			{
				c: "harness",
				config: {
					provider: "tool-provider",
					api: "tool-api",
					responses: [
						{ kind: "toolUse", calls: [{ name: "read", args: { path: "x" }, id: "call-read" }] },
						{ kind: "text", text: "done" },
					],
					tools: [{ name: "read", replay: "safe" }],
					activeToolNames: ["read"],
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
		];
		await baseline("tool-unsafe", steps);
		const metadata = { id: "crash-tool-unsafe", createdAt: CLOCK, storageVersion: 1 };

		for (const variant of [
			{ name: "declared never", tools: [{ name: "read", replay: "never" as const }] },
			{ name: "declaration removed", tools: [] },
		]) {
			resetDirectory(directory);
			const child = await initChild(directory, "tool-unsafe");
			await runSteps(child, steps.slice(0, 9));
			await child.killNow();

			const repo = await parentRepo(directory);
			const session = await repo.open(metadata);
			const executed: string[] = [];
			const { harness } = await createParentHarness(session, {
				provider: "tool-provider",
				api: "tool-api",
				responses: ["done"],
				tools: variant.tools.map((spec) => ({ ...spec, record: executed })),
				activeToolNames: variant.tools.map((spec) => spec.name),
			});
			await harness.resume();
			strictEqual(executed.length, 0, `${variant.name}: no tool effect may run`);
			const results = await toolResults(session);
			strictEqual(results.length, 1, `${variant.name}: exactly one durable tool-result entry`);
			expect(results[0]!.text).toContain("interrupted before settlement");
			await harness.close();
		}
	});

	it("adaptive tool intent: clearance re-runs only when the batch entry never committed", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-adaptive-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-adaptive" },
			{
				c: "harness",
				config: {
					provider: "adaptive-provider",
					api: "adaptive-api",
					responses: [
						{ kind: "toolUse", calls: [{ name: "read", args: { path: "x" }, id: "call-read" }] },
						{ kind: "text", text: "done" },
					],
					tools: [{ name: "read", replay: "safe" }],
					activeToolNames: ["read"],
					policy: "permissive",
				},
			},
			{ c: "promptAdaptive", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("adaptive", steps);
		const metadata = { id: "crash-adaptive", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "adaptive");
		await runSteps(before, steps.slice(0, 9));
		await killMidWrite(before, { bytes: 16, target: "append" }, { c: "step" });

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[8]);
		expect(await sessionA.findEntry({ type: "custom", customType: "adaptive.tool_batch" })).toBeUndefined();
		const laneA = await sessionA.getRegister("lane.state", "main");
		const phaseA = (await opState(sessionA, laneA!.value.currentOperationId as string)) as {
			phase: { batch: { calls: Array<{ status: string }> } };
		};
		strictEqual(phaseA.phase.batch.calls[0]?.status, "planned");
		const fixtures = await createBundleFixtures({ catalogFingerprint: CRASH_CATALOG_FINGERPRINT });
		const countingA = countingPolicy(fixtures);
		const executedA: string[] = [];
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "adaptive-provider",
			api: "adaptive-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedA }],
			activeToolNames: ["read"],
			policy: countingA.attach(sessionA),
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({ kind: "completed" });
		strictEqual(countingA.count(), 1);
		deepStrictEqual(executedA, ["read"]);
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "adaptive");
		await runSteps(after, steps.slice(0, 10));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[9]);
		const batchEntry = await sessionB.findEntry({ type: "custom", customType: "adaptive.tool_batch" });
		expect(batchEntry?.type === "custom" ? batchEntry.data : undefined).toMatchObject({
			schemaVersion: 1,
			decisions: [{ kind: "allow", toolName: "read" }],
		});
		const countingB = countingPolicy(fixtures);
		const executedB: string[] = [];
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "adaptive-provider",
			api: "adaptive-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedB }],
			activeToolNames: ["read"],
			policy: countingB.attach(sessionB),
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({ kind: "completed" });
		strictEqual(countingB.count(), 0);
		deepStrictEqual(executedB, ["read"]);
		await harnessB.close();
	});

	it("assistant settlement: no partial writes before it, and no provider call after it is durable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-settle-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-settle" },
			{
				c: "harness",
				config: { provider: "settle-provider", api: "settle-api", responses: [{ kind: "text", text: "settled" }] },
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "waitCall", n: 1 },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("settle", steps);
		const metadata = { id: "crash-settle", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "settle");
		await runSteps(before, steps.slice(0, 7));
		await before.killNow();

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[6]);
		const assistantsA = (await sessionA.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		strictEqual(assistantsA.length, 0);
		deepStrictEqual(await sessionA.scanUsage({}), []);
		const laneA = await sessionA.getRegister("lane.state", "main");
		expect(await opState(sessionA, laneA!.value.currentOperationId as string)).toMatchObject({
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});
		const { faux: fauxA, harness: harnessA } = await createParentHarness(sessionA, {
			provider: "settle-provider",
			api: "settle-api",
			responses: [],
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({ kind: "failed" });
		strictEqual(fauxA.state.callCount, 0);
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "settle");
		await runSteps(after, steps.slice(0, 9));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[8]);
		const assistantsB = (await sessionB.findEntries({ type: "message" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		);
		strictEqual(assistantsB.length, 1);
		strictEqual(await sessionB.getLeafId(), assistantsB[0]!.id);
		strictEqual((await sessionB.scanUsage({})).length, 1);
		const laneB = await sessionB.getRegister("lane.state", "main");
		expect(await opState(sessionB, laneB!.value.currentOperationId as string)).toMatchObject({
			phase: { kind: "checkpoint", continuation: { kind: "may_finish" } },
			latestAssistantEntryId: assistantsB[0]!.id,
		});
		const { faux: fauxB, harness: harnessB } = await createParentHarness(sessionB, {
			provider: "settle-provider",
			api: "settle-api",
			responses: [],
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "settled" }] },
		});
		strictEqual(fauxB.state.callCount, 0);
		await harnessB.close();
	});

	it("tool settlement: a crash mid-tool keeps the original effect state and replays only safe under the reserved id", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-tool-settle-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-tool-settle" },
			{
				c: "harness",
				config: {
					provider: "tool-provider",
					api: "tool-api",
					responses: [
						{ kind: "toolUse", calls: [{ name: "read", args: { path: "x" }, id: "call-read" }] },
						{ kind: "text", text: "done" },
					],
					tools: [{ name: "read", replay: "safe" }],
					activeToolNames: ["read"],
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "waitTool", n: 1 },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("tool-settle", steps);
		const metadata = { id: "crash-tool-settle", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "tool-settle");
		await runSteps(before, steps.slice(0, 12));
		await before.killNow();

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[10]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		const phaseA = (await opState(sessionA, laneA!.value.currentOperationId as string)) as {
			phase: { batch: { calls: Array<{ status: string; resultEntryId: string }> } };
		};
		strictEqual(phaseA.phase.batch.calls[0]?.status, "effect_pending");
		const reservedId = phaseA.phase.batch.calls[0]!.resultEntryId;
		strictEqual((await toolResults(sessionA)).length, 0);

		const executedA: string[] = [];
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "tool-provider",
			api: "tool-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedA }],
			activeToolNames: ["read"],
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({ kind: "completed" });
		deepStrictEqual(executedA, ["read"]);
		const resultsA = await toolResults(sessionA);
		strictEqual(resultsA.length, 1);
		strictEqual(resultsA[0]!.id, reservedId);
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "tool-settle");
		await runSteps(after, steps.slice(0, 14));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[13]);
		const resultsB = await toolResults(sessionB);
		strictEqual(resultsB.length, 1);
		strictEqual(resultsB[0]!.id, reservedId);
		strictEqual(await sessionB.getLeafId(), resultsB[0]!.id);
		strictEqual((await sessionB.scanUsage({ entryIds: [resultsB[0]!.id] })).length, 1);
		const laneB = await sessionB.getRegister("lane.state", "main");
		const phaseB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			phase: { batch: { calls: Array<{ status: string }> } };
		};
		strictEqual(phaseB.phase.batch.calls[0]?.status, "completed");
		const executedB: string[] = [];
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "tool-provider",
			api: "tool-api",
			responses: ["done"],
			tools: [{ name: "read", replay: "safe", record: executedB }],
			activeToolNames: ["read"],
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "done" }] },
		});
		strictEqual(executedB.length, 0);
		await harnessB.close();
	});

	it("inbox drain: pending registers and the old leaf survive a crash before the drain and never double-consume after it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-drain-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-drain" },
			{
				c: "harness",
				config: {
					provider: "drain-provider",
					api: "drain-api",
					responses: [
						{ kind: "text", text: "first" },
						{ kind: "text", text: "second" },
						{ kind: "text", text: "third" },
					],
					steeringMode: "one-at-a-time",
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "steer", text: "steer one" },
			{ c: "steer", text: "steer two" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "waitCall", n: 1 },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("drain", steps);
		const metadata = { id: "crash-drain", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "drain");
		await runSteps(before, steps.slice(0, 12));
		await before.killNow();

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[11]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		const stateA = (await opState(sessionA, laneA!.value.currentOperationId as string)) as {
			inbox: { steer: string[] };
		};
		strictEqual(stateA.inbox.steer.length, 2);
		const [steerOneA, steerTwoA] = stateA.inbox.steer as [string, string];
		expect(await sessionA.getRegister("pending.entry", steerOneA)).toBeDefined();
		expect(await sessionA.getRegister("pending.entry", steerTwoA)).toBeDefined();
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "drain-provider",
			api: "drain-api",
			responses: ["second", "third"],
			steeringMode: "one-at-a-time",
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "third" }] },
		});
		expect(await sessionA.getRegister("pending.entry", steerOneA)).toBeUndefined();
		expect(await sessionA.getRegister("pending.entry", steerTwoA)).toBeUndefined();
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "drain");
		await runSteps(after, steps.slice(0, 13));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[12]);
		const laneB = await sessionB.getRegister("lane.state", "main");
		const stateB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			inbox: { steer: string[] };
		};
		strictEqual(stateB.inbox.steer.length, 1);
		const remainingSteer = stateB.inbox.steer[0]!;
		expect(await sessionB.getEntry(steerOneA)).toMatchObject({ type: "message" });
		expect(await sessionB.getRegister("pending.entry", steerOneA)).toBeUndefined();
		expect(await sessionB.getRegister("pending.entry", remainingSteer)).toBeDefined();
		strictEqual(await sessionB.getLeafId(), steerOneA);
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "drain-provider",
			api: "drain-api",
			responses: ["second", "third"],
			steeringMode: "one-at-a-time",
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "third" }] },
		});
		const branchB = await sessionB.findEntriesOnBranch({ order: "oldestFirst" });
		strictEqual(branchB.filter((entry) => entry.id === steerOneA).length, 1);
		await harnessB.close();
	});

	it("abort marker: the running control and queue survive a crash before it; the drained marker is atomic after it", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-abort-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-abort" },
			{ c: "harness", config: { provider: "abort-provider", api: "abort-api", responses: [{ kind: "block" }] } },
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "steer", text: "queued before abort" },
			{ c: "append", text: "pre-crash write" },
			{ c: "abort" },
		];
		const snapshots = await baseline("abort", steps);
		const metadata = { id: "crash-abort", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "abort");
		await runSteps(before, steps.slice(0, 6));
		await before.killNow();

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[5]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		const stateA = (await opState(sessionA, laneA!.value.currentOperationId as string)) as {
			control: { status: string };
			inbox: { steer: string[]; writes: string[] };
		};
		strictEqual(stateA.control.status, "running");
		strictEqual(stateA.inbox.steer.length, 1);
		const steerId = stateA.inbox.steer[0]!;
		const writeId = stateA.inbox.writes[0]!;
		expect(await sessionA.getRegister("pending.entry", steerId)).toBeDefined();
		expect(await sessionA.getRegister("pending.entry", writeId)).toBeDefined();
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "abort-provider",
			api: "abort-api",
			responses: [],
			drive: "manual",
		});
		expect(await harnessA.abort()).toMatchObject({ ok: true });
		// The abort marker wakes a process-local recovery drive (tracked by
		// the manual gate); run it to the aborted terminal instead of racing
		// it with a second resume.
		await harnessA.runToCompletion();
		expect(await sessionA.getEntry(writeId)).toMatchObject({ type: "message" });
		expect(await sessionA.getRegister("lane.lastResult", "main")).toMatchObject({ value: { outcome: "aborted" } });
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "abort");
		await runSteps(after, steps.slice(0, 7));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[6]);
		const laneB = await sessionB.getRegister("lane.state", "main");
		const stateB = (await opState(sessionB, laneB!.value.currentOperationId as string)) as {
			control: { status: string; drainedSteer: string[]; drainedFollowUp: string[] };
			inbox: { steer: string[] };
		};
		strictEqual(stateB.control.status, "cancel_requested");
		deepStrictEqual(stateB.control.drainedSteer, [steerId]);
		deepStrictEqual(stateB.control.drainedFollowUp, []);
		deepStrictEqual(stateB.inbox.steer, []);
		expect(await sessionB.getRegister("pending.entry", steerId)).toBeDefined();
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "abort-provider",
			api: "abort-api",
			responses: [],
		});
		expect(settledValue(await harnessB.resume())).toMatchObject({ kind: "aborted" });
		expect(await sessionB.getEntry(writeId)).toMatchObject({ type: "message" });
		expect(await sessionB.getRegister("pending.entry", steerId)).toBeUndefined();
		expect(await sessionB.getRegister("pending.entry", writeId)).toBeUndefined();
		expect(await sessionB.getRegister("lane.lastResult", "main")).toMatchObject({ value: { outcome: "aborted" } });
		await harnessB.close();
	});

	it("terminal cleanup: a crash before it keeps a coherent open operation; after it all op registers are gone and lastResult is set", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-terminal-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-terminal" },
			{
				c: "harness",
				config: { provider: "terminal-provider", api: "terminal-api", responses: [{ kind: "text", text: "done" }] },
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
			{ c: "step" },
			{ c: "waitCall", n: 1 },
			{ c: "step" },
			{ c: "step" },
		];
		const snapshots = await baseline("terminal", steps);
		const metadata = { id: "crash-terminal", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "terminal");
		await runSteps(before, steps.slice(0, 9));
		await before.killNow();

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionA), snapshots[8]);
		const laneA = await sessionA.getRegister("lane.state", "main");
		strictEqual(typeof laneA?.value.currentOperationId, "string");
		strictEqual((await sessionA.listRegisters("op.meta")).length, 1);
		expect(await sessionA.getRegister("lane.lastResult", "main")).toBeUndefined();
		const { harness: harnessA } = await createParentHarness(sessionA, {
			provider: "terminal-provider",
			api: "terminal-api",
			responses: [],
		});
		expect(settledValue(await harnessA.resume())).toMatchObject({
			kind: "completed",
			finalMessage: { content: [{ text: "done" }] },
		});
		deepStrictEqual(await sessionA.listRegisters("op.meta"), []);
		expect(await sessionA.getRegister("lane.lastResult", "main")).toMatchObject({ value: { outcome: "completed" } });
		await harnessA.close();

		resetDirectory(directory);
		const after = await initChild(directory, "terminal");
		await runSteps(after, steps.slice(0, 10));
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[9]);
		deepStrictEqual(await sessionB.listRegisters("op.meta"), []);
		deepStrictEqual(await sessionB.listRegisters("op.state"), []);
		expect(await sessionB.getRegister("lane.lastResult", "main")).toMatchObject({ value: { outcome: "completed" } });
		strictEqual((await sessionB.getRegister("lane.state", "main"))?.value.currentOperationId, null);
		const { harness: harnessB } = await createParentHarness(sessionB, {
			provider: "terminal-provider",
			api: "terminal-api",
			responses: [],
		});
		expect(await harnessB.resume()).toMatchObject({ ok: false, error: { _tag: "NothingToResume" } });
		await harnessB.close();
	});

	it("torn append: recovery observes the old prefix or the complete transaction, never a mix", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-torn-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-torn" },
			{ c: "append", text: "torn-entry" },
		];
		const snapshots = await baseline("torn", steps);
		const metadata = { id: "crash-torn", createdAt: CLOCK, storageVersion: 1 };

		const before = await initChild(directory, "torn");
		await before.send(steps[0]!);
		await killMidWrite(before, { bytes: 10, target: "append" }, { c: "append", text: "torn-entry" });

		const repo = await parentRepo(directory);
		const sessionA = await repo.open(metadata);
		const recoveredA = await canonicalSnapshot(sessionA);
		assertPrefixOrFull(recoveredA, snapshots, 1, "torn append");
		deepStrictEqual(recoveredA, snapshots[0]);
		await sessionA.setName("after repair");
		await sessionA.close();
		const reread = await repo.open(metadata);
		strictEqual(await reread.getName(), "after repair");
		await reread.close();

		resetDirectory(directory);
		const after = await initChild(directory, "torn");
		await runSteps(after, steps);
		await after.killNow();

		const sessionB = await repo.open(metadata);
		deepStrictEqual(await canonicalSnapshot(sessionB), snapshots[1]);
		strictEqual((await sessionB.findEntries()).length, 1);
		await sessionB.close();
	});

	it("never replays the same assistant effect key across processes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-crash-key-"));
		cleanupDirectories.add(directory);
		const steps = [
			{ c: "create", id: "crash-key" },
			{
				c: "harness",
				config: {
					provider: "key-provider",
					api: "key-api",
					responses: [{ kind: "text", text: "key-answer" }],
					retry: { maxAttempts: 3, baseDelayMs: 0 },
				},
			},
			{ c: "prompt", text: "hello" },
			{ c: "waitAcceptance" },
			{ c: "step" },
			{ c: "step" },
		];
		await baseline("key", steps);
		const metadata = { id: "crash-key", createdAt: CLOCK, storageVersion: 1 };

		const child = await initChild(directory, "key");
		await runSteps(child, steps);
		await child.killNow();

		const repo = await parentRepo(directory);
		const session = await repo.open(metadata);
		const lane = await session.getRegister("lane.state", "main");
		const before = (await opState(session, lane!.value.currentOperationId as string)) as {
			phase: { generation: { attempt: number; responseEntryId: string } };
		};
		strictEqual(before.phase.generation.attempt, 1);
		const firstReserved = before.phase.generation.responseEntryId;
		const { faux, harness } = await createParentHarness(session, {
			provider: "key-provider",
			api: "key-api",
			responses: ["only attempt two"],
			drive: "manual",
			retry: { maxAttempts: 3, baseDelayMs: 0 },
		});
		const resumed = harness.resume();
		await waitForAction(harness, "commit_transition");
		await harness.executeAction();
		await harness.coordinator.gate.whenIdle();
		const ready = (await opState(session, lane!.value.currentOperationId as string)) as {
			phase: { generation: { status: string; nextAttempt: number } };
		};
		strictEqual(ready.phase.generation.status, "ready");
		strictEqual(ready.phase.generation.nextAttempt, 2);
		await waitForAction(harness, "commit_transition");
		await harness.executeAction();
		await harness.coordinator.gate.whenIdle();
		const advanced = (await opState(session, lane!.value.currentOperationId as string)) as {
			phase: { generation: { attempt: number; responseEntryId: string } };
		};
		strictEqual(advanced.phase.generation.attempt, 2);
		notStrictEqual(advanced.phase.generation.responseEntryId, firstReserved);
		await harness.runToCompletion();
		expect(settledValue(await resumed)).toMatchObject({ kind: "completed" });
		strictEqual(faux.state.callCount, 1);
		expect(await session.getEntry(firstReserved)).toBeUndefined();
		await harness.close();
	});
});
