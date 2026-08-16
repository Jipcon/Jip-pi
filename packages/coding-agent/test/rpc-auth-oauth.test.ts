import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Provider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getResponse(outputLines: string[], id: string, command = "login_oauth"): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === command,
	);
}

async function waitForLine(
	predicate: (line: ParsedOutputLine) => boolean,
	timeoutMs = 5_000,
): Promise<ParsedOutputLine> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = parseOutputLines(rpcIo.outputLines).find(predicate);
		if (found) {
			return found;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for output line");
}

interface OAuthFlowOptions {
	/** Called with the AuthInteraction; must resolve with an oauth credential. */
	login?: (interaction: {
		notify: (event: unknown) => void;
		prompt: (prompt: { type: string; message: string; signal?: AbortSignal }) => Promise<string>;
	}) => Promise<{ type: "oauth"; refresh: string; access: string; expires: number }>;
	/** Extra auth fields on the provider. */
	oauth?: Record<string, unknown>;
}

async function createRuntimeHost(options: OAuthFlowOptions = {}): Promise<{
	runtimeHost: AgentSessionRuntime;
	authStorage: AuthStorage;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	const modelRuntime = getModelRuntime(modelRegistry);

	const provider = {
		id: "oauth-provider",
		name: "OAuth Provider",
		auth: {
			oauth: {
				name: "OAuth Provider (Subscription)",
				loginLabel: "Sign in with OAuth Provider",
				isSubscription: true,
				login: options.login,
				refresh: async (credential: { refresh: string }) => credential as never,
				toAuth: async () => ({ apiKey: "oauth-token" }),
				...options.oauth,
			},
		},
		getModels: () => [],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	} as unknown as Provider;

	modelRuntime.registerNativeProvider(provider);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		authStorage,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: OAuthFlowOptions = {}): Promise<{
	lineHandler: (line: string) => void;
	authStorage: AuthStorage;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, authStorage, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, authStorage, cleanup };
}

