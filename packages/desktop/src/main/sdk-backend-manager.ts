/**
 * SdkBackendManager: two-level pool of in-process SdkSessionBackends.
 *
 *   BackendManager
 *   ├─ warm Workspace A ─ Map<sessionId, SessionBackendRecord>
 *   ├─ warm Workspace B ─ Map<...>
 *   └─ ...
 *
 * - A workspace needs no backend at all: opening it is a status transition,
 *   and host services (models/auth) work with zero session backends.
 * - Each session backend owns exactly one AgentSession; backends are created
 *   lazily (first prompt or explicit open) and shared across switches.
 * - Workspace warm semantics and async race protection from the legacy pool
 *   are preserved (MAX_WARM_WORKSPACES + switchGeneration).
 * - Idle background backends are LRU-evicted per workspace; running,
 *   interaction-pending and UI-active sessions are pinned.
 */

import {
	type AgentHostServices,
	type AgentMessage,
	type AgentSessionBackend,
	type AgentState,
	type AuthPromptResponse,
	type EditAndResendResult,
	type EditableUserMessage,
	type InteractionResponse,
	type ModelInfo,
	type ModelRef,
	messageText,
	type ProviderAuthStatus,
	type SessionInfo,
	type SessionUsage,
	type UserMessage,
} from "@earendil-works/pi-agent-protocol";
import type { ModelRuntime } from "@earendil-works/pi-sdk-adapter";
import { SdkSessionBackend } from "@earendil-works/pi-sdk-adapter";
import type { BackendStatus, RoutedAgentEvent, SessionSnapshot, SessionStorageConfig } from "../shared/ipc.ts";
import { DEFAULT_SESSION_STORAGE } from "../shared/ipc.ts";
import { workspacePathKey } from "../shared/workspace-path.ts";
import type { DesktopAgentRuntime } from "./agent-runtime.ts";
import { resolveSessionDirectory } from "./session-storage.ts";

/** How many workspaces may stay warm (legacy semantics preserved). */
const MAX_WARM_WORKSPACES = 2;
/**
 * Upper bound on background idle session backends per workspace. Pinned
 * backends (running, pending interaction, UI-active) never count against
 * this limit. The concrete value is measured in the delivery report.
 */
export const MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE = 4;

/** A session backend plus the pool bookkeeping fields the manager needs. */
export interface ManagedSessionBackend extends AgentSessionBackend {
	readonly isRunning: boolean;
	readonly isStreaming: boolean;
	readonly hasPendingInteractions: boolean;
	readonly sessionId: string | undefined;
	renameSession?(name: string): void;
	/**
	 * Editable user messages on the live leaf path, when the backend owns a
	 * session manager (SDK path). Optional so legacy backends can omit it.
	 */
	editableUserMessages?(): EditableUserMessage[];
	/**
	 * Edit a past user message in place and resend it (in-file branch), when
	 * the backend owns a live session (SDK path). Optional so legacy
	 * backends can omit it.
	 */
	editAndResend?(entryId: string, text: string): Promise<EditAndResendResult>;
}

export interface SdkBackendManagerOptions {
	agentDir: string;
	/** Host services with the shared runtime promise exposed. */
	hostServices: AgentHostServices & { sharedRuntime: Promise<ModelRuntime> };
	/** Read a session's full history through Pi's own parser (catalog). */
	readSessionHistory(filePath: string): Promise<AgentMessage[]>;
	/** Compute usage stats for a persisted session without a live backend. */
	readSessionUsage(
		filePath: string,
		options: {
			sessionId: string;
			resolveContextWindow(model: { provider: string; modelId: string } | null): number | undefined;
		},
	): Promise<SessionUsage>;
	/** Resolve session metadata by id (cached catalog). */
	findSession(sessionId: string): Promise<SessionInfo | null>;
	/** Cached session catalog for all workspaces; live state is layered on top. */
	listCatalogSessions(): Promise<SessionInfo[]>;
	/** Create a persisted session identity through the SDK SessionManager. */
	createSessionFile(workspacePath: string, sessionDir?: string): Promise<{ sessionId: string; sessionFile: string }>;
	/** Rename a session's metadata on disk (no live backend). */
	renameCatalogSession(sessionId: string, name: string): Promise<void>;
	/** Delete a session file from disk (recycle bin). */
	deleteCatalogFile(filePath: string): Promise<void>;
	/** Backend factory (tests inject an in-process fake). */
	createSessionBackend?(workspace: string): ManagedSessionBackend;
	/**
	 * Predict the model/thinking defaults a fresh (message-less) session will
	 * materialize with, so pending sessions display their real defaults
	 * instead of the selectors' first-option fallback. Best-effort: failures
	 * leave the state fields unset.
	 */
	resolveFreshSessionDefaults?(
		workspacePath: string,
		pendingModel?: ModelRef,
	): Promise<{ model: ModelInfo | null; thinkingLevel: string }>;
	/**
	 * Read a persisted session's file-recorded model/thinking state (mirrors
	 * createAgentSession's restore path), so reopened historical sessions
	 * display their real model before materialization. Best-effort: failures
	 * leave the state fields unset.
	 */
	readPersistedSessionState?(filePath: string): Promise<{ model: ModelInfo | null; thinkingLevel?: string }>;
	/** Read the editable user messages of a persisted session (no live backend). */
	readEditableUserMessages(filePath: string): Promise<EditableUserMessage[]>;
}

