import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Context,
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type MutableModels,
} from "@earendil-works/pi-ai";
import type { Session } from "../../../agent/src/harness-v4.ts";
import { AgentHarness } from "../../../agent/src/harness-v4.ts";
import type { CreateChildHarness, CreateRootHarness, HardVerifier, HardVerifierResult } from "../../src/index.ts";
import { PermissiveToolPolicyAdapter, type PolicyRegistry } from "../../src/index.ts";

/**
 * Stage 8 runtime fixtures: faux providers only, real file effects inside
 * the lease root, no real provider APIs, keys or paid tokens.
 */

export interface RecordedCall {
	name: string;
	args: Record<string, unknown>;
}

export interface Stage8Tools {
	tools: AgentTool[];
	calls: RecordedCall[];
}

/** The fixed catalog with real schemas and real lease-root file effects. */
export function createStage8Tools(leaseRoot: string, calls: RecordedCall[] = []): AgentTool[] {
	const mkfile = async (path: string, content: string): Promise<void> => {
		const target = join(leaseRoot, path.replace(/^\/+/, ""));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	};
	const real = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
	return real.map((tool) => ({
		...tool,
		execute: async (_id: string, params: unknown) => {
			const args = params as Record<string, unknown>;
			calls.push({ name: tool.name, args: { ...args } });
			if (tool.name === "write" && typeof args.path === "string" && typeof args.content === "string") {
				await mkfile(args.path, args.content);
			} else if (tool.name === "edit" && typeof args.path === "string" && typeof args.content === "string") {
				const target = join(leaseRoot, args.path.replace(/^\/+/, ""));
				const previous = (await readFile(target, "utf8").catch(() => "")) + args.content;
				await mkfile(args.path, previous);
			} else if (tool.name === "read" && typeof args.path === "string") {
				const target = join(leaseRoot, args.path.replace(/^\/+/, ""));
				const content = await readFile(target, "utf8").catch(() => "");
				const result: AgentToolResult<unknown> = {
					content: [{ type: "text", text: content }],
					details: {},
				};
				return result;
			} else if (tool.name === "bash" && typeof args.command === "string") {
				// "fail" commands produce a durable tool error (failure evidence).
				if (args.command.includes("fail")) throw new Error("bash failed");
				if (args.command.includes("rm -rf")) {
					await rm(join(leaseRoot, "marker"), { recursive: true, force: true }).catch(() => undefined);
				}
			}
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: `${tool.name} ran` }],
				details: {},
			};
			return result;
		},
	}));
}

export interface Stage8Verdict {
	pass: boolean;
	coverage: number;
}

/** Verifier that passes when the marker file exists in the candidate cwd. */
export function createStage8Verifier(options?: {
	marker?: string;
	replay?: "safe" | "never";
	verdict?: (candidateId: string, cwd: string) => Stage8Verdict;
	onVerify?: (candidateId: string, cwd: string) => void;
}): HardVerifier & { effectCount(): number } {
	let effects = 0;
	const marker = options?.marker ?? "good.txt";
	return {
		id: "stage8-verifier",
		version: "v1",
		replay: options?.replay ?? "safe",
		async verify(input: { candidateId: string; cwd: string }): Promise<HardVerifierResult> {
			effects += 1;
			options?.onVerify?.(input.candidateId, input.cwd);
			const verdict =
				options?.verdict?.(input.candidateId, input.cwd) ??
				(existsSync(join(input.cwd, marker)) ? { pass: true, coverage: 100 } : { pass: false, coverage: 0 });
			return {
				status: verdict.pass ? "pass" : "fail",
				coverage: verdict.coverage,
				durationMs: 1,
				summary: { hash: "", length: 0, prefix: verdict.pass ? "pass" : "fail" },
			};
		},
		effectCount: () => effects,
	};
}

export function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

