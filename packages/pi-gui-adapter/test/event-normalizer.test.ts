import { describe, expect, test } from "vitest";
import {
	normalizeEvent,
	normalizeInteractionRequest,
	normalizeMessage,
	normalizeModel,
	normalizeSessionUsage,
	normalizeState,
	normalizeToolEnd,
	normalizeToolStart,
	normalizeToolUpdate,
} from "../src/event-normalizer.ts";
import type { PiExtensionUiRequest, PiJsonEvent } from "../src/rpc-client.ts";

describe("normalizeModel", () => {
	test("maps a Pi model to ModelInfo", () => {
		const model = normalizeModel({
			id: "claude-sonnet-4-20250514",
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			provider: "anthropic",
			reasoning: true,
			contextWindow: 200000,
		});
		expect(model).toEqual({
			id: "claude-sonnet-4-20250514",
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			provider: "anthropic",
			reasoning: true,
			contextWindow: 200000,
		});
	});

	test("returns null for invalid models", () => {
		expect(normalizeModel(null)).toBeNull();
		expect(normalizeModel({})).toBeNull();
	});
});

describe("normalizeMessage", () => {
	test("normalizes user message with string content", () => {
		const message = normalizeMessage({ role: "user", content: "Hello", timestamp: 123 });
		expect(message).toEqual({ role: "user", content: "Hello", timestamp: 123 });
	});

	test("normalizes assistant message with blocks", () => {
		const message = normalizeMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Hi" },
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
				{ type: "unknownBlock", foo: "bar" },
			],
			model: "m1",
			stopReason: "stop",
		});
		expect(message).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Hi" },
				{ type: "thinking", thinking: "hmm" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			],
			model: "m1",
			stopReason: "stop",
		});
	});

	test("parses string toolCall arguments", () => {
		const message = normalizeMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "edit", arguments: '{"file":"a.ts"}' }],
		});
		expect(message).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { file: "a.ts" } }],
		});
	});

	test("normalizes image blocks without leaking unknown fields", () => {
		const message = normalizeMessage({
			role: "user",
			content: [
				{ type: "text", text: "Inspect this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "sample.png", path: "/tmp/x" },
			],
		});
		expect(message).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Inspect this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "sample.png" },
			],
		});
	});

	test("normalizes toolResult messages", () => {
		const message = normalizeMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "out" }],
			isError: true,
		});
		expect(message).toEqual({
			role: "tool",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "out" }],
			isError: true,
		});
	});

	test("passes through provider, api, stopReason, errorMessage and diagnostics", () => {
		const message = normalizeMessage({
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			model: "kimi-k3",
			provider: "opencode-go",
			api: "openai-completions",
			stopReason: "error",
			errorMessage: "Go usage limit reached",
			diagnostics: [
				{
					type: "stream_error",
					timestamp: 1234,
					error: { name: "GoUsageLimitError", message: "Monthly quota exceeded", code: 429 },
				},
			],
		});
		expect(message).toMatchObject({
			role: "assistant",
			provider: "opencode-go",
			api: "openai-completions",
			stopReason: "error",
			errorMessage: "Go usage limit reached",
			diagnostics: [
				{
					type: "stream_error",
					timestamp: 1234,
					error: { name: "GoUsageLimitError", message: "Monthly quota exceeded", code: 429 },
				},
			],
		});
	});

	test("redacts credential-shaped values from diagnostics details", () => {
		const message = normalizeMessage({
			role: "assistant",
			content: [],
			stopReason: "error",
			provider: "opencode-go",
			errorMessage: "failed",
			diagnostics: [
				{
					type: "http_error",
					details: {
						status: 401,
						headers: { authorization: "Bearer sk-abcdefghijklmnop", "x-api-key": "sekrit123456789" },
						nested: { token: "tok-abc" },
					},
				},
			],
		});
		const details = (message as Extract<typeof message, { role: "assistant" }>).diagnostics?.[0].details;
		expect(details).toEqual({
			status: 401,
			headers: { authorization: "[redacted]", "x-api-key": "[redacted]" },
			nested: { token: "[redacted]" },
		});
	});

	test("returns null for unknown roles", () => {
		expect(normalizeMessage({ role: "system", content: "x" })).toBeNull();
	});
});

