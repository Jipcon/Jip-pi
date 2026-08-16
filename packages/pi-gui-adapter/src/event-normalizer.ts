/**
 * Event normalizer: maps raw Pi RPC records to protocol AgentEvents.
 *
 * This is the single place where Pi-specific shapes become GUI-owned types.
 * Unknown event types are mapped to `custom` events with the raw payload so
 * new Pi behavior keeps flowing through the GUI without breaking it.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AssistantMessage,
	AssistantMessageDiagnostic,
	MessageBlock,
	ModelInfo,
	SessionUsage,
	ToolCallInfo,
	ToolResultMessage,
	UserInteractionRequest,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import type { PiExtensionUiRequest, PiJsonEvent } from "./rpc-client.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export function normalizeModel(raw: unknown): ModelInfo | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.id !== "string" || typeof value.provider !== "string") {
		return null;
	}
	const model: ModelInfo = {
		id: value.id,
		name: typeof value.name === "string" ? value.name : value.id,
		provider: value.provider,
	};
	if (typeof value.api === "string") model.api = value.api;
	if (typeof value.baseUrl === "string") model.baseUrl = value.baseUrl;
	if (typeof value.reasoning === "boolean") model.reasoning = value.reasoning;
	if (typeof value.contextWindow === "number") model.contextWindow = value.contextWindow;
	if (typeof value.maxTokens === "number") model.maxTokens = value.maxTokens;
	if (Array.isArray(value.input)) {
		model.input = value.input.filter((entry): entry is string => typeof entry === "string");
	}
	return model;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function normalizeBlock(raw: unknown): MessageBlock | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	switch (value.type) {
		case "text":
			return typeof value.text === "string" ? { type: "text", text: value.text } : null;
		case "thinking":
			return typeof value.thinking === "string" ? { type: "thinking", thinking: value.thinking } : null;
		case "image": {
			if (typeof value.data !== "string" || typeof value.mimeType !== "string") {
				return null;
			}
			return {
				type: "image",
				data: value.data,
				mimeType: value.mimeType,
				...(typeof value.name === "string" ? { name: value.name } : {}),
			};
		}
		case "toolCall": {
			if (typeof value.id !== "string" || typeof value.name !== "string") {
				return null;
			}
			return {
				type: "toolCall",
				id: value.id,
				name: value.name,
				arguments: normalizeArguments(value.arguments),
			};
		}
		default:
			// Unknown content block types are dropped; the raw event still
			// surfaces through custom events if needed.
			return null;
	}
}

function normalizeArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// fall through
		}
	}
	return { raw };
}

function normalizeContent(raw: unknown): string | MessageBlock[] {
	if (typeof raw === "string") {
		return raw;
	}
	if (Array.isArray(raw)) {
		const blocks = raw.map(normalizeBlock).filter((block): block is MessageBlock => block !== null);
		return blocks;
	}
	return "";
}

function normalizeTimestamp(raw: unknown): number | undefined {
	return typeof raw === "number" ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Diagnostics redaction
//
// Diagnostics originate from the agent runtime and are supposed to be
// redacted already, but the GUI is the last line of defense: any value whose
// key looks like a credential is stripped before it can reach the store,
// logs, snapshots or test output.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN =
	/^(api[_-]?key|authorization|auth|token|secret|password|passwd|credential|access[_-]?key|private[_-]?key)$|(api[_-]?key|authorization|secret|password|passwd|credential)/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Redact credential-shaped fragments inside a diagnostic string without
 * destroying ordinary text (e.g. `Bearer abc`, `sk-...`, `KEY=value`).
 */
export function redactDiagnosticString(text: string): string {
	return text
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/(api[_-]?key|authorization|token|secret|password|credential)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/([A-Z][A-Z0-9_]*_API_KEY|OPENCODE_API_KEY)\s*=\s*\S+/gi, "$1=[redacted]");
}

/** Recursively redact credential-looking values in a diagnostic payload. */
function redactDiagnosticValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactDiagnosticValue);
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record)) {
			if (isSensitiveKey(key)) {
				out[key] = "[redacted]";
			} else {
				out[key] = redactDiagnosticValue(entry);
			}
		}
		return out;
	}
	return value;
}

