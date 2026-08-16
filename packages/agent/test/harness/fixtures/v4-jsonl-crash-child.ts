/**
 * Real-process crash driver for the JSONL process-crash matrix. The parent
 * vitest process spawns this file with `process.execPath` and drives it over
 * IPC; the parent force-terminates it (Windows) or SIGKILLs it (other
 * platforms) at durable boundaries. Nothing in here is production API.
 *
 * Determinism: `Date.now` is pinned to the scenario clock and
 * `crypto.getRandomValues` is seeded so baseline and crash runs produce
 * byte-identical durable snapshots.
 */
import { mkdirSync } from "node:fs";
import { appendFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	createOriginCapsule,
	fingerprintPolicyBundle,
	type PolicyBundleRef,
	PROJECTOR_VERSION,
} from "../../../../adaptive-agent/src/index.ts";
import { originSnapshot, permissiveBundle } from "../../../../adaptive-agent/test/runtime/stage5-fixtures.ts";
import type { AgentHarnessTool } from "../../../src/harness/types.ts";
import {
	type AdaptiveRunBasisInput,
	type AdaptiveToolBatchClearance,
	type AdaptiveToolClearanceInput,
	type AdaptiveToolClearanceResult,
	AgentHarness,
	type JsonlFileSystem,
	JsonlSessionRepo,
	type JsonValue,
	type RegisterNamespace,
	type Session,
	type SessionMetadata,
} from "../../../src/harness-v4.ts";
import type { AgentMessage } from "../../../src/types.ts";

const REGISTER_NAMESPACES: readonly RegisterNamespace[] = [
	"lane.leaf",
	"lane.config",
	"lane.state",
	"lane.lastResult",
	"op.meta",
	"op.state",
	"op.tool_args",
	"op.preparation",
	"pending.entry",
	"fact.name",
	"fact.label",
	"fact.custom",
];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

/**
 * Deterministic real run basis for adaptive acceptance: a permissive bundle
 * with a fixed catalog fingerprint (the permissive adapter never checks the
 * catalog), plus a valid task-origin capsule. Both the child and the parent
 * vitest process construct byte-identical content, so the parent's registry
 * resolves the exact ref the child persisted.
 */
export const CRASH_CATALOG_FINGERPRINT = "0".repeat(64);

function adaptiveBasis(sessionId: string): AdaptiveRunBasisInput {
	const bundle = permissiveBundle(CRASH_CATALOG_FINGERPRINT);
	const ref: PolicyBundleRef = { version: bundle.version, fingerprint: fingerprintPolicyBundle(bundle) };
	return {
		schemaVersion: 1,
		taskId: "task",
		candidateId: "candidate",
		policyBundle: ref,
		projectorVersion: PROJECTOR_VERSION,
		inheritedPolicyState: createOriginCapsule({
			taskId: "task",
			candidateId: "candidate",
			sessionId,
			lane: "main",
			policyBundle: ref,
			snapshot: originSnapshot(bundle),
		}),
		start: { kind: "prompt" },
	} as unknown as AdaptiveRunBasisInput;
}

/** Durable-state projection compared byte-for-byte between baseline and crash runs. */
export async function canonicalSnapshot(session: Session): Promise<unknown> {
	const entries = await session.findEntries({ order: "asc" });
	const registers: unknown[] = [];
	for (const namespace of REGISTER_NAMESPACES) {
		registers.push(...(await session.listRegisters(namespace)));
	}
	registers.sort((left, right) => (left as { seq: number }).seq - (right as { seq: number }).seq);
	const usage = await session.scanUsage({ order: "asc" });
	const stats = await session.getStats();
	return JSON.parse(JSON.stringify({ entries, registers, usage, stats }));
}

type ChildResponse =
	| { kind: "text"; text: string }
	| { kind: "toolUse"; calls: Array<{ name: string; args: Record<string, JsonValue>; id?: string }> }
	| { kind: "block" };

interface ChildToolSpec {
	name: string;
	replay?: "never" | "safe";
}

interface HarnessConfig {
	provider: string;
	api: string;
	responses: ChildResponse[];
	tools?: ChildToolSpec[];
	activeToolNames?: string[];
	policy?: "permissive";
	steeringMode?: "all" | "one-at-a-time";
	retry?: { maxAttempts: number; baseDelayMs: number };
}

