import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-protocol";
import { describe, expect, test } from "vitest";
import { AgentStore, type AppState, initialState, reducer, sessionIndicator } from "../src/renderer/state/store.ts";

function makeState(overrides: Partial<AppState> = {}): AppState {
	return { ...initialState, ...overrides };
}

function routed(workspaceId: string, sessionId: string, event: AgentEvent) {
	return { type: "routed-event" as const, workspaceId, sessionId, event };
}

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const WORKSPACE = "C:\\work";

function snapshotAction(sessionId: string, messages: AgentMessage[] = []) {
	return {
		type: "session-snapshot" as const,
		workspaceId: WORKSPACE,
		state: {
			model: null,
			isStreaming: false,
			isCompacting: false,
			sessionId,
			messageCount: messages.length,
		},
		messages,
		usage: null,
		thinkingLevels: ["off", "medium", "high"],
	};
}

describe("store reducer (per-session)", () => {
	test("an event with sessionId=A only mutates A's state", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "user", content: "Hello A" },
			}),
		);
		expect(state.sessionStateById[SESSION_A].messages).toHaveLength(1);
		expect(state.sessionStateById[SESSION_B].messages).toHaveLength(0);
	});

	test("both sessions can be streaming at the same time", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(state, routed(WORKSPACE, SESSION_A, { type: "agent_started" }));
		state = reducer(state, routed(WORKSPACE, SESSION_B, { type: "agent_started" }));
		expect(state.sessionStateById[SESSION_A].agentState?.isStreaming).toBe(true);
		expect(state.sessionStateById[SESSION_B].agentState?.isStreaming).toBe(true);
		// Stopping A leaves B streaming.
		state = reducer(state, routed(WORKSPACE, SESSION_A, { type: "agent_stopped" }));
		expect(state.sessionStateById[SESSION_A].agentState?.isStreaming).toBe(false);
		expect(state.sessionStateById[SESSION_B].agentState?.isStreaming).toBe(true);
	});

	test("activeSessionId switching does not affect the background session", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(state, { type: "active-session", sessionId: SESSION_A });
		state = reducer(state, routed(WORKSPACE, SESSION_A, { type: "agent_started" }));
		// Switch focus to B while A runs: A keeps its state.
		state = reducer(state, { type: "active-session", sessionId: SESSION_B });
		state = reducer(state, routed(WORKSPACE, SESSION_A, { type: "agent_stopped" }));
		expect(state.activeSessionId).toBe(SESSION_B);
		expect(state.sessionStateById[SESSION_A].agentState?.isStreaming).toBe(false);
	});

	test("a background session's interaction sets needs-attention without touching the viewed session", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(state, { type: "active-session", sessionId: SESSION_B });
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "interaction_requested",
				request: { id: "i1", kind: "confirm", title: "Approve?" },
			}),
		);
		expect(state.sessionStateById[SESSION_A].interactions).toHaveLength(1);
		expect(state.sessionStateById[SESSION_B].interactions).toHaveLength(0);
		expect(sessionIndicator(state.sessionStateById[SESSION_A])).toBe("needs-attention");
		expect(sessionIndicator(state.sessionStateById[SESSION_B])).toBeNull();
	});

	test("sidebar indicator: running wins over needs-attention", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "interaction_requested",
				request: { id: "i1", kind: "input" },
			}),
		);
		state = reducer(state, routed(WORKSPACE, SESSION_A, { type: "agent_started" }));
		expect(sessionIndicator(state.sessionStateById[SESSION_A])).toBe("running");
	});

	test("message_started appends user and assistant messages in the routed session", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "user", content: "Hello" },
			}),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "assistant", content: [], model: "m1" },
			}),
		);
		const messages = state.sessionStateById[SESSION_A].messages;
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "user", complete: true });
		expect(messages[1]).toMatchObject({ role: "assistant", complete: false, model: "m1" });
	});

	test("deduplicates image message start/end events without hiding a repeated prompt", () => {
		const content = [
			{ type: "text" as const, text: "Compare" },
			{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
		];
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "user", content, timestamp: 1 },
			}),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_completed",
				message: { role: "user", content, timestamp: 1 },
			}),
		);
		expect(state.sessionStateById[SESSION_A].messages).toHaveLength(1);
		expect(state.sessionStateById[SESSION_A].messages[0].blocks).toEqual(content);

		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "user", content, timestamp: 2 },
			}),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_completed",
				message: { role: "user", content, timestamp: 2 },
			}),
		);
		expect(state.sessionStateById[SESSION_A].messages).toHaveLength(2);
	});

	test("streams text deltas into the assistant message", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "assistant", content: [] },
			}),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, { type: "message_delta", contentIndex: 0, kind: "text", delta: "Hello" }),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, { type: "message_delta", contentIndex: 0, kind: "text", delta: " world" }),
		);
		expect(state.sessionStateById[SESSION_A].messages[0].blocks).toEqual([{ type: "text", text: "Hello world" }]);
	});

	test("streams toolcall placeholders and finalizes with the authoritative message", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_started",
				message: { role: "assistant", content: [] },
			}),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_delta",
				contentIndex: 1,
				kind: "toolcall",
				delta: '{"co',
			}),
		);
		const placeholder = state.sessionStateById[SESSION_A].messages[0].blocks[1];
		expect(placeholder.type).toBe("toolCall");
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "message_completed",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { command: "x" } }],
				},
			}),
		);
		expect(state.sessionStateById[SESSION_A].messages[0].blocks[0]).toMatchObject({
			type: "toolCall",
			id: "tc1",
		});
	});

	test("error events land in the owning session only", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, { type: "error", message: "provider exploded", source: "provider" }),
		);
		expect(state.sessionStateById[SESSION_A].error).toBe("provider exploded");
		expect(state.sessionStateById[SESSION_B].error).toBeNull();
	});

	test("notification interactions become app-level toasts", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "interaction_requested",
				request: { id: "n1", kind: "notification", message: "Done", notifyType: "info" },
			}),
		);
		expect(state.notifications).toHaveLength(1);
		expect(state.sessionStateById[SESSION_A].interactions).toHaveLength(0);
	});

	test("session-snapshot replaces history and resets interactions", () => {
		let state = makeState();
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "interaction_requested",
				request: { id: "i1", kind: "input" },
			}),
		);
		state = reducer(state, snapshotAction(SESSION_A, [{ role: "user", content: "hi" }]));
		expect(state.sessionStateById[SESSION_A].interactions).toHaveLength(0);
		expect(state.sessionStateById[SESSION_A].messages).toHaveLength(1);
		expect(state.sessionStateById[SESSION_A].loaded).toBe(true);
	});

	test("message-delta-batch applies only to its session", () => {
		let state = makeState();
		state = reducer(state, snapshotAction(SESSION_A));
		state = reducer(state, snapshotAction(SESSION_B));
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, { type: "message_started", message: { role: "assistant", content: [] } }),
		);
		state = reducer(state, {
			type: "message-delta-batch",
			workspaceId: WORKSPACE,
			sessionId: SESSION_B,
			deltas: [{ type: "message_delta", contentIndex: 0, kind: "text", delta: "wrong" }],
		});
		// The wrong-session batch must not create blocks in A's message.
		expect(state.sessionStateById[SESSION_A].messages[0].blocks).toHaveLength(0);
		state = reducer(state, {
			type: "message-delta-batch",
			workspaceId: WORKSPACE,
			sessionId: SESSION_A,
			deltas: [{ type: "message_delta", contentIndex: 0, kind: "text", delta: "ok" }],
		});
		expect(state.sessionStateById[SESSION_A].messages[0].blocks[0]).toMatchObject({ type: "text", text: "ok" });
	});

	test("the live session list replaces wholesale and clears when the workspace goes away", () => {
		let state = makeState();
		state = reducer(state, {
			type: "sessions",
			sessions: [{ id: SESSION_A, workspacePath: WORKSPACE }],
		});
		expect(state.sessions).toHaveLength(1);
		state = reducer(state, {
			type: "sessions",
			sessions: [{ id: SESSION_B, workspacePath: WORKSPACE }],
		});
		expect(state.sessions.map((session) => session.id)).toEqual([SESSION_B]);
		state = reducer(state, { type: "status", status: { phase: "no-workspace", workspace: null } });
		expect(state.sessions).toEqual([]);
		// A starting/running workspace keeps the current list until refreshAll replaces it.
		state = reducer(state, {
			type: "sessions",
			sessions: [{ id: SESSION_A, workspacePath: WORKSPACE }],
		});
		state = reducer(state, { type: "status", status: { phase: "starting", workspace: WORKSPACE } });
		expect(state.sessions).toHaveLength(1);
	});
});

describe("AgentStore", () => {
	test("dispatches updates and notifies subscribers", () => {
		const store = new AgentStore();
		let notified = 0;
		const unsubscribe = store.subscribe(() => {
			notified += 1;
		});
		store.dispatch({ type: "active-session", sessionId: SESSION_A });
		expect(store.getSnapshot().activeSessionId).toBe(SESSION_A);
		expect(notified).toBe(1);
		unsubscribe();
	});
});
