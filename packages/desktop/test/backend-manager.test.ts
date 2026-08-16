import type { AgentEvent } from "@earendil-works/pi-agent-protocol";
import { describe, expect, test, vi } from "vitest";

interface FakeBackend {
	isRunning: boolean;
	isStreaming: boolean;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	setApiKey: (provider: string, apiKey: string) => Promise<void>;
	removeCredential: (provider: string) => Promise<void>;
	loginWithOAuth: (provider: string) => Promise<void>;
	cancelOAuthLogin: () => Promise<void>;
	respondToAuthPrompt: (requestId: string, response: unknown) => Promise<void>;
	refreshAuth: (provider?: string) => Promise<void>;
}

const backendMock = vi.hoisted(() => ({
	instances: [] as FakeBackend[],
	subscribers: [] as Array<(event: AgentEvent) => void>,
	startCalls: 0,
	stopCalls: 0,
	stateCalls: 0,
	modelCalls: 0,
	apiKeyCalls: [] as Array<{ provider: string; apiKey: string }>,
	removeCredentialCalls: [] as string[],
	loginCalls: [] as string[],
	cancelCalls: 0,
	promptResponseCalls: [] as Array<{ requestId: string; response: unknown }>,
	refreshAuthCalls: [] as Array<{ provider?: string; instanceIndex: number }>,
	loginResolvers: [] as Array<() => void>,
	loginRejecters: [] as Array<(error: Error) => void>,
	failNextStart: false,
}));

vi.mock("@earendil-works/pi-gui-adapter", () => ({
	PiBackend: class {
		isRunning = true;
		isStreaming = false;

		constructor() {
			backendMock.instances.push(this);
		}

		subscribe(handler: (event: AgentEvent) => void): () => void {
			backendMock.subscribers.push(handler);
			return () => {};
		}

		async start(): Promise<void> {
			backendMock.startCalls += 1;
			if (backendMock.failNextStart) {
				backendMock.failNextStart = false;
				throw new Error("simulated launch failure");
			}
		}

		async stop(): Promise<void> {
			backendMock.stopCalls += 1;
			this.isRunning = false;
		}

		async getState(): Promise<never> {
			backendMock.stateCalls += 1;
			throw new Error("unexpected state refresh");
		}

		async listModels(): Promise<never> {
			backendMock.modelCalls += 1;
			throw new Error("unexpected model refresh");
		}

		async getHandshake() {
			return {
				protocolVersion: "1.0.0",
				backend: { id: "pi", name: "Pi" },
				capabilities: {},
			};
		}

		async setApiKey(provider: string, apiKey: string): Promise<void> {
			backendMock.apiKeyCalls.push({ provider, apiKey });
		}

		async removeCredential(provider: string): Promise<void> {
			backendMock.removeCredentialCalls.push(provider);
		}

		async loginWithOAuth(provider: string): Promise<void> {
			backendMock.loginCalls.push(provider);
			const index = backendMock.instances.indexOf(this);
			await new Promise<void>((resolve, reject) => {
				backendMock.loginResolvers[index] = resolve;
				backendMock.loginRejecters[index] = reject;
			});
		}

		async cancelOAuthLogin(): Promise<void> {
			backendMock.cancelCalls += 1;
		}

		async respondToAuthPrompt(requestId: string, response: unknown): Promise<void> {
			backendMock.promptResponseCalls.push({ requestId, response });
		}

		async refreshAuth(provider?: string): Promise<void> {
			backendMock.refreshAuthCalls.push({ provider, instanceIndex: backendMock.instances.indexOf(this) });
		}

		async listProviderAuthStatus(): Promise<never> {
			throw new Error("unexpected auth status refresh");
		}
	},
}));

vi.mock("electron", () => ({
	app: { isPackaged: false },
	shell: { trashItem: vi.fn(async () => {}), openExternal: vi.fn(async () => {}) },
}));

import { shell } from "electron";