describe("RPC OAuth login", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("streams auth events and prompt, answers via auth_prompt_response, and stores the credential", async () => {
		const { lineHandler, authStorage, cleanup } = await startRpcMode({
			login: async (interaction) => {
				interaction.notify({
					type: "auth_url",
					url: "https://example.invalid/oauth",
					instructions: "Open it",
				});
				interaction.notify({
					type: "device_code",
					userCode: "CODE-123",
					verificationUri: "https://example.invalid/device",
				});
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
				if (code !== "GOOD-CODE") {
					throw new Error(`Invalid code: ${code}`);
				}
				return { type: "oauth", refresh: "refresh-token", access: "access-token", expires: Date.now() + 3600_000 };
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "login-1", type: "login_oauth", provider: "oauth-provider" }));

			const urlEvent = await waitForLine(
				(line) => line.type === "auth_event" && (line.event as { type?: string }).type === "auth_url",
			);
			expect(urlEvent).toMatchObject({
				loginId: expect.any(String),
				event: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
			});
			const loginId = urlEvent.loginId as string;

			const deviceEvent = await waitForLine(
				(line) => line.type === "auth_event" && (line.event as { type?: string }).type === "device_code",
			);
			expect(deviceEvent).toMatchObject({
				loginId,
				event: { type: "device_code", userCode: "CODE-123", verificationUri: "https://example.invalid/device" },
			});

			const prompt = await waitForLine((line) => line.type === "auth_prompt");
			expect(prompt).toMatchObject({
				loginId,
				requestId: expect.any(String),
				prompt: { type: "manual_code", message: "Paste the code" },
			});
			// The runtime-only signal must never cross the wire.
			expect((prompt.prompt as Record<string, unknown>).signal).toBeUndefined();

			lineHandler(JSON.stringify({ type: "auth_prompt_response", requestId: prompt.requestId, value: "GOOD-CODE" }));

			await vi.waitFor(() => {
				const responses = getResponse(rpcIo.outputLines, "login-1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "login-1",
					type: "response",
					command: "login_oauth",
					success: true,
					data: { provider: "oauth-provider" },
				});
			});

			const credential = await authStorage.read("oauth-provider");
			expect(credential).toMatchObject({ type: "oauth", refresh: "refresh-token", access: "access-token" });
		} finally {
			await cleanup();
		}
	});

	it("emits prompt_cancelled when the provider aborts a prompt signal (callback won the race)", async () => {
		const { lineHandler, authStorage, cleanup } = await startRpcMode({
			login: async (interaction) => {
				const controller = new AbortController();
				const codePromise = interaction.prompt({
					type: "manual_code",
					message: "Paste the code",
					signal: controller.signal,
				});
				// The callback server wins: abort the manual code prompt.
				controller.abort();
				await expect(codePromise).rejects.toThrow("Login cancelled");
				return { type: "oauth", refresh: "refresh-token", access: "access-token", expires: Date.now() + 3600_000 };
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "login-2", type: "login_oauth", provider: "oauth-provider" }));

			const prompt = await waitForLine((line) => line.type === "auth_prompt");
			const cancelled = await waitForLine(
				(line) =>
					line.type === "auth_event" &&
					(line.event as { type?: string }).type === "prompt_cancelled" &&
					(line.event as { requestId?: string }).requestId === prompt.requestId,
			);
			expect(cancelled).toMatchObject({
				loginId: prompt.loginId,
				event: { type: "prompt_cancelled", requestId: prompt.requestId },
			});

			await vi.waitFor(() => {
				expect(getResponse(rpcIo.outputLines, "login-2")[0]).toMatchObject({
					command: "login_oauth",
					success: true,
				});
			});
			expect(await authStorage.read("oauth-provider")).toMatchObject({ type: "oauth" });
		} finally {
			await cleanup();
		}
	});

	it("cancels an in-flight login via cancel_login_oauth", async () => {
		const { lineHandler, authStorage, cleanup } = await startRpcMode({
			login: async (interaction) => {
				const code = await interaction.prompt({ type: "text", message: "Enter anything" });
				return { type: "oauth", refresh: code, access: "a", expires: Date.now() + 3600_000 };
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "login-3", type: "login_oauth", provider: "oauth-provider" }));
			await waitForLine((line) => line.type === "auth_prompt");

			lineHandler(JSON.stringify({ id: "cancel-1", type: "cancel_login_oauth" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "cancel-1" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ command: "cancel_login_oauth", success: true });
			});

			await vi.waitFor(() => {
				const responses = getResponse(rpcIo.outputLines, "login-3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					command: "login_oauth",
					success: false,
					error: "Login cancelled",
				});
			});
			expect(await authStorage.read("oauth-provider")).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	it("rejects a second login while one is in progress", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			login: async (interaction) => {
				const code = await interaction.prompt({ type: "text", message: "Enter anything" });
				return { type: "oauth", refresh: code, access: "a", expires: Date.now() + 3600_000 };
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "login-4", type: "login_oauth", provider: "oauth-provider" }));
			await waitForLine((line) => line.type === "auth_prompt");

			lineHandler(JSON.stringify({ id: "login-5", type: "login_oauth", provider: "oauth-provider" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "login-5" && record.type === "response",
				);
				expect(responses[0]).toMatchObject({
					command: "login_oauth",
					success: false,
					error: "An OAuth login is already in progress",
				});
			});

			// The first login stays usable.
			const firstPrompt = parseOutputLines(rpcIo.outputLines).find((line) => line.type === "auth_prompt");
			lineHandler(JSON.stringify({ type: "auth_prompt_response", requestId: firstPrompt?.requestId, value: "x" }));
			await vi.waitFor(() => expect(getResponse(rpcIo.outputLines, "login-4")).toHaveLength(1));
		} finally {
			await cleanup();
		}
	});

	it("rejects for unknown providers and providers without oauth", async () => {
		const { lineHandler, cleanup } = await startRpcMode();

		try {
			lineHandler(JSON.stringify({ id: "login-6", type: "login_oauth", provider: "nope" }));
			await vi.waitFor(() => {
				expect(getResponse(rpcIo.outputLines, "login-6")[0]).toMatchObject({
					command: "login_oauth",
					success: false,
					error: "Unknown provider: nope",
				});
			});

			// The in-memory registry has builtin providers without oauth (e.g.
			// a provider with only apiKey auth) — anthropic has oauth in the
			// real catalog, so assert against a provider we know has none.
			lineHandler(JSON.stringify({ id: "login-7", type: "login_oauth", provider: "openai" }));
			await vi.waitFor(() => {
				const response = getResponse(rpcIo.outputLines, "login-7")[0];
				expect(response).toMatchObject({ command: "login_oauth", success: false });
				expect(String(response.error)).toContain("does not support OAuth login");
			});
		} finally {
			await cleanup();
		}
	});

	it("redacts prompt answers from login error messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			login: async (interaction) => {
				const code = await interaction.prompt({ type: "secret", message: "Enter the code" });
				throw new Error(`The code ${code} was rejected by the upstream service`);
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "login-8", type: "login_oauth", provider: "oauth-provider" }));
			const prompt = await waitForLine((line) => line.type === "auth_prompt");
			lineHandler(
				JSON.stringify({ type: "auth_prompt_response", requestId: prompt.requestId, value: "SUPER-SECRET" }),
			);

			await vi.waitFor(() => {
				const responses = getResponse(rpcIo.outputLines, "login-8");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ command: "login_oauth", success: false });
			});
			const error = String(getResponse(rpcIo.outputLines, "login-8")[0].error);
			expect(error).toContain("[redacted]");
			expect(error).not.toContain("SUPER-SECRET");
		} finally {
			await cleanup();
		}
	});

	it("reports oauth capability in get_auth_status with mutable stored credentials", async () => {
		const { lineHandler, authStorage, cleanup } = await startRpcMode({
			login: async (interaction) => {
				const code = await interaction.prompt({ type: "text", message: "Enter anything" });
				return { type: "oauth", refresh: code, access: "a", expires: Date.now() + 3600_000 };
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "status-1", type: "get_auth_status" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "status-1" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
			});
			const providers = (
				getResponse(rpcIo.outputLines, "status-1", "get_auth_status")[0] as unknown as {
					data: { providers: Array<Record<string, unknown>> };
				}
			).data.providers;
			const oauth = providers.find((entry) => entry.provider === "oauth-provider");
			expect(oauth).toMatchObject({
				configured: false,
				source: "none",
				mutable: true,
				supportsApiKey: false,
				supportsOAuth: true,
				oauthName: "Sign in with OAuth Provider",
				isSubscription: true,
			});

			// After login the credential is stored and removable (mutable),
			// and the source flips to oauth.
			lineHandler(JSON.stringify({ id: "login-9", type: "login_oauth", provider: "oauth-provider" }));
			const prompt = await waitForLine((line) => line.type === "auth_prompt");
			lineHandler(JSON.stringify({ type: "auth_prompt_response", requestId: prompt.requestId, value: "x" }));
			await vi.waitFor(() => expect(getResponse(rpcIo.outputLines, "login-9")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "status-2", type: "get_auth_status" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "status-2" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
			});
			const providersAfter = (
				getResponse(rpcIo.outputLines, "status-2", "get_auth_status")[0] as unknown as {
					data: { providers: Array<Record<string, unknown>> };
				}
			).data.providers;
			const oauthAfter = providersAfter.find((entry) => entry.provider === "oauth-provider");
			expect(oauthAfter).toMatchObject({ configured: true, source: "oauth", mutable: true });

			// remove_credential works for the stored oauth credential.
			lineHandler(JSON.stringify({ id: "remove-1", type: "remove_credential", provider: "oauth-provider" }));
			await vi.waitFor(async () => {
				expect(await authStorage.read("oauth-provider")).toBeUndefined();
			});
		} finally {
			await cleanup();
		}
	});

	it("refresh_auth re-reads credentials and refreshes the catalog", async () => {
		const { lineHandler, authStorage, cleanup } = await startRpcMode();

		try {
			// Simulate a credential written by another backend process.
			await authStorage.modify("oauth-provider", async () => ({
				type: "oauth",
				refresh: "r",
				access: "a",
				expires: Date.now() + 3600_000,
			}));

			lineHandler(JSON.stringify({ id: "refresh-1", type: "refresh_auth", provider: "oauth-provider" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "refresh-1" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ command: "refresh_auth", success: true });
			});

			lineHandler(JSON.stringify({ id: "status-3", type: "get_auth_status" }));
			await vi.waitFor(() => {
				const providers = (
					getResponse(rpcIo.outputLines, "status-3", "get_auth_status")[0] as unknown as {
						data: { providers: Array<Record<string, unknown>> };
					}
				).data.providers;
				expect(providers.find((entry) => entry.provider === "oauth-provider")).toMatchObject({
					configured: true,
					source: "oauth",
					mutable: true,
				});
			});
		} finally {
			await cleanup();
		}
	});
});