interface SessionBackendRecord {
	workspaceKey: string;
	workspace: string;
	sessionId: string;
	backend: ManagedSessionBackend;
	lastUsedAt: number;
	startPromise?: Promise<void>;
}

interface WorkspaceRecord {
	key: string;
	path: string;
	sessions: Map<string, SessionBackendRecord>;
	lastUsedAt: number;
	/** UI-focused session; pinned against eviction. */
	activeSessionId?: string;
}

interface PendingSessionConfig {
	model?: ModelRef;
	thinkingLevel?: string;
}

export class SdkBackendManager implements DesktopAgentRuntime {
	private readonly options: SdkBackendManagerOptions;
	private readonly workspaces = new Map<string, WorkspaceRecord>();
	private readonly eventListeners = new Set<(event: RoutedAgentEvent) => void>();
	private readonly statusListeners = new Set<(status: BackendStatus) => void>();
	private readonly logListeners = new Set<(line: string) => void>();

	private sessionStorage: SessionStorageConfig = { ...DEFAULT_SESSION_STORAGE };
	private status: BackendStatus = { phase: "no-workspace", workspace: null };
	private activeWorkspaceKey: string | null = null;
	/** Bumped on lifecycle transitions; stale async materializations must not linger. */
	private switchGeneration = 0;
	/** Model/thinking choices made before a session's backend exists. */
	private readonly pendingConfigs = new Map<string, PendingSessionConfig>();

	constructor(options: SdkBackendManagerOptions) {
		this.options = options;
	}

	get currentStatus(): BackendStatus {
		return this.status;
	}

	get currentSessionStorage(): SessionStorageConfig {
		return { ...this.sessionStorage };
	}

	get isRunning(): boolean {
		return this.status.phase === "running";
	}

	get hasLiveBackends(): boolean {
		for (const workspace of this.workspaces.values()) {
			for (const record of workspace.sessions.values()) {
				if (record.backend.isRunning) {
					return true;
				}
			}
		}
		return false;
	}

	get isAnySessionStreaming(): boolean {
		for (const workspace of this.workspaces.values()) {
			for (const record of workspace.sessions.values()) {
				if (record.backend.isStreaming) {
					return true;
				}
			}
		}
		return false;
	}

	setSessionStorage(config: SessionStorageConfig): void {
		this.sessionStorage = { ...config };
	}

	setActiveSession(workspace: string, sessionId: string): void {
		const record = this.workspaces.get(workspacePathKey(workspace));
		if (!record) {
			return;
		}
		record.activeSessionId = sessionId;
	}

	onEvent(handler: (event: RoutedAgentEvent) => void): () => void {
		this.eventListeners.add(handler);
		return () => this.eventListeners.delete(handler);
	}

	onStatus(handler: (status: BackendStatus) => void): () => void {
		this.statusListeners.add(handler);
		return () => this.statusListeners.delete(handler);
	}

	onLog(handler: (line: string) => void): () => void {
		this.logListeners.add(handler);
		return () => this.logListeners.delete(handler);
	}

	// -----------------------------------------------------------------------
	// Workspace lifecycle
	// -----------------------------------------------------------------------

