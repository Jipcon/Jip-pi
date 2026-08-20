import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-agent-protocol";
import { resetMockAgent } from "./setup.ts";
import {
	deleteSessionEntry,
	loginProviderOAuth,
	newSession,
	openSession,
	pickWorkspaceAndStart,
	removeProviderCredential,
	renameSessionEntry,
	resendEditedMessage,
	saveCustomProvider,
	saveProviderApiKey,
	startWorkspace,
	store,
	useAgentBridge,
} from "../src/renderer/state/hooks.ts";

function BridgeProbe(): null {
	useAgentBridge();
	return null;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

function snapshotState(sessionId: string, isStreaming = false) {
	return {
		model: null,
		isStreaming,
		isCompacting: false,
		sessionId,
		messageCount: 0,
	};
}

beforeEach(() => {
	resetMockAgent();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("useAgentBridge", () => {
	test("routes a session event into that session's state only", async () => {
		let eventHandler: Parameters<typeof window.agent.subscribe>[0] | undefined;
		vi.mocked(window.agent.subscribe).mockImplementation((handler) => {
			eventHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});

		render(<BridgeProbe />);
		await waitFor(() => expect(eventHandler).toBeTypeOf("function"));
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "session-a",
				event: { type: "agent_started" },
			}),
		);
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "session-a",
				event: { type: "agent_stopped" },
			}),
		);
		const snapshot = store.getSnapshot();
		expect(snapshot.sessionStateById["session-a"]).toBeDefined();
		expect(snapshot.sessionStateById["session-b"]).toBeUndefined();
	});

	test("refreshes per-session usage after a completed turn", async () => {
		let eventHandler: Parameters<typeof window.agent.subscribe>[0] | undefined;
		vi.mocked(window.agent.subscribe).mockImplementation((handler) => {
			eventHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});
		vi.mocked(window.agent.getSessionUsage).mockResolvedValue({
			sessionId: "usage-session",
			tokens: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, total: 175 },
			cost: 0.01,
			contextUsage: { tokens: 1000, contextWindow: 2000, percent: 50 },
		});
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("usage-session"),
			messages: [],
			usage: null,
			thinkingLevels: [],
		});

		render(<BridgeProbe />);
		await waitFor(() => expect(eventHandler).toBeTypeOf("function"));
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "usage-session",
				event: { type: "turn_completed" },
			}),
		);

		await waitFor(() =>
			expect(store.getSnapshot().sessionStateById["usage-session"].sessionUsage?.tokens.total).toBe(175),
		);
		expect(window.agent.getSessionUsage).toHaveBeenCalledWith("D:\\work", "usage-session");
	});

	test("refreshes the live session list after a completed turn in the active workspace", async () => {
		let eventHandler: Parameters<typeof window.agent.subscribe>[0] | undefined;
		vi.mocked(window.agent.subscribe).mockImplementation((handler) => {
			eventHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});
		vi.mocked(window.agent.getStatus).mockResolvedValue({ phase: "running", workspace: "D:\\work" });
		vi.mocked(window.agent.listSessions).mockResolvedValue([
			{ id: "live-session", workspacePath: "D:\\work", preview: "First prompt" },
		]);
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\work" } });

		render(<BridgeProbe />);
		await waitFor(() => expect(eventHandler).toBeTypeOf("function"));
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "live-session",
				event: { type: "turn_completed" },
			}),
		);

		await waitFor(() =>
			expect(store.getSnapshot().sessions).toEqual([
				{ id: "live-session", workspacePath: "D:\\work", preview: "First prompt" },
			]),
		);
		expect(window.agent.listSessions).toHaveBeenCalledWith("D:\\work");
	});

	test("does not refresh the live session list for background workspace turns", async () => {
		let eventHandler: Parameters<typeof window.agent.subscribe>[0] | undefined;
		vi.mocked(window.agent.subscribe).mockImplementation((handler) => {
			eventHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});
		vi.mocked(window.agent.getStatus).mockResolvedValue({ phase: "running", workspace: "D:\\active" });
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\active" } });

		render(<BridgeProbe />);
		await waitFor(() => expect(eventHandler).toBeTypeOf("function"));
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\other",
				sessionId: "background-session",
				event: { type: "turn_completed" },
			}),
		);

		expect(window.agent.getSessionUsage).toHaveBeenCalledWith("D:\\other", "background-session");
		expect(window.agent.listSessions).not.toHaveBeenCalledWith("D:\\other");
	});

	test("fetches provider auth status, the model catalog and sessions on startup while no workspace is active", async () => {
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});
		vi.mocked(window.agent.getStatus).mockResolvedValue({ phase: "no-workspace", workspace: null });
		vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([
			{ id: "old-session", workspacePath: "D:\\old" },
		]);
		vi.mocked(window.agent.listWorkspaces).mockResolvedValue(["D:\\old"]);
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([
			{ provider: "opencode", configured: true, source: "stored", mutable: true },
		]);
		vi.mocked(window.agent.listModels).mockResolvedValue([{ id: "m1", name: "M", provider: "p" }]);

		render(<BridgeProbe />);
		await waitFor(() => expect(store.getSnapshot().authStatuses).toHaveLength(1));
		await waitFor(() => expect(store.getSnapshot().sessionCatalog).toHaveLength(1));
		await waitFor(() => expect(store.getSnapshot().models).toHaveLength(1));
		expect(store.getSnapshot().workspaces).toEqual(["D:\\old"]);
	});

	test("host auth_flow events update the app-level flow view", async () => {
		let hostHandler: Parameters<typeof window.agent.onHostEvent>[0] | undefined;
		vi.mocked(window.agent.onHostEvent).mockImplementation((handler) => {
			hostHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.subscribe).mockReturnValue(() => {});

		render(<BridgeProbe />);
		await waitFor(() => expect(hostHandler).toBeTypeOf("function"));
		act(() =>
			hostHandler?.({
				type: "custom",
				namespace: "pi",
				name: "auth_flow",
				payload: {
					kind: "event",
					loginId: "login-1",
					event: { type: "auth_url", url: "https://example.com/auth" },
				},
			}),
		);
		expect(store.getSnapshot().authFlow?.loginId).toBe("login-1");
		expect(store.getSnapshot().authFlow?.display?.type).toBe("auth_url");
	});
});

