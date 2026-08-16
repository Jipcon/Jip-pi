/**
 * Agent event stream model.
 *
 * The union is open: unknown behaviors from a concrete agent runtime are
 * delivered as `custom` events so the GUI never crashes on new event types.
 */

import type { AgentMessage } from "./messages.ts";
import type { AgentState } from "./sessions.ts";
import type { ToolCallInfo } from "./tools.ts";

export interface AgentStartedEvent {
	type: "agent_started";
}

export interface AgentStoppedEvent {
	type: "agent_stopped";
	/** True when the agent run will be automatically retried. */
	willRetry?: boolean;
}

export interface TurnStartedEvent {
	type: "turn_started";
}

export interface TurnCompletedEvent {
	type: "turn_completed";
}

export interface MessageStartedEvent {
	type: "message_started";
	message: AgentMessage;
}

export type MessageDeltaKind = "text" | "thinking" | "toolcall";

export interface MessageDeltaEvent {
	type: "message_delta";
	/** Content block index this delta belongs to (0-based). */
	contentIndex: number;
	kind: MessageDeltaKind;
	delta?: string;
}

export interface MessageCompletedEvent {
	type: "message_completed";
	message: AgentMessage;
}

export interface ToolStartedEvent {
	type: "tool_started";
	tool: ToolCallInfo;
}

export interface ToolUpdatedEvent {
	type: "tool_updated";
	tool: ToolCallInfo;
}

export interface ToolCompletedEvent {
	type: "tool_completed";
	tool: ToolCallInfo;
}

export interface StateChangedEvent {
	type: "state_changed";
	state: AgentState;
}

export interface ErrorEvent {
	type: "error";
	message: string;
	source?: string;
}

/** An automatic retry of a failed agent run has been scheduled. */
export interface AutoRetryStartedEvent {
	type: "auto_retry_started";
	/** 1-based attempt that is about to run. */
	attempt: number;
	maxAttempts: number;
	/** Wait before the retry starts, in milliseconds. */
	delayMs: number;
	/** Redacted reason of the failure that triggered the retry. */
	errorMessage: string;
}

/** An automatic retry cycle finished (successfully or not). */
export interface AutoRetryEndedEvent {
	type: "auto_retry_ended";
	/** True when one of the attempts finally succeeded. */
	success: boolean;
	/** Total attempts that ran (1 = initial request, +1 per retry). */
	attempt: number;
	/** Redacted final failure, present when `success` is false. */
	finalError?: string;
}

/** Extension point: unknown backend behavior flows through here. */
export interface CustomEvent {
	type: "custom";
	namespace: string;
	name: string;
	payload: unknown;
}

/**
 * A user interaction request, normalized from a backend's extension UI
 * protocol (select / confirm / input / editor dialogs, notifications).
 */
export type InteractionKind = "select" | "confirm" | "input" | "editor" | "notification";

export interface UserInteractionRequest {
	id: string;
	kind: InteractionKind;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	payload?: unknown;
}

export interface InteractionRequestedEvent {
	type: "interaction_requested";
	request: UserInteractionRequest;
}

export type AgentEvent =
	| AgentStartedEvent
	| AgentStoppedEvent
	| TurnStartedEvent
	| TurnCompletedEvent
	| MessageStartedEvent
	| MessageDeltaEvent
	| MessageCompletedEvent
	| ToolStartedEvent
	| ToolUpdatedEvent
	| ToolCompletedEvent
	| StateChangedEvent
	| ErrorEvent
	| AutoRetryStartedEvent
	| AutoRetryEndedEvent
	| InteractionRequestedEvent
	| CustomEvent;