	async start(workspace: string): Promise<string | undefined> {
		this.switchGeneration += 1;
		const key = workspacePathKey(workspace);
		let record = this.workspaces.get(key);
		if (!record) {
			record = { key, path: workspace, sessions: new Map(), lastUsedAt: 0 };
			this.workspaces.set(key, record);
		}
		record.lastUsedAt = Date.now();
		this.activeWorkspaceKey = key;
		this.setStatus({ phase: "running", workspace });
		void this.options.hostServices.getHandshake().then((handshake) => {
			if (this.status.phase === "running" && this.status.workspace === workspace) {
				this.setStatus({ phase: "running", workspace, handshake });
			}
		});
		this.evictWorkspaces();
		return undefined;
	}

	/** Stop every backend for a removed workspace. */
	async discardWorkspace(workspace: string): Promise<void> {
		this.switchGeneration += 1;
		const key = workspacePathKey(workspace);
		const record = this.workspaces.get(key);
		if (!record) {
			return;
		}
		this.workspaces.delete(key);
		if (this.activeWorkspaceKey === key) {
			this.activeWorkspaceKey = null;
		}
		for (const sessionRecord of record.sessions.values()) {
			await sessionRecord.backend.stop().catch(() => {});
		}
	}

	/** Reset status to no-workspace after the active workspace was removed. */
	deactivateWorkspace(workspace: string): void {
		if (this.status.workspace && workspacePathKey(this.status.workspace) === workspacePathKey(workspace)) {
			this.setStatus({ phase: "no-workspace", workspace: null });
		}
	}

	/** Stop everything and forget the pools (app quit). */
	async stop(): Promise<void> {
		this.switchGeneration += 1;
		const workspace = this.status.workspace ?? null;
		await this.options.hostServices.cancelOAuthLogin().catch(() => {});
		await this.disposeAll();
		this.setStatus({ phase: "stopped", workspace });
	}

	/** Dispose every backend and forget the pools (§11.2). */
	async disposeAll(): Promise<void> {
		this.switchGeneration += 1;
		for (const record of this.workspaces.values()) {
			for (const sessionRecord of record.sessions.values()) {
				await sessionRecord.backend.stop().catch(() => {});
			}
		}
		this.workspaces.clear();
		this.activeWorkspaceKey = null;
		this.pendingConfigs.clear();
	}

	/** Stop every backend without touching status (session storage changed). */
	async stopAllBackends(): Promise<void> {
		await this.options.hostServices.cancelOAuthLogin().catch(() => {});
		await this.disposeAll();
	}

	// -----------------------------------------------------------------------
	// Backend pool (§11.2)
	// -----------------------------------------------------------------------

	/** The session's backend if it is materialized and alive. */
	getBackend(workspace: string, sessionId: string): ManagedSessionBackend | undefined {
		const record = this.workspaces.get(workspacePathKey(workspace))?.sessions.get(sessionId);
		return record?.backend.isRunning ? record.backend : undefined;
	}

	/** Materialize a session backend, or return the existing one (idempotent). */
	async getOrCreateBackend(workspace: string, sessionId: string): Promise<ManagedSessionBackend> {
		const existing = this.getBackend(workspace, sessionId);
		if (existing) {
			this.touch(workspace, sessionId);
			return existing;
		}
		const generation = this.switchGeneration;
		const key = workspacePathKey(workspace);
		const workspaceRecord = this.workspaces.get(key) ?? {
			key,
			path: workspace,
			sessions: new Map<string, SessionBackendRecord>(),
			lastUsedAt: Date.now(),
		};
		this.workspaces.set(key, workspaceRecord);
		workspaceRecord.lastUsedAt = Date.now();

		const pending = this.takePendingConfig(workspace, sessionId);
		const backend = this.createBackend(workspace);
		const record: SessionBackendRecord = {
			workspaceKey: key,
			workspace,
			sessionId,
			backend,
			lastUsedAt: Date.now(),
		};
		workspaceRecord.sessions.set(sessionId, record);
		record.startPromise = backend.start({
			workspacePath: workspace,
			sessionId,
			sessionFile: (await this.options.findSession(sessionId))?.file,
			...(pending?.model !== undefined ? { model: pending.model } : {}),
		});
		try {
			await record.startPromise;
			if (pending?.thinkingLevel !== undefined) {
				await backend.setThinkingLevel(pending.thinkingLevel).catch(() => {});
			}
		} catch (error) {
			// §10: a failed materialization removes the record and keeps the
			// pool intact; other sessions are unaffected.
			workspaceRecord.sessions.delete(sessionId);
			await backend.stop().catch(() => {});
			throw error;
		}
		if (generation !== this.switchGeneration || this.getBackend(workspace, sessionId) !== backend) {
			// Superseded while materializing: dispose the orphan.
			await backend.stop().catch(() => {});
			const current = this.getBackend(workspace, sessionId);
			if (current) {
				return current;
			}
			throw new Error("Session backend was disposed while starting");
		}
		// The open-time snapshot of a not-yet-materialized session can carry no
		// model (e.g. opened from history): push the authoritative state now
		// that the backend exists so the renderer's selectors catch up.
		try {
			const state = await backend.getState();
			this.routeEvent(backend, workspace, { type: "state_changed", state });
		} catch {
			// The push is best-effort; explicit state refreshes still work.
		}
		this.evictIdleIn(workspaceRecord);
		return backend;
	}

