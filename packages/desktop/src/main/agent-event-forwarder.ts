/**
 * Agent event forwarding with tool_updated throttling.
 *
 * Pi can emit tool_execution_update events very frequently while a tool is
 * producing lots of output, each carrying the cumulative partialResult. To
 * keep the renderer interactive, tool_updated events are coalesced
 * latest-wins per tool id and flushed at a bounded rate. Lifecycle and
 * interaction events (tool_started, tool_completed, message_completed,
 * error, interaction_requested, agent_started/stopped) are never delayed.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-protocol";
import type { RoutedAgentEvent } from "../shared/ipc.ts";

/** How often buffered tool_updated events are flushed to the renderer. */
export const TOOL_UPDATE_INTERVAL_MS = 40;

export interface AgentEventForwarder {
	forward: (event: RoutedAgentEvent) => void;
	dispose: () => void;
}

export function createAgentEventForwarder(send: (event: RoutedAgentEvent) => void): AgentEventForwarder {
	const pendingToolUpdates = new Map<string, RoutedAgentEvent>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	function toolId(event: RoutedAgentEvent): string {
		return `${event.sessionId}\u0000${(event.event as Extract<AgentEvent, { type: "tool_updated" | "tool_completed" }>).tool.id}`;
	}

	function flushPendingToolUpdates(): void {
		flushTimer = null;
		if (pendingToolUpdates.size === 0) {
			return;
		}
		const events = [...pendingToolUpdates.values()];
		pendingToolUpdates.clear();
		for (const event of events) {
			send(event);
		}
	}

	return {
		forward(event: RoutedAgentEvent): void {
			if (event.event.type === "tool_updated") {
				pendingToolUpdates.set(toolId(event), event);
				if (flushTimer === null) {
					flushTimer = setTimeout(flushPendingToolUpdates, TOOL_UPDATE_INTERVAL_MS);
				}
				return;
			}
			if (event.event.type === "tool_completed") {
				// Final tool state is authoritative: drop any unsent stale update
				// for the same tool so it cannot regress the completed result.
				pendingToolUpdates.delete(toolId(event));
			}
			if (
				event.event.type === "tool_started" ||
				event.event.type === "tool_completed" ||
				event.event.type === "message_completed" ||
				event.event.type === "agent_started" ||
				event.event.type === "agent_stopped" ||
				event.event.type === "error" ||
				event.event.type === "interaction_requested"
			) {
				// Critical events must not wait behind buffered updates.
				flushPendingToolUpdates();
			}
			send(event);
		},
		dispose(): void {
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			pendingToolUpdates.clear();
		},
	};
}
