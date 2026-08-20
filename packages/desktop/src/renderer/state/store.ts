/**
 * Renderer state store (per-session).
 *
 * The reducer is pure and testable. Every routed AgentEvent updates ONLY the
 * session state it carries (`sessionStateById[sessionId]`); the UI-focused
 * session (`activeSessionId`) is never used to guess an event's owner.
 * Streaming assistant messages are assembled locally from message_started /
 * message_delta / message_completed events; the completed message from the
 * backend is treated as authoritative.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AssistantMessageDiagnostic,
	AuthFlowEvent,
	AuthFlowPrompt,
	AuthFlowUpdate,
	EditableUserMessage,
	MessageBlock,
	MessageDeltaEvent,
	ModelInfo,
	ProviderAuthStatus,
	SessionInfo,
	SessionUsage,
	ToolCallInfo,
	UserInteractionRequest,
} from "@earendil-works/pi-agent-protocol";
import type { BackendStatus } from "../../shared/ipc.ts";

export interface UiMessage {
	id: string;
	role: "user" | "assistant";
	blocks: MessageBlock[];
	model?: string;
	provider?: string;
	api?: string;
	stopReason?: string;
	errorMessage?: string;
	diagnostics?: AssistantMessageDiagnostic[];
	timestamp?: number;
	complete: boolean;
	/** Session entry id, aligned from `listEditableUserMessages`. */
	entryId?: string;
}

/** One structured diagnostics entry shown in Settings. */
export interface DiagnosticEntry {
	id: string;
	/** Where the diagnostic came from. */
	source: "backend" | "provider";
	/** Human-readable label, e.g. the provider or "stderr". */
	label: string;
	type?: string;
	message: string;
	timestamp?: number;
}

/** Auto-retry progress visible while the backend waits and retries. */
export interface RetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface NotificationItem {
	id: string;
	message: string;
	type: "info" | "warning" | "error";
}

/**
 * Accumulated OAuth login flow view. The host streams one auth_flow update
 * per step (auth url, device code, prompt, progress); a url/device code must
 * stay visible while a prompt is pending, so the store merges updates instead
 * of keeping only the latest one.
 */
export interface AuthFlowState {
	loginId: string;
	/** Latest authorization url or device code (sticky until the flow ends). */
	display?: Extract<AuthFlowEvent, { type: "auth_url" | "device_code" }>;
	/** Latest info/progress message. */
	message?: string;
	/** Currently pending prompt awaiting a user answer. */
	prompt?: { requestId: string; prompt: AuthFlowPrompt };
}

/** Per-session UI state. One entry per session the renderer knows about. */
export interface SessionUIState {
	sessionId: string;
	workspaceId: string;
	agentState: AgentState | null;
	messages: UiMessage[];
	tools: Record<string, ToolCallInfo>;
	/** Thinking levels available for the session's current model. */
	thinkingLevels: string[];
	/** Pending interaction requests raised by this session's extensions. */
	interactions: UserInteractionRequest[];
	sessionUsage: SessionUsage | null;
	retry: RetryState | null;
	/** openSession completed for this session (history loaded). */
	loaded: boolean;
	error: string | null;
	/** Inline user-message edit in progress: edit target and initial text (the draft stays editor-local). */
	editing: { entryId: string; text: string } | null;
	nextId: number;
}

export type SessionStatusIndicator = "running" | "needs-attention";

export interface AppState {
	status: BackendStatus;
	activeSessionId: string | null;
	sessionStateById: Record<string, SessionUIState>;
	// Host-level state (available with zero session backends).
	models: ModelInfo[];
	authStatuses: ProviderAuthStatus[];
	authFlow: AuthFlowState | null;
	notifications: NotificationItem[];
	logs: string[];
	diagnostics: DiagnosticEntry[];
	sessions: SessionInfo[];
	sessionCatalog: SessionInfo[];
	workspaces: string[];
	sessionCatalogStatus: "loading" | "ready";
	error: string | null;
	nextId: number;
}

export const initialState: AppState = {
	status: { phase: "no-workspace", workspace: null },
	activeSessionId: null,
	sessionStateById: {},
	models: [],
	authStatuses: [],
	authFlow: null,
	notifications: [],
	logs: [],
	diagnostics: [],
	sessions: [],
	sessionCatalog: [],
	workspaces: [],
	sessionCatalogStatus: "loading",
	error: null,
	nextId: 1,
};