describe("normalizeState", () => {
	test("maps get_state data", () => {
		const state = normalizeState({
			model: { id: "m1", name: "M1", provider: "p1" },
			thinkingLevel: "high",
			isStreaming: true,
			isCompacting: false,
			sessionFile: "/s/s.jsonl",
			sessionId: "abc",
			sessionName: "my-session",
			messageCount: 3,
			pendingMessageCount: 1,
		});
		expect(state).toMatchObject({
			model: { id: "m1", name: "M1", provider: "p1" },
			thinkingLevel: "high",
			isStreaming: true,
			sessionFile: "/s/s.jsonl",
			sessionId: "abc",
			sessionName: "my-session",
			messageCount: 3,
			pendingMessageCount: 1,
		});
	});

	test("returns null without sessionId", () => {
		expect(normalizeState({ isStreaming: false })).toBeNull();
	});
});

describe("normalizeSessionUsage", () => {
	test("maps cumulative tokens and context usage", () => {
		expect(
			normalizeSessionUsage({
				sessionId: "s1",
				tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
				cost: 0.01,
				contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 },
			}),
		).toEqual({
			sessionId: "s1",
			tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
			cost: 0.01,
			contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 },
		});
	});

	test("preserves a temporarily unknown context count", () => {
		expect(
			normalizeSessionUsage({
				sessionId: "s1",
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				contextUsage: { tokens: null, contextWindow: 1000, percent: null },
			})?.contextUsage,
		).toEqual({ tokens: null, contextWindow: 1000, percent: null });
	});
});