describe("session operations", () => {
	test("openSession sets the active session and applies the snapshot", async () => {
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("target-session"),
			messages: [{ role: "user", content: "hello" }],
			usage: null,
		});
		vi.mocked(window.agent.listThinkingLevels).mockResolvedValue(["off", "high"]);

		await openSession("D:\\work", "target-session");
		const snapshot = store.getSnapshot();
		expect(snapshot.activeSessionId).toBe("target-session");
		expect(snapshot.sessionStateById["target-session"].messages).toHaveLength(1);
		expect(snapshot.sessionStateById["target-session"].thinkingLevels).toEqual(["off", "high"]);
		expect(window.agent.openSession).toHaveBeenCalledWith("D:\\work", "target-session");
	});

	test("openSession activates the workspace first when it is not running", async () => {
		// Regression: opening a session from the startup catalog used to leave
		// the workspace status at no-workspace, so the chat stayed hidden
		// until a workspace was added manually.
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("target-session"),
			messages: [],
			usage: null,
		});
		vi.mocked(window.agent.start).mockResolvedValue();
		vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([]);
		vi.mocked(window.agent.listWorkspaces).mockResolvedValue([]);
		vi.mocked(window.agent.listModels).mockResolvedValue([]);
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([]);
		store.dispatch({ type: "status", status: { phase: "no-workspace", workspace: null } });

		await openSession("D:\\work", "target-session");
		expect(window.agent.start).toHaveBeenCalledWith("D:\\work");
		expect(window.agent.openSession).toHaveBeenCalledWith("D:\\work", "target-session");
		expect(store.getSnapshot().activeSessionId).toBe("target-session");
	});

	test("openSession skips the workspace start when the same workspace is already running", async () => {
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("target-session"),
			messages: [],
			usage: null,
		});
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\work" } });

		await openSession("D:\\work", "target-session");
		expect(window.agent.start).not.toHaveBeenCalled();
	});

	test("openSession rejects sessions without a workspace path", async () => {
		await expect(openSession("", "orphan-session")).rejects.toThrow(
			"This session does not record a workspace path",
		);
		expect(window.agent.openSession).not.toHaveBeenCalled();
	});

	test("newSession creates the session and opens it", async () => {
		vi.mocked(window.agent.createSession).mockResolvedValue({ id: "fresh-session" });
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("fresh-session"),
			messages: [],
			usage: null,
		});
		vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([{ id: "fresh-session" }]);
		vi.mocked(window.agent.listWorkspaces).mockResolvedValue(["D:\\work"]);

		const sessionId = await newSession("D:\\work");
		expect(sessionId).toBe("fresh-session");
		expect(window.agent.createSession).toHaveBeenCalledWith("D:\\work");
		expect(window.agent.openSession).toHaveBeenCalledWith("D:\\work", "fresh-session");
	});

	test("renameSessionEntry routes through the session's own workspace", async () => {
		const session: SessionInfo = { id: "s1", workspacePath: "D:\\other" };
		await renameSessionEntry(session, "New name");
		expect(window.agent.renameSession).toHaveBeenCalledWith("D:\\other", "s1", "New name");
	});

	test("renameSessionEntry falls back to the catalog for sessions without a workspace", async () => {
		await renameSessionEntry({ id: "orphan" }, "Renamed");
		expect(window.agent.renameCatalogSession).toHaveBeenCalledWith("orphan", "Renamed");
	});

	test("deleteSessionEntry falls back to another session when deleting the active one", async () => {
		vi.mocked(window.agent.deleteSession).mockResolvedValue();
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("active-session"),
			messages: [],
			usage: null,
			thinkingLevels: [],
		});
		store.dispatch({ type: "active-session", sessionId: "active-session" });
		store.dispatch({
			type: "session-catalog",
			sessions: [
				{ id: "active-session", workspacePath: "D:\\work" },
				{ id: "other-session", workspacePath: "D:\\work" },
			],
		});
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("other-session"),
			messages: [],
			usage: null,
		});

		await deleteSessionEntry({ id: "active-session", workspacePath: "D:\\work" });
		expect(window.agent.deleteSession).toHaveBeenCalledWith("D:\\work", "active-session");
		expect(store.getSnapshot().activeSessionId).toBe("other-session");
	});

	test("deleteSessionEntry clears the active session when no fallback exists", async () => {
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("only-session"),
			messages: [],
			usage: null,
			thinkingLevels: [],
		});
		store.dispatch({ type: "active-session", sessionId: "only-session" });
		vi.mocked(window.agent.deleteSession).mockResolvedValue();
		vi.mocked(window.agent.listWorkspaces).mockResolvedValue([]);

		await deleteSessionEntry({ id: "only-session", workspacePath: "D:\\work" });
		expect(store.getSnapshot().activeSessionId).toBeNull();
	});
});