	/** Dispose one session backend (no-op when absent). */
	async disposeBackend(workspace: string, sessionId: string): Promise<void> {
		this.switchGeneration += 1;
		const record = this.workspaces.get(workspacePathKey(workspace))?.sessions.get(sessionId);
		if (!record) {
			return;
		}
		this.workspaces.get(workspacePathKey(workspace))?.sessions.delete(sessionId);
		await record.backend.stop().catch(() => {});
	}

	/** Dispose every backend of a workspace. */
	async disposeWorkspace(workspace: string): Promise<void> {
		this.switchGeneration += 1;
		const record = this.workspaces.get(workspacePathKey(workspace));
		if (!record) {
			return;
		}
		this.workspaces.delete(record.key);
		if (this.activeWorkspaceKey === record.key) {
			this.activeWorkspaceKey = null;
		}
		for (const sessionRecord of record.sessions.values()) {
			await sessionRecord.backend.stop().catch(() => {});
		}
	}

	// -----------------------------------------------------------------------
	// Session execution
	// -----------------------------------------------------------------------

	async openSession(workspaceId: string, sessionId: string): Promise<SessionSnapshot> {
		const existing = this.getBackend(workspaceId, sessionId);
		if (existing) {
			this.touch(workspaceId, sessionId);
			return {
				state: await existing.getState(),
				messages: await existing.getMessages(),
				usage: await existing.getSessionUsage().catch(() => null),
			};
		}
		// Not materialized: history comes from the catalog (Pi's own parser);
		// model/thinking come from the pending config. No AgentSession is
		// created here — 500 historical sessions stay out of memory.
		const session = await this.options.findSession(sessionId);
		const messages = session?.file ? await this.options.readSessionHistory(session.file) : [];
		const models = await this.options.hostServices.listModels();
		const pending = this.pendingConfigs.get(this.pendingKey(workspaceId, sessionId));
		let model: ModelInfo | null = pending?.model
			? (models.find((entry) => entry.provider === pending.model?.provider && entry.id === pending.model?.modelId) ??
				null)
			: null;
		let thinkingLevel: string | undefined = pending?.thinkingLevel;
		// A fresh (message-less) session has no materialized defaults yet:
		// predict them so the UI shows the real model and thinking level
		// before the AgentSession exists, instead of selector fallbacks.
		if (
			messages.length === 0 &&
			(model === null || thinkingLevel === undefined) &&
			this.options.resolveFreshSessionDefaults
		) {
			try {
				const defaults = await this.options.resolveFreshSessionDefaults(workspaceId, pending?.model);
				model ??= defaults.model;
				thinkingLevel ??= defaults.thinkingLevel;
			} catch {
				// Defaults resolution is best-effort; never block opening a session.
			}
		}
		// A historical session restores its file-recorded model and thinking
		// level on materialization (createAgentSession's restore path): show
		// them now instead of the selector fallbacks.
		if (session?.file && (model === null || thinkingLevel === undefined) && this.options.readPersistedSessionState) {
			try {
				const persisted = await this.options.readPersistedSessionState(session.file);
				model ??= persisted.model;
				thinkingLevel ??= persisted.thinkingLevel;
			} catch {
				// Persisted-state resolution is best-effort; never block opening.
			}
		}
		// Historical sessions still report usage: aggregate the JSONL file
		// instead of waiting for a backend to materialize.
		const usage = session?.file ? await this.historicalUsage(sessionId) : null;
		const state: AgentState = {
			model,
			isStreaming: false,
			isCompacting: false,
			sessionId,
			messageCount: messages.length,
			...(session?.file !== undefined ? { sessionFile: session.file } : {}),
			...(session?.name !== undefined ? { sessionName: session.name } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		};
		return { state, messages, usage };
	}

	async sendMessage(workspaceId: string, sessionId: string, message: UserMessage): Promise<void> {
		const backend = await this.getOrCreateBackend(workspaceId, sessionId);
		await backend.sendMessage(message);
	}

	async abort(workspaceId: string, sessionId: string): Promise<void> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (!backend) {
			// Nothing materialized: abort is a no-op.
			return;
		}
		await backend.abort();
	}