export type StoreAction =
	| { type: "status"; status: BackendStatus }
	| { type: "routed-event"; workspaceId: string; sessionId: string; event: AgentEvent }
	| { type: "host-event"; event: AgentEvent }
	| { type: "models"; models: ModelInfo[] }
	| { type: "auth-status"; statuses: ProviderAuthStatus[] }
	| { type: "auth-flow"; flow: AuthFlowState | null }
	| {
			type: "session-snapshot";
			workspaceId: string;
			state: AgentState;
			messages: AgentMessage[];
			usage: SessionUsage | null;
			thinkingLevels: string[];
			/** Stable entry ids parallel to `messages` (structural pairing). */
			entryIds?: Array<string | undefined>;
	  }
	| {
			type: "session-state-update";
			workspaceId: string;
			state: AgentState;
			usage: SessionUsage | null;
			thinkingLevels?: string[];
	  }
	| { type: "session-open-failed"; sessionId: string; error: string }
	| { type: "active-session"; sessionId: string | null }
	| { type: "sessions"; sessions: SessionInfo[] }
	| { type: "session-catalog"; sessions: SessionInfo[] }
	| { type: "workspaces"; workspaces: string[] }
	| { type: "session-catalog-failed" }
	| { type: "notify"; notification: Omit<NotificationItem, "id"> }
	| { type: "session-edit-start"; sessionId: string; entryId: string; text: string }
	| { type: "session-edit-cancel"; sessionId: string }
	| { type: "session-edit-commit"; sessionId: string; entryId: string }
	| { type: "clear-error" }
	| { type: "dismiss-notification"; id: string }
	| { type: "dismiss-interaction"; sessionId: string; id: string }
	| { type: "message-delta-batch"; workspaceId: string; sessionId: string; deltas: MessageDeltaEvent[] };

const MAX_LOGS = 500;
const MAX_DIAGNOSTICS = 200;

function pushLimited<T>(list: T[], item: T, max: number): T[] {
	const next = [...list, item];
	return next.length > max ? next.slice(next.length - max) : next;
}

/** Monotonic id source for diagnostics entries. */
let diagnosticSequence = 0;

function emptySessionState(workspaceId: string, sessionId: string): SessionUIState {
	return {
		sessionId,
		workspaceId,
		agentState: null,
		messages: [],
		tools: {},
		thinkingLevels: [],
		interactions: [],
		sessionUsage: null,
		retry: null,
		loaded: false,
		error: null,
		editing: null,
		nextId: 1,
	};
}

/** Collect redacted provider diagnostics from a completed assistant message. */
function diagnosticsFromMessage(state: AppState, message: AgentMessage): DiagnosticEntry[] {
	if (message.role !== "assistant" || !message.diagnostics || message.diagnostics.length === 0) {
		return state.diagnostics;
	}
	const entries: DiagnosticEntry[] = message.diagnostics.map((diagnostic) => {
		diagnosticSequence += 1;
		const entry: DiagnosticEntry = {
			id: `d-${diagnosticSequence}`,
			source: "provider",
			label: message.provider ?? "provider",
			type: diagnostic.type,
			message: diagnostic.error?.message ?? diagnostic.type,
		};
		if (diagnostic.timestamp !== undefined) entry.timestamp = diagnostic.timestamp;
		return entry;
	});
	const next = [...state.diagnostics, ...entries];
	return next.length > MAX_DIAGNOSTICS ? next.slice(next.length - MAX_DIAGNOSTICS) : next;
}

function normalizeUserMessage(message: AgentMessage, entryId?: string): UiMessage {
	return {
		id: `user-${Math.random().toString(36).slice(2, 10)}`,
		role: "user",
		blocks: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
		timestamp: message.timestamp,
		complete: true,
		...(entryId !== undefined ? { entryId } : {}),
	};
}

function normalizeAssistantMessage(message: AgentMessage, id: string, complete: boolean): UiMessage {
	return {
		id,
		role: "assistant",
		blocks: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
		model: message.role === "assistant" ? message.model : undefined,
		provider: message.role === "assistant" ? message.provider : undefined,
		api: message.role === "assistant" ? message.api : undefined,
		stopReason: message.role === "assistant" ? message.stopReason : undefined,
		errorMessage: message.role === "assistant" ? message.errorMessage : undefined,
		diagnostics: message.role === "assistant" ? message.diagnostics : undefined,
		timestamp: message.timestamp,
		complete,
	};
}

/**
 * Assign newly editable entry ids onto rendered user messages that do not
 * have one yet. Both lists are chronological, so positional assignment is
 * deterministic — no timestamp matching is involved.
 */