describe("message editing (in place)", () => {
	test("openSession applies structurally paired entry ids from the snapshot", async () => {
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("target-session"),
			messages: [{ role: "user", content: "hello", timestamp: 10 }],
			usage: null,
			entryIds: ["e1"],
		});
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\work" } });

		await openSession("D:\\work", "target-session");
		// No separate editable scan: the pairing rides on the snapshot itself.
		expect(window.agent.listEditableUserMessages).not.toHaveBeenCalled();
		expect(store.getSnapshot().sessionStateById["target-session"].messages[0].entryId).toBe("e1");
	});

	test("agent_stopped never re-scans; the editable delta carries only new entries", async () => {
		let eventHandler: Parameters<typeof window.agent.subscribe>[0] | undefined;
		vi.mocked(window.agent.subscribe).mockImplementation((handler) => {
			eventHandler = handler;
			return () => {};
		});
		vi.mocked(window.agent.onStatus).mockReturnValue(() => {});
		vi.mocked(window.agent.onHostEvent).mockReturnValue(() => {});
		vi.mocked(window.agent.getStatus).mockResolvedValue({ phase: "running", workspace: "D:\\work" });
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("stopped-session"),
			messages: [{ role: "user", content: "late message", timestamp: 42 }],
			usage: null,
			thinkingLevels: [],
		});

		render(<BridgeProbe />);
		await waitFor(() => expect(eventHandler).toBeTypeOf("function"));
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "stopped-session",
				event: { type: "agent_stopped" },
			}),
		);
		// Stopping triggers no full editable re-scan.
		expect(window.agent.listEditableUserMessages).not.toHaveBeenCalled();

		// The backend pushes only the newly editable entry.
		act(() =>
			eventHandler?.({
				workspaceId: "D:\\work",
				sessionId: "stopped-session",
				event: {
					type: "editable_messages_added",
					entries: [{ entryId: "e-late", text: "late message", timestamp: 42 }],
				},
			}),
		);
		expect(store.getSnapshot().sessionStateById["stopped-session"].messages[0].entryId).toBe("e-late");
	});

	test("resendEditedMessage truncates optimistically and sends the edit in place", async () => {
		vi.mocked(window.agent.editUserMessage).mockResolvedValue({ status: "sent" });
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("source-session"),
			messages: [
				{ role: "user", content: "first", timestamp: 100 },
				{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 150 },
				{ role: "user", content: "second", timestamp: 200 },
			],
			usage: null,
			thinkingLevels: [],
			entryIds: ["e1", undefined, "e2"],
		});
		store.dispatch({ type: "active-session", sessionId: "source-session" });
		store.dispatch({
			type: "session-edit-start",
			sessionId: "source-session",
			entryId: "e2",
			text: "second",
		});

		await resendEditedMessage("D:\\work", "source-session", "e2", "second (edited)");

		expect(window.agent.editUserMessage).toHaveBeenCalledWith("D:\\work", "source-session", "e2", "second (edited)");
		// The optimistic truncation dropped the edited message and its answer.
		const session = store.getSnapshot().sessionStateById["source-session"];
		expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(session.editing).toBeNull();
		// Stays in the same session: no reopen, no catalog churn needed.
		expect(store.getSnapshot().activeSessionId).toBe("source-session");
	});

	test("resendEditedMessage restores the original history when the backend rejects", async () => {
		vi.mocked(window.agent.editUserMessage).mockRejectedValue(new Error("prompt rejected"));
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("source-session"),
			messages: [
				{ role: "user", content: "first", timestamp: 100 },
				{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 150 },
				{ role: "user", content: "second", timestamp: 200 },
			],
			usage: null,
		});
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\work" } });
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("source-session"),
			messages: [
				{ role: "user", content: "first", timestamp: 100 },
				{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 150 },
				{ role: "user", content: "second", timestamp: 200 },
			],
			usage: null,
			thinkingLevels: [],
			entryIds: ["e1", undefined, "e2"],
		});
		store.dispatch({
			type: "session-edit-start",
			sessionId: "source-session",
			entryId: "e2",
			text: "second",
		});

		await expect(resendEditedMessage("D:\\work", "source-session", "e2", "edited")).rejects.toThrow(
			"prompt rejected",
		);

		// The backend rolled the leaf back; the snapshot restores u2-a2.
		const session = store.getSnapshot().sessionStateById["source-session"];
		expect(session.messages).toHaveLength(3);
	});

	test("resendEditedMessage surfaces an extension veto and restores the snapshot", async () => {
		vi.mocked(window.agent.editUserMessage).mockResolvedValue({ status: "cancelled" });
		vi.mocked(window.agent.openSession).mockResolvedValue({
			state: snapshotState("source-session"),
			messages: [{ role: "user", content: "first", timestamp: 100 }],
			usage: null,
		});
		store.dispatch({ type: "status", status: { phase: "running", workspace: "D:\\work" } });
		store.dispatch({
			type: "session-snapshot",
			workspaceId: "D:\\work",
			state: snapshotState("source-session"),
			messages: [{ role: "user", content: "first", timestamp: 100 }],
			usage: null,
			thinkingLevels: [],
			entryIds: ["e1"],
		});
		store.dispatch({
			type: "session-edit-start",
			sessionId: "source-session",
			entryId: "e1",
			text: "first",
		});

		await resendEditedMessage("D:\\work", "source-session", "e1", "edited");

		const snapshot = store.getSnapshot();
		expect(snapshot.notifications.some((notification) => notification.message.includes("cancelled"))).toBe(true);
		expect(snapshot.sessionStateById["source-session"].messages).toHaveLength(1);
	});
});