/** Test-only decorator that splits one write/append and parks mid-write for the parent kill. */
class SplitFileSystem implements JsonlFileSystem {
	private armed: { bytes: number; target: "write" | "append" } | undefined;
	private onHeld: (() => void) | undefined;

	arm(bytes: number, target: "write" | "append"): void {
		this.armed = { bytes, target };
	}

	setOnHeld(handler: () => void): void {
		this.onHeld = handler;
	}

	ensureDirectory(path: string): void {
		mkdirSync(path, { recursive: true });
	}

	async listFiles(directory: string): Promise<string[]> {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile())
			.map((entry) => join(directory, entry.name));
	}

	readTextFile(path: string): Promise<string> {
		return readFile(path, "utf8");
	}

	async readHead(path: string, maxBytes: number): Promise<string> {
		return (await readFile(path, "utf8")).slice(0, maxBytes);
	}

	async writeFile(path: string, data: string): Promise<void> {
		if (this.armed?.target === "write" && data.length > this.armed.bytes) {
			await this.split(path, data, false);
			return;
		}
		await writeFile(path, data, "utf8");
	}

	async appendFile(path: string, data: string): Promise<void> {
		if (this.armed?.target === "append" && data.length > this.armed.bytes) {
			await this.split(path, data, true);
			return;
		}
		await appendFile(path, data, "utf8");
	}

	private async split(path: string, data: string, appending: boolean): Promise<void> {
		const armed = this.armed!;
		this.armed = undefined;
		if (appending) await appendFile(path, data.slice(0, armed.bytes), "utf8");
		else await writeFile(path, data.slice(0, armed.bytes), "utf8");
		let release: () => void = () => {};
		this.onHeld?.();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await appendFile(path, data.slice(armed.bytes), "utf8");
		void release;
	}

	rename(source: string, destination: string): Promise<void> {
		return rename(source, destination);
	}

	remove(path: string): Promise<void> {
		return rm(path, { force: true });
	}

	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	}
}

function makePermissivePolicy(replay: "never" | "safe"): AdaptiveToolBatchClearance {
	return {
		async clearBatch(input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult> {
			return {
				policyStateFingerprint: "permissive-v1",
				decisions: input.calls.map(({ sourceIndex, call }) => ({
					kind: "allow",
					sourceIndex,
					toolCallId: call.id,
					toolName: call.name,
					effectiveArgs: structuredClone(call.arguments),
					replay,
				})),
			};
		},
	};
}

function seedRandom(seed: string): () => number {
	let state = 2166136261;
	for (let index = 0; index < seed.length; index++) {
		state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
	}
	if (state === 0) state = 0x9e3779b9;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
}

function installDeterminism(seed: string, clock: number): void {
	const next = seedRandom(seed);
	const randomValues = (bytes: Uint8Array): Uint8Array => {
		for (let index = 0; index < bytes.length; index++) bytes[index] = next() & 0xff;
		return bytes;
	};
	Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: randomValues }, configurable: true });
	Date.now = () => clock;
}

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

function makeTool(spec: ChildToolSpec, runtime: ChildRuntime): AgentHarnessTool<undefined> {
	return {
		name: spec.name,
		description: `${spec.name} tool`,
		label: spec.name,
		parameters: Type.Object({ path: Type.String() }),
		...(spec.replay === undefined ? {} : { replay: spec.replay }),
		execute: async () => {
			runtime.toolExecutions++;
			return okResult(`${spec.name} ran`);
		},
	};
}

function makeResponse(spec: ChildResponse) {
	if (spec.kind === "text") return fauxAssistantMessage(spec.text);
	if (spec.kind === "toolUse") {
		return fauxAssistantMessage(
			spec.calls.map((call) => fauxToolCall(call.name, call.args, { id: call.id ?? `call-${call.name}` })),
			{ stopReason: "toolUse" },
		);
	}
	return (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const finish = () => resolve(fauxAssistantMessage(""));
			if (options?.signal?.aborted) {
				finish();
				return;
			}
			options?.signal?.addEventListener("abort", finish, { once: true });
		});
}