function normalizeDiagnostics(raw: unknown): AssistantMessageDiagnostic[] | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const diagnostics: AssistantMessageDiagnostic[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const value = entry as Record<string, unknown>;
		if (typeof value.type !== "string") {
			continue;
		}
		const diagnostic: AssistantMessageDiagnostic = { type: value.type };
		if (typeof value.timestamp === "number") diagnostic.timestamp = value.timestamp;
		if (typeof value.error === "object" && value.error !== null) {
			const error = value.error as Record<string, unknown>;
			const message = typeof error.message === "string" ? error.message : undefined;
			if (message !== undefined) {
				diagnostic.error = {
					message,
					...(typeof error.name === "string" ? { name: error.name } : {}),
					...(typeof error.code === "string" || typeof error.code === "number" ? { code: error.code } : {}),
				};
			}
		}
		if (typeof value.details === "object" && value.details !== null) {
			diagnostic.details = redactDiagnosticValue(value.details) as Record<string, unknown>;
		}
		diagnostics.push(diagnostic);
	}
	return diagnostics.length > 0 ? diagnostics : undefined;
}

export function normalizeMessage(raw: unknown): AgentMessage | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	const role = value.role;

	if (role === "user") {
		const message: UserMessage = {
			role: "user",
			content: normalizeContent(value.content),
		};
		const timestamp = normalizeTimestamp(value.timestamp);
		if (timestamp !== undefined) message.timestamp = timestamp;
		return message;
	}

	if (role === "assistant") {
		const content = normalizeContent(value.content);
		const message: AssistantMessage = {
			role: "assistant",
			content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		};
		if (typeof value.model === "string") message.model = value.model;
		if (typeof value.provider === "string") message.provider = value.provider;
		if (typeof value.api === "string") message.api = value.api;
		if (typeof value.stopReason === "string") message.stopReason = value.stopReason;
		if (typeof value.errorMessage === "string") message.errorMessage = value.errorMessage;
		const diagnostics = normalizeDiagnostics(value.diagnostics);
		if (diagnostics) message.diagnostics = diagnostics;
		const timestamp = normalizeTimestamp(value.timestamp);
		if (timestamp !== undefined) message.timestamp = timestamp;
		return message;
	}

	if (role === "toolResult" || role === "tool") {
		if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") {
			return null;
		}
		const message: ToolResultMessage = {
			role: "tool",
			toolCallId: value.toolCallId,
			toolName: value.toolName,
			content: normalizeContent(value.content),
		};
		if (typeof value.isError === "boolean") message.isError = value.isError;
		const timestamp = normalizeTimestamp(value.timestamp);
		if (timestamp !== undefined) message.timestamp = timestamp;
		return message;
	}

	// Unknown message roles are dropped.
	return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function normalizeState(raw: unknown): AgentState | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.sessionId !== "string") {
		return null;
	}
	const state: AgentState = {
		model: normalizeModel(value.model),
		isStreaming: value.isStreaming === true,
		isCompacting: value.isCompacting === true,
		sessionId: value.sessionId,
		messageCount: typeof value.messageCount === "number" ? value.messageCount : 0,
	};
	if (typeof value.thinkingLevel === "string") state.thinkingLevel = value.thinkingLevel;
	if (typeof value.sessionFile === "string") state.sessionFile = value.sessionFile;
	if (typeof value.sessionName === "string") state.sessionName = value.sessionName;
	if (typeof value.autoCompactionEnabled === "boolean") state.autoCompactionEnabled = value.autoCompactionEnabled;
	if (typeof value.pendingMessageCount === "number") state.pendingMessageCount = value.pendingMessageCount;
	return state;
}

export function normalizeSessionUsage(raw: unknown): SessionUsage | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const value = raw as Record<string, unknown>;
	const tokens = value.tokens;
	if (typeof value.sessionId !== "string" || typeof tokens !== "object" || tokens === null) {
		return null;
	}
	const tokenValue = tokens as Record<string, unknown>;
	const input = finiteNumber(tokenValue.input);
	const output = finiteNumber(tokenValue.output);
	const cacheRead = finiteNumber(tokenValue.cacheRead);
	const cacheWrite = finiteNumber(tokenValue.cacheWrite);
	const total = finiteNumber(tokenValue.total);
	const cost = finiteNumber(value.cost);
	if (
		input === null ||
		output === null ||
		cacheRead === null ||
		cacheWrite === null ||
		total === null ||
		cost === null
	) {
		return null;
	}
	const usage: SessionUsage = {
		sessionId: value.sessionId,
		tokens: { input, output, cacheRead, cacheWrite, total },
		cost,
	};
	const context = value.contextUsage;
	if (typeof context === "object" && context !== null) {
		const contextValue = context as Record<string, unknown>;
		const contextWindow = finiteNumber(contextValue.contextWindow);
		const contextTokens = nullableFiniteNumber(contextValue.tokens);
		const percent = nullableFiniteNumber(contextValue.percent);
		if (contextWindow !== null && contextTokens !== undefined && percent !== undefined) {
			usage.contextUsage = { tokens: contextTokens, contextWindow, percent };
		}
	}
	return usage;
}

