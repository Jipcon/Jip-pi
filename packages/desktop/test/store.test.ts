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

function snapshotAction(sessionId: string, messages: AgentMessage[] = [], entryIds?: Array<string | undefined>) {
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
		...(entryIds !== undefined ? { entryIds } : {}),
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

describe("editable user message entry ids", () => {
	test("session-snapshot assigns structurally paired entry ids", () => {
		let state = makeState();
		state = reducer(
			state,
			snapshotAction(
				SESSION_A,
				[
					{ role: "user", content: "first", timestamp: 100 },
					{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 150 },
					{ role: "user", content: "second", timestamp: 200 },
				],
				["e1", undefined, "e2"],
			),
		);
		const messages = state.sessionStateById[SESSION_A].messages;
		expect(messages[0]).toMatchObject({ role: "user", entryId: "e1" });
		expect(messages[1]).toMatchObject({ role: "assistant" });
		expect(messages[1].entryId).toBeUndefined();
		expect(messages[2]).toMatchObject({ role: "user", entryId: "e2" });
	});

	test("user messages with identical timestamps keep their own entry ids", () => {
		let state = makeState();
		state = reducer(
			state,
			snapshotAction(
				SESSION_A,
				[
					{ role: "user", content: "a", timestamp: 500 },
					{ role: "user", content: "b", timestamp: 500 },
					{ role: "user", content: "c", timestamp: 500 },
				],
				["e-1", "e-2", "e-3"],
			),
		);
		const messages = state.sessionStateById[SESSION_A].messages;
		expect(messages.map((message) => message.entryId)).toEqual(["e-1", "e-2", "e-3"]);
	});

	test("editable_messages_added assigns only the new ids and never touches other state", () => {
		let state = makeState();
		state = reducer(
			state,
			snapshotAction(SESSION_A, [
				{ role: "user", content: "hello", timestamp: 10 },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 20 },
			]),
		);
		expect(state.sessionStateById[SESSION_A].messages[0].entryId).toBeUndefined();

		state = reducer(
			state,
			routed(WORKSPACE, SESSION_A, {
				type: "editable_messages_added",
				entries: [{ entryId: "e1", text: "hello", timestamp: 10 }],
			}),
		);
		expect(state.sessionStateById[SESSION_A].messages[0].entryId).toBe("e1");

		// A second delta only fills messages that still lack an id.
		state = reducer(
			state,
			snapshotAction(SESSION_B, [
				{ role: "user", content: "old", timestamp: 1 },
				{ role: "user", content: "new", timestamp: 2 },
			]),
		);
		state = reducer(
			state,
			routed(WORKSPACE, SESSION_B, {
				type: "editable_messages_added",
				entries: [{ entryId: "b2", text: "new", timestamp: 2 }],
			}),
		);
		// One entry, two unassigned messages: chronological order assigns it
		// to the first one still missing an id.
		expect(state.sessionStateById[SESSION_B].messages.map((message) => message.entryId)).toEqual(["b2", undefined]);

		// Unknown sessions are a no-op.
		const unchanged = reducer(
			state,
			routed(WORKSPACE, "missing", {
				type: "editable_messages_added",
				entries: [{ entryId: "x", text: "x" }],
			}),
		);
		expect(unchanged).toBe(state);
	});
});

describe("inline message editing", () => {
	function editingState() {
		let state = makeState();
		state = reducer(
			state,
			snapshotAction(
				SESSION_A,
				[
					{ role: "user", content: "first", timestamp: 100 },
					{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 150 },
					{ role: "user", content: "second", timestamp: 200 },
					{ role: "assistant", content: [{ type: "text", text: "another" }], timestamp: 250 },
				],
				["e1", undefined, "e2", undefined],
			),
		);
		return state;
	}

	test("start and cancel manage the editor without touching messages", () => {
		let state = editingState();
		const before = state.sessionStateById[SESSION_A];

		state = reducer(state, {
			type: "session-edit-start",
			sessionId: SESSION_A,
			entryId: "e2",
			text: "second",
		});
		expect(state.sessionStateById[SESSION_A].editing).toEqual({ entryId: "e2", text: "second" });
		expect(state.sessionStateById[SESSION_A].messages).toBe(before.messages);

		state = reducer(state, { type: "session-edit-cancel", sessionId: SESSION_A });
		expect(state.sessionStateById[SESSION_A].editing).toBeNull();
		expect(state.sessionStateById[SESSION_A].messages).toBe(before.messages);
	});

	test("commit truncates from the edited message and prunes removed tool records", () => {
		let state = makeState();
		state = reducer(
			state,
			snapshotAction(
				SESSION_A,
				[
					{ role: "user", content: "first", timestamp: 100 },
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "call-2", name: "bash", arguments: {} },
							{ type: "text", text: "removed answer" },
						],
						timestamp: 150,
					},
					{ role: "tool", toolCallId: "call-2", toolName: "bash", content: "kept output", timestamp: 160 },
					{ role: "user", content: "second", timestamp: 200 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call-4", name: "read", arguments: {} }],
						timestamp: 250,
					},
					{ role: "tool", toolCallId: "call-4", toolName: "read", content: "file body", timestamp: 260 },
				],
				["e1", undefined, undefined, "e2", undefined, undefined],
			),
		);

		state = reducer(state, {
			type: "session-edit-start",
			sessionId: SESSION_A,
			entryId: "e2",
			text: "second",
		});
		state = reducer(state, { type: "session-edit-commit", sessionId: SESSION_A, entryId: "e2" });

		const session = state.sessionStateById[SESSION_A];
		expect(session.editing).toBeNull();
		// The edited message and everything after it leave the view, together
		// with the tool records of removed turns.
		expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(session.messages[0].entryId).toBe("e1");
		expect(session.messages[1].blocks.some((block) => block.type === "toolCall" && block.id === "call-2")).toBe(true);
		expect(session.tools["call-2"]).toBeDefined();
		expect(session.tools["call-4"]).toBeUndefined();
	});

	test("commit with an unknown entry id or without an editor is a no-op", () => {
		let state = editingState();
		const unchanged = reducer(state, { type: "session-edit-commit", sessionId: SESSION_A, entryId: "missing" });
		expect(unchanged).toBe(state);

		state = reducer(state, { type: "session-edit-commit", sessionId: SESSION_B, entryId: "e2" });
		expect(state).toBe(unchanged);
	});

	test("a fresh snapshot closes any open editor", () => {
		let state = editingState();
		state = reducer(state, {
			type: "session-edit-start",
			sessionId: SESSION_A,
			entryId: "e2",
			text: "second",
		});
		state = reducer(state, snapshotAction(SESSION_A, [{ role: "user", content: "fresh" }]));
		expect(state.sessionStateById[SESSION_A].editing).toBeNull();
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