import { BackendManager } from "../src/main/backend-manager.ts";

function resetMockCounts(): void {
	backendMock.instances = [];
	backendMock.subscribers = [];
	backendMock.startCalls = 0;
	backendMock.stopCalls = 0;
	backendMock.stateCalls = 0;
	backendMock.modelCalls = 0;
	backendMock.apiKeyCalls = [];
	backendMock.removeCredentialCalls = [];
	backendMock.loginCalls = [];
	backendMock.cancelCalls = 0;
	backendMock.promptResponseCalls = [];
	backendMock.refreshAuthCalls = [];
	backendMock.loginResolvers = [];
	backendMock.loginRejecters = [];
	backendMock.failNextStart = false;
}

describe("BackendManager diagnostics", () => {
	test("routes backend stderr through the diagnostic stream only once", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		const events: AgentEvent[] = [];
		const logs: string[] = [];
		manager.onEvent((event) => events.push(event));
		manager.onLog((line) => logs.push(line));

		await manager.start("D:\\workspace");
		backendMock.subscribers.at(-1)?.({
			type: "custom",
			namespace: "gui-adapter",
			name: "backend_stderr",
			payload: "diagnostic line",
		});

		expect(logs).toEqual(["diagnostic line"]);
		expect(events).toEqual([]);
	});

	test("does not repeat state and model hydration after backend startup", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await expect(manager.start("D:\\workspace")).resolves.toBeUndefined();

		expect(backendMock.startCalls).toBe(1);
		expect(backendMock.stateCalls).toBe(0);
		expect(backendMock.modelCalls).toBe(0);
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\workspace" });
	});
});

describe("BackendManager auth fan-out", () => {
	test("applies api key and credential removal to every warm backend in the pool", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		await manager.start("D:\\b");
		expect(backendMock.instances).toHaveLength(2);

		await manager.setApiKey("opencode-go", "sk-test-value");
		expect(backendMock.apiKeyCalls).toEqual([
			{ provider: "opencode-go", apiKey: "sk-test-value" },
			{ provider: "opencode-go", apiKey: "sk-test-value" },
		]);

		await manager.removeCredential("opencode-go");
		expect(backendMock.removeCredentialCalls).toEqual(["opencode-go", "opencode-go"]);
	});

	test("auth status reads come from the active backend only", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");
		const backend = backendMock.instances[0];
		const listProviderAuthStatus = vi
			.spyOn(backend as unknown as { listProviderAuthStatus: () => Promise<unknown> }, "listProviderAuthStatus")
			.mockResolvedValue([{ provider: "opencode-go", configured: false, source: "none", mutable: true }]);
		const statuses = await manager.listProviderAuthStatus();
		expect(statuses).toEqual([{ provider: "opencode-go", configured: false, source: "none", mutable: true }]);
		listProviderAuthStatus.mockRestore();
	});

	test("loginWithOAuth runs on the active backend and fans out refreshAuth after success", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");
		await manager.start("D:\\b");
		expect(backendMock.instances).toHaveLength(2);

		const login = manager.loginWithOAuth("opencode-go");
		expect(backendMock.loginCalls).toEqual(["opencode-go"]);
		expect(manager.isOAuthLoginInProgress).toBe(true);

		// The active backend (b, index 1) completes the flow.
		backendMock.loginResolvers[1]?.();
		await login;

		expect(manager.isOAuthLoginInProgress).toBe(false);
		// The other warm backend (a, index 0) refreshed its catalog; the
		// active backend already synced during its own login.
		expect(backendMock.refreshAuthCalls).toEqual([{ provider: "opencode-go", instanceIndex: 0 }]);
	});

	test("workspace switch cancels an in-flight OAuth login", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");

		const login = manager.loginWithOAuth("opencode-go");
		expect(manager.isOAuthLoginInProgress).toBe(true);

		await manager.start("D:\\b");
		expect(backendMock.cancelCalls).toBe(1);

		backendMock.loginRejecters[0]?.(new Error("Login cancelled"));
		await expect(login).rejects.toThrow("Login cancelled");
		expect(manager.isOAuthLoginInProgress).toBe(false);
	});

	test("stop() and discardWorkspace() cancel an in-flight OAuth login", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");

		const login = manager.loginWithOAuth("opencode-go");
		await manager.stop();
		expect(backendMock.cancelCalls).toBe(1);
		backendMock.loginRejecters[0]?.(new Error("Login cancelled"));
		await expect(login).rejects.toThrow("Login cancelled");

		resetMockCounts();
		const manager2 = new BackendManager();
		await manager2.start("D:\\a");
		const login2 = manager2.loginWithOAuth("opencode-go");
		await manager2.discardWorkspace("D:\\a");
		expect(backendMock.cancelCalls).toBe(1);
		backendMock.loginRejecters[0]?.(new Error("Login cancelled"));
		await expect(login2).rejects.toThrow("Login cancelled");
	});

	test("forwards auth prompt responses to the active backend", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");
		await manager.respondToAuthPrompt("prompt-1", { kind: "value", value: "x" });
		expect(backendMock.promptResponseCalls).toEqual([
			{ requestId: "prompt-1", response: { kind: "value", value: "x" } },
		]);
	});

	test("auth_url flow events open the system browser from the main process", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		await manager.start("D:\\a");
		backendMock.subscribers.at(-1)?.({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: {
				kind: "event",
				loginId: "l",
				event: { type: "auth_url", url: "https://example.invalid/oauth" },
			},
		});
		await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith("https://example.invalid/oauth"));

		// Non-url flow events never touch the browser.
		backendMock.subscribers.at(-1)?.({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: { kind: "event", loginId: "l", event: { type: "progress", message: "waiting" } },
		});
		backendMock.subscribers.at(-1)?.({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: { kind: "prompt", loginId: "l", requestId: "p", prompt: { type: "text", message: "x" } },
		});
		expect(shell.openExternal).toHaveBeenCalledTimes(1);
	});
});