function applyEditableDelta(messages: UiMessage[], entries: readonly EditableUserMessage[]): UiMessage[] {
	if (entries.length === 0) {
		return messages;
	}
	let nextEntry = 0;
	let changed = false;
	const result = messages.map((message) => {
		if (message.role !== "user" || message.entryId !== undefined || nextEntry >= entries.length) {
			return message;
		}
		changed = true;
		return { ...message, entryId: entries[nextEntry++].entryId };
	});
	return changed ? result : messages;
}

function normalizeHistoricalTools(messages: AgentMessage[]): Record<string, ToolCallInfo> {
	const argumentsById = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") {
				argumentsById.set(block.id, block.arguments);
			}
		}
	}

	const tools: Record<string, ToolCallInfo> = {};
	for (const message of messages) {
		if (message.role !== "tool") continue;
		const result =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("");
		tools[message.toolCallId] = {
			id: message.toolCallId,
			name: message.toolName,
			args: argumentsById.get(message.toolCallId) ?? {},
			status: message.isError ? "error" : "completed",
			result,
			isError: message.isError,
			completedAt: message.timestamp,
		};
	}
	return tools;
}

function findStreamingMessageIndex(session: SessionUIState): number {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message.role === "assistant" && !message.complete) {
			return index;
		}
	}
	return -1;
}

function appendDelta(block: MessageBlock, delta: string): MessageBlock {
	if (block.type === "text") {
		return { ...block, text: block.text + delta };
	}
	if (block.type === "thinking") {
		return { ...block, thinking: block.thinking + delta };
	}
	return block;
}

