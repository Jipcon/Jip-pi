import type { AgentEvent } from "@earendil-works/pi-agent-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentEventForwarder, TOOL_UPDATE_INTERVAL_MS } from "../src/main/agent-event-forwarder.ts";
import type { RoutedAgentEvent } from "../src/shared/ipc.ts";

function routedEvent(
	type: "tool_started" | "tool_updated" | "tool_completed",
	id: string,
	sessionId = "session-1",
	partialResult?: string,
): RoutedAgentEvent {
	return {
		workspaceId: "C:\\work",
		sessionId,
		event: {
			type,
			tool: {
				id,
				name: "bash",
				args: { command: "echo hi" },
				status: type === "tool_started" || type === "tool_updated" ? "running" : "completed",
				...(partialResult !== undefined ? { partialResult } : {}),
			},
		} as AgentEvent,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("agent event forwarder", () => {
	test("coalesces tool_updated events latest-wins per tool id", () => {
		vi.useFakeTimers();
		const sent: RoutedAgentEvent[] = [];
		const forwarder = createAgentEventForwarder((event) => sent.push(event));

		forwarder.forward(routedEvent("tool_started", "t1"));
		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "a"));
		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "ab"));
		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "abc"));
		expect(sent).toHaveLength(1);
		expect(sent[0].event.type).toBe("tool_started");

		vi.advanceTimersByTime(TOOL_UPDATE_INTERVAL_MS);
		expect(sent).toHaveLength(2);
		expect(sent[1].event).toMatchObject({ type: "tool_updated", tool: { id: "t1", partialResult: "abc" } });
	});

	test("coalescing is per session: the same tool id in two sessions stays independent", () => {
		vi.useFakeTimers();
		const sent: RoutedAgentEvent[] = [];
		const forwarder = createAgentEventForwarder((event) => sent.push(event));

		forwarder.forward(routedEvent("tool_updated", "t1", "session-a", "a1"));
		forwarder.forward(routedEvent("tool_updated", "t1", "session-b", "b1"));
		vi.advanceTimersByTime(TOOL_UPDATE_INTERVAL_MS);
		expect(sent).toHaveLength(2);
		expect(sent.map((entry) => entry.sessionId).sort()).toEqual(["session-a", "session-b"]);
	});

	test("tool_started arrives immediately and flushes other pending updates", () => {
		vi.useFakeTimers();
		const sent: RoutedAgentEvent[] = [];
		const forwarder = createAgentEventForwarder((event) => sent.push(event));

		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "partial"));
		forwarder.forward(routedEvent("tool_started", "t2"));
		expect(sent).toHaveLength(2);
		expect(sent[0].event).toMatchObject({ type: "tool_updated", tool: { id: "t1", partialResult: "partial" } });
		expect(sent[1].event).toMatchObject({ type: "tool_started", tool: { id: "t2" } });
	});

	test("tool_completed arrives immediately and supersedes pending updates", () => {
		vi.useFakeTimers();
		const sent: RoutedAgentEvent[] = [];
		const forwarder = createAgentEventForwarder((event) => sent.push(event));

		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "stale"));
		forwarder.forward(routedEvent("tool_completed", "t1"));
		expect(sent).toHaveLength(1);
		expect(sent[0].event).toMatchObject({ type: "tool_completed", tool: { id: "t1" } });
		vi.advanceTimersByTime(TOOL_UPDATE_INTERVAL_MS);
		expect(sent).toHaveLength(1);
	});

	test("interaction and lifecycle events flush immediately", () => {
		vi.useFakeTimers();
		const sent: RoutedAgentEvent[] = [];
		const forwarder = createAgentEventForwarder((event) => sent.push(event));

		forwarder.forward(routedEvent("tool_updated", "t1", "session-1", "pending"));
		forwarder.forward({
			workspaceId: "C:\\work",
			sessionId: "session-1",
			event: {
				type: "interaction_requested",
				request: { id: "i1", kind: "confirm", title: "Approve?" },
			},
		});
		expect(sent.map((entry) => entry.event.type)).toEqual(["tool_updated", "interaction_requested"]);
	});
});