describe("workspace operations", () => {
	test("startWorkspace refreshes the catalog and models", async () => {
		vi.mocked(window.agent.start).mockResolvedValue();
		vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([]);
		vi.mocked(window.agent.listSessions).mockResolvedValue([{ id: "live-session", workspacePath: "D:\\work" }]);
		vi.mocked(window.agent.listWorkspaces).mockResolvedValue([]);
		vi.mocked(window.agent.listModels).mockResolvedValue([{ id: "m1", name: "M", provider: "p" }]);
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([]);

		await startWorkspace("D:\\work");
		expect(window.agent.start).toHaveBeenCalledWith("D:\\work");
		await waitFor(() => expect(store.getSnapshot().models).toHaveLength(1));
		await waitFor(() => expect(store.getSnapshot().sessions).toEqual([{ id: "live-session", workspacePath: "D:\\work" }]));
		expect(window.agent.listSessions).toHaveBeenCalledWith("D:\\work");
	});

	test("pickWorkspaceAndStart returns undefined when the picker is cancelled", async () => {
		vi.mocked(window.agent.pickWorkspace).mockResolvedValue(null);
		await expect(pickWorkspaceAndStart()).resolves.toBeUndefined();
	});
});

describe("auth operations", () => {
	test("saveProviderApiKey refreshes auth status and the model catalog", async () => {
		vi.mocked(window.agent.setApiKey).mockResolvedValue();
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([
			{ provider: "opencode", configured: true, source: "stored", mutable: true },
		]);
		vi.mocked(window.agent.listModels).mockResolvedValue([{ id: "m1", name: "M", provider: "opencode" }]);

		await saveProviderApiKey("opencode", "sk-test");
		expect(window.agent.setApiKey).toHaveBeenCalledWith("opencode", "sk-test");
		expect(store.getSnapshot().authStatuses).toHaveLength(1);
		expect(store.getSnapshot().models).toHaveLength(1);
	});

	test("removeProviderCredential refreshes auth status and the model catalog", async () => {
		vi.mocked(window.agent.removeCredential).mockResolvedValue();
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([]);
		vi.mocked(window.agent.listModels).mockResolvedValue([]);

		await removeProviderCredential("opencode");
		expect(window.agent.removeCredential).toHaveBeenCalledWith("opencode");
	});

	test("loginProviderOAuth refreshes models and auth status after success", async () => {
		vi.mocked(window.agent.loginWithOAuth).mockResolvedValue();
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([]);
		vi.mocked(window.agent.listModels).mockResolvedValue([]);

		await loginProviderOAuth("opencode");
		expect(window.agent.loginWithOAuth).toHaveBeenCalledWith("opencode");
		expect(window.agent.listModels).toHaveBeenCalled();
	});
});

