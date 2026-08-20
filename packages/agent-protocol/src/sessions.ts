/**
 * Session and runtime state model.
 */

import type { AgentMessage } from "./messages.ts";
import type { ModelInfo } from "./models.ts";

/** A historical user message that can be edited by forking a new session before it. */
export interface EditableUserMessage {
	/** Session entry id of the user message (stable across the same session file). */
	entryId: string;
	/** Plain text of the user message (image blocks are not carried back). */
	text: string;
	/** Timestamp of the embedded message, in milliseconds since Unix epoch. */
	timestamp?: number;
}

/** Result of editing a past user message and resending it in place. */
export type EditAndResendResult = { status: "sent" } | { status: "cancelled" };

/**
 * One-pass projection of a persisted session: messages, state, usage and
 * stable entry ids come out of a single read/parse of the session file.
 */
export interface SessionProjection {
	/** Active-branch messages in context order. */
	messages: AgentMessage[];
	/**
	 * Stable session entry id per message, parallel to `messages`. Only user
	 * messages on the active branch carry one; every other slot is undefined.
	 */
	entryIds: Array<string | undefined>;
	/** File-recorded model, only when resolvable with configured auth. */
	model: ModelInfo | null;
	/** File-recorded thinking level, only when the branch changed it explicitly. */
	thinkingLevel?: string;
	usage: SessionUsage;
	editable: EditableUserMessage[];
}

export interface SessionInfo {
	id: string;
	file?: string;
	/** Working directory recorded in the session header. */
	workspacePath?: string;
	name?: string;
	/** Timestamp when the session was created, in milliseconds since Unix epoch. */
	createdAt?: number;
	/** Timestamp of the latest persisted session activity, in milliseconds since Unix epoch. */
	updatedAt?: number;
	messageCount?: number;
	/** Short human-readable summary, normally derived from the first user message. */
	preview?: string;
}

export interface AgentState {
	/** Currently active model, or null when the backend has no model. */
	model: ModelInfo | null;
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled?: boolean;
	messageCount: number;
	pendingMessageCount?: number;
}

/** Cumulative token usage for the active session. */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Current model context-window consumption. */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Usage information reported by the backend for the active session. */
export interface SessionUsage {
	sessionId: string;
	tokens: TokenUsage;
	cost: number;
	contextUsage?: ContextUsage;
}