function finiteNumber(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function nullableFiniteNumber(raw: unknown): number | null | undefined {
	return raw === null ? null : (finiteNumber(raw) ?? undefined);
}

// ---------------------------------------------------------------------------
// Tool executions
// ---------------------------------------------------------------------------

function extractText(raw: unknown): string | undefined {
	if (typeof raw === "string") {
		return raw;
	}
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	const content = value.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (
					typeof block === "object" &&
					block !== null &&
					typeof (block as Record<string, unknown>).text === "string"
				) {
					return (block as Record<string, unknown>).text as string;
				}
				return null;
			})
			.filter((text): text is string => text !== null)
			.join("");
	}
	return undefined;
}

export function normalizeToolStart(raw: PiJsonEvent): ToolCallInfo | null {
	const toolCallId = raw.toolCallId;
	const toolName = raw.toolName;
	if (typeof toolCallId !== "string" || typeof toolName !== "string") {
		return null;
	}
	const args = typeof raw.args === "object" && raw.args !== null ? (raw.args as Record<string, unknown>) : {};
	return {
		id: toolCallId,
		name: toolName,
		args,
		status: "running",
		startedAt: Date.now(),
	};
}

export function normalizeToolUpdate(raw: PiJsonEvent): ToolCallInfo | null {
	const toolCallId = raw.toolCallId;
	const toolName = raw.toolName;
	if (typeof toolCallId !== "string" || typeof toolName !== "string") {
		return null;
	}
	const partialResult = extractText(raw.partialResult);
	return {
		id: toolCallId,
		name: toolName,
		args: typeof raw.args === "object" && raw.args !== null ? (raw.args as Record<string, unknown>) : {},
		status: "running",
		partialResult,
	};
}