describe("custom provider save", () => {
	const config = {
		id: "my-local",
		baseUrl: "http://x",
		api: "openai-completions" as const,
		models: [{ id: "m1" }],
	};

	test("saving config and api key refreshes models/auth exactly once", async () => {
		vi.mocked(window.agent.saveCustomProvider).mockResolvedValue();
		vi.mocked(window.agent.setApiKey).mockResolvedValue();
		vi.mocked(window.agent.listModels).mockResolvedValue([{ id: "m1", name: "M", provider: "my-local" }]);
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([
			{ provider: "my-local", configured: true, source: "stored", mutable: true },
		]);

		await saveCustomProvider(config, "sk-test");

		expect(window.agent.saveCustomProvider).toHaveBeenCalledTimes(1);
		expect(window.agent.setApiKey).toHaveBeenCalledWith("my-local", "sk-test");
		// One refresh for the combined save, not one per step.
		expect(window.agent.listModels).toHaveBeenCalledTimes(1);
		expect(window.agent.listProviderAuthStatus).toHaveBeenCalledTimes(1);
		expect(store.getSnapshot().models).toHaveLength(1);
		expect(store.getSnapshot().authStatuses).toHaveLength(1);
	});

	test("saving without an api key skips the credential write", async () => {
		vi.mocked(window.agent.saveCustomProvider).mockResolvedValue();
		vi.mocked(window.agent.listModels).mockResolvedValue([]);
		vi.mocked(window.agent.listProviderAuthStatus).mockResolvedValue([]);

		await saveCustomProvider(config);

		expect(window.agent.saveCustomProvider).toHaveBeenCalledTimes(1);
		expect(window.agent.setApiKey).not.toHaveBeenCalled();
	});
});
