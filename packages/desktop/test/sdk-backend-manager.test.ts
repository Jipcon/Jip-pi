/**
 * BackendManager pool tests with an in-process FakeAgentBackend.
 *
 * The stub-backend.mjs RPC subprocess fixture is intentionally NOT used here:
 * it exercises the PiBackend/RpcClient transport, not the pool semantics.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	InteractionResponse,
	ModelInfo,
	ModelRef,
	SessionBackendConfig,
	SessionUsage,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE,
	type ManagedSessionBackend,
	SdkBackendManager,
	type SdkBackendManagerOptions,
} from "../src/main/sdk-backend-manager.ts";
import type { RoutedAgentEvent } from "../src/shared/ipc.ts";

class FakeAgentBackend implements ManagedSessionBackend {
	started = false;
	streaming = false;
	pendingInteractions = 0;
	sessionId: string | undefined;
	startConfig: SessionBackendConfig | undefined;
	stopCount = 0;
	/** Custom state returned by getState (falls back to the default shape). */
	customState: AgentState | null = null;
	/** Messages returned by getMessages. */
	messages: AgentMessage[] = [];
	/** When true, getState rejects (simulates a backend shutting down). */
	failGetState = false;
	private readonly handlers = new Set<(event: AgentEvent) => void>();

	constructor(sessionId?: string) {
		this.sessionId = sessionId;
	}

	get isRunning(): boolean {
		return this.started;
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	get hasPendingInteractions(): boolean {
		return this.pendingInteractions > 0;
	}

	async start(config: SessionBackendConfig): Promise<void> {
		this.started = true;
		this.startConfig = config;
		this.sessionId = config.sessionId ?? this.sessionId ?? "fake-session";
	}

	async stop(): Promise<void> {
		this.started = false;
		this.streaming = false;
		this.stopCount += 1;
	}

	async sendMessage(_message: UserMessage): Promise<void> {}
	async abort(): Promise<void> {
		this.streaming = false;
	}
	async getState(): Promise<AgentState> {
		if (this.failGetState) {
			throw new Error("backend is shutting down");
		}
		if (this.customState) {
			return this.customState;
		}
		return {
			model: null,
			isStreaming: this.streaming,
			isCompacting: false,
			sessionId: this.sessionId ?? "",
			messageCount: this.messages.length,
		};
	}
	async getMessages(): Promise<AgentMessage[]> {
		return this.messages;
	}
	async getSessionUsage(): Promise<SessionUsage> {
		throw new Error("not implemented");
	}
	async setModel(_model: ModelRef): Promise<ModelInfo | null> {
		return null;
	}
	async listThinkingLevels(): Promise<string[]> {
		return ["off", "high"];
	}
	async setThinkingLevel(_level: string): Promise<void> {}
	async respondToInteraction(_id: string, _response: InteractionResponse): Promise<void> {
		this.pendingInteractions -= 1;
	}
	renameSession(_name: string): void {}

	subscribe(handler: (event: AgentEvent) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	emit(event: AgentEvent): void {
		for (const handler of this.handlers) {
			handler(event);
		}
	}

	emitInteraction(id: string): void {
		this.pendingInteractions += 1;
		this.emit({
			type: "interaction_requested",
			request: { id, kind: "confirm", title: "Approve?" },
		});
	}
}

interface TestHarness {
	manager: SdkBackendManager;
	fakes: FakeAgentBackend[];
	freshDefaultsCalls: Array<{ workspacePath: string; pendingModel: ModelRef | undefined }>;
}

function fakeHostServices(): SdkBackendManagerOptions["hostServices"] {
	return {
		sharedRuntime: new Promise(() => {}),
		getHandshake: async () => ({
			protocolVersion: "1.0.0",
			backend: { id: "pi", name: "Pi" },
			capabilities: {},
		}),
		listModels: async () => [],
		reloadModels: async () => {},
		listProviderAuthStatus: async () => [],
		setApiKey: async () => {},
		removeCredential: async () => {},
		loginWithOAuth: async () => {},
		cancelOAuthLogin: async () => {},
		respondToAuthPrompt: async () => {},
		subscribe: () => () => {},
	};
}

function readSessionUsageStub(
	_file: string,
	options: {
		sessionId: string;
		resolveContextWindow(model: { provider: string; modelId: string } | null): number | undefined;
	},
): SessionUsage {
	return {
		sessionId: options.sessionId,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
	};
}

function createManagerWithBackend(backend: FakeAgentBackend): SdkBackendManager {
	return new SdkBackendManager({
		agentDir: "C:\\agent",
		hostServices: fakeHostServices(),
		readSessionHistory: async () => [],
		readSessionUsage: async (file, options) => readSessionUsageStub(file, options),
		findSession: async (sessionId) => ({ id: sessionId, file: `C:\\sessions\\${sessionId}.jsonl` }),
		listCatalogSessions: async () => [],
		createSessionFile: async () => ({ sessionId: "created", sessionFile: "C:\\sessions\\created.jsonl" }),
		renameCatalogSession: async () => {},
		deleteCatalogFile: async () => {},
		createSessionBackend: () => backend,
	});
}

function createManager(overrides: Partial<SdkBackendManagerOptions> = {}): TestHarness {
	const fakes: FakeAgentBackend[] = [];
	const freshDefaultsCalls: TestHarness["freshDefaultsCalls"] = [];
	const manager = new SdkBackendManager({
		agentDir: "C:\\agent",
		hostServices: fakeHostServices(),
		readSessionHistory: async () => [],
		readSessionUsage: async (file, options) => readSessionUsageStub(file, options),
		findSession: async (sessionId) => ({ id: sessionId, file: `C:\\sessions\\${sessionId}.jsonl` }),
		listCatalogSessions: async () => [],
		createSessionFile: async () => ({ sessionId: "created", sessionFile: "C:\\sessions\\created.jsonl" }),
		renameCatalogSession: async () => {},
		deleteCatalogFile: async () => {},
		createSessionBackend: () => {
			const fake = new FakeAgentBackend();
			fakes.push(fake);
			return fake;
		},
		resolveFreshSessionDefaults: async (workspacePath, pendingModel) => {
			freshDefaultsCalls.push({ workspacePath, pendingModel });
			return {
				model: { id: "default-model", name: "Default Model", provider: "provider" },
				thinkingLevel: "medium",
			};
		},
		...overrides,
	});
	return { manager, fakes, freshDefaultsCalls };
}

let harness: TestHarness;

beforeEach(() => {
	harness = createManager();
});

afterEach(async () => {
	await harness.manager.disposeAll();
});

const W1 = "C:\\workspace-a";
const W2 = "C:\\workspace-b";

describe("SdkBackendManager pool", () => {
	test("getOrCreateBackend is idempotent per session and distinct across sessions", async () => {
		const { manager, fakes } = harness;
		const a1 = await manager.getOrCreateBackend(W1, "session-a");
		const a2 = await manager.getOrCreateBackend(W1, "session-a");
		const b = await manager.getOrCreateBackend(W1, "session-b");
		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
		expect(fakes).toHaveLength(2);
	});

	test("sessions of different workspaces get separate backends", async () => {
		const { manager } = harness;
		const a = await manager.getOrCreateBackend(W1, "session-a");
		const b = await manager.getOrCreateBackend(W2, "session-a");
		expect(a).not.toBe(b);
	});

	test("start config carries the session identity", async () => {
		const { manager } = harness;
		await manager.getOrCreateBackend(W1, "session-a");
		const backend = manager.getBackend(W1, "session-a") as FakeAgentBackend | undefined;
		expect(backend).toBeDefined();
		expect(backend?.startConfig).toMatchObject({
			workspacePath: W1,
			sessionId: "session-a",
		});
	});

	test("openSession returns a snapshot without materializing a backend", async () => {
		const { manager, fakes } = harness;
		const snapshot = await manager.openSession(W1, "history-session");
		expect(snapshot.state.sessionId).toBe("history-session");
		expect(fakes).toHaveLength(0);
	});

	test("openSession reports the predicted model and thinking level for a fresh pending session", async () => {
		const { manager, fakes, freshDefaultsCalls } = harness;
		const snapshot = await manager.openSession(W1, "fresh-session");
		expect(snapshot.state.model).toEqual({ id: "default-model", name: "Default Model", provider: "provider" });
		expect(snapshot.state.thinkingLevel).toBe("medium");
		expect(freshDefaultsCalls).toEqual([{ workspacePath: W1, pendingModel: undefined }]);
		expect(fakes).toHaveLength(0);
	});

	test("a pending model wins over the predicted default", async () => {
		const { manager } = createManager({
			hostServices: {
				...fakeHostServices(),
				listModels: async () => [{ id: "m1", name: "Model One", provider: "p1" }],
			},
		});
		await manager.setModel(W1, "fresh-session", { provider: "p1", modelId: "m1" });
		const snapshot = await manager.openSession(W1, "fresh-session");
		expect(snapshot.state.model).toEqual({ id: "m1", name: "Model One", provider: "p1" });
	});

	test("a pending thinking level wins over the predicted default", async () => {
		const { manager, freshDefaultsCalls } = harness;
		await manager.setThinkingLevel(W1, "fresh-session", "max");
		const snapshot = await manager.openSession(W1, "fresh-session");
		expect(snapshot.state.thinkingLevel).toBe("max");
		// The model is still missing, so the defaults prediction runs to fill it.
		expect(freshDefaultsCalls).toEqual([{ workspacePath: W1, pendingModel: undefined }]);
	});

	test("openSession does not predict defaults for sessions with history", async () => {
		const calls: TestHarness["freshDefaultsCalls"] = [];
		const { manager } = createManager({
			readSessionHistory: async () => [{ role: "user", content: "hello" }],
			resolveFreshSessionDefaults: async (workspacePath, pendingModel) => {
				calls.push({ workspacePath, pendingModel });
				return { model: null, thinkingLevel: "medium" };
			},
		});
		const snapshot = await manager.openSession(W1, "historical");
		expect(snapshot.state.thinkingLevel).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("openSession reports the file-recorded model for a historical session", async () => {
		const persistedModel: ModelInfo = { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek" };
		const { manager, fakes } = createManager({
			readSessionHistory: async () => [{ role: "user", content: "hello" }],
			readPersistedSessionState: async () => ({ model: persistedModel, thinkingLevel: "max" }),
		});
		const snapshot = await manager.openSession(W1, "historical");
		expect(snapshot.state.model).toEqual(persistedModel);
		expect(snapshot.state.thinkingLevel).toBe("max");
		expect(fakes).toHaveLength(0);
	});

	test("pushes the authoritative state once a session backend materializes", async () => {
		const restoredModel: ModelInfo = { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", provider: "deepseek" };
		const backend = new FakeAgentBackend();
		backend.getState = async () => ({
			model: restoredModel,
			isStreaming: false,
			isCompacting: false,
			sessionId: backend.sessionId ?? "",
			messageCount: 3,
		});
		const manager = createManagerWithBackend(backend);
		const events: RoutedAgentEvent[] = [];
		manager.onEvent((routed) => events.push(routed));
		await manager.getOrCreateBackend(W1, "session-a");
		const stateEvent = events.find((entry) => entry.event.type === "state_changed");
		expect(stateEvent?.workspaceId).toBe(W1);
		expect(stateEvent?.sessionId).toBe("session-a");
		expect(stateEvent?.event.type === "state_changed" && stateEvent.event.state.model).toEqual(restoredModel);
		await manager.disposeAll();
	});

	test("a failed defaults prediction never blocks opening a session", async () => {
		const { manager } = createManager({
			resolveFreshSessionDefaults: async () => {
				throw new Error("settings unreadable");
			},
		});
		const snapshot = await manager.openSession(W1, "fresh-session");
		expect(snapshot.state.sessionId).toBe("fresh-session");
		expect(snapshot.state.thinkingLevel).toBeUndefined();
	});

	test("openSession reports usage for a historical session without a backend", async () => {
		const { manager, fakes } = harness;
		const snapshot = await manager.openSession(W1, "history-session");
		expect(fakes).toHaveLength(0);
		expect(snapshot.usage).not.toBeNull();
		expect(snapshot.usage?.sessionId).toBe("history-session");
	});

	test("getSessionUsage aggregates from the catalog for a historical session", async () => {
		const { manager, fakes } = harness;
		const usage = await manager.getSessionUsage(W1, "history-session");
		expect(fakes).toHaveLength(0);
		expect(usage?.sessionId).toBe("history-session");
	});

	test("openSession uses the live backend once materialized", async () => {
		const { manager } = harness;
		await manager.getOrCreateBackend(W1, "session-a");
		const snapshot = await manager.openSession(W1, "session-a");
		expect(snapshot.state.sessionId).toBe("session-a");
	});

	test("a failed materialization leaves the pool intact and rejects only the caller", async () => {
		const failing = new FakeAgentBackend();
		failing.start = async () => {
			throw new Error("createAgentSession exploded");
		};
		const failingManager = createManagerWithBackend(failing);
		await expect(failingManager.getOrCreateBackend(W1, "session-a")).rejects.toThrow("createAgentSession exploded");
		expect(failingManager.getBackend(W1, "session-a")).toBeUndefined();
		// A healthy session on the same workspace still materializes.
		const { manager } = harness;
		await expect(manager.getOrCreateBackend(W1, "session-b")).resolves.toBeDefined();
	});

	test("idle eviction respects the per-workspace limit and never evicts pinned backends", async () => {
		const { manager } = harness;
		const workspace = W1;
		// Fill the workspace with idle backends beyond the limit.
		const sessionIds: string[] = [];
		for (let index = 0; index < MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE + 2; index += 1) {
			const sessionId = `idle-${index}`;
			sessionIds.push(sessionId);
			await manager.getOrCreateBackend(workspace, sessionId);
		}
		// The first-created idle backends were evicted; the pool holds the limit.
		const liveIds = sessionIds.filter((id) => manager.getBackend(workspace, id) !== undefined);
		expect(liveIds).toHaveLength(MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE);

		// A running session is pinned: mark one live backend streaming and
		// create enough new ones to force eviction.
		const pinnedId = liveIds[liveIds.length - 1];
		const pinned = manager.getBackend(workspace, pinnedId) as FakeAgentBackend;
		pinned.streaming = true;
		for (let index = 0; index < 4; index += 1) {
			await manager.getOrCreateBackend(workspace, `extra-${index}`);
		}
		expect(manager.getBackend(workspace, pinnedId)).toBeDefined();
		// Pending interactions are pinned too.
		const waiting = manager.getBackend(workspace, "extra-0") as FakeAgentBackend;
		waiting.emitInteraction("i1");
		for (let index = 0; index < 4; index += 1) {
			await manager.getOrCreateBackend(workspace, `more-${index}`);
		}
		expect(manager.getBackend(workspace, "extra-0")).toBeDefined();
		// The UI-active session is pinned.
		manager.setActiveSession(workspace, "more-0");
		for (let index = 0; index < 4; index += 1) {
			await manager.getOrCreateBackend(workspace, `last-${index}`);
		}
		expect(manager.getBackend(workspace, "more-0")).toBeDefined();
	});

	test("workspace warm eviction keeps the most recent workspaces and never kills pinned work", async () => {
		const { manager } = harness;
		await manager.start(W1);
		await manager.getOrCreateBackend(W1, "s1");
		await manager.start(W2);
		await manager.getOrCreateBackend(W2, "s2");
		// A third workspace makes the pool exceed MAX_WARM_WORKSPACES.
		await manager.start("C:\\workspace-c");
		await manager.getOrCreateBackend("C:\\workspace-c", "s3");
		// The oldest workspace (W1) was evicted along with its idle backend.
		expect(manager.getBackend(W1, "s1")).toBeUndefined();
		expect(manager.getBackend(W2, "s2")).toBeDefined();
	});

	test("disposeBackend and disposeWorkspace clean up targeted backends only", async () => {
		const { manager } = harness;
		await manager.getOrCreateBackend(W1, "a");
		await manager.getOrCreateBackend(W1, "b");
		await manager.getOrCreateBackend(W2, "c");
		await manager.disposeBackend(W1, "a");
		expect(manager.getBackend(W1, "a")).toBeUndefined();
		expect(manager.getBackend(W1, "b")).toBeDefined();
		await manager.disposeWorkspace(W2);
		expect(manager.getBackend(W2, "c")).toBeUndefined();
		expect(manager.getBackend(W1, "b")).toBeDefined();
	});

	test("disposeAll stops every backend", async () => {
		const { manager } = harness;
		await manager.getOrCreateBackend(W1, "a");
		await manager.getOrCreateBackend(W2, "b");
		await manager.stop();
		expect(manager.hasLiveBackends).toBe(false);
		expect(manager.getBackend(W1, "a")).toBeUndefined();
		expect(manager.getBackend(W2, "b")).toBeUndefined();
	});

	test("routed events carry the owning workspace and session", async () => {
		const { manager } = harness;
		const events: Array<{ workspaceId: string; sessionId: string; event: AgentEvent }> = [];
		manager.onEvent((event) => events.push(event));
		const backend = (await manager.getOrCreateBackend(W1, "session-a")) as FakeAgentBackend;
		backend.emit({ type: "agent_started" });
		expect(events).toEqual([
			// Materialization pushes the authoritative state first.
			{
				workspaceId: W1,
				sessionId: "session-a",
				event: {
					type: "state_changed",
					state: { model: null, isStreaming: false, isCompacting: false, sessionId: "session-a", messageCount: 0 },
				},
			},
			{ workspaceId: W1, sessionId: "session-a", event: { type: "agent_started" } },
		]);
	});

	test("deleteSession rejects running targets and disposes idle ones", async () => {
		const { manager } = harness;
		const backend = (await manager.getOrCreateBackend(W1, "session-a")) as FakeAgentBackend;
		backend.streaming = true;
		await expect(manager.deleteSession(W1, "session-a")).rejects.toThrow("Cannot delete a running session");
		backend.streaming = false;
		await manager.deleteSession(W1, "session-a");
		expect(manager.getBackend(W1, "session-a")).toBeUndefined();
	});

	test("renameSession routes through the live backend, else the catalog", async () => {
		const { manager } = harness;
		const renamed: string[] = [];
		const observing = createManagerWithBackend(
			(() => {
				const fake = new FakeAgentBackend();
				fake.renameSession = (name) => renamed.push(name);
				return fake;
			})(),
		);
		await observing.getOrCreateBackend(W1, "session-a");
		await observing.renameSession(W1, "session-a", "Live name");
		expect(renamed).toEqual(["Live name"]);
		// No live backend: the catalog path handles it (no-op in this fake).
		await expect(manager.renameSession(W1, "no-backend", "Catalog name")).resolves.toBeUndefined();
	});

	test("createSession creates a persisted identity without a backend", async () => {
		const { manager, fakes } = harness;
		const session = await manager.createSession(W1);
		expect(session.id).toBe("created");
		expect(session.file).toContain("created.jsonl");
		expect(fakes).toHaveLength(0);
	});
});

describe("SdkBackendManager listSessions", () => {
	test("returns only the requested workspace's catalog sessions", async () => {
		const { manager } = createManager({
			listCatalogSessions: async () => [
				{ id: "w1-session", workspacePath: W1 },
				{ id: "w2-session", workspacePath: W2 },
				{ id: "orphan-session" },
			],
		});

		const sessions = await manager.listSessions(W1);
		expect(sessions.map((session) => session.id)).toEqual(["w1-session"]);
	});

	test("overlays live backend state and messages onto catalog entries", async () => {
		const { manager } = createManager({
			listCatalogSessions: async () => [
				{
					id: "session-a",
					workspacePath: W1,
					file: "C:\\sessions\\a.jsonl",
					name: "Stale name",
					preview: "(no messages)",
					messageCount: 0,
					updatedAt: 50,
				},
			],
		});
		await manager.getOrCreateBackend(W1, "session-a");
		const backend = manager.getBackend(W1, "session-a") as FakeAgentBackend | undefined;
		expect(backend).toBeDefined();
		backend!.customState = {
			model: null,
			isStreaming: false,
			isCompacting: false,
			sessionId: "session-a",
			sessionName: "Fresh name",
			sessionFile: "C:\\sessions\\a.jsonl",
			messageCount: 2,
		};
		backend!.messages = [
			{ role: "user", content: "First question", timestamp: 100 },
			{ role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: 200 },
		];

		const sessions = await manager.listSessions(W1);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "session-a",
			file: "C:\\sessions\\a.jsonl",
			workspacePath: W1,
			name: "Fresh name",
			preview: "First question",
			messageCount: 2,
			updatedAt: 200,
		});
	});

	test("includes a materialized session that is missing from the catalog", async () => {
		const { manager } = harness;
		await manager.getOrCreateBackend(W1, "session-a");
		const backend = manager.getBackend(W1, "session-a") as FakeAgentBackend | undefined;
		expect(backend).toBeDefined();
		backend!.customState = {
			model: null,
			isStreaming: false,
			isCompacting: false,
			sessionId: "session-a",
			sessionFile: "C:\\sessions\\a.jsonl",
			messageCount: 1,
		};
		backend!.messages = [{ role: "user", content: "Only message", timestamp: 300 }];

		const sessions = await manager.listSessions(W1);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "session-a",
			file: "C:\\sessions\\a.jsonl",
			workspacePath: W1,
			preview: "Only message",
			updatedAt: 300,
		});
	});

	test("a failing live backend falls back to the catalog entry", async () => {
		const { manager } = createManager({
			listCatalogSessions: async () => [{ id: "session-a", workspacePath: W1, preview: "Catalog preview" }],
		});
		await manager.getOrCreateBackend(W1, "session-a");
		const backend = manager.getBackend(W1, "session-a") as FakeAgentBackend | undefined;
		expect(backend).toBeDefined();
		backend!.failGetState = true;

		const sessions = await manager.listSessions(W1);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: "session-a", preview: "Catalog preview" });
	});
});