export function normalizeToolEnd(raw: PiJsonEvent): ToolCallInfo | null {
	const toolCallId = raw.toolCallId;
	const toolName = raw.toolName;
	if (typeof toolCallId !== "string" || typeof toolName !== "string") {
		return null;
	}
	const isError = raw.isError === true;
	return {
		id: toolCallId,
		name: toolName,
		args: typeof raw.args === "object" && raw.args !== null ? (raw.args as Record<string, unknown>) : {},
		status: isError ? "error" : "completed",
		result: extractText(raw.result),
		isError,
		completedAt: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Extension UI requests
// ---------------------------------------------------------------------------

export function normalizeInteractionRequest(raw: PiExtensionUiRequest): UserInteractionRequest | null {
	const id = raw.id;
	const method = raw.method;
	if (typeof id !== "string" || typeof method !== "string") {
		return null;
	}
	const request: UserInteractionRequest = { id, kind: "notification" };
	switch (method) {
		case "select":
			request.kind = "select";
			if (typeof raw.title === "string") request.title = raw.title;
			if (Array.isArray(raw.options)) {
				request.options = raw.options.filter((entry): entry is string => typeof entry === "string");
			}
			break;
		case "confirm":
			request.kind = "confirm";
			if (typeof raw.title === "string") request.title = raw.title;
			if (typeof raw.message === "string") request.message = raw.message;
			break;
		case "input":
			request.kind = "input";
			if (typeof raw.title === "string") request.title = raw.title;
			if (typeof raw.placeholder === "string") request.placeholder = raw.placeholder;
			break;
		case "editor":
			request.kind = "editor";
			if (typeof raw.title === "string") request.title = raw.title;
			if (typeof raw.prefill === "string") request.prefill = raw.prefill;
			break;
		case "notify":
			request.kind = "notification";
			if (typeof raw.message === "string") request.message = raw.message;
			if (raw.notifyType === "info" || raw.notifyType === "warning" || raw.notifyType === "error") {
				request.notifyType = raw.notifyType;
			}
			break;
		default:
			// Fire-and-forget methods (setStatus, setWidget, setTitle, ...) are
			// delivered as custom events so the GUI can ignore or render them.
			return null;
	}
	return request;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function customEvent(name: string, payload: unknown): AgentEvent {
	return { type: "custom", namespace: "pi", name, payload };
}

/**
 * Normalize one raw Pi event record into a protocol AgentEvent.
 * Returns null for records that are not agent events.
 */
export function normalizeEvent(raw: PiJsonEvent): AgentEvent | null {
	switch (raw.type) {
		case "agent_start":
			return { type: "agent_started" };
		case "agent_end":
			// A single agent loop ended; retries, compaction and queued
			// continuations may still follow. Only agent_settled means the
			// session is truly idle.
			return customEvent("agent_end", { willRetry: raw.willRetry === true });
		case "agent_settled":
			return { type: "agent_stopped" };
		case "turn_start":
			return { type: "turn_started" };
		case "turn_end":
			return { type: "turn_completed" };
		case "message_start": {
			const message = normalizeMessage(raw.message);
			return message ? { type: "message_started", message } : null;
		}
		case "message_update": {
			const event = raw.assistantMessageEvent as Record<string, unknown> | undefined;
			if (typeof event !== "object" || event === null) {
				return null;
			}
			const deltaType = event.type;
			const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : 0;
			if (deltaType === "text_start" || deltaType === "text_delta" || deltaType === "text_end") {
				return {
					type: "message_delta",
					contentIndex,
					kind: "text",
					delta: typeof event.delta === "string" ? event.delta : undefined,
				};
			}
			if (deltaType === "thinking_start" || deltaType === "thinking_delta" || deltaType === "thinking_end") {
				return {
					type: "message_delta",
					contentIndex,
					kind: "thinking",
					delta: typeof event.delta === "string" ? event.delta : undefined,
				};
			}
			if (deltaType === "toolcall_start" || deltaType === "toolcall_delta" || deltaType === "toolcall_end") {
				return {
					type: "message_delta",
					contentIndex,
					kind: "toolcall",
					delta: typeof event.delta === "string" ? event.delta : undefined,
				};
			}
			return null;
		}
		case "message_end": {
			const message = normalizeMessage(raw.message);
			return message ? { type: "message_completed", message } : null;
		}
		case "tool_execution_start": {
			const tool = normalizeToolStart(raw);
			return tool ? { type: "tool_started", tool } : null;
		}
		case "tool_execution_update": {
			const tool = normalizeToolUpdate(raw);
			return tool ? { type: "tool_updated", tool } : null;
		}
		case "tool_execution_end": {
			const tool = normalizeToolEnd(raw);
			return tool ? { type: "tool_completed", tool } : null;
		}
		case "extension_ui_request":
			// Normalized through normalizeInteractionRequest by the backend.
			return null;
		case "auth_event":
			// OAuth login events flow to the GUI as auth_flow updates.
			return customEvent("auth_flow", {
				kind: "event",
				loginId: raw.loginId,
				event: raw.event,
			});
		case "auth_prompt":
			return customEvent("auth_flow", {
				kind: "prompt",
				loginId: raw.loginId,
				requestId: raw.requestId,
				prompt: raw.prompt,
			});
		case "compaction_start":
			return customEvent("compaction_start", { reason: raw.reason });
		case "compaction_end":
			return customEvent("compaction_end", {
				reason: raw.reason,
				aborted: raw.aborted,
				willRetry: raw.willRetry,
				errorMessage: raw.errorMessage,
			});
		case "auto_retry_start":
			return {
				type: "auto_retry_started",
				attempt: typeof raw.attempt === "number" ? raw.attempt : 1,
				maxAttempts: typeof raw.maxAttempts === "number" ? raw.maxAttempts : 1,
				delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0,
				errorMessage:
					typeof raw.errorMessage === "string" ? redactDiagnosticString(raw.errorMessage) : "Unknown error",
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_ended",
				success: raw.success === true,
				attempt: typeof raw.attempt === "number" ? raw.attempt : 1,
				...(typeof raw.finalError === "string" ? { finalError: redactDiagnosticString(raw.finalError) } : {}),
			};
		case "summarization_retry_scheduled":
			return customEvent("summarization_retry_scheduled", {
				attempt: raw.attempt,
				maxAttempts: raw.maxAttempts,
				delayMs: raw.delayMs,
				errorMessage: raw.errorMessage,
			});
		case "summarization_retry_attempt_start":
			return customEvent("summarization_retry_attempt_start", {
				source: raw.source,
				reason: raw.reason,
			});
		case "summarization_retry_finished":
			return customEvent("summarization_retry_finished", {});
		case "queue_update":
			return customEvent("queue_update", {
				steering: raw.steering,
				followUp: raw.followUp,
			});
		case "bash_execution_update":
			return customEvent("bash_execution_update", {
				id: raw.id,
				delta: raw.delta,
			});
		case "extension_error":
			return customEvent("extension_error", {
				extensionPath: raw.extensionPath,
				event: raw.event,
				error: raw.error,
			});
		default: {
			// Unknown event: keep it flowing as a custom event.
			return customEvent(raw.type, raw);
		}
	}
}

// ---------------------------------------------------------------------------
// Messages helpers used by the backend for get_messages payloads
// ---------------------------------------------------------------------------

export function normalizeMessages(raw: unknown): AgentMessage[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(normalizeMessage).filter((message): message is AgentMessage => message !== null);
}