describe("tool event normalization", () => {
	test("normalizeToolStart", () => {
		const tool = normalizeToolStart({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
		});
		expect(tool).toMatchObject({ id: "c1", name: "bash", args: { command: "ls" }, status: "running" });
	});

	test("normalizeToolUpdate extracts partial text", () => {
		const tool = normalizeToolUpdate({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		expect(tool).toMatchObject({ id: "c1", status: "running", partialResult: "partial" });
	});

	test("normalizeToolEnd maps isError", () => {
		const ok = normalizeToolEnd({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		});
		expect(ok).toMatchObject({ id: "c1", status: "completed", result: "done", isError: false });
		const err = normalizeToolEnd({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [] },
			isError: true,
		});
		expect(err).toMatchObject({ status: "error", isError: true });
	});
});

describe("normalizeInteractionRequest", () => {
	test("maps select", () => {
		const request = normalizeInteractionRequest({
			type: "extension_ui_request",
			id: "u1",
			method: "select",
			title: "T",
			options: ["A", "B"],
		} as PiExtensionUiRequest);
		expect(request).toEqual({ id: "u1", kind: "select", title: "T", options: ["A", "B"] });
	});

	test("maps confirm", () => {
		const request = normalizeInteractionRequest({
			type: "extension_ui_request",
			id: "u2",
			method: "confirm",
			title: "T",
			message: "M",
		} as PiExtensionUiRequest);
		expect(request).toMatchObject({ id: "u2", kind: "confirm", message: "M" });
	});

	test("maps input and editor", () => {
		const input = normalizeInteractionRequest({
			type: "extension_ui_request",
			id: "u3",
			method: "input",
			title: "T",
			placeholder: "p",
		} as PiExtensionUiRequest);
		expect(input).toMatchObject({ kind: "input", placeholder: "p" });
		const editor = normalizeInteractionRequest({
			type: "extension_ui_request",
			id: "u4",
			method: "editor",
			title: "T",
			prefill: "line1",
		} as PiExtensionUiRequest);
		expect(editor).toMatchObject({ kind: "editor", prefill: "line1" });
	});

	test("maps notify with type", () => {
		const notify = normalizeInteractionRequest({
			type: "extension_ui_request",
			id: "u5",
			method: "notify",
			message: "M",
			notifyType: "warning",
		} as PiExtensionUiRequest);
		expect(notify).toEqual({ id: "u5", kind: "notification", message: "M", notifyType: "warning" });
	});

	test("returns null for fire-and-forget methods", () => {
		expect(
			normalizeInteractionRequest({
				type: "extension_ui_request",
				id: "u6",
				method: "setStatus",
				statusKey: "k",
				statusText: "v",
			} as PiExtensionUiRequest),
		).toBeNull();
	});
});

describe("normalizeEvent", () => {
	test("maps lifecycle events", () => {
		expect(normalizeEvent({ type: "agent_start" })).toEqual({ type: "agent_started" });
		// agent_end only ends one agent loop; retries, compaction and queued
		// continuations may still follow, so it flows through as a custom event.
		expect(normalizeEvent({ type: "agent_end", willRetry: true })).toEqual({
			type: "custom",
			namespace: "pi",
			name: "agent_end",
			payload: { willRetry: true },
		});
		// Only agent_settled means the session is truly idle.
		expect(normalizeEvent({ type: "agent_settled" })).toEqual({ type: "agent_stopped" });
		expect(normalizeEvent({ type: "turn_start" })).toEqual({ type: "turn_started" });
		expect(normalizeEvent({ type: "turn_end" })).toEqual({ type: "turn_completed" });
	});

	test("maps OAuth auth_flow events and prompts to custom events", () => {
		expect(
			normalizeEvent({
				type: "auth_event",
				loginId: "login-1",
				event: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
			}),
		).toEqual({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: {
				kind: "event",
				loginId: "login-1",
				event: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
			},
		});
		expect(
			normalizeEvent({
				type: "auth_event",
				loginId: "login-1",
				event: { type: "prompt_cancelled", requestId: "prompt-1" },
			}),
		).toMatchObject({
			type: "custom",
			name: "auth_flow",
			payload: { kind: "event", event: { type: "prompt_cancelled", requestId: "prompt-1" } },
		});
		expect(
			normalizeEvent({
				type: "auth_prompt",
				loginId: "login-1",
				requestId: "prompt-1",
				prompt: { type: "manual_code", message: "Paste the code" },
			}),
		).toEqual({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: {
				kind: "prompt",
				loginId: "login-1",
				requestId: "prompt-1",
				prompt: { type: "manual_code", message: "Paste the code" },
			},
		});
	});

	test("maps message events", () => {
		const started = normalizeEvent({ type: "message_start", message: { role: "user", content: "hi" } });
		expect(started).toMatchObject({ type: "message_started", message: { role: "user", content: "hi" } });
		const completed = normalizeEvent({ type: "message_end", message: { role: "assistant", content: [] } });
		expect(completed).toMatchObject({ type: "message_completed" });
	});

	test("maps message_update deltas by kind", () => {
		const text = normalizeEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "abc" },
		});
		expect(text).toEqual({ type: "message_delta", contentIndex: 2, kind: "text", delta: "abc" });
		const thinking = normalizeEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "t" },
		});
		expect(thinking).toMatchObject({ type: "message_delta", kind: "thinking" });
		const toolcall = normalizeEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{" },
		});
		expect(toolcall).toMatchObject({ type: "message_delta", kind: "toolcall", delta: "{" });
	});

	test("maps tool execution events", () => {
		const started = normalizeEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
		expect(started).toMatchObject({ type: "tool_started", tool: { id: "c1", name: "bash", status: "running" } });
	});

	test("maps compaction/retry/queue/extension_error to custom events", () => {
		expect(normalizeEvent({ type: "compaction_start", reason: "threshold" })).toMatchObject({
			type: "custom",
			namespace: "pi",
			name: "compaction_start",
			payload: { reason: "threshold" },
		});
		expect(normalizeEvent({ type: "queue_update", steering: [] })).toMatchObject({
			type: "custom",
			name: "queue_update",
		});
		expect(
			normalizeEvent({ type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" }),
		).toMatchObject({
			type: "custom",
			name: "extension_error",
			payload: { extensionPath: "/x.ts", error: "boom" },
		});
	});

	test("maps auto_retry events to typed retry events with redacted errors", () => {
		expect(
			normalizeEvent({
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 4,
				delayMs: 5000,
				errorMessage: "upstream 429: use Bearer sk-abcdef1234567890",
			}),
		).toEqual({
			type: "auto_retry_started",
			attempt: 2,
			maxAttempts: 4,
			delayMs: 5000,
			errorMessage: "upstream 429: use Bearer [redacted]",
		});
		expect(
			normalizeEvent({
				type: "auto_retry_end",
				success: false,
				attempt: 4,
				finalError: "api_key=sk-abcdefghijklmnop12345678 upstream failed",
			}),
		).toEqual({
			type: "auto_retry_ended",
			success: false,
			attempt: 4,
			finalError: "api_key=[redacted] upstream failed",
		});
		expect(normalizeEvent({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual({
			type: "auto_retry_ended",
			success: true,
			attempt: 2,
		});
	});

	test("maps unknown events to custom events with raw payload", () => {
		const event = normalizeEvent({ type: "brand_new_future_event", foo: 42 } as PiJsonEvent);
		expect(event).toEqual({
			type: "custom",
			namespace: "pi",
			name: "brand_new_future_event",
			payload: { type: "brand_new_future_event", foo: 42 },
		});
	});

	test("returns null for unknown message_update sub-events", () => {
		expect(normalizeEvent({ type: "message_update", assistantMessageEvent: { type: "mystery" } })).toBeNull();
	});
});
