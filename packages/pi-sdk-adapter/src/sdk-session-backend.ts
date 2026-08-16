/**
 * SdkSessionBackend: in-process AgentSessionBackend over the Pi coding-agent
 * SDK.
 *
 * One instance owns exactly one AgentSession. Nothing mutable is shared
 * between instances except the injected host-level model runtime, so N
 * instances run fully independent sessions in one process: streaming, tool
 * execution, abort, interactions and state stay session-local.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AgentEvent,
	AgentMessage,
	AgentSessionBackend,
	AgentState,
	InteractionResponse,
	MessageBlock,
	ModelInfo,
	ModelRef,
	SessionBackendConfig,
	SessionUsage,
	UserInteractionRequest,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import type {
	AgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { loadSdk } from "./sdk-loader.ts";
import {
	normalizeSdkEvent,
	normalizeSdkMessages,
	normalizeSdkModel,
	normalizeSdkState,
	normalizeSdkUsage,
} from "./sdk-normalizer.ts";

export interface SdkSessionBackendOptions {
	/** Shared model/auth runtime (owned by the host services); may be a promise. */
	modelRuntime: ModelRuntime | Promise<ModelRuntime>;
	/** Shared agent config directory (~/.pi/agent). */
	agentDir: string;
	/** Resolve the session directory for a workspace (Desktop storage policy). */
	resolveSessionDirectory(workspacePath: string): string | undefined;
	/** SessionManager override (tests). */
	sessionManager?: SessionManager;
	/** SettingsManager override (tests). */
	settingsManager?: SettingsManager;
}

interface PendingInteraction {
	resolve: (value: string | boolean | undefined) => void;
	reject: (reason: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class SdkSessionBackend implements AgentSessionBackend {
	private readonly options: SdkSessionBackendOptions;
	private readonly subscribers = new Set<(event: AgentEvent) => void>();
	private readonly pendingInteractions = new Map<string, PendingInteraction>();

	private session: AgentSession | undefined;
	private sessionManager: SessionManager | undefined;
	private unsubscribeSession: (() => void) | undefined;
	private modelFallbackMessage: string | undefined;

	constructor(options: SdkSessionBackendOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.session !== undefined;
	}

	/** True while the session has an active agent run. */
	get isStreaming(): boolean {
		return this.session?.isStreaming ?? false;
	}

	get isIdle(): boolean {
		return this.session === undefined || this.session.isIdle;
	}

	get sessionId(): string | undefined {
		return this.sessionManager?.getSessionId();
	}

	get hasPendingInteractions(): boolean {
		return this.pendingInteractions.size > 0;
	}

	/** Session creation warning (model fallback), if any. */
	get modelFallback(): string | undefined {
		return this.modelFallbackMessage;
	}

	subscribe(handler: (event: AgentEvent) => void): () => void {
		this.subscribers.add(handler);
		return () => this.subscribers.delete(handler);
	}

	async start(config: SessionBackendConfig): Promise<void> {
		if (this.session) {
			throw new Error("Backend already started");
		}
		const sdk = await loadSdk();
		const modelRuntime = await this.options.modelRuntime;
		const sessionDir = this.options.resolveSessionDirectory(config.workspacePath);

		const sessionManager =
			this.options.sessionManager ??
			(config.sessionFile
				? sdk.SessionManager.open(config.sessionFile, sessionDir, config.workspacePath)
				: sdk.SessionManager.create(
						config.workspacePath,
						sessionDir,
						config.sessionId ? { id: config.sessionId } : undefined,
					));
		this.sessionManager = sessionManager;

		const { session, modelFallbackMessage } = await sdk.createAgentSession({
			cwd: config.workspacePath,
			agentDir: this.options.agentDir,
			modelRuntime,
			settingsManager:
				this.options.settingsManager ?? sdk.SettingsManager.create(config.workspacePath, this.options.agentDir),
			sessionManager,
			model:
				config.model !== undefined ? modelRuntime.getModel(config.model.provider, config.model.modelId) : undefined,
		});
		this.session = session;
		this.modelFallbackMessage = modelFallbackMessage;

		// The subscriber is wired before bindExtensions so extension UI
		// requests raised during extension startup are observable.
		this.unsubscribeSession = session.subscribe((event) => {
			try {
				const normalized = normalizeSdkEvent(event);
				if (normalized) {
					this.emit(normalized);
				}
			} catch {
				// §15.1: a throwing event consumer must not break the session's
				// own event pipeline; the error is isolated to this consumer.
			}
		});
		await session.bindExtensions({ uiContext: this.createUiContext(), mode: "rpc" });
	}

	async stop(): Promise<void> {
		const session = this.session;
		if (!session) {
			return;
		}
		// Settle every pending interaction so extensions do not hang forever.
		for (const entry of this.pendingInteractions.values()) {
			entry.reject(new Error("Backend stopped"));
		}
		this.pendingInteractions.clear();
		this.unsubscribeSession?.();
		this.unsubscribeSession = undefined;
		session.dispose();
		this.session = undefined;
	}

	async sendMessage(message: UserMessage): Promise<void> {
		const session = this.requireSession();
		const text = typeof message.content === "string" ? message.content : messageText(message);
		const images =
			typeof message.content === "string"
				? undefined
				: message.content
						.filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image")
						.map((block) => ({ type: "image" as const, data: block.data, mimeType: block.mimeType }));
		// Mirror the RPC mode prompt contract: steering while streaming;
		// preflight acceptance decides whether the host sees the prompt as
		// accepted. The promise resolves once the prompt is queued.
		await new Promise<void>((resolve, reject) => {
			let preflightSucceeded = false;
			void session
				.prompt(text, {
					...(images !== undefined && images.length > 0 ? { images } : {}),
					...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
					source: "rpc",
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							preflightSucceeded = true;
							resolve();
						}
					},
				})
				.catch((error: unknown) => {
					if (!preflightSucceeded) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				});
		});
	}