export function reducer(state: AppState, action: StoreAction): AppState {
	switch (action.type) {
		case "status": {
			const next: AppState = { ...state, status: action.status };
			if (action.status.phase === "error" && action.status.error) {
				next.error = action.status.error;
			}
			if (action.status.phase === "running" && !action.status.error) {
				next.error = null;
			}
			// No live backend can exist without a workspace: drop stale live entries.
			if (action.status.workspace === null) {
				next.sessions = [];
			}
			return next;
		}

		case "models":
			return { ...state, models: action.models };

		case "auth-status":
			return { ...state, authStatuses: action.statuses };

		case "auth-flow":
			return { ...state, authFlow: action.flow };

		case "session-snapshot": {
			const session =
				state.sessionStateById[action.state.sessionId] ??
				emptySessionState(action.workspaceId, action.state.sessionId);
			// Entry ids arrive structurally paired with the snapshot messages
			// (one projection pass on the backend), so the association is
			// exact and survives identical timestamps.
			const messages: UiMessage[] = [];
			action.messages.forEach((message, index) => {
				if (message.role === "user") {
					messages.push(normalizeUserMessage(message, action.entryIds?.[index]));
				} else if (message.role === "assistant") {
					messages.push(normalizeAssistantMessage(message, `m-${session.nextId + index}`, true));
				}
			});
			let diagnostics = state.diagnostics;
			for (const message of action.messages) {
				diagnostics = diagnosticsFromMessage({ ...state, diagnostics }, message);
			}
			return {
				...state,
				diagnostics,
				sessionStateById: {
					...state.sessionStateById,
					[action.state.sessionId]: {
						...session,
						agentState: action.state,
						messages,
						tools: normalizeHistoricalTools(action.messages),
						thinkingLevels: action.thinkingLevels,
						interactions: [],
						sessionUsage: action.usage,
						retry: null,
						loaded: true,
						error: null,
						editing: null,
						nextId: session.nextId + Math.max(messages.length, 1),
					},
				},
			};
		}

		case "session-state-update": {
			const session =
				state.sessionStateById[action.state.sessionId] ??
				emptySessionState(action.workspaceId, action.state.sessionId);
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.state.sessionId]: {
						...session,
						agentState: action.state,
						sessionUsage: action.usage,
						...(action.thinkingLevels !== undefined ? { thinkingLevels: action.thinkingLevels } : {}),
					},
				},
			};
		}

		case "session-open-failed": {
			const session = state.sessionStateById[action.sessionId] ?? emptySessionState("", action.sessionId);
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: { ...session, error: action.error },
				},
			};
		}

		case "active-session":
			return { ...state, activeSessionId: action.sessionId };

		case "sessions":
			return { ...state, sessions: action.sessions };

		case "session-catalog":
			return { ...state, sessionCatalog: action.sessions, sessionCatalogStatus: "ready" };

		case "workspaces":
			return { ...state, workspaces: action.workspaces };

		case "session-catalog-failed":
			return { ...state, sessionCatalogStatus: "ready" };

		case "session-edit-start": {
			const session = state.sessionStateById[action.sessionId];
			if (!session) {
				return state;
			}
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: { ...session, editing: { entryId: action.entryId, text: action.text } },
				},
			};
		}

		case "session-edit-cancel": {
			const session = state.sessionStateById[action.sessionId];
			if (!session?.editing) {
				return state;
			}
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: { ...session, editing: null },
				},
			};
		}

		case "session-edit-commit": {
			const session = state.sessionStateById[action.sessionId];
			if (!session?.editing || session.editing.entryId !== action.entryId) {
				return state;
			}
			// Optimistic truncation: the edit branches the session tree before
			// this message, so the edited message and everything after it leave
			// the active context immediately. Tool records of removed turns go
			// with them; the authoritative history arrives via the next snapshot.
			const cutIndex = session.messages.findIndex(
				(message) => message.role === "user" && message.entryId === action.entryId,
			);
			if (cutIndex === -1) {
				return state;
			}
			const removedToolIds = new Set<string>();
			for (const message of session.messages.slice(cutIndex)) {
				if (message.role !== "assistant") continue;
				for (const block of message.blocks) {
					if (block.type === "toolCall") removedToolIds.add(block.id);
				}
			}
			const tools = { ...session.tools };
			for (const id of removedToolIds) {
				delete tools[id];
			}
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: {
						...session,
						messages: session.messages.slice(0, cutIndex),
						tools,
						editing: null,
						retry: null,
						error: null,
					},
				},
			};
		}

		case "notify":
			return {
				...state,
				notifications: [...state.notifications, { id: `n-${state.nextId}`, ...action.notification }],
				nextId: state.nextId + 1,
			};

		case "clear-error":
			return { ...state, error: null };

		case "dismiss-notification":
			return { ...state, notifications: state.notifications.filter((item) => item.id !== action.id) };

		case "dismiss-interaction": {
			const session = state.sessionStateById[action.sessionId];
			if (!session) {
				return state;
			}
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: {
						...session,
						interactions: session.interactions.filter((item) => item.id !== action.id),
					},
				},
			};
		}

		case "message-delta-batch": {
			const session = state.sessionStateById[action.sessionId];
			if (!session || action.deltas.length === 0) {
				return state;
			}
			const targetIndex = findStreamingMessageIndex(session);
			if (targetIndex === -1) {
				return state;
			}
			const target = session.messages[targetIndex];
			// Clone once, mutate the copy in place for the whole frame.
			const blocks = [...target.blocks];
			let changed = false;
			for (const delta of action.deltas) {
				while (blocks.length <= delta.contentIndex) {
					blocks.push({ type: "text", text: "" });
					changed = true;
				}
				const current = blocks[delta.contentIndex];
				if (delta.kind === "text" || delta.kind === "thinking") {
					if (current.type !== delta.kind) {
						blocks[delta.contentIndex] =
							delta.kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
						changed = true;
					}
					if (delta.delta) {
						blocks[delta.contentIndex] = appendDelta(blocks[delta.contentIndex], delta.delta);
						changed = true;
					}
				} else if (current.type !== "toolCall") {
					// Toolcall deltas only maintain the structural placeholder;
					// argument text is not accumulated (message_completed is authoritative).
					blocks[delta.contentIndex] = {
						type: "toolCall",
						id: `pending-${delta.contentIndex}`,
						name: "",
						arguments: {},
					};
					changed = true;
				}
			}
			if (!changed) {
				return state;
			}
			const messages = [...session.messages];
			messages[targetIndex] = { ...target, blocks };
			return {
				...state,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: { ...session, messages },
				},
			};
		}

		case "routed-event": {
			// §13.1: an event with sessionId = A only ever mutates A's state.
			if (action.event.type === "interaction_requested" && action.event.request.kind === "notification") {
				// Notifications are app-level toasts, not session dialogs.
				return {
					...state,
					notifications: pushLimited(
						state.notifications,
						{
							id: `n-${state.nextId}`,
							message: action.event.request.message ?? "",
							type: action.event.request.notifyType ?? "info",
						},
						20,
					),
					nextId: state.nextId + 1,
				};
			}
			if (action.event.type === "editable_messages_added") {
				// Delta only: newly editable entries gain their entry ids without
				// the full history text ever being re-sent or re-scanned.
				const session = state.sessionStateById[action.sessionId];
				if (!session) {
					return state;
				}
				const messages = applyEditableDelta(session.messages, action.event.entries);
				if (messages === session.messages) {
					return state;
				}
				return {
					...state,
					sessionStateById: {
						...state.sessionStateById,
						[action.sessionId]: { ...session, messages },
					},
				};
			}
			const session =
				state.sessionStateById[action.sessionId] ?? emptySessionState(action.workspaceId, action.sessionId);
			let diagnostics = state.diagnostics;
			if (action.event.type === "message_completed" && action.event.message.role === "assistant") {
				diagnostics = diagnosticsFromMessage(state, action.event.message);
			}
			const reduced = reduceSessionEvent(session, action.event);
			if (reduced === session) {
				return state;
			}
			return {
				...state,
				diagnostics,
				sessionStateById: {
					...state.sessionStateById,
					[action.sessionId]: reduced,
				},
			};
		}

		case "host-event":
			return reduceHostEvent(state, action.event);
	}
}

