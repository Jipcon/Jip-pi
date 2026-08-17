/**
 * PiBackend: implements the AgentBackend protocol over the Pi RPC subprocess.
 *
 * This adapter owns every Pi-specific concern:
 * - spawning Pi with `--mode rpc` (ProcessManager)
 * - JSONL framing and request/response correlation (RpcClient + JsonlParser)
 * - mapping Pi events to protocol events (event-normalizer)
 * - capability discovery (compatibility)
 *
 * Nothing above this layer may know anything about Pi.
 */

import {
	type AgentBackend,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AuthPromptResponse,
	type BackendHandshake,
	type Capabilities,
	type InteractionResponse,
	type ModelInfo,
	type ModelRef,
	messageText,
	type ProviderAuthStatus,
	type SessionInfo,
	type SessionUsage,
	type StartConfig,
	type UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { buildHandshake, defaultCapabilityProbes, detectCapabilities, normalizeModelList } from "./compatibility.ts";
import {
	normalizeEvent,
	normalizeInteractionRequest,
	normalizeMessages,
	normalizeSessionUsage,
	normalizeState,
	redactDiagnosticString,
} from "./event-normalizer.ts";
import { ProcessManager } from "./process-manager.ts";
import { type PiExtensionUiRequest, type PiJsonEvent, RpcClient } from "./rpc-client.ts";

export interface PiBackendOptions {
	/** Per-request timeout for RPC commands. */
	requestTimeoutMs?: number;
	/** How long to wait for the backend to become responsive at startup. */
	startupTimeoutMs?: number;
	/** Number of recent stderr lines kept for crash diagnostics. */
	stderrRetention?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_STDERR_RETENTION = 50;
const READY_POLL_INTERVAL_MS = 200;

interface PiRpcSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export class PiBackend implements AgentBackend {
	private readonly options: Required<PiBackendOptions>;
	private readonly subscribers = new Set<(event: AgentEvent) => void>();

	private process: ProcessManager | undefined;
	private client: RpcClient | undefined;
	private workspacePath: string | undefined;

	private latestState: AgentState | null = null;
	private cachedSessions: SessionInfo[] = [];
	private capabilities: Capabilities = {};
	private handshake: BackendHandshake | undefined;
	private readonly stderrTail: string[] = [];
	private stopping = false;
	/** Last successful full model catalog; used as a fallback on transient failures. */
	private cachedModels: ModelInfo[] = [];

	/** Monotonic revision bumped on every agent lifecycle transition. */
	private lifecycleRevision = 0;
	/** Monotonic sequence for get_state requests. */
	private nextStateRequestId = 0;
	/** Sequence of the newest get_state response applied to latestState. */
	private lastAppliedStateRequestId = 0;

	constructor(options: PiBackendOptions = {}) {
		this.options = {
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
			stderrRetention: options.stderrRetention ?? DEFAULT_STDERR_RETENTION,
		};
	}

	get isRunning(): boolean {
		return this.client !== undefined && !this.client.isClosed;
	}

	/** Streaming state from the cached get_state snapshot; does not hit the backend. */
	get isStreaming(): boolean {
		return this.latestState?.isStreaming === true;
	}

	subscribe(handler: (event: AgentEvent) => void): () => void {
		this.subscribers.add(handler);
		return () => this.subscribers.delete(handler);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async start(config: StartConfig): Promise<void> {
		if (this.isRunning) {
			throw new Error("Backend already running");
		}
		this.workspacePath = config.workspacePath;
		this.stopping = false;
		this.stderrTail.length = 0;

		const process = new ProcessManager({
			executable: config.executable,
			args: config.args ?? [],
			cwd: config.workspacePath,
			env: config.env,
		});
		this.process = process;

		const client = new RpcClient({
			sendLine: (line) => this.writeLine(line),
			onEvent: (event) => this.handleRawEvent(event),
			onExtensionUiRequest: (request) => this.handleExtensionUiRequest(request),
			onProtocolError: (message) => this.emit({ type: "error", message, source: "protocol" }),
			onParseError: (line) =>
				this.emit({
					type: "error",
					message: `Malformed JSON from backend: ${line.slice(0, 120)}`,
					source: "protocol",
				}),
			requestTimeoutMs: this.options.requestTimeoutMs,
		});
		this.client = client;

		process.onStdout((chunk) => client.pushStdout(chunk));
		process.onStderr((line) => this.handleStderr(line));
		process.onExit((info) => this.handleExit(info));

		await process.start();

		// Wait until the backend answers a get_state probe.
		const ready = await this.waitForReady();
		if (!ready) {
			const tail = this.stderrTail.slice(-10).join("\n");
			await this.stop();
			throw new Error(`Pi backend failed to start.${tail ? `\n${tail}` : ""}`);
		}

		// Discover capabilities. Models are loaded by the GUI during hydration.
		this.capabilities = await detectCapabilities(client, defaultCapabilityProbes());
		this.capabilities.tools = true;
		this.capabilities.compaction = true;
		this.capabilities.extensionUI = true;

		if (config.model) {
			await this.setModel(config.model);
		}
		if (config.name) {
			await this.request({ type: "set_session_name", name: config.name });
		}
		this.handshake = buildHandshake(this.capabilities);

		if (config.name) {
			await this.refreshState();
		}
		this.emit({ type: "custom", namespace: "gui-adapter", name: "backend_ready", payload: this.handshake });
	}

	async stop(): Promise<void> {
		this.stopping = true;
		// Invalidate any in-flight get_state responses from before the stop.
		this.lifecycleRevision += 1;
		const process = this.process;
		const client = this.client;
		this.process = undefined;
		this.client = undefined;

		if (client) {
			client.close("Backend stopped");
		}
		if (process) {
			await process.stop();
		}
		this.latestState = null;
		this.cachedSessions = [];
		this.capabilities = {};
		this.handshake = undefined;
		this.cachedModels = [];
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	async sendMessage(message: UserMessage): Promise<void> {
		const text = typeof message.content === "string" ? message.content : messageText(message);
		const command: Record<string, unknown> = { type: "prompt", message: text };
		if (typeof message.content !== "string") {
			const images = message.content
				.filter((block) => block.type === "image")
				.map((block) => ({ type: "image", data: block.data, mimeType: block.mimeType }));
			if (images.length > 0) {
				command.images = images;
			}
		}
		if (this.latestState?.isStreaming) {
			// Pi rejects prompts while streaming unless a behavior is given.
			command.streamingBehavior = "steer";
		}
		const result = await this.request(command);
		if (!result.success) {
			throw new Error(result.error ?? "prompt rejected");
		}
	}

	async abort(): Promise<void> {
		const result = await this.request({ type: "abort" });
		if (!result.success) {
			throw new Error(result.error ?? "abort failed");
		}
		await this.refreshState();
	}

	async createSession(): Promise<SessionInfo> {
		const result = await this.request<{ cancelled: boolean }>({ type: "new_session" });
		if (!result.success) {
			throw new Error(result.error ?? "new_session failed");
		}
		if (!result.data?.cancelled) {
			await this.persistCurrentSession();
			this.capabilities.sessionPersistence = true;
			this.handshake = buildHandshake(this.capabilities);
		}
		await this.refreshState();
		this.emit({ type: "custom", namespace: "gui-adapter", name: "session_changed", payload: this.latestState });
		return this.currentSessionInfo();
	}

	async listSessions(): Promise<SessionInfo[]> {
		if (this.handshake && this.capabilities.sessions !== true) {
			throw new Error(
				"The bundled Pi backend does not support session history (list_sessions). Rebuild and restage the backend before packaging Pi Desktop.",
			);
		}
		const result = await this.request<{ sessions?: PiRpcSessionInfo[] }>({ type: "list_sessions" });
		if (!result.success) {
			throw new Error(result.error ?? "list_sessions failed");
		}
		const sessions = (result.data?.sessions ?? []).map((session) => ({
			id: session.id,
			file: session.path,
			workspacePath: session.cwd,
			name: session.name,
			createdAt: parseTimestamp(session.created),
			updatedAt: parseTimestamp(session.modified),
			messageCount: session.messageCount,
			preview: session.firstMessage,
		}));
		const current = this.currentSessionInfo();
		this.cachedSessions =
			current.id && !sessions.some((session) => session.id === current.id) ? [current, ...sessions] : sessions;
		return [...this.cachedSessions];
	}

	async switchSession(sessionId: string): Promise<SessionInfo> {
		if (this.latestState?.isStreaming) {
			throw new Error("Cannot switch sessions while the agent is running");
		}
		let target = this.cachedSessions.find((session) => session.id === sessionId);
		if (!target) {
			target = (await this.listSessions()).find((session) => session.id === sessionId);
		}
		if (!target?.file) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		const result = await this.request<{ cancelled: boolean }>({ type: "switch_session", sessionPath: target.file });
		if (!result.success) {
			throw new Error(result.error ?? "switch_session failed");
		}
		if (result.data?.cancelled) {
			return this.currentSessionInfo();
		}
		await this.refreshState();
		// The renderer re-fetches the session list right after switching;
		// skip the redundant RPC here and let cachedSessions refresh lazily.
		this.emit({ type: "custom", namespace: "gui-adapter", name: "session_changed", payload: this.latestState });
		return this.currentSessionInfo();
	}

	async renameSession(sessionId: string, name: string): Promise<void> {
		if (this.latestState?.isStreaming) {
			throw new Error("Cannot rename sessions while the agent is running");
		}
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error("Session name cannot be empty");
		}
		if (!(await this.listSessions()).some((session) => session.id === sessionId)) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		const result = await this.request({ type: "rename_session", sessionId, name: trimmedName });
		if (!result.success) {
			throw new Error(result.error ?? "rename_session failed");
		}
		await this.refreshState();
		await this.listSessions();
	}

	async getState(): Promise<AgentState> {
		await this.refreshState();
		return (
			this.latestState ?? { model: null, isStreaming: false, isCompacting: false, sessionId: "", messageCount: 0 }
		);
	}

	async getMessages(): Promise<AgentMessage[]> {
		const result = await this.request<{ messages: unknown }>({ type: "get_messages" });
		if (!result.success) {
			throw new Error(result.error ?? "get_messages failed");
		}
		return normalizeMessages(result.data?.messages);
	}

	async getSessionUsage(): Promise<SessionUsage> {
		const result = await this.request({ type: "get_session_stats" });
		if (!result.success) {
			throw new Error(result.error ?? "get_session_stats failed");
		}
		const usage = normalizeSessionUsage(result.data);
		if (!usage) {
			throw new Error("get_session_stats returned an invalid payload");
		}
		return usage;
	}

	async listModels(): Promise<ModelInfo[]> {
		return this.refreshModels();
	}

	async reloadModels(): Promise<void> {
		// Tell the backend subprocess to re-read models.json and recompose its
		// providers, then refill this adapter's model cache from the result.
		const result = await this.request({ type: "reload_models" });
		if (!result.success) {
			throw new Error(result.error ?? "reload_models failed");
		}
		this.cachedModels = [];
		await this.refreshModels();
	}

	async setModel(model: ModelRef): Promise<ModelInfo | null> {
		const result = await this.request({ type: "set_model", provider: model.provider, modelId: model.modelId });
		if (!result.success) {
			throw new Error(result.error ?? "set_model failed");
		}
		await this.refreshState();
		return this.latestState?.model ?? null;
	}

	async listThinkingLevels(): Promise<string[]> {
		const result = await this.request<{ levels?: unknown }>({ type: "get_available_thinking_levels" });
		if (!result.success) {
			throw new Error(result.error ?? "get_available_thinking_levels failed");
		}
		return Array.isArray(result.data?.levels)
			? result.data.levels.filter((level): level is string => typeof level === "string")
			: [];
	}

	async setThinkingLevel(level: string): Promise<void> {
		const result = await this.request({ type: "set_thinking_level", level });
		if (!result.success) {
			throw new Error(result.error ?? "set_thinking_level failed");
		}
		await this.refreshState();
	}

	async listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
		const result = await this.request<{ providers?: ProviderAuthStatus[] }>({ type: "get_auth_status" });
		if (!result.success) {
			throw new Error(result.error ?? "get_auth_status failed");
		}
		return (result.data?.providers ?? []).map((status) => ({
			provider: status.provider,
			...(status.name !== undefined ? { name: status.name } : {}),
			configured: status.configured === true,
			source: status.source ?? "none",
			mutable: status.mutable === true,
			...(status.supportsApiKey !== undefined ? { supportsApiKey: status.supportsApiKey } : {}),
			...(status.supportsOAuth !== undefined ? { supportsOAuth: status.supportsOAuth } : {}),
			...(typeof status.oauthName === "string" ? { oauthName: status.oauthName } : {}),
			...(status.isSubscription !== undefined ? { isSubscription: status.isSubscription } : {}),
			...(typeof status.error === "string" ? { error: redactDiagnosticString(status.error) } : {}),
		}));
	}

	async setApiKey(provider: string, apiKey: string): Promise<void> {
		const result = await this.request({ type: "set_api_key", provider, apiKey });
		if (!result.success) {
			throw new Error(redactDiagnosticString(result.error ?? "set_api_key failed"));
		}
		await this.refreshState();
	}

	async removeCredential(provider: string): Promise<void> {
		const result = await this.request({ type: "remove_credential", provider });
		if (!result.success) {
			throw new Error(redactDiagnosticString(result.error ?? "remove_credential failed"));
		}
		await this.refreshState();
	}

	async loginWithOAuth(provider: string): Promise<void> {
		// No client-side timeout: the flow is user-paced (browser sign-in) and
		// cancellation is protocol-driven via cancelOAuthLogin.
		const result = await this.request({ type: "login_oauth", provider }, null);
		if (!result.success) {
			throw new Error(redactDiagnosticString(result.error ?? "login_oauth failed"));
		}
		await this.refreshState();
	}

	async cancelOAuthLogin(): Promise<void> {
		const result = await this.request({ type: "cancel_login_oauth" });
		if (!result.success) {
			throw new Error(redactDiagnosticString(result.error ?? "cancel_login_oauth failed"));
		}
	}

	async respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
		if (!this.client) {
			throw new Error("Backend not started");
		}
		const payload: Record<string, unknown> =
			response.kind === "value" ? { value: response.value } : { cancelled: true };
		this.client.sendAuthPromptResponse(requestId, payload);
	}

	async refreshAuth(provider?: string): Promise<void> {
		const result = await this.request({ type: "refresh_auth", ...(provider !== undefined ? { provider } : {}) });
		if (!result.success) {
			throw new Error(redactDiagnosticString(result.error ?? "refresh_auth failed"));
		}
	}

	async getHandshake(): Promise<BackendHandshake> {
		if (!this.handshake) {
			throw new Error("Backend not started");
		}
		return this.handshake;
	}

	async respondToInteraction(id: string, response: InteractionResponse): Promise<void> {
		if (!this.client) {
			throw new Error("Backend not started");
		}
		const payload: Record<string, unknown> =
			response.kind === "value"
				? { value: response.value }
				: response.kind === "confirmed"
					? { confirmed: response.confirmed }
					: { cancelled: true };
		this.client.respondExtensionUi(id, payload);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private request<T = unknown>(
		command: Record<string, unknown>,
		timeoutMs?: number | null,
	): Promise<{ success: boolean; data?: T; error?: string }> {
		if (!this.client) {
			return Promise.reject(new Error("Backend not started"));
		}
		return this.client.request<T>(command as never, timeoutMs);
	}

	private async persistCurrentSession(): Promise<void> {
		const result = await this.request<{ path?: string }>({ type: "persist_session" });
		if (!result.success) {
			throw new Error(result.error ?? "persist_session failed");
		}
	}

	private writeLine(line: string): void {
		const stdin = this.process?.stdin;
		if (!stdin || stdin.destroyed) {
			return;
		}
		stdin.write(line, (error) => {
			if (error) {
				this.emit({ type: "error", message: `Failed to write to backend: ${error.message}`, source: "process" });
			}
		});
	}

	private async waitForReady(): Promise<boolean> {
		const deadline = Date.now() + this.options.startupTimeoutMs;
		while (Date.now() < deadline) {
			if (!this.client || this.client.isClosed) {
				return false;
			}
			try {
				const result = await this.client.request({ type: "get_state" }, 5_000);
				if (result.success) {
					this.latestState = normalizeState(result.data);
					return true;
				}
			} catch {
				// Process likely died; check below.
			}
			if (!this.process?.isRunning) {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
		}
		return false;
	}

	private async refreshState(): Promise<void> {
		if (!this.client) {
			return;
		}

		const lifecycleRevision = this.lifecycleRevision;
		const requestId = ++this.nextStateRequestId;

		try {
			const result = await this.client.request({ type: "get_state" });
			if (result.success) {
				const state = normalizeState(result.data);
				if (!state) {
					return;
				}
				// Drop stale responses: those captured before a lifecycle
				// transition (e.g. a streaming snapshot returning after
				// agent_settled) and those overtaken by a newer request.
				if (lifecycleRevision !== this.lifecycleRevision || requestId <= this.lastAppliedStateRequestId) {
					return;
				}
				this.lastAppliedStateRequestId = requestId;
				this.latestState = state;
				this.emit({ type: "state_changed", state });
			}
		} catch {
			// Backend unreachable; keep the last known state.
		}
	}

	private async refreshModels(): Promise<ModelInfo[]> {
		if (!this.client) {
			return this.cachedModels;
		}
		try {
			const result = await this.client.request({ type: "get_available_models" });
			if (result.success) {
				const models = normalizeModelList(result.data);
				if (models.length > 0) {
					this.cachedModels = models;
					return models;
				}
			}
		} catch {
			// Backend unreachable; fall through to the cached catalog.
		}
		// Never fabricate a single-model catalog from the current model: the
		// GUI would cache it and the model selector would stay stuck on one
		// entry. Return the last successful full catalog, or report the
		// failure explicitly.
		if (this.cachedModels.length > 0) {
			return this.cachedModels;
		}
		throw new Error("get_available_models failed");
	}

	private handleRawEvent(event: PiJsonEvent): void {
		const normalized = normalizeEvent(event);
		if (normalized) {
			this.applyEventToCache(normalized);
			this.emit(normalized);
		}
	}

	private applyEventToCache(event: AgentEvent): void {
		switch (event.type) {
			case "agent_started":
				this.lifecycleRevision += 1;
				this.latestState = this.latestState ? { ...this.latestState, isStreaming: true } : null;
				break;
			case "agent_stopped":
				this.lifecycleRevision += 1;
				this.latestState = this.latestState ? { ...this.latestState, isStreaming: false } : null;
				void this.refreshState();
				break;
			default:
				break;
		}
	}

	private handleExtensionUiRequest(request: PiExtensionUiRequest): void {
		const normalized = normalizeInteractionRequest(request);
		if (normalized) {
			this.emit({ type: "interaction_requested", request: normalized });
		} else {
			// Fire-and-forget methods we don't render yet still flow through.
			this.emit({
				type: "custom",
				namespace: "pi",
				name: `extension_ui_${request.method}`,
				payload: request,
			});
		}
	}

	private handleStderr(line: string): void {
		this.stderrTail.push(line);
		if (this.stderrTail.length > this.options.stderrRetention) {
			this.stderrTail.shift();
		}
		this.emit({ type: "custom", namespace: "gui-adapter", name: "backend_stderr", payload: line });
	}

	private handleExit(info: { code: number | null; signal: NodeJS.Signals | null; crashed: boolean }): void {
		this.client?.flushStdout();
		this.client?.close("Backend process exited");
		if (info.crashed && !this.stopping) {
			const tail = this.stderrTail.slice(-10).join("\n");
			const message = `Pi backend exited unexpectedly (code ${info.code ?? "null"}${info.signal ? `, signal ${info.signal}` : ""})${tail ? `:\n${tail}` : ""}`;
			this.emit({ type: "error", message, source: "process" });
			this.emit({ type: "custom", namespace: "gui-adapter", name: "backend_exited", payload: info });
		}
	}

	private currentSessionInfo(): SessionInfo {
		const state = this.latestState;
		const cached = this.cachedSessions.find((session) => session.id === state?.sessionId);
		return {
			...cached,
			id: state?.sessionId ?? "",
			file: state?.sessionFile ?? cached?.file,
			workspacePath: cached?.workspacePath ?? this.workspacePath,
			name: state?.sessionName ?? cached?.name,
		};
	}

	private emit(event: AgentEvent): void {
		for (const handler of this.subscribers) {
			handler(event);
		}
	}
}

function parseTimestamp(value: string): number | undefined {
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}