	async getState(workspaceId: string, sessionId: string): Promise<AgentState> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend) {
			return backend.getState();
		}
		return (await this.openSession(workspaceId, sessionId)).state;
	}

	async getMessages(workspaceId: string, sessionId: string): Promise<AgentMessage[]> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend) {
			return backend.getMessages();
		}
		return (await this.openSession(workspaceId, sessionId)).messages;
	}

	async getSessionUsage(workspaceId: string, sessionId: string): Promise<SessionUsage | null> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (!backend) {
			// Not materialized: aggregate the JSONL file instead, so historical
			// sessions report usage without launching a backend.
			return this.historicalUsage(sessionId);
		}
		return backend.getSessionUsage().catch(() => null);
	}

	/** Usage for a session without a live backend, aggregated from its JSONL file. */
	private async historicalUsage(sessionId: string): Promise<SessionUsage | null> {
		const session = await this.options.findSession(sessionId);
		if (!session?.file) {
			return null;
		}
		const models = await this.options.hostServices.listModels();
		return this.options
			.readSessionUsage(session.file, {
				sessionId,
				resolveContextWindow: (sessionModel) =>
					sessionModel
						? models.find(
								(entry) => entry.provider === sessionModel.provider && entry.id === sessionModel.modelId,
							)?.contextWindow
						: undefined,
			})
			.catch(() => null);
	}

	async setModel(workspaceId: string, sessionId: string, model: ModelRef): Promise<ModelInfo | null> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend) {
			return backend.setModel(model);
		}
		// Pending config: applied when the session materializes (§7.6).
		const key = this.pendingKey(workspaceId, sessionId);
		const current = this.pendingConfigs.get(key) ?? {};
		this.pendingConfigs.set(key, { ...current, model });
		return (
			(await this.options.hostServices.listModels()).find(
				(entry) => entry.provider === model.provider && entry.id === model.modelId,
			) ?? null
		);
	}

	async listThinkingLevels(workspaceId: string, sessionId: string): Promise<string[]> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend) {
			return backend.listThinkingLevels();
		}
		// Pending sessions have no model yet: the renderer falls back to the
		// full level list until the session materializes.
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	}

	async setThinkingLevel(workspaceId: string, sessionId: string, level: string): Promise<void> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend) {
			await backend.setThinkingLevel(level);
			return;
		}
		const key = this.pendingKey(workspaceId, sessionId);
		const current = this.pendingConfigs.get(key) ?? {};
		this.pendingConfigs.set(key, { ...current, thinkingLevel: level });
	}

	async respondInteraction(
		workspaceId: string,
		sessionId: string,
		id: string,
		response: InteractionResponse,
	): Promise<void> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (!backend) {
			throw new Error(`Interaction not found: ${id}`);
		}
		await backend.respondToInteraction(id, response);
	}

	// -----------------------------------------------------------------------
	// Session administration (target-session semantics)
	// -----------------------------------------------------------------------

	/** Create a persisted session identity (方案 A); the AgentSession materializes on first use. */
	async createSession(workspaceId: string): Promise<SessionInfo> {
		const { sessionId, sessionFile } = await this.options.createSessionFile(
			workspaceId,
			resolveSessionDirectory(workspaceId, this.sessionStorage),
		);
		return { id: sessionId, file: sessionFile, workspacePath: workspaceId };
	}

	/**
	 * Live session list for a workspace: catalog entries overlaid with live
	 * backend state. Previews and activity timestamps come from the in-memory
	 * history, so a freshly completed turn updates the sidebar without a
	 * catalog rescan. Non-materialized sessions come from the cached catalog.
	 */
	async listSessions(workspaceId: string): Promise<SessionInfo[]> {
		const key = workspacePathKey(workspaceId);
		const catalog = await this.options.listCatalogSessions();
		const byId = new Map<string, SessionInfo>();
		for (const session of catalog) {
			if (session.workspacePath && workspacePathKey(session.workspacePath) === key) {
				byId.set(session.id, session);
			}
		}
		const workspace = this.workspaces.get(key);
		if (!workspace) {
			return [...byId.values()];
		}
		for (const record of workspace.sessions.values()) {
			if (!record.backend.isRunning) {
				continue;
			}
			const entry = await this.liveSessionEntry(workspaceId, record, byId.get(record.sessionId));
			if (entry) {
				byId.set(entry.id, entry);
			}
		}
		return [...byId.values()];
	}

	/** Overlay a live backend's state and messages over its catalog entry. */
	private async liveSessionEntry(
		workspaceId: string,
		record: SessionBackendRecord,
		catalogEntry: SessionInfo | undefined,
	): Promise<SessionInfo | null> {
		try {
			const [state, messages] = await Promise.all([record.backend.getState(), record.backend.getMessages()]);
			const firstUser = messages.find((message) => message.role === "user");
			const lastTimestamp = [...messages].reverse().find((message) => message.timestamp !== undefined)?.timestamp;
			return {
				...(catalogEntry ?? {}),
				id: state.sessionId || record.sessionId,
				file: catalogEntry?.file ?? state.sessionFile,
				workspacePath: catalogEntry?.workspacePath ?? workspaceId,
				name: state.sessionName ?? catalogEntry?.name,
				messageCount: state.messageCount,
				preview: firstUser !== undefined ? messageText(firstUser) || catalogEntry?.preview : catalogEntry?.preview,
				updatedAt: lastTimestamp ?? catalogEntry?.updatedAt,
			};
		} catch {
			// A backend that is shutting down must not break the list.
			return catalogEntry ?? null;
		}
	}

	async renameSession(workspaceId: string, sessionId: string, name: string): Promise<void> {
		// A live backend for the target owns the file: route through its
		// SessionManager (single-writer semantics, memory+disk consistent).
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend?.renameSession) {
			backend.renameSession(name);
			return;
		}
		await this.options.renameCatalogSession(sessionId, name);
	}

	async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend?.isStreaming) {
			// §14.4: deleting a running session is rejected; delete is never an
			// implicit abort.
			throw new Error("Cannot delete a running session");
		}
		const session = await this.options.findSession(sessionId);
		if (!session?.file) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		if (backend) {
			await this.disposeBackend(workspaceId, sessionId);
		}
		await this.options.deleteCatalogFile(session.file);
	}

	/**
	 * Editable user messages of a session. A live backend answers from its
	 * own `SessionManager.getBranch()` (same source as `getMessages()`, so
	 * timestamps align exactly); a not-yet-materialized session is read from
	 * its catalog file. Returns an empty list for sessions with no file yet.
	 */
	async listEditableUserMessages(workspaceId: string, sessionId: string): Promise<EditableUserMessage[]> {
		const backend = this.getBackend(workspaceId, sessionId);
		if (backend?.editableUserMessages) {
			return backend.editableUserMessages();
		}
		const session = await this.options.findSession(sessionId);
		if (!session?.file) {
			return [];
		}
		return this.options.readEditableUserMessages(session.file);
	}

	/**
	 * Edit a past user message in place and resend it: the session tree
	 * branches before the edited message (same session file). Requires a
	 * live session, so a not-yet-materialized session is materialized on
	 * demand - an explicit user action, unlike history browsing. An
	 * unpersisted session (no live backend, no catalog file) is rejected.
	 */
	async editUserMessage(
		workspaceId: string,
		sessionId: string,
		entryId: string,
		text: string,
	): Promise<EditAndResendResult> {
		const existing = this.getBackend(workspaceId, sessionId);
		if (existing?.isStreaming) {
			throw new Error("Wait for the current response to finish before editing a message");
		}
		if (!existing) {
			const session = await this.options.findSession(sessionId);
			if (!session?.file) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before editing it.",
				);
			}
		}
		const backend = await this.getOrCreateBackend(workspaceId, sessionId);
		if (!backend.editAndResend) {
			throw new Error("Message editing is not supported by this backend");
		}
		return backend.editAndResend(entryId, text);
	}

	// -----------------------------------------------------------------------
	// Host services (shared state; no fan-out)
	// -----------------------------------------------------------------------

	listModels(): Promise<ModelInfo[]> {
		return this.options.hostServices.listModels();
	}

	reloadModels(): Promise<void> {
		return this.options.hostServices.reloadModels();
	}

	listModelsByIds(ids: string[]): Promise<ModelInfo[]> {
		return this.options.hostServices.listModelsByIds(ids);
	}

	listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
		return this.options.hostServices.listProviderAuthStatus();
	}

	setApiKey(provider: string, apiKey: string): Promise<void> {
		return this.options.hostServices.setApiKey(provider, apiKey);
	}

	removeCredential(provider: string): Promise<void> {
		return this.options.hostServices.removeCredential(provider);
	}

	loginWithOAuth(provider: string): Promise<void> {
		return this.options.hostServices.loginWithOAuth(provider);
	}

	cancelOAuthLogin(): Promise<void> {
		return this.options.hostServices.cancelOAuthLogin();
	}

	respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
		return this.options.hostServices.respondToAuthPrompt(requestId, response);
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private createBackend(workspace: string): ManagedSessionBackend {
		const backend =
			this.options.createSessionBackend?.(workspace) ??
			new SdkSessionBackend({
				// The host services own the shared runtime; the adapter backend
				// resolves the same instance so sessions and host state never diverge.
				modelRuntime: this.options.hostServices.sharedRuntime,
				agentDir: this.options.agentDir,
				resolveSessionDirectory: (workspacePath) => resolveSessionDirectory(workspacePath, this.sessionStorage),
			});
		backend.subscribe((event) => {
			this.routeEvent(backend, workspace, event);
		});
		return backend;
	}

	private touch(workspace: string, sessionId: string): void {
		const record = this.workspaces.get(workspacePathKey(workspace))?.sessions.get(sessionId);
		if (record) {
			record.lastUsedAt = Date.now();
		}
	}

	private pendingKey(workspace: string, sessionId: string): string {
		return `${workspacePathKey(workspace)}\u0000${sessionId}`;
	}

	private takePendingConfig(workspace: string, sessionId: string): PendingSessionConfig | undefined {
		const key = this.pendingKey(workspace, sessionId);
		const config = this.pendingConfigs.get(key);
		this.pendingConfigs.delete(key);
		return config;
	}

	private isPinned(record: SessionBackendRecord): boolean {
		if (record.backend.isStreaming) {
			return true;
		}
		if (record.backend.hasPendingInteractions) {
			return true;
		}
		const workspace = this.workspaces.get(record.workspaceKey);
		return workspace?.activeSessionId === record.sessionId;
	}

	/** LRU-evict background idle backends beyond the per-workspace limit. */
	private evictIdleIn(workspace: WorkspaceRecord): void {
		const idle = [...workspace.sessions.values()].filter((record) => !this.isPinned(record));
		while (idle.length > MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE) {
			idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
			const oldest = idle.shift();
			if (!oldest) {
				break;
			}
			workspace.sessions.delete(oldest.sessionId);
			void oldest.backend.stop().catch(() => {});
		}
	}

	/** Keep at most MAX_WARM_WORKSPACES warm; never dispose pinned backends. */
	private evictWorkspaces(): void {
		while (this.workspaces.size > MAX_WARM_WORKSPACES) {
			let oldest: WorkspaceRecord | null = null;
			for (const workspace of this.workspaces.values()) {
				if (workspace.key === this.activeWorkspaceKey) {
					continue;
				}
				if ([...workspace.sessions.values()].some((record) => this.isPinned(record))) {
					continue;
				}
				if (oldest === null || workspace.lastUsedAt < oldest.lastUsedAt) {
					oldest = workspace;
				}
			}
			if (!oldest) {
				// Every other workspace has pinned work; the pool may grow.
				return;
			}
			void this.disposeWorkspace(oldest.path);
		}
	}

	private routeEvent(backend: ManagedSessionBackend, workspace: string, event: RoutedAgentEvent["event"]): void {
		try {
			const sessionId = backend.sessionId;
			if (sessionId === undefined) {
				return;
			}
			const routed: RoutedAgentEvent = { workspaceId: workspace, sessionId, event };
			for (const handler of this.eventListeners) {
				try {
					handler(routed);
				} catch {
					// §15.1: a throwing event consumer must not break the pipeline.
				}
			}
		} catch {
			// Route failures are isolated to this event.
		}
	}

	private setStatus(status: BackendStatus): void {
		this.status = status;
		for (const handler of this.statusListeners) {
			handler(status);
		}
	}
}