function reduceSessionEvent(session: SessionUIState, event: AgentEvent): SessionUIState {
	switch (event.type) {
		case "agent_started":
			return {
				...session,
				agentState: session.agentState ? { ...session.agentState, isStreaming: true } : session.agentState,
				error: null,
			};

		case "agent_stopped": {
			const messages = session.messages.map((message) =>
				!message.complete ? { ...message, complete: true } : message,
			);
			return {
				...session,
				agentState: session.agentState ? { ...session.agentState, isStreaming: false } : session.agentState,
				messages,
			};
		}

		case "turn_started":
		case "turn_completed":
			return session;

		case "message_started": {
			if (event.message.role === "user") {
				return { ...session, messages: [...session.messages, normalizeUserMessage(event.message)] };
			}
			if (event.message.role === "assistant") {
				const id = `m-${session.nextId}`;
				const message = normalizeAssistantMessage(event.message, id, false);
				return { ...session, nextId: session.nextId + 1, messages: [...session.messages, message] };
			}
			return session;
		}

		case "message_delta": {
			const targetIndex = findStreamingMessageIndex(session);
			if (targetIndex === -1) {
				return session;
			}
			const target = session.messages[targetIndex];
			const { contentIndex, kind, delta } = event;
			const blocks = [...target.blocks];
			let changed = false;
			while (blocks.length <= contentIndex) {
				blocks.push({ type: "text", text: "" });
				changed = true;
			}
			const current = blocks[contentIndex];
			if (kind === "text" || kind === "thinking") {
				if (current.type !== kind) {
					blocks[contentIndex] = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
					changed = true;
				}
				if (delta) {
					blocks[contentIndex] = appendDelta(blocks[contentIndex], delta);
					changed = true;
				}
			} else if (current.type !== "toolCall") {
				// Toolcall deltas only maintain the structural placeholder.
				blocks[contentIndex] = {
					type: "toolCall",
					id: `pending-${contentIndex}`,
					name: "",
					arguments: {},
				};
				changed = true;
			}
			if (!changed) {
				// Repeated toolcall deltas and empty text deltas are no-ops.
				return session;
			}
			const messages = [...session.messages];
			messages[targetIndex] = { ...target, blocks };
			return { ...session, messages };
		}

		case "message_completed": {
			if (event.message.role === "assistant") {
				const targetIndex = findStreamingMessageIndex(session);
				if (targetIndex !== -1) {
					const message = normalizeAssistantMessage(event.message, session.messages[targetIndex].id, true);
					const messages = [...session.messages];
					messages[targetIndex] = message;
					return { ...session, messages };
				}
				const id = `m-${session.nextId}`;
				const message = normalizeAssistantMessage(event.message, id, true);
				return { ...session, nextId: session.nextId + 1, messages: [...session.messages, message] };
			}
			if (event.message.role === "user") {
				const previous = session.messages.at(-1);
				const alreadyPresent =
					previous?.role === "user" &&
					previous.complete &&
					previous.timestamp === event.message.timestamp &&
					messageBlocksEqual(previous.blocks, event.message);
				if (alreadyPresent) {
					return session;
				}
				return { ...session, messages: [...session.messages, normalizeUserMessage(event.message)] };
			}
			return session;
		}

		case "tool_started":
		case "tool_updated":
		case "tool_completed":
			return { ...session, tools: { ...session.tools, [event.tool.id]: event.tool } };

		case "state_changed": {
			const sessionUsage = session.sessionUsage?.sessionId === event.state.sessionId ? session.sessionUsage : null;
			return { ...session, agentState: event.state, sessionUsage };
		}

		case "error":
			return { ...session, error: event.message };

		case "auto_retry_started":
			return {
				...session,
				retry: {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				},
			};

		case "auto_retry_ended": {
			if (event.success) {
				return { ...session, retry: null };
			}
			const message = event.finalError
				? event.finalError
				: `The agent failed after ${Math.max(event.attempt, 1)} attempt(s)`;
			return { ...session, retry: null, error: message };
		}

		case "interaction_requested": {
			if (session.interactions.some((interaction) => interaction.id === event.request.id)) {
				return session;
			}
			return { ...session, interactions: [...session.interactions, event.request] };
		}

		case "custom": {
			if (event.namespace === "gui-adapter" && event.name === "session_changed") {
				return session;
			}
			if (event.namespace === "pi" && event.name === "compaction_end") {
				return session;
			}
			return session;
		}

		default:
			return session;
	}
}

