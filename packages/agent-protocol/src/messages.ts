/**
 * Generic message model used by the GUI.
 *
 * These types are deliberately GUI-owned: they are NOT Pi types and must never
 * leak Pi-specific fields into the renderer. Backend adapters normalize
 * whatever a concrete agent runtime produces into these shapes.
 */

export type MessageRole = "user" | "assistant" | "tool";

/** Plain text content block. */
export interface TextBlock {
	type: "text";
	text: string;
}

/** Reasoning/thinking content block. */
export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

/** Base64-encoded image content attached to a message. */
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
	/** Original filename, when it is available to the GUI. */
	name?: string;
}

/** A tool invocation requested by the assistant. */
export interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type MessageBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock;

/**
 * A redacted failure/recovery diagnostic attached to an assistant message.
 *
 * Field names mirror the runtime's own redacted diagnostics: secrets and
 * request bodies must never be included here. The GUI renders these as
 * structured diagnostics in Settings and error summaries.
 */
export interface AssistantMessageDiagnostic {
	type: string;
	timestamp?: number;
	error?: {
		name?: string;
		message: string;
		code?: string | number;
	};
	details?: Record<string, unknown>;
}

/** A user prompt. */
export interface UserMessage {
	role: "user";
	content: string | MessageBlock[];
	timestamp?: number;
}

/** An assistant response, possibly containing tool calls. */
export interface AssistantMessage {
	role: "assistant";
	content: MessageBlock[];
	model?: string;
	/** Provider id (e.g. `opencode-go`, `opencode`, `anthropic`). */
	provider?: string;
	/** Provider API surface (e.g. `openai-completions`, `anthropic-messages`). */
	api?: string;
	/** Why generation stopped (`stop`, `error`, `aborted`, `length`, ...). */
	stopReason?: string;
	/** Redacted failure message when `stopReason` is `error`. */
	errorMessage?: string;
	/** Redacted failure/recovery diagnostics (never contains secrets). */
	diagnostics?: AssistantMessageDiagnostic[];
	timestamp?: number;
}

/** The result of a tool execution. */
export interface ToolResultMessage {
	role: "tool";
	toolCallId: string;
	toolName: string;
	content: string | MessageBlock[];
	isError?: boolean;
	timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

/** Extract the plain text of a message, ignoring thinking/tool blocks. */
export function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("");
}
