import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PiBackend } from "../src/pi-backend.ts";

const stubPath = fileURLToPath(new URL("./fixtures/stub-backend.mjs", import.meta.url));
const tempDirs: string[] = [];

function makeWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-backend-test-"));
	tempDirs.push(dir);
	return dir;
}

function makeBackend(): PiBackend {
	return new PiBackend({ startupTimeoutMs: 15_000 });
}

function collectEvents(backend: PiBackend): AgentEvent[] {
	const events: AgentEvent[] = [];
	backend.subscribe((event) => events.push(event));
	return events;
}

async function waitForEvent(
	events: AgentEvent[],
	predicate: (event: AgentEvent) => boolean,
	timeoutMs = 10_000,
): Promise<AgentEvent> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = events.find(predicate);
		if (found) {
			return found;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for event");
}

describe("PiBackend over stub RPC", () => {
	let backend: PiBackend;
	let workspace: string;
	let events: AgentEvent[];

	beforeEach(() => {
		backend = makeBackend();
		workspace = makeWorkspace();
		events = collectEvents(backend);
	});

	afterEach(async () => {
		await backend.stop();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function start(env?: Record<string, string>): Promise<void> {
		await backend.start({
			workspacePath: workspace,
			executable: process.execPath,
			args: [stubPath],
			env,
		});
	}

	test("start performs the handshake and discovers capabilities", async () => {
		await start();
		const handshake = await backend.getHandshake();
		expect(handshake.protocolVersion).toBe("1.0.0");
		expect(handshake.backend.id).toBe("pi");
		expect(handshake.capabilities).toMatchObject({
			sessions: true,
			models: true,
			abort: true,
			commands: true,
			reasoningLevels: true,
			tools: true,
			extensionUI: true,
			sessionUsage: true,
		});
		const state = await backend.getState();
		expect(state.sessionId).toBe("stub-session-1");
		expect(state.isStreaming).toBe(false);
		const ready = await waitForEvent(events, (event) => event.type === "custom" && event.name === "backend_ready");
		expect(ready.type === "custom" && ready.payload).toBeTruthy();
	});

	test("keeps startup transient and persists only an explicitly created blank session", async () => {
		const persistEvents = () =>
			events.filter(
				(event) => event.type === "custom" && event.namespace === "pi" && event.name === "persist_session_called",
			);

		await start({ STUB_TRACE_PERSIST_SESSION: "1" });
		expect(persistEvents()).toHaveLength(0);

		await backend.createSession();
		expect(persistEvents()).toHaveLength(1);
	});

	test("listModels returns the backend's model list (no hardcoded providers)", async () => {
		await start();
		const models = await backend.listModels();
		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({ id: "stub-model", provider: "stub-provider", input: ["text", "image"] });
		expect(models[1]).toMatchObject({ id: "stub-model-2" });
	});

	test("listModels falls back to the last good catalog on transient failure", async () => {
		await start({ STUB_FAIL_MODELS: "after" });
		// First call succeeds and populates the catalog cache.
		const first = await backend.listModels();
		expect(first).toHaveLength(2);
		// Later calls fail: the last good catalog is served instead of a
		// fabricated single-model list.
		const second = await backend.listModels();
		expect(second).toHaveLength(2);
		expect(second[0]).toMatchObject({ id: "stub-model" });

		// A backend without any prior catalog surfaces the failure explicitly.
		const cold = makeBackend();
		await cold.start({
			workspacePath: workspace,
			executable: process.execPath,
			args: [stubPath],
			env: { STUB_FAIL_MODELS: "1" },
		});
		await expect(cold.listModels()).rejects.toThrow(/get_available_models failed/);
		await cold.stop();
	});

	test("auth status lists providers without key values; set/remove round-trip", async () => {
		await start();
		const statuses = await backend.listProviderAuthStatus();
		expect(statuses).toEqual([
			{
				provider: "opencode-go",
				name: "OpenCode Go",
				configured: false,
				source: "none",
				mutable: true,
				supportsApiKey: true,
				supportsOAuth: true,
				oauthName: "Sign in with OAuth Provider",
				isSubscription: true,
			},
			{
				provider: "opencode",
				name: "OpenCode Zen",
				configured: true,
				source: "environment",
				mutable: false,
				supportsApiKey: true,
			},
		]);
		await backend.setApiKey("opencode-go", "sk-test");
		await backend.removeCredential("opencode-go");
		await expect(backend.setApiKey("opencode-go", "")).rejects.toThrow("non-empty");
	});

	test("OAuth login streams auth_flow events, answers prompts, and completes", async () => {
		await start();
		const login = backend.loginWithOAuth("opencode-go");

		const urlFlow = await waitForEvent(
			events,
			(event) =>
				event.type === "custom" &&
				event.name === "auth_flow" &&
				(event.payload as { event?: { type?: string } }).event?.type === "auth_url",
		);
		expect(urlFlow.type === "custom" && urlFlow.payload).toMatchObject({
			kind: "event",
			loginId: "stub-login",
			event: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
		});

		await waitForEvent(
			events,
			(event) =>
				event.type === "custom" &&
				event.name === "auth_flow" &&
				(event.payload as { event?: { type?: string } }).event?.type === "device_code",
		);
		const promptFlow = await waitForEvent(
			events,
			(event) =>
				event.type === "custom" &&
				event.name === "auth_flow" &&
				(event.payload as { kind?: string }).kind === "prompt",
		);
		expect(promptFlow.type === "custom" && promptFlow.payload).toMatchObject({
			kind: "prompt",
			loginId: "stub-login",
			requestId: "stub-prompt-1",
			prompt: { type: "manual_code", message: "Paste the code" },
		});

		await backend.respondToAuthPrompt("stub-prompt-1", { kind: "value", value: "STUB-CODE" });
		await login;

		// The login response refreshes backend state.
		const state = await backend.getState();
		expect(state.sessionId).toBe("stub-session-1");
	});

	test("OAuth login rejects on provider error and cancels via cancelOAuthLogin", async () => {
		await start();
		const login = backend.loginWithOAuth("missing-provider");
		await expect(login).rejects.toThrow("Unknown provider");

		const cancelled = backend.loginWithOAuth("opencode-go");
		await waitForEvent(
			events,
			(event) =>
				event.type === "custom" &&
				event.name === "auth_flow" &&
				(event.payload as { kind?: string }).kind === "prompt",
		);
		await backend.cancelOAuthLogin();
		await expect(cancelled).rejects.toThrow("Login cancelled");
	});

	test("refreshAuth re-reads credentials without surfacing values", async () => {
		await start();
		await expect(backend.refreshAuth("opencode-go")).resolves.toBeUndefined();
	});

	test("sendMessage streams a full turn with messages and tool events", async () => {
		await start();
		await backend.sendMessage({ role: "user", content: "Hello" });

		await waitForEvent(events, (event) => event.type === "agent_started");
		const deltas = await waitForEvent(events, (event) => event.type === "message_delta" && event.delta === " world");
		expect(deltas.type === "message_delta" && deltas.kind).toBe("text");
		await waitForEvent(events, (event) => event.type === "tool_started" && event.tool.name === "bash");
		await waitForEvent(events, (event) => event.type === "tool_updated" && event.tool.partialResult === "hi\n");
		await waitForEvent(events, (event) => event.type === "tool_completed" && event.tool.status === "completed");
		await waitForEvent(events, (event) => event.type === "message_completed" && event.message.role === "assistant");
		await waitForEvent(events, (event) => event.type === "agent_stopped");
		// agent_end and agent_settled must collapse into exactly one terminal event.
		expect(events.filter((event) => event.type === "agent_stopped")).toHaveLength(1);

		const state = await backend.getState();
		expect(state.isStreaming).toBe(false);
		const messages = await backend.getMessages();
		expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	});

	test("sendMessage forwards multiple image blocks through Pi RPC", async () => {
		await start();
		await backend.sendMessage({
			role: "user",
			content: [
				{ type: "text", text: "Compare these" },
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/png", name: "first.png" },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/jpeg", name: "second.jpg" },
			],
		});
		await waitForEvent(events, (event) => event.type === "agent_stopped");

		const userMessage = (await backend.getMessages()).find((message) => message.role === "user");
		expect(userMessage).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "Compare these" },
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/png" },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/jpeg" },
			],
		});
	});

	test("getSessionUsage returns cumulative tokens and live context usage", async () => {
		await start();
		expect(await backend.getSessionUsage()).toEqual({
			sessionId: "stub-session-1",
			tokens: { input: 1200, output: 300, cacheRead: 600, cacheWrite: 100, total: 2200 },
			cost: 0.012,
			contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
		});
	});

	test("sendMessage uses steer behavior while streaming", async () => {
		await start();
		// STAY_STREAMING keeps the stub busy; a prompt without streamingBehavior
		// would be rejected by the stub, so success proves steer was sent.
		await backend.sendMessage({ role: "user", content: "STAY_STREAMING" });
		await waitForEvent(events, (event) => event.type === "agent_started");
		await backend.sendMessage({ role: "user", content: "FINISH" });
		await waitForEvent(events, (event) => event.type === "agent_stopped");
	});

	test("drops a stale streaming get_state response that returns after agent_settled", async () => {
		await start({ STUB_HOLD_STREAMING_GET_STATE: "1" });
		await backend.sendMessage({ role: "user", content: "STAY_STREAMING" });
		await waitForEvent(events, (event) => event.type === "agent_started");

		// The stub holds this request with an isStreaming: true snapshot until
		// the turn settles, simulating a slow get_state response.
		const staleState = backend.getState();

		await backend.sendMessage({ role: "user", content: "FINISH" });
		await waitForEvent(events, (event) => event.type === "agent_stopped");

		expect((await staleState).isStreaming).toBe(false);
		expect(events.filter((event) => event.type === "agent_stopped")).toHaveLength(1);

		const finalState = await backend.getState();
		expect(finalState.isStreaming).toBe(false);
		const lastStateChanged = events.filter((event) => event.type === "state_changed").at(-1);
		expect(lastStateChanged?.type === "state_changed" && lastStateChanged.state.isStreaming).toBe(false);
	});

	test("abort stops a streaming turn", async () => {
		await start();
		await backend.sendMessage({ role: "user", content: "STAY_STREAMING" });
		await waitForEvent(events, (event) => event.type === "agent_started");
		await backend.abort();
		await waitForEvent(events, (event) => event.type === "agent_stopped");
		const state = await backend.getState();
		expect(state.isStreaming).toBe(false);
	});

	test("createSession starts a fresh session and emits session_changed", async () => {
		await start();
		const first = await backend.getState();
		const session = await backend.createSession();
		expect(session.id).not.toBe(first.sessionId);
		expect(session.id).toBeTruthy();
		await waitForEvent(events, (event) => event.type === "custom" && event.name === "session_changed");
		const state = await backend.getState();
		expect(state.sessionId).toBe(session.id);
	});

	test("keeps a blank session after switching away from it", async () => {
		await start();
		const blankSession = await backend.createSession();

		await backend.switchSession("stub-session-2");

		expect((await backend.listSessions()).find((session) => session.id === blankSession.id)).toMatchObject({
			id: blankSession.id,
			messageCount: 0,
		});
	});

	test("lists saved sessions and restores one by id", async () => {
		await start();
		const sessions = await backend.listSessions();
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toMatchObject({
			id: "stub-session-1",
			file: "/stub/session-1.jsonl",
			preview: "Current desktop session",
			messageCount: 0,
		});
		expect(sessions[1]).toMatchObject({
			id: "stub-session-2",
			name: "Historical session",
			messageCount: 2,
		});
		expect(sessions[1].updatedAt).toBe(Date.parse("2026-08-07T03:00:00.000Z"));

		const restored = await backend.switchSession("stub-session-2");
		expect(restored).toMatchObject({ id: "stub-session-2", name: "Historical session" });
		const state = await backend.getState();
		expect(state).toMatchObject({ sessionId: "stub-session-2", sessionName: "Historical session", messageCount: 2 });
		const messages = await backend.getMessages();
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user", content: "Restore the previous conversation" });
		await waitForEvent(
			events,
			(event) =>
				event.type === "custom" &&
				event.name === "session_changed" &&
				(event.payload as { sessionId?: string }).sessionId === "stub-session-2",
		);
	});

	test("reports an actionable error for a backend without list_sessions", async () => {
		await start({ STUB_NO_LIST_SESSIONS: "1" });
		const handshake = await backend.getHandshake();
		expect(handshake.capabilities.sessions).not.toBe(true);
		await expect(backend.listSessions()).rejects.toThrow("Rebuild and restage the backend");
	});

	test("rejects switching to an unknown session id", async () => {
		await start();
		await expect(backend.switchSession("missing-session")).rejects.toThrow("Session not found");
	});

	test("renames current and historical sessions without switching", async () => {
		await start();
		await backend.renameSession("stub-session-2", "Renamed history");
		expect((await backend.getState()).sessionId).toBe("stub-session-1");
		expect((await backend.listSessions()).find((session) => session.id === "stub-session-2")?.name).toBe(
			"Renamed history",
		);

		await backend.renameSession("stub-session-1", "Renamed current");
		expect(await backend.getState()).toMatchObject({
			sessionId: "stub-session-1",
			sessionName: "Renamed current",
		});
		await expect(backend.renameSession("missing-session", "Nope")).rejects.toThrow("Session not found");
	});

	test("setModel switches the model and updates state", async () => {
		await start();
		const model = await backend.setModel({ provider: "stub-provider", modelId: "stub-model-2" });
		expect(model).toMatchObject({ id: "stub-model-2" });
		const state = await backend.getState();
		expect(state.model?.id).toBe("stub-model-2");
		await expect(backend.setModel({ provider: "nope", modelId: "nope" })).rejects.toThrow("Model not found");
	});

	test("lists and sets thinking levels", async () => {
		await start();
		expect(await backend.listThinkingLevels()).toEqual(["off", "low", "medium", "high"]);
		await backend.setThinkingLevel("high");
		expect((await backend.getState()).thinkingLevel).toBe("high");
	});

	test("unknown RPC events flow through as custom events without crashing", async () => {
		await start();
		await backend.sendMessage({ role: "user", content: "EMIT_UNKNOWN_EVENT" });
		const custom = await waitForEvent(events, (event) => event.type === "custom" && event.name === "weird_new_event");
		expect(custom.type === "custom" && custom.payload).toMatchObject({ some: "payload" });
		// Backend still usable afterwards.
		const state = await backend.getState();
		expect(state.sessionId).toBe("stub-session-1");
	});

	test("extension UI select is surfaced and can be answered", async () => {
		await start();
		await backend.sendMessage({ role: "user", content: "EXT_UI_SELECT" });
		const requested = await waitForEvent(events, (event) => event.type === "interaction_requested");
		expect(requested.type === "interaction_requested" && requested.request).toMatchObject({
			id: "ext-1",
			kind: "select",
			options: ["A", "B"],
		});
		await backend.respondToInteraction("ext-1", { kind: "value", value: "A" });
		await waitForEvent(events, (event) => event.type === "agent_stopped");
	});

	test("backend crash emits an error event and keeps the GUI safe", async () => {
		await start();
		const crash = backend.sendMessage({ role: "user", content: "CRASH_NOW" });
		await crash;
		const error = await waitForEvent(events, (event) => event.type === "error" && event.source === "process");
		expect(error.type === "error" && error.message).toContain("exited unexpectedly");
		expect(error.type === "error" && error.message).toContain("simulated crash");
		await waitForEvent(events, (event) => event.type === "custom" && event.name === "backend_exited");
	});

	test("stderr diagnostics are forwarded as custom events", async () => {
		await start();
		await backend.sendMessage({ role: "user", content: "STDERR_ONLY" });
		await waitForEvent(events, (event) => event.type === "custom" && event.name === "backend_stderr");
	});

	test("start fails when the executable does not exist", async () => {
		await expect(
			backend.start({
				workspacePath: workspace,
				executable: join(workspace, "missing.exe"),
				args: [],
			}),
		).rejects.toThrow();
	});

	test("start fails with stderr diagnostics when the backend never becomes ready", async () => {
		const failing = new PiBackend({ startupTimeoutMs: 2_000 });
		const failEvents: AgentEvent[] = [];
		failing.subscribe((event) => failEvents.push(event));
		await expect(
			failing.start({
				workspacePath: workspace,
				executable: process.execPath,
				args: ["-e", "process.stderr.write('config broken\\n'); process.exit(1);"],
			}),
		).rejects.toThrow(/config broken/);
		await failing.stop();
	});

	test("stop cleans up the subprocess and rejects new commands", async () => {
		await start();
		await backend.stop();
		expect(backend.isRunning).toBe(false);
		await expect(backend.sendMessage({ role: "user", content: "x" })).rejects.toThrow(/not started/);
	});
});
