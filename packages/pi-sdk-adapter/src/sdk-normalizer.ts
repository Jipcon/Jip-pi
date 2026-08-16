/**
 * SDK → protocol normalizer: maps typed coding-agent SDK structures to the
 * agent-protocol types the GUI consumes.
 *
 * The SDK and the RPC subprocess share the same underlying agent events, so
 * this mapping mirrors the RPC normalizer's output shapes exactly; the GUI
 * cannot tell the two adapters apart.
 */

import type { AgentMessage as SdkAgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AssistantMessageDiagnostic,
	MessageBlock,
	ModelInfo,
	AssistantMessage as ProtocolAssistantMessage,
	UserMessage as ProtocolUserMessage,
	SessionUsage,
	ToolCallInfo,
	ToolResultMessage,
} from "@earendil-works/pi-agent-protocol";
import type { AssistantMessage as SdkAssistantMessage } from "@earendil-works/pi-ai";
import type { SdkSessionEvent } from "./sdk-loader.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Structural view of a pi-ai Model (typed as the SDK reports it). */
export interface SdkModelShape {
	id?: string;
	provider?: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: readonly string[];
}

export function normalizeSdkModel(model: SdkModelShape | undefined | null): ModelInfo | null {
	if (!model || typeof model.id !== "string" || typeof model.provider !== "string") {
		return null;
	}
	const info: ModelInfo = { id: model.id, name: model.name ?? model.id, provider: model.provider };
	if (typeof model.api === "string") info.api = model.api;
	if (typeof model.baseUrl === "string") info.baseUrl = model.baseUrl;
	if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;
	if (typeof model.contextWindow === "number") info.contextWindow = model.contextWindow;
	if (typeof model.maxTokens === "number") info.maxTokens = model.maxTokens;
	if (model.input !== undefined) {
		info.input = [...model.input];
	}
	return info;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function normalizeBlock(block: unknown): MessageBlock | null {
	if (typeof block !== "object" || block === null) {
		return null;
	}
	const value = block as Record<string, unknown>;
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
		return raw.map(normalizeBlock).filter((block): block is MessageBlock => block !== null);
	}
	return "";
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
		diagnostics.push(diagnostic);
	}
	return diagnostics.length > 0 ? diagnostics : undefined;
}

export function normalizeSdkMessage(message: SdkAgentMessage): AgentMessage | null {
	if (typeof message !== "object" || message === null) {
		return null;
	}
	const value = message as unknown as Record<string, unknown>;
	const role = value.role;

	if (role === "user") {
		const normalized: ProtocolUserMessage = { role: "user", content: normalizeContent(value.content) };
		if (typeof value.timestamp === "number") normalized.timestamp = value.timestamp;
		return normalized;
	}

	if (role === "assistant") {
		const content = normalizeContent(value.content);
		const normalized: ProtocolAssistantMessage = {
			role: "assistant",
			content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		};
		if (typeof value.model === "string") normalized.model = value.model;
		if (typeof value.provider === "string") normalized.provider = value.provider;
		if (typeof value.api === "string") normalized.api = value.api;
		if (typeof value.stopReason === "string") normalized.stopReason = value.stopReason;
		if (typeof value.errorMessage === "string") normalized.errorMessage = value.errorMessage;
		const diagnostics = normalizeDiagnostics(value.diagnostics);
		if (diagnostics) normalized.diagnostics = diagnostics;
		if (typeof value.timestamp === "number") normalized.timestamp = value.timestamp;
		return normalized;
	}

	if (role === "toolResult" || role === "tool") {
		if (typeof value.toolCallId !== "string" || typeof value.toolName !== "string") {
			return null;
		}
		const normalized: ToolResultMessage = {
			role: "tool",
			toolCallId: value.toolCallId,
			toolName: value.toolName,
			content: normalizeContent(value.content),
		};
		if (typeof value.isError === "boolean") normalized.isError = value.isError;
		if (typeof value.timestamp === "number") normalized.timestamp = value.timestamp;
		return normalized;
	}

	return null;
}

