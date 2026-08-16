// Stub RPC backend used by pi-gui-adapter integration tests.
// Speaks the Pi RPC JSONL protocol well enough to exercise the adapter:
// state/model/session commands, streaming prompt events, tool execution
// events, extension UI request/response, unknown events and crashes.
let buffer = "";
let sessionId = "stub-session-1";
let sessionName;
let sessionFile = "/stub/session-1.jsonl";
let isStreaming = false;
let thinkingLevel = "medium";
let model = {
	id: "stub-model",
	name: "Stub Model",
	provider: "stub-provider",
	api: "stub",
	reasoning: false,
	contextWindow: 128000,
	input: ["text", "image"],
};
let messages = [];
const savedSessions = [
	{
		path: "/stub/session-1.jsonl",
		id: "stub-session-1",
		cwd: process.cwd(),
		created: "2026-08-08T01:00:00.000Z",
		modified: "2026-08-08T02:00:00.000Z",
		messageCount: 0,
		firstMessage: "Current desktop session",
		messages: [],
	},
	{
		path: "/stub/session-2.jsonl",
		id: "stub-session-2",
		cwd: process.cwd(),
		name: "Historical session",
		created: "2026-08-07T01:00:00.000Z",
		modified: "2026-08-07T03:00:00.000Z",
		messageCount: 2,
		firstMessage: "Restore the previous conversation",
		messages: [
			{ role: "user", content: "Restore the previous conversation", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Historical reply" }],
				model: "stub-model",
				stopReason: "stop",
				timestamp: 2,
			},
		],
	},
];

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// When STUB_HOLD_STREAMING_GET_STATE=1, the first get_state received while
// streaming is captured and held (not answered) until the turn settles, so
// tests can exercise stale streaming responses arriving after agent_settled.
let heldGetState = null;
let modelListCalls = 0;

// OAuth login state: login_oauth responds only after the prompt is answered.
let pendingOAuthLogin = null;

function settleAgent(agentMessages) {
	out({ type: "agent_end", messages: agentMessages, willRetry: false });
	isStreaming = false;
	out({ type: "agent_settled" });
	if (heldGetState) {
		respond(heldGetState.id, "get_state", heldGetState.snapshot);
		heldGetState = null;
	}
}

process.stdout.write(`${JSON.stringify({ type: "backend_info", version: "stub-1.0.0" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "cwd", cwd: process.cwd(), marker: process.env.STUB_MARKER ?? null })}\n`);

function respond(id, command, data, error) {
	if (error !== undefined) {
		out({ id, type: "response", command, success: false, error });
	} else if (data !== undefined) {
		out({ id, type: "response", command, success: true, data });
	} else {
		out({ id, type: "response", command, success: true });
	}
}