function reduceHostEvent(state: AppState, event: AgentEvent): AppState {
	if (event.type === "custom" && event.namespace === "pi" && event.name === "auth_flow") {
		return { ...state, authFlow: reduceAuthFlowUpdate(state.authFlow, event.payload as AuthFlowUpdate) };
	}
	if (event.type === "custom" && event.namespace === "gui-adapter" && event.name === "backend_stderr") {
		const line = typeof event.payload === "string" ? event.payload : String(event.payload);
		diagnosticSequence += 1;
		const diagnostics = pushLimited(
			state.diagnostics,
			{
				id: `d-${diagnosticSequence}`,
				source: "backend",
				label: "stderr",
				message: line,
			},
			MAX_DIAGNOSTICS,
		);
		return { ...state, logs: pushLimited(state.logs, line, MAX_LOGS), diagnostics };
	}
	if (event.type === "error") {
		return {
			...state,
			error: event.message,
			logs: pushLimited(state.logs, `ERROR: ${event.message}`, MAX_LOGS),
		};
	}
	return state;
}

/** Merge one auth_flow update into the accumulated view for its loginId. */
function reduceAuthFlowUpdate(current: AuthFlowState | null, update: AuthFlowUpdate): AuthFlowState {
	const base: AuthFlowState = current && current.loginId === update.loginId ? current : { loginId: update.loginId };
	if (update.kind === "prompt") {
		return { ...base, prompt: { requestId: update.requestId, prompt: update.prompt } };
	}
	const event = update.event;
	switch (event.type) {
		case "auth_url":
		case "device_code":
			return { ...base, display: event };
		case "info":
		case "progress":
			return { ...base, message: event.message };
		case "prompt_cancelled":
			return base.prompt?.requestId === event.requestId ? { ...base, prompt: undefined } : base;
	}
}

function messageBlocksEqual(blocks: MessageBlock[], message: AgentMessage): boolean {
	const otherBlocks =
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	if (blocks.length !== otherBlocks.length) {
		return false;
	}
	return blocks.every((block, index) => {
		const other = otherBlocks[index];
		if (block.type !== other.type) {
			return false;
		}
		if (block.type === "text" && other.type === "text") return block.text === other.text;
		if (block.type === "thinking" && other.type === "thinking") return block.thinking === other.thinking;
		if (block.type === "image" && other.type === "image") {
			return block.data === other.data && block.mimeType === other.mimeType;
		}
		if (block.type === "toolCall" && other.type === "toolCall") {
			return block.id === other.id && block.name === other.name;
		}
		return false;
	});
}

/** Sidebar indicator for a session: running wins over needs-attention. */
export function sessionIndicator(session: SessionUIState | undefined): SessionStatusIndicator | null {
	if (!session) {
		return null;
	}
	if (session.agentState?.isStreaming === true || session.retry !== null) {
		return "running";
	}
	if (session.interactions.length > 0) {
		return "needs-attention";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Minimal external store (useSyncExternalStore-compatible)
// ---------------------------------------------------------------------------

export class AgentStore {
	private state: AppState;
	private readonly listeners = new Set<() => void>();

	constructor(initial: AppState = initialState) {
		this.state = initial;
	}

	getSnapshot(): AppState {
		return this.state;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispatch(action: StoreAction): void {
		const next = reducer(this.state, action);
		if (Object.is(next, this.state)) {
			// Reducer no-ops (e.g. repeated toolcall deltas) must not wake React.
			return;
		}
		this.state = next;
		for (const listener of this.listeners) {
			listener();
		}
	}
}