export function normalizeSdkMessages(messages: readonly SdkAgentMessage[]): AgentMessage[] {
	return messages
		.map((message) => normalizeSdkMessage(message))
		.filter((message): message is AgentMessage => message !== null);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SdkStateSource {
	sessionId: string;
	model: SdkModelShape | undefined | null;
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	pendingMessageCount: number;
	messageCount: number;
}

export function normalizeSdkState(source: SdkStateSource): AgentState {
	return {
		model: normalizeSdkModel(source.model),
		isStreaming: source.isStreaming,
		isCompacting: source.isCompacting,
		sessionId: source.sessionId,
		messageCount: source.messageCount,
		thinkingLevel: source.thinkingLevel,
		...(source.sessionFile !== undefined ? { sessionFile: source.sessionFile } : {}),
		...(source.sessionName !== undefined ? { sessionName: source.sessionName } : {}),
		autoCompactionEnabled: source.autoCompactionEnabled,
		pendingMessageCount: source.pendingMessageCount,
	};
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface SdkStatsSource {
	sessionId: string;
	cost: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export function normalizeSdkUsage(stats: SdkStatsSource): SessionUsage {
	const usage: SessionUsage = {
		sessionId: stats.sessionId,
		tokens: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			total: stats.tokens.total,
		},
		cost: stats.cost,
	};
	if (stats.contextUsage) {
		usage.contextUsage = {
			tokens: stats.contextUsage.tokens,
			contextWindow: stats.contextUsage.contextWindow,
			percent: stats.contextUsage.percent,
		};
	}
	return usage;
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

function normalizeArgs(raw: unknown): Record<string, unknown> {
	return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function customEvent(name: string, payload: unknown): AgentEvent {
	return { type: "custom", namespace: "pi", name, payload };
}

/**
 * Map one SDK session event to a protocol AgentEvent.
 * Returns null for events with no GUI-visible protocol form.
 */
export function normalizeSdkEvent(event: SdkSessionEvent): AgentEvent | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_started" };
		case "agent_end":
			return customEvent("agent_end", { willRetry: event.willRetry });
		case "agent_settled":
			return { type: "agent_stopped" };
		case "turn_start":
			return { type: "turn_started" };
		case "turn_end":
			return { type: "turn_completed" };
		case "message_start": {
			const message = normalizeSdkMessage(event.message);
			return message ? { type: "message_started", message } : null;
		}
		case "message_update": {
			const assistantEvent = event.assistantMessageEvent;
			const contentIndex =
				"contentIndex" in assistantEvent && typeof assistantEvent.contentIndex === "number"
					? assistantEvent.contentIndex
					: 0;
			const delta =
				"delta" in assistantEvent && typeof assistantEvent.delta === "string" ? assistantEvent.delta : undefined;
			if (
				assistantEvent.type === "text_start" ||
				assistantEvent.type === "text_delta" ||
				assistantEvent.type === "text_end"
			) {
				return { type: "message_delta", contentIndex, kind: "text", delta };
			}
			if (
				assistantEvent.type === "thinking_start" ||
				assistantEvent.type === "thinking_delta" ||
				assistantEvent.type === "thinking_end"
			) {
				return { type: "message_delta", contentIndex, kind: "thinking", delta };
			}
			if (
				assistantEvent.type === "toolcall_start" ||
				assistantEvent.type === "toolcall_delta" ||
				assistantEvent.type === "toolcall_end"
			) {
				return { type: "message_delta", contentIndex, kind: "toolcall", delta };
			}
			return null;
		}
		case "message_end": {
			const message = normalizeSdkMessage(event.message);
			return message ? { type: "message_completed", message } : null;
		}
		case "tool_execution_start": {
			const tool: ToolCallInfo = {
				id: event.toolCallId,
				name: event.toolName,
				args: normalizeArgs(event.args),
				status: "running",
				startedAt: Date.now(),
			};
			return { type: "tool_started", tool };
		}
		case "tool_execution_update": {
			const tool: ToolCallInfo = {
				id: event.toolCallId,
				name: event.toolName,
				args: normalizeArgs(event.args),
				status: "running",
				partialResult: extractText(event.partialResult),
			};
			return { type: "tool_updated", tool };
		}
		case "tool_execution_end": {
			const tool: ToolCallInfo = {
				id: event.toolCallId,
				name: event.toolName,
				args: {},
				status: event.isError ? "error" : "completed",
				result: extractText(event.result),
				isError: event.isError,
				completedAt: Date.now(),
			};
			return { type: "tool_completed", tool };
		}
		case "auto_retry_start":
			return {
				type: "auto_retry_started",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_ended",
				success: event.success,
				attempt: event.attempt,
				...(typeof event.finalError === "string" ? { finalError: event.finalError } : {}),
			};
		case "compaction_start":
			return customEvent("compaction_start", { reason: event.reason });
		case "compaction_end":
			return customEvent("compaction_end", {
				reason: event.reason,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
			});
		case "summarization_retry_scheduled":
			return customEvent("summarization_retry_scheduled", {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		case "summarization_retry_attempt_start":
			return customEvent("summarization_retry_attempt_start", {
				source: event.source,
				...(event.source === "compaction" ? { reason: event.reason } : {}),
			});
		case "summarization_retry_finished":
			return customEvent("summarization_retry_finished", {});
		case "queue_update":
			return customEvent("queue_update", { steering: event.steering, followUp: event.followUp });
		case "bash_execution_update":
			return customEvent("bash_execution_update", { id: event.id, delta: event.delta });
		case "session_info_changed":
			return customEvent("session_info_changed", { name: event.name });
		case "thinking_level_changed":
			return customEvent("thinking_level_changed", { level: event.level });
		case "entry_appended":
			// Internal persistence bookkeeping; no GUI-visible form.
			return null;
		default: {
			// Open union: unknown SDK events flow through as custom events.
			const unknownEvent = event as unknown as { type: string };
			return customEvent(unknownEvent.type, event);
		}
	}
}

export function normalizeSdkAssistantMessage(message: SdkAssistantMessage): ProtocolAssistantMessage | null {
	return normalizeSdkMessage(message) as ProtocolAssistantMessage | null;
}
