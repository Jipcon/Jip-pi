/**
 * LegacyBackendManager: adapts the legacy one-workspace / one-active-session
 * RPC BackendManager to the session-routed facade.
 *
 * Only for migration/regression comparison (PI_DESKTOP_LEGACY_BACKEND=1):
 * switching sessions keeps the legacy teardown semantics (no concurrent
 * streaming across sessions), rename/delete keep the legacy active-session
 * guards, and there is never more than one live backend per workspace.
 */

import type {
	AgentMessage,
	AgentState,
	AuthPromptResponse,
	EditAndResendResult,
	EditableUserMessage,
	InteractionResponse,
	ModelInfo,
	ModelRef,
	ProviderAuthStatus,
	SessionInfo,
	SessionUsage,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import type { BackendStatus, RoutedAgentEvent, SessionSnapshot, SessionStorageConfig } from "../shared/ipc.ts";
import { workspacePathKey } from "../shared/workspace-path.ts";
import type { DesktopAgentRuntime } from "./agent-runtime.ts";
import { BackendManager } from "./backend-manager.ts";

export interface LegacyBackendManagerOptions {
	findSession(sessionId: string): Promise<SessionInfo | null>;
	renameCatalogSession(sessionId: string, name: string): Promise<void>;
	deleteCatalogFile(filePath: string): Promise<void>;
}

export class LegacyBackendManager implements DesktopAgentRuntime {
	private readonly delegate = new BackendManager();
	private readonly options: LegacyBackendManagerOptions;
	private lastSessionId: string | null = null;
	private lastStreaming = false;

	constructor(options: LegacyBackendManagerOptions) {
		this.options = options;
		this.delegate.onEvent((event) => {
			if (event.type === "state_changed") {
				this.lastSessionId = event.state.sessionId;
				this.lastStreaming = event.state.isStreaming;
			}
			const workspace = this.delegate.currentStatus.workspace;
			if (!workspace || !this.lastSessionId) {
				return;
			}
			this.emitEvent({ workspaceId: workspace, sessionId: this.lastSessionId, event });
		});
	}

	get currentStatus(): BackendStatus {
		return this.delegate.currentStatus;
	}

	get currentSessionStorage(): SessionStorageConfig {
		return this.delegate.currentSessionStorage;
	}

	get isRunning(): boolean {
		return this.delegate.isRunning;
	}

	get hasLiveBackends(): boolean {
		return this.delegate.hasLiveBackends;
	}

	get isAnySessionStreaming(): boolean {
		return this.lastStreaming;
	}

	setSessionStorage(config: SessionStorageConfig): void {
		this.delegate.setSessionStorage(config);
	}

	setActiveSession(_workspace: string, _sessionId: string): void {
		// Legacy active session is backend-driven; switching happens on demand.
	}

	onEvent(handler: (event: RoutedAgentEvent) => void): () => void {
		return this.onRoutedEvent(handler);
	}

	onStatus(handler: (status: BackendStatus) => void): () => void {
		return this.delegate.onStatus(handler);
	}

	onLog(handler: (line: string) => void): () => void {
		return this.delegate.onLog(handler);
	}

	start(workspace: string): Promise<string | undefined> {
		return this.delegate.start(workspace);
	}

	discardWorkspace(workspace: string): Promise<void> {
		return this.delegate.discardWorkspace(workspace);
	}

	deactivateWorkspace(workspace: string): void {
		this.delegate.deactivateWorkspace(workspace);
	}

	stop(): Promise<void> {
		return this.delegate.stop();
	}

	stopAllBackends(): Promise<void> {
		return this.delegate.stopAllBackends();
	}

	async openSession(workspaceId: string, sessionId: string): Promise<SessionSnapshot> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return {
			state: await this.delegate.getState(),
			messages: await this.delegate.getMessages(),
			usage: await this.delegate.getSessionUsage().catch(() => null),
		};
	}

	async sendMessage(workspaceId: string, sessionId: string, message: UserMessage): Promise<void> {
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.sendMessage(message);
	}

	async abort(workspaceId: string, sessionId: string): Promise<void> {
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.abort();
	}

	async getState(workspaceId: string, sessionId: string): Promise<AgentState> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return this.delegate.getState();
	}

	async getMessages(workspaceId: string, sessionId: string): Promise<AgentMessage[]> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return this.delegate.getMessages();
	}

	async getSessionUsage(workspaceId: string, sessionId: string): Promise<SessionUsage | null> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return this.delegate.getSessionUsage().catch(() => null);
	}

	async setModel(workspaceId: string, sessionId: string, model: ModelRef): Promise<ModelInfo | null> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return this.delegate.setModel(model);
	}

	async listThinkingLevels(workspaceId: string, sessionId: string): Promise<string[]> {
		await this.ensureActiveSession(workspaceId, sessionId);
		return this.delegate.listThinkingLevels();
	}

	async setThinkingLevel(workspaceId: string, sessionId: string, level: string): Promise<void> {
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.setThinkingLevel(level);
	}

	async respondInteraction(
		workspaceId: string,
		sessionId: string,
		id: string,
		response: InteractionResponse,
	): Promise<void> {
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.respondInteraction(id, response);
	}

	async createSession(workspaceId: string): Promise<SessionInfo> {
		await this.ensureWorkspaceStarted(workspaceId);
		const session = await this.delegate.newSession();
		this.lastSessionId = session.id;
		return { ...session, workspacePath: session.workspacePath ?? workspaceId };
	}

	async listSessions(workspaceId: string): Promise<SessionInfo[]> {
		const active = this.delegate.currentStatus.workspace;
		if (!this.delegate.isRunning || !active || workspacePathKey(active) !== workspacePathKey(workspaceId)) {
			// No live backend for this workspace: the renderer falls back to the catalog.
			return [];
		}
		return this.delegate.listSessions();
	}

	async renameSession(workspaceId: string, sessionId: string, name: string): Promise<void> {
		const active = this.delegate.currentStatus.workspace;
		if (!this.delegate.isRunning || !active || workspacePathKey(active) !== workspacePathKey(workspaceId)) {
			// Sessions of non-active workspaces are renamed through the
			// catalog (no backend teardown for a background workspace).
			await this.options.renameCatalogSession(sessionId, name);
			return;
		}
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.renameSession(sessionId, name);
	}

	async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
		const active = this.delegate.currentStatus.workspace;
		if (!this.delegate.isRunning || !active || workspacePathKey(active) !== workspacePathKey(workspaceId)) {
			const session = await this.options.findSession(sessionId);
			if (!session?.file) {
				throw new Error(`Session not found: ${sessionId}`);
			}
			await this.options.deleteCatalogFile(session.file);
			return;
		}
		await this.ensureActiveSession(workspaceId, sessionId);
		await this.delegate.deleteSession(sessionId);
	}

	/** Legacy RPC mode does not support message editing (capability off). */
	listEditableUserMessages(_workspaceId: string, _sessionId: string): Promise<EditableUserMessage[]> {
		throw new Error("Message editing is not supported in legacy backend mode");
	}

	editUserMessage(
		_workspaceId: string,
		_sessionId: string,
		_entryId: string,
		_text: string,
	): Promise<EditAndResendResult> {
		throw new Error("Message editing is not supported in legacy backend mode");
	}

	listModels(): Promise<ModelInfo[]> {
		return this.delegate.listModels();
	}

	reloadModels(): Promise<void> {
		return this.delegate.reloadModels();
	}

	listModelsByIds(ids: string[]): Promise<ModelInfo[]> {
		return this.delegate.listModelsByIds(ids);
	}

	listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
		return this.delegate.listProviderAuthStatus();
	}

	setApiKey(provider: string, apiKey: string): Promise<void> {
		return this.delegate.setApiKey(provider, apiKey);
	}

	removeCredential(provider: string): Promise<void> {
		return this.delegate.removeCredential(provider);
	}

	loginWithOAuth(provider: string): Promise<void> {
		return this.delegate.loginWithOAuth(provider);
	}

	cancelOAuthLogin(): Promise<void> {
		return this.delegate.cancelOAuthLogin();
	}

	respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
		return this.delegate.respondToAuthPrompt(requestId, response);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private readonly routedListeners = new Set<(event: RoutedAgentEvent) => void>();

	private onRoutedEvent(handler: (event: RoutedAgentEvent) => void): () => void {
		this.routedListeners.add(handler);
		return () => this.routedListeners.delete(handler);
	}

	private emitEvent(event: RoutedAgentEvent): void {
		for (const handler of this.routedListeners) {
			try {
				handler(event);
			} catch {
				// Consumer exceptions are isolated per handler.
			}
		}
	}

	private async ensureWorkspaceStarted(workspace: string): Promise<void> {
		const active = this.delegate.currentStatus.workspace;
		if (this.delegate.isRunning && active && workspacePathKey(active) === workspacePathKey(workspace)) {
			return;
		}
		const error = await this.delegate.start(workspace);
		if (error !== undefined) {
			throw new Error(error);
		}
	}

	private async ensureActiveSession(workspace: string, sessionId: string): Promise<void> {
		await this.ensureWorkspaceStarted(workspace);
		const state = await this.delegate.getState();
		if (state.sessionId !== sessionId) {
			// Legacy semantics: switching while streaming is rejected by the
			// backend (single active session, no concurrent runs).
			await this.delegate.switchSession(sessionId);
			this.lastSessionId = sessionId;
		}
	}
}