interface ChildRuntime {
	repo: JsonlSessionRepo | undefined;
	session: Session | undefined;
	metadata: SessionMetadata | undefined;
	harness: AgentHarness<undefined> | undefined;
	faux: { state: { callCount: number } } | undefined;
	toolExecutions: number;
	split: SplitFileSystem;
	clock: number;
}

interface ChildCommand {
	c: string;
	__ack: number;
	[key: string]: unknown;
}

/**
 * After one released gate action: return once the next action parks (its
 * commit landed) or once the gate drained entirely (the run finished). Avoids
 * a bare `whenIdle`, which can deadlock on an effect promise blocked by a
 * parked follow-up action; the park-appearance race wins in that case.
 */
async function waitForStepSettle(harness: AgentHarness<undefined>): Promise<void> {
	for (;;) {
		if ((await harness.peekAction()) !== undefined) return;
		const parked = (async (): Promise<"parked"> => {
			for (;;) {
				if ((await harness.peekAction()) !== undefined) return "parked";
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
		})();
		const winner = await Promise.race([harness.coordinator.gate.whenIdle(), parked]);
		if (winner === "parked") return;
		if ((await harness.peekAction()) === undefined) return;
	}
}

async function runChild(): Promise<void> {
	const runtime: ChildRuntime = {
		repo: undefined,
		session: undefined,
		metadata: undefined,
		harness: undefined,
		faux: undefined,
		toolExecutions: 0,
		split: new SplitFileSystem(),
		clock: 0,
	};
	runtime.split.setOnHeld(() => {
		process.send?.({ t: "held" });
	});

	const send = (id: number, reply: Record<string, unknown>, withSnapshot = false): void => {
		if (!withSnapshot || runtime.session === undefined) {
			process.send?.({ ...reply, __ack: id });
			return;
		}
		void canonicalSnapshot(runtime.session).then((snapshot) => {
			process.send?.({ ...reply, __ack: id, snapshot });
		});
	};

	process.on("message", (message: ChildCommand) => {
		void handle(message);
	});

	async function handle(message: ChildCommand): Promise<void> {
		const id = message.__ack as number;
		try {
			switch (message.c) {
				case "init": {
					runtime.clock = message.clock as number;
					installDeterminism(message.seed as string, runtime.clock);
					runtime.repo = new JsonlSessionRepo({
						directory: message.dir as string,
						fs: runtime.split,
						now: () => runtime.clock,
					});
					send(id, { t: "init" });
					return;
				}
				case "create": {
					runtime.session = await runtime.repo!.create({ id: message.id as string });
					runtime.metadata = structuredClone(runtime.session.metadata);
					send(id, { t: "create", id: runtime.metadata.id }, true);
					return;
				}
				case "harness": {
					const config = message.config as HarnessConfig;
					const faux = fauxProvider({ provider: config.provider, api: config.api });
					const models = createModels();
					models.setProvider(faux.provider);
					const model = faux.getModel() as Model<Api>;
					faux.setResponses(config.responses.map(makeResponse));
					const tools = (config.tools ?? []).map((spec) => makeTool(spec, runtime));
					const { harness } = await AgentHarness.create({
						session: runtime.session!,
						models,
						model,
						drive: "manual",
						...(tools.length === 0 ? {} : { tools }),
						...(config.activeToolNames === undefined ? {} : { activeToolNames: config.activeToolNames }),
						...(config.policy === "permissive"
							? { adaptiveToolPolicy: makePermissivePolicy(config.tools?.[0]?.replay ?? "never") }
							: {}),
						...(config.steeringMode === undefined ? {} : { steeringMode: config.steeringMode }),
						...(config.retry === undefined
							? {}
							: {
									retry: {
										enabled: true,
										maxRetries: config.retry.maxAttempts - 1,
										baseDelayMs: config.retry.baseDelayMs,
									},
								}),
					});
					runtime.harness = harness;
					runtime.faux = faux;
					send(id, { t: "harness" }, true);
					return;
				}
				case "prompt": {
					runtime.harness!.prompt(userMessage(message.text as string));
					send(id, { t: "prompt" });
					return;
				}
				case "promptAdaptive": {
					runtime.harness!.promptAdaptive(
						userMessage(message.text as string),
						adaptiveBasis(runtime.metadata!.id),
					);
					send(id, { t: "promptAdaptive" });
					return;
				}
				case "append": {
					const entryId =
						runtime.harness === undefined
							? await runtime.session!.appendMessage(userMessage(message.text as string))
							: await runtime.harness.session.appendMessage(userMessage(message.text as string));
					send(id, { t: "append", id: entryId }, true);
					return;
				}
				case "setName": {
					await runtime.session!.setName(message.name as string);
					send(id, { t: "setName" }, true);
					return;
				}
				case "commitUsagePending": {
					await runtime.session!.commit({
						writes: [
							{
								kind: "usage",
								row: {
									id: "source-usage",
									...(message.entryId === undefined ? {} : { entryId: message.entryId as string }),
									usage: {
										input: 1,
										output: 1,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 2,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									adjustment: false,
								},
							},
							{
								kind: "register",
								op: "set",
								namespace: "pending.entry",
								key: "pending",
								value: { type: "custom", customType: "note" },
							},
						],
					});
					send(id, { t: "commitUsagePending" }, true);
					return;
				}
				case "fork": {
					const child = await runtime.repo!.fork(runtime.metadata!, {
						id: message.id as string,
						...(message.entryId === undefined ? {} : { entryId: message.entryId as string }),
						...(message.position === undefined ? {} : { position: message.position as "before" | "at" }),
					});
					runtime.session = child;
					runtime.metadata = structuredClone(child.metadata);
					send(id, { t: "fork", id: child.metadata.id }, true);
					return;
				}
				case "waitAcceptance": {
					for (;;) {
						const action = await runtime.harness!.peekAction();
						if (action !== undefined) {
							send(id, { t: "waitAcceptance", kind: action.kind }, true);
							return;
						}
						await new Promise((resolve) => setTimeout(resolve, 2));
					}
				}
				case "peek": {
					const action = await runtime.harness!.peekAction();
					send(id, { t: "peek", kind: action?.kind ?? null }, true);
					return;
				}
				case "step": {
					const action = await runtime.harness!.executeAction();
					// The gate releases before the action's effect completes; wait
					// for the executed action so the ack snapshot reflects the
					// commit it performed, never a racing pre-commit read. The
					// next parked action (or a fully drained gate) signals the
					// commit landed.
					await waitForStepSettle(runtime.harness!);
					send(id, { t: "step", kind: action?.kind ?? null }, true);
					return;
				}
				case "steer": {
					await runtime.harness!.steer(userMessage(message.text as string));
					send(id, { t: "steer" }, true);
					return;
				}
				case "abort": {
					const result = await runtime.harness!.abort();
					send(id, { t: "abort", ok: result.ok }, true);
					return;
				}
				case "waitCall": {
					for (;;) {
						if ((runtime.faux?.state.callCount ?? 0) >= (message.n as number)) {
							send(id, { t: "waitCall", count: runtime.faux!.state.callCount });
							return;
						}
						await new Promise((resolve) => setTimeout(resolve, 2));
					}
				}
				case "waitTool": {
					for (;;) {
						if (runtime.toolExecutions >= (message.n as number)) {
							send(id, { t: "waitTool", count: runtime.toolExecutions });
							return;
						}
						await new Promise((resolve) => setTimeout(resolve, 2));
					}
				}
				case "armSplit": {
					runtime.split.arm(message.bytes as number, (message.target as "write" | "append") ?? "append");
					send(id, { t: "armSplit" });
					return;
				}
				case "snapshot": {
					const snapshot = runtime.session === undefined ? undefined : await canonicalSnapshot(runtime.session);
					send(id, { t: "snapshot", snapshot });
					return;
				}
				case "finish": {
					if (runtime.harness !== undefined) await runtime.harness.runToCompletion();
					const snapshot = runtime.session === undefined ? undefined : await canonicalSnapshot(runtime.session);
					await runtime.session?.close();
					send(id, { t: "finish", snapshot });
					process.exit(0);
					return;
				}
				case "exit": {
					await runtime.session?.close();
					process.exit(0);
					return;
				}
				default:
					send(id, { t: "error", message: `unknown command ${message.c}` });
			}
		} catch (error) {
			send(id, { t: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}
}

if (process.env.PI_JSONL_CRASH_CHILD === "1") {
	void runChild();
}