describe("BackendManager catalog backend", () => {
	test("auth status without a workspace is served by a pooled catalog backend", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		// The first read launches the catalog backend. The default mock
		// status read rejects; the launch must still be pooled afterwards.
		await expect(manager.listProviderAuthStatus()).rejects.toThrow("unexpected auth status refresh");
		expect(backendMock.instances).toHaveLength(1);
		expect(backendMock.startCalls).toBe(1);

		const catalogBackend = backendMock.instances[0];
		const listProviderAuthStatus = vi
			.spyOn(
				catalogBackend as unknown as { listProviderAuthStatus: () => Promise<unknown> },
				"listProviderAuthStatus",
			)
			.mockResolvedValue([{ provider: "opencode-go", configured: true, source: "stored", mutable: true }]);

		const statuses = await manager.listProviderAuthStatus();
		expect(statuses).toEqual([{ provider: "opencode-go", configured: true, source: "stored", mutable: true }]);
		// The warm catalog backend is reused: no second launch.
		expect(backendMock.startCalls).toBe(1);
		// The catalog backend never activates: the app stays on the home screen.
		expect(manager.currentStatus).toMatchObject({ phase: "no-workspace", workspace: null });
		listProviderAuthStatus.mockRestore();
	});

	test("setApiKey and removeCredential work without a workspace via the catalog backend", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.setApiKey("opencode-go", "sk-test-value");
		await manager.removeCredential("opencode-go");

		expect(backendMock.startCalls).toBe(1);
		expect(backendMock.apiKeyCalls).toEqual([{ provider: "opencode-go", apiKey: "sk-test-value" }]);
		expect(backendMock.removeCredentialCalls).toEqual(["opencode-go"]);
		expect(manager.currentStatus).toMatchObject({ phase: "no-workspace", workspace: null });
	});

	test("a warm catalog backend also receives credential fan-out after a workspace opens", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		// Warm up the catalog backend from the home screen.
		await manager.setApiKey("opencode-go", "sk-first");
		expect(backendMock.startCalls).toBe(1);

		await manager.start("D:\\workspace");
		expect(backendMock.instances).toHaveLength(2);

		await manager.setApiKey("opencode-go", "sk-second");
		expect(backendMock.apiKeyCalls).toEqual([
			{ provider: "opencode-go", apiKey: "sk-first" },
			{ provider: "opencode-go", apiKey: "sk-second" },
			{ provider: "opencode-go", apiKey: "sk-second" },
		]);
	});
});