	async abort(): Promise<void> {
		await this.requireSession().abort();
	}

	async getState(): Promise<AgentState> {
		const session = this.requireSession();
		return normalizeSdkState({
			sessionId: session.sessionId,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			sessionFile: session.sessionFile,
			sessionName: session.sessionName,
			autoCompactionEnabled: session.autoCompactionEnabled,
			pendingMessageCount: session.pendingMessageCount,
			messageCount: session.messages.length,
		});
	}

	async getMessages(): Promise<AgentMessage[]> {
		return normalizeSdkMessages(this.requireSession().messages);
	}

	async getSessionUsage(): Promise<SessionUsage> {
		return normalizeSdkUsage(this.requireSession().getSessionStats());
	}

	async setModel(modelRef: ModelRef): Promise<ModelInfo | null> {
		const modelRuntime = await this.options.modelRuntime;
		const model = modelRuntime
			.getAvailableSnapshot()
			.find((entry) => entry.provider === modelRef.provider && entry.id === modelRef.modelId);
		if (!model) {
			throw new Error(`Model not found: ${modelRef.provider}/${modelRef.modelId}`);
		}
		await this.requireSession().setModel(model);
		return normalizeSdkModel(this.requireSession().model);
	}

	async listThinkingLevels(): Promise<string[]> {
		return [...this.requireSession().getAvailableThinkingLevels()];
	}

	async setThinkingLevel(level: string): Promise<void> {
		// setThinkingLevel clamps to the current model's capabilities and
		// persists a thinking_level_change entry (session-local state).
		this.requireSession().setThinkingLevel(level as ThinkingLevel);
	}

	async respondToInteraction(id: string, response: InteractionResponse): Promise<void> {
		const pending = this.pendingInteractions.get(id);
		if (!pending) {
			throw new Error(`Interaction not found: ${id}`);
		}
		this.pendingInteractions.delete(id);
		if (pending.signal && pending.onAbort) {
			pending.signal.removeEventListener("abort", pending.onAbort);
		}
		switch (response.kind) {
			case "value":
				pending.resolve(response.value);
				break;
			case "confirmed":
				pending.resolve(response.confirmed);
				break;
			case "cancelled":
				pending.resolve(undefined);
				break;
		}
	}

	/**
	 * Rename this session through the live SessionManager (single-writer
	 * semantics: the manager keeps its loaded entries and the on-disk file
	 * consistent; a session_info_changed event is emitted).
	 */
	renameSession(name: string): void {
		const session = this.requireSession();
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		if (!sanitizedName) {
			throw new Error("Session name cannot be empty");
		}
		if (sanitizedName.length > 160) {
			throw new Error("Session name cannot exceed 160 characters");
		}
		session.setSessionName(sanitizedName);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private requireSession(): AgentSession {
		if (!this.session) {
			throw new Error("Backend not started");
		}
		return this.session;
	}

	private emit(event: AgentEvent): void {
		for (const handler of this.subscribers) {
			try {
				handler(event);
			} catch {
				// §15.1: consumer exceptions are isolated per handler.
			}
		}
	}

	private requestInteraction(
		kind: "select" | "confirm" | "input" | "editor",
		request: Omit<UserInteractionRequest, "id" | "kind">,
		signal?: AbortSignal,
	): Promise<string | boolean | undefined> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		return new Promise<string | boolean | undefined>((resolve, reject) => {
			const onAbort = (): void => {
				this.pendingInteractions.delete(id);
				reject(new Error("Interaction cancelled"));
			};
			this.pendingInteractions.set(id, { resolve, reject, signal, onAbort });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.emit({
				type: "interaction_requested",
				request: { id, kind, ...request },
			});
			if (signal?.aborted) {
				onAbort();
			}
		});
	}

	/** Builds the extension UI context (protected for test access). */
	protected createUiContext() {
		return {
			select: (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
				this.requestInteraction("select", { title, options: [...options] }, opts?.signal) as Promise<
					string | undefined
				>,
			confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) =>
				this.requestInteraction("confirm", { title, message }, opts?.signal) as Promise<boolean>,
			input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
				this.requestInteraction(
					"input",
					{ title, ...(placeholder !== undefined ? { placeholder } : {}) },
					opts?.signal,
				) as Promise<string | undefined>,
			notify: (message: string, type?: "info" | "warning" | "error") => {
				this.emit({
					type: "interaction_requested",
					request: {
						id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
						kind: "notification",
						message,
						...(type !== undefined ? { notifyType: type } : {}),
					},
				});
			},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined as never,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: (title: string, prefill?: string) =>
				this.requestInteraction("editor", { title, ...(prefill !== undefined ? { prefill } : {}) }) as Promise<
					string | undefined
				>,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme: new Proxy({} as Theme, { get: () => undefined }) as Theme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not supported in the GUI" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}
}

function messageText(message: UserMessage): string {
	const blocks = message.content;
	if (typeof blocks === "string") {
		return blocks;
	}
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}