export interface Stage8RequestCapture {
	kind: "root" | string;
	context: {
		systemPrompt?: string;
		messages: Context["messages"];
		tools: Array<{ name: string; description: string; parameters: unknown }>;
	};
}

export interface Stage8HarnessFactories {
	createRootHarness: CreateRootHarness;
	createChildHarness: CreateChildHarness;
	requests: Stage8RequestCapture[];
	/** All faux provider handles created by the factories (call counting). */
	providers: FauxProviderHandle[];
	totalCallCount(): number;
}

export interface Stage8HarnessFactoryOptions {
	registry: PolicyRegistry;
	rootResponses?: () => FauxResponseStep[];
	childResponses?: (variantId: string) => FauxResponseStep[];
	onChildHarness?: (variantId: string, session: Session) => void;
}

/**
 * Harness factories: one faux provider per harness; the first provider
 * request context (systemPrompt + messages + tools) is captured per harness
 * so sibling model-visible inputs can be compared byte-for-byte.
 */
export function createStage8HarnessFactories(options: Stage8HarnessFactoryOptions): Stage8HarnessFactories {
	const requests: Stage8RequestCapture[] = [];
	const providers: FauxProviderHandle[] = [];
	const rootResponses = options.rootResponses ?? (() => []);
	const childResponses = options.childResponses ?? (() => []);
	// Exact-continuation children reconstruct the inherited capsule with the
	// source session's usage rows; every created session is registered here.
	const sessionsById = new Map<string, Session>();

	const createHarness = async (
		session: Session,
		leaseRoot: string,
		captureKind: "root" | string,
		responses: FauxResponseStep[],
	): Promise<AgentHarness<undefined>> => {
		// All harnesses of one task share the same frozen provider/model id.
		const faux = fauxProvider({ provider: "stage8", api: "stage8-api" });
		providers.push(faux);
		const models: MutableModels = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel() as Model<Api>;
		let captured = false;
		faux.setResponses(
			responses.map((response) => {
				if (typeof response === "function") return response;
				const step: FauxResponseStep = (context: Context) => {
					if (!captured) {
						captured = true;
						// The provider-visible projection: tools carry execute
						// functions that cannot be structured-cloned.
						requests.push({
							kind: captureKind,
							context: {
								systemPrompt: context.systemPrompt,
								messages: structuredClone(context.messages),
								tools: (context.tools ?? []).map((tool) => ({
									name: tool.name,
									description: tool.description,
									parameters: (tool as { parameters?: unknown }).parameters,
								})),
							},
						});
					}
					return response;
				};
				return step;
			}),
		);
		sessionsById.set(session.metadata.id, session);
		const { harness } = await AgentHarness.create<undefined>({
			session,
			models,
			model,
			tools: createStage8Tools(leaseRoot) as unknown as Parameters<typeof AgentHarness.create>[0]["tools"],
			activeToolNames: ["read", "write", "edit", "bash"],
			adaptiveToolPolicy: new PermissiveToolPolicyAdapter({
				registry: options.registry,
				session,
				usageSourceResolver: async (sourceSessionId) => sessionsById.get(sourceSessionId),
			}),
		});
		return harness;
	};

	const createRootHarness: CreateRootHarness = async ({ session, lease }) => {
		const harness = await createHarness(session, lease.root, "root", rootResponses());
		return { lane: harness, close: () => harness.close() };
	};

	const createChildHarness: CreateChildHarness = async ({ session, variant, environment }) => {
		const harness = await createHarness(session, environment.physicalRoot, variant.id, childResponses(variant.id));
		options.onChildHarness?.(variant.id, session);
		return { lane: harness, close: () => harness.close() };
	};

	return {
		createRootHarness,
		createChildHarness,
		requests,
		providers,
		totalCallCount: () => providers.reduce((total, provider) => total + provider.state.callCount, 0),
	};
}

export function fauxFinal(message: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(message);
}

export function fauxWrite(path: string, content: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
}