describe("BackendManager warm backend pool", () => {
	test("reuses a warm backend when switching back to a cached workspace", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		await manager.start("D:\\b");
		await manager.start("D:\\a");

		// Third switch reused the warm backend: no new launch, no stop.
		expect(backendMock.startCalls).toBe(2);
		expect(backendMock.stopCalls).toBe(0);
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\a" });
	});

	test("switching to the active workspace is idempotent", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		await manager.start("D:\\a");

		expect(backendMock.startCalls).toBe(1);
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\a" });
	});

	test("evicts the least recently used non-active backend beyond the pool size", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		await manager.start("D:\\b");
		await manager.start("D:\\c");

		expect(backendMock.startCalls).toBe(3);
		// The pool holds two; the oldest (a) was stopped and evicted.
		expect(backendMock.stopCalls).toBe(1);
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\c" });
		// Switching back to a re-launches it (cold again).
		await manager.start("D:\\a");
		expect(backendMock.startCalls).toBe(4);
	});

	test("does not forward events from inactive backends", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		const events: AgentEvent[] = [];
		manager.onEvent((event) => events.push(event));

		await manager.start("D:\\a");
		await manager.start("D:\\b");

		// The active (b) backend's events are forwarded...
		const bHandler = backendMock.subscribers.at(-1);
		expect(bHandler).toBeTypeOf("function");
		bHandler?.({ type: "agent_started" });
		expect(events).toEqual([{ type: "agent_started" }]);

		// ...while the inactive (a) backend's events are dropped.
		backendMock.subscribers.at(-2)?.({
			type: "message_started",
			message: { role: "user", content: "leak" },
		});
		expect(events).toEqual([{ type: "agent_started" }]);
	});

	test("keeps the previous workspace active when a new launch fails", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		backendMock.failNextStart = true;
		const error = await manager.start("D:\\b");

		expect(error).toContain("simulated launch failure");
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\a" });
		expect(manager.isRunning).toBe(true);
	});

	test("stops every backend on stop()", async () => {
		resetMockCounts();
		const manager = new BackendManager();

		await manager.start("D:\\a");
		await manager.start("D:\\b");
		await manager.stop();

		expect(backendMock.stopCalls).toBe(2);
		expect(manager.currentStatus.phase).toBe("stopped");
		expect(manager.isRunning).toBe(false);
	});

	test("removes a crashed backend from the pool", async () => {
		resetMockCounts();
		const manager = new BackendManager();
		const statuses: string[] = [];
		manager.onStatus((status) => statuses.push(status.phase));

		await manager.start("D:\\a");
		await manager.start("D:\\b");

		// The inactive (a) backend crashes: silently evicted, status untouched.
		backendMock.subscribers.at(-2)?.({
			type: "error",
			message: "Pi backend exited unexpectedly",
			source: "process",
		});
		expect(statuses.at(-1)).toBe("running");
		expect(manager.currentStatus).toMatchObject({ phase: "running", workspace: "D:\\b" });

		// The active (b) backend crashes: status moves to error.
		backendMock.subscribers.at(-1)?.({
			type: "error",
			message: "Pi backend exited unexpectedly",
			source: "process",
		});
		expect(statuses.at(-1)).toBe("error");
		expect(manager.isRunning).toBe(false);
	});
});