function streamAssistantReply(text) {
	const assistantMsg = {
		role: "assistant",
		content: [{ type: "text", text }],
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	out({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
	out({ type: "message_end", message: assistantMsg });
	messages.push(assistantMsg);
	out({ type: "turn_end", message: assistantMsg, toolResults: [] });
	settleAgent(messages);
}

function handle(cmd) {
	const id = cmd.id;
	switch (cmd.type) {
		case "get_state": {
			const snapshot = {
				model,
				thinkingLevel,
				isStreaming,
				isCompacting: false,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				sessionFile,
				sessionId,
				sessionName,
				autoCompactionEnabled: true,
				messageCount: messages.length,
				pendingMessageCount: 0,
			};
			if (process.env.STUB_HOLD_STREAMING_GET_STATE === "1" && isStreaming && !heldGetState) {
				heldGetState = { id, snapshot };
				break;
			}
			respond(id, "get_state", snapshot);
			break;
		}

		case "get_available_models":
			if (process.env.STUB_FAIL_MODELS === "1") {
				respond(id, "get_available_models", undefined, "simulated models failure");
				break;
			}
			if (process.env.STUB_FAIL_MODELS === "after" && modelListCalls >= 2) {
				respond(id, "get_available_models", undefined, "simulated models failure");
				break;
			}
			modelListCalls += 1;
			respond(id, "get_available_models", {
				models: [
					model,
					{
						id: "stub-model-2",
						name: "Stub Model 2",
						provider: "stub-provider",
						api: "stub",
						reasoning: true,
						contextWindow: 128000,
						input: ["text", "image"],
					},
				],
			});
			break;

		case "get_auth_status":
			respond(id, "get_auth_status", {
				providers: [
					{ provider: "opencode-go", name: "OpenCode Go", configured: false, source: "none", mutable: true, supportsApiKey: true, supportsOAuth: true, oauthName: "Sign in with OAuth Provider", isSubscription: true },
					{ provider: "opencode", name: "OpenCode Zen", configured: true, source: "environment", mutable: false, supportsApiKey: true },
				],
			});
			break;

		case "set_api_key":
			if (cmd.provider === "opencode-go" && typeof cmd.apiKey === "string" && cmd.apiKey.length > 0) {
				respond(id, "set_api_key", { provider: cmd.provider });
			} else {
				respond(id, "set_api_key", undefined, "apiKey must be a non-empty string");
			}
			break;

		case "remove_credential":
			respond(id, "remove_credential", { provider: cmd.provider });
			break;

		case "login_oauth":
			if (cmd.provider !== "opencode-go") {
				respond(id, "login_oauth", undefined, `Unknown provider: ${cmd.provider}`);
				break;
			}
			if (pendingOAuthLogin) {
				respond(id, "login_oauth", undefined, "An OAuth login is already in progress");
				break;
			}
			pendingOAuthLogin = { id, provider: cmd.provider };
			out({
				type: "auth_event",
				loginId: "stub-login",
				event: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
			});
			out({
				type: "auth_event",
				loginId: "stub-login",
				event: { type: "device_code", userCode: "STUB-CODE", verificationUri: "https://example.invalid/device" },
			});
			out({
				type: "auth_prompt",
				loginId: "stub-login",
				requestId: "stub-prompt-1",
				prompt: { type: "manual_code", message: "Paste the code" },
			});
			break;

		case "cancel_login_oauth":
			if (pendingOAuthLogin) {
				const login = pendingOAuthLogin;
				pendingOAuthLogin = null;
				respond(login.id, "login_oauth", undefined, "Login cancelled");
			}
			respond(id, "cancel_login_oauth");
			break;

		case "auth_prompt_response":
			if (pendingOAuthLogin && cmd.requestId === "stub-prompt-1") {
				const login = pendingOAuthLogin;
				pendingOAuthLogin = null;
				if (cmd.cancelled) {
					respond(login.id, "login_oauth", undefined, "Login cancelled");
				} else if (typeof cmd.value === "string" && cmd.value.length > 0) {
					respond(login.id, "login_oauth", { provider: login.provider });
				} else {
					respond(login.id, "login_oauth", undefined, "Login cancelled");
				}
			}
			break;

		case "refresh_auth":
			respond(id, "refresh_auth");
			break;

		case "set_model":
			if (cmd.provider === "stub-provider" && (cmd.modelId === "stub-model" || cmd.modelId === "stub-model-2")) {
				model = {
					id: cmd.modelId,
					name: cmd.modelId === "stub-model" ? "Stub Model" : "Stub Model 2",
					provider: cmd.provider,
					api: "stub",
					contextWindow: 128000,
					input: ["text", "image"],
				};
				respond(id, "set_model", model);
			} else {
				respond(id, "set_model", undefined, `Model not found: ${cmd.provider}/${cmd.modelId}`);
			}
			break;

		case "new_session":
			sessionId = `stub-session-${Math.random().toString(36).slice(2, 8)}`;
			sessionFile = `/stub/${sessionId}.jsonl`;
			sessionName = undefined;
			messages = [];
			respond(id, "new_session", { cancelled: false });
			break;

		case "persist_session":
			if (process.env.STUB_TRACE_PERSIST_SESSION === "1") {
				out({ type: "persist_session_called", sessionId });
			}
			if (!savedSessions.some((session) => session.id === sessionId)) {
				const timestamp = new Date().toISOString();
				savedSessions.unshift({
					path: sessionFile,
					id: sessionId,
					cwd: process.cwd(),
					created: timestamp,
					modified: timestamp,
					messageCount: messages.length,
					firstMessage: "",
					messages: messages.map((message) => ({ ...message })),
				});
			}
			respond(id, "persist_session", { path: sessionFile });
			break;

		case "list_sessions":
			if (process.env.STUB_NO_LIST_SESSIONS === "1") {
				respond(id, "list_sessions", undefined, "Unknown command: list_sessions");
				break;
			}
			respond(id, "list_sessions", {
				sessions: savedSessions.map((session) => ({
					path: session.path,
					id: session.id,
					cwd: session.cwd,
					name: session.name,
					created: session.created,
					modified: session.modified,
					messageCount: session.messageCount,
					firstMessage: session.firstMessage,
				})),
			});
			break;

		case "switch_session": {
			const target = savedSessions.find((session) => session.path === cmd.sessionPath);
			if (!target) {
				respond(id, "switch_session", undefined, `Session not found: ${cmd.sessionPath}`);
				break;
			}
			sessionId = target.id;
			sessionFile = target.path;
			sessionName = target.name;
			messages = target.messages.map((message) => ({ ...message }));
			respond(id, "switch_session", { cancelled: false });
			break;
		}

		case "rename_session": {
			const target = savedSessions.find((session) => session.id === cmd.sessionId);
			if (!target) {
				respond(id, "rename_session", undefined, `Session not found: ${cmd.sessionId}`);
				break;
			}
			target.name = cmd.name;
			target.modified = new Date().toISOString();
			if (target.id === sessionId) {
				sessionName = cmd.name;
			}
			respond(id, "rename_session");
			break;
		}

		case "set_session_name":
			sessionName = cmd.name;
			respond(id, "set_session_name");
			break;

		case "abort":
			if (isStreaming) {
				settleAgent(messages);
			}
			respond(id, "abort");
			break;

		case "prompt": {
			if (isStreaming && cmd.streamingBehavior !== "steer" && cmd.streamingBehavior !== "followUp") {
				respond(id, "prompt", undefined, "Agent is already streaming; specify streamingBehavior");
				break;
			}
			if (cmd.message === "CRASH_NOW") {
				respond(id, "prompt");
				process.stderr.write("stub: simulated crash\n");
				process.exit(7);
				break;
			}
			if (cmd.message === "EMIT_UNKNOWN_EVENT") {
				respond(id, "prompt");
				out({ type: "weird_new_event", some: "payload" });
				break;
			}
			if (cmd.message === "EXT_UI_SELECT") {
				respond(id, "prompt");
				out({
					type: "extension_ui_request",
					id: "ext-1",
					method: "select",
					title: "Pick one",
					options: ["A", "B"],
					timeout: 5000,
				});
				break;
			}
			if (cmd.message === "STAY_STREAMING") {
				respond(id, "prompt");
				isStreaming = true;
				out({ type: "agent_start" });
				out({ type: "turn_start" });
				out({ type: "message_start", message: { role: "user", content: cmd.message, timestamp: Date.now() } });
				break;
			}
			if (cmd.message === "FINISH") {
				respond(id, "prompt");
				streamAssistantReply("finished");
				break;
			}
			if (cmd.message === "STDERR_ONLY") {
				respond(id, "prompt");
				process.stderr.write("stub: some diagnostic\n");
				streamAssistantReply("ok");
				break;
			}

			respond(id, "prompt");
			isStreaming = true;
			out({ type: "agent_start" });
			out({ type: "turn_start" });
			const imageBlocks = Array.isArray(cmd.images) ? cmd.images : [];
			const userContent = imageBlocks.length > 0
				? [...(cmd.message ? [{ type: "text", text: cmd.message }] : []), ...imageBlocks]
				: cmd.message;
			const userMsg = { role: "user", content: userContent, timestamp: Date.now() };
			out({ type: "message_start", message: userMsg });
			messages.push(userMsg);
			out({ type: "message_end", message: userMsg });
			out({ type: "message_start", message: { role: "assistant", content: [], model: model.id, timestamp: Date.now() } });
			out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } });
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" } });
			out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" } });
			out({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo hi" } });
			out({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "hi\n" }], details: {} },
			});
			out({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "echo hi" },
				result: { content: [{ type: "text", text: "hi\n" }], details: {} },
				isError: false,
			});
			const assistantMsg = {
				role: "assistant",
				content: [
					{ type: "text", text: "Hello world" },
					{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo hi" } },
				],
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } });
			out({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { id: "tool-1", name: "bash", arguments: { command: "echo hi" } },
				},
			});
			out({ type: "message_end", message: assistantMsg });
			messages.push(assistantMsg);
			out({
				type: "turn_end",
				message: assistantMsg,
				toolResults: [
					{ role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: Date.now() },
				],
			});
			settleAgent(messages);
			break;
		}

		case "get_messages":
			respond(id, "get_messages", { messages });
			break;

		case "get_session_stats":
			respond(id, "get_session_stats", {
				sessionFile,
				sessionId,
				userMessages: messages.filter((message) => message.role === "user").length,
				assistantMessages: messages.filter((message) => message.role === "assistant").length,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: messages.length,
				tokens: { input: 1200, output: 300, cacheRead: 600, cacheWrite: 100, total: 2200 },
				cost: 0.012,
				contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
			});
			break;

		case "get_commands":
			respond(id, "get_commands", {
				commands: [{ name: "session-name", description: "Set session name", source: "extension", sourceInfo: {} }],
			});
			break;

		case "get_available_thinking_levels":
			respond(id, "get_available_thinking_levels", { levels: ["off", "low", "medium", "high"] });
			break;

		case "set_thinking_level":
			thinkingLevel = cmd.level;
			respond(id, "set_thinking_level");
			break;

		case "extension_ui_response":
			respond(id, "extension_ui_response");
			out({ type: "agent_start" });
			out({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
			out({
				type: "message_update",
				assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			});
			out({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: `answered ${cmd.id}: ${JSON.stringify(cmd)}`,
				},
			});
			out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done" } });
			out({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() },
			});
			settleAgent(messages);
			break;

		default:
			respond(id, cmd.type, undefined, `Unknown command: ${cmd.type}`);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex === -1) break;
		const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
		buffer = buffer.slice(newlineIndex + 1);
		if (line.trim().length === 0) continue;
		let cmd;
		try {
			cmd = JSON.parse(line);
		} catch {
			out({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
			continue;
		}
		handle(cmd);
	}
});
