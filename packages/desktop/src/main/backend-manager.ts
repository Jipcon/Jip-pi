/**
 * BackendManager: owns a bounded pool of PiBackend instances in the main process.
 *
 * Responsibilities:
 * - Launch Pi backends (dev: source checkout via tsx; packaged: bundled pi.exe)
 * - Keep the two most recently used workspaces warm, so switching between
 *   them is a fast in-process swap instead of a cold 400-500ms spawn
 * - Atomically switch the active backend and track a single source of truth
 *   for backend status
 * - Fan out events only from the active backend / status / diagnostics to
 *   listeners (the window)
 */

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	AgentEvent,
	AuthPromptResponse,
	BackendHandshake,
	InteractionResponse,
	ModelInfo,
	ModelRef,
	ProviderAuthStatus,
	SessionInfo,
	SessionUsage,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { PiBackend } from "@earendil-works/pi-gui-adapter";
import { app, shell } from "electron";
import { type BackendStatus, DEFAULT_SESSION_STORAGE, type SessionStorageConfig } from "../shared/ipc.ts";
import { workspacePathKey } from "../shared/workspace-path.ts";
import { resolveSessionDirectory } from "./session-storage.ts";

export interface LaunchConfig {
	executable: string;
	args: string[];
}

/** How many backend processes may stay resident while idle. */
const MAX_WARM_BACKENDS = 2;

/**
 * Sentinel pool key for the workspace-independent catalog backend. No real
 * workspace path can collide with it, so it never participates in
 * activation, eviction-by-workspace or status updates.
 */
const CATALOG_WORKSPACE_KEY = "\u0000catalog";

/**
 * Throwaway session directory for the catalog backend. The agent always
 * creates a session at startup; pointing it at a temp dir keeps that session
 * out of the user's session catalog and away from every real workspace.
 */
function catalogSessionDirectory(): string {
	return join(tmpdir(), "pi-desktop", "catalog");
}

interface BackendSlot {
	/** Normalized map key (workspacePathKey). */
	workspaceKey: string;
	/** Original workspace path as requested by the caller. */
	workspace: string;
	backend: PiBackend;
	startPromise?: Promise<void>;
	handshake?: BackendHandshake;
	lastUsedAt: number;
	/**
	 * Catalog-only backend: answers auth/catalog queries while no workspace
	 * is open. It never becomes the active backend and its events are
	 * discarded by the active-slot filter.
	 */
	catalog?: boolean;
}

/**
 * Resolve how to launch Pi:
 * - development: spawn the current source checkout (`tsx src/cli.ts --mode rpc`)
 * - packaged:    spawn `resources/backend/pi.exe --mode rpc`
 */
export function resolveLaunch(): LaunchConfig {
	if (app.isPackaged) {
		return {
			executable: resolve(process.resourcesPath, "backend", "pi.exe"),
			args: ["--mode", "rpc"],
		};
	}

	const repoRoot = process.env.PI_REPO_ROOT ?? resolve(__dirname, "..", "..", "..", "..");
	const nodeExecutable = process.env.npm_node_execPath ?? process.env.PI_NODE_PATH ?? "node";
	return {
		executable: nodeExecutable,
		args: [
			resolve(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			resolve(repoRoot, "tsconfig.json"),
			resolve(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
			"--mode",
			"rpc",
		],
	};
}

export class BackendManager {
	private readonly slots = new Map<string, BackendSlot>();
	private activeKey: string | null = null;
	private status: BackendStatus = { phase: "no-workspace", workspace: null };
	private readonly eventListeners = new Set<(event: AgentEvent) => void>();
	private readonly statusListeners = new Set<(status: BackendStatus) => void>();
	private readonly logListeners = new Set<(line: string) => void>();
	private sessionStorage: SessionStorageConfig = { ...DEFAULT_SESSION_STORAGE };

	/** Bumped on every switch request; stale async launches must not activate. */
	private switchGeneration = 0;

	/** Set while an OAuth login is in flight on the active backend. */
	private oauthLoginInProgress = false;

	/** In-flight launch of the catalog backend; null when idle or launched. */
	private catalogStartPromise: Promise<BackendSlot> | null = null;

	private get activeSlot(): BackendSlot | null {
		if (this.activeKey === null) {
			return null;
		}
		return this.slots.get(this.activeKey) ?? null;
	}

	get isRunning(): boolean {
		return this.activeSlot?.backend.isRunning ?? false;
	}

	/** Whether an OAuth login flow is in flight on the active backend. */
	get isOAuthLoginInProgress(): boolean {
		return this.oauthLoginInProgress;
	}

	/** Whether any pooled backend process is still alive (app-quit cleanup). */
	get hasLiveBackends(): boolean {
		for (const slot of this.slots.values()) {
			if (slot.backend.isRunning) {
				return true;
			}
		}
		return false;
	}

	get currentStatus(): BackendStatus {
		return this.status;
	}

	get currentSessionStorage(): SessionStorageConfig {
		return { ...this.sessionStorage };
	}

	setSessionStorage(config: SessionStorageConfig): void {
		this.sessionStorage = { ...config };
	}

	onEvent(handler: (event: AgentEvent) => void): () => void {
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

	/**
	 * Switch to the backend for the given workspace. A warm cached backend is
	 * activated immediately; otherwise a new backend is launched in the
	 * background and the previous workspace stays usable if the launch fails.
	 * Returns an error message on failure.
	 */
	async start(workspace: string): Promise<string | undefined> {
		this.switchGeneration += 1;
		const generation = this.switchGeneration;

		// An in-flight login belongs to the workspace being switched away from;
		// cancel it before the backend stops or is deactivated.
		const active = this.activeSlot;
		if (
			this.oauthLoginInProgress &&
			!(active && workspacePathKey(active.workspaceKey) === workspacePathKey(workspace))
		) {
			await this.cancelOAuthLogin();
		}
		if (active && workspacePathKey(active.workspaceKey) === workspacePathKey(workspace)) {
			if (active.backend.isRunning) {
				// Already on this workspace: idempotent.
				active.lastUsedAt = Date.now();
				return undefined;
			}
			// The active backend died (crash): drop it and relaunch.
			this.slots.delete(active.workspaceKey);
			this.activeKey = null;
		}

		// Keep the existing termination semantics: switching away from a
		// workspace whose agent is still running stops it instead of caching it.
		if (active?.backend.isStreaming) {
			await active.backend.stop().catch(() => {});
			this.slots.delete(active.workspaceKey);
			if (this.activeKey === active.workspaceKey) {
				this.activeKey = null;
			}
		}

		const cached = this.slots.get(workspacePathKey(workspace));
		if (cached?.backend.isRunning) {
			this.activate(cached);
			return undefined;
		}
		if (cached) {
			// Cached but dead: replace it.
			this.slots.delete(cached.workspaceKey);
			await cached.backend.stop().catch(() => {});
		}

		// Launch in the background; the previous workspace stays active (and
		// the UI keeps showing it) until the new backend is ready.
		const slot = this.createSlot(workspace);
		this.slots.set(slot.workspaceKey, slot);
		if (!slot.startPromise) {
			slot.startPromise = this.launch(slot);
		}
		try {
			await slot.startPromise;
		} catch (error) {
			this.slots.delete(slot.workspaceKey);
			await slot.backend.stop().catch(() => {});
			const message = error instanceof Error ? error.message : String(error);
			if (this.activeKey === null) {
				// First launch failed: surface the error.
				this.setStatus({ phase: "error", workspace, error: message });
			}
			// Otherwise keep the previous workspace active and usable.
			return message;
		}
		if (generation !== this.switchGeneration) {
			// A newer switch superseded this launch; keep the slot warm.
			void this.evictIfNeeded();
			return undefined;
		}
		this.activate(slot);
		return undefined;
	}

	/** Stop every backend and forget the pool (app quit). */
	async stop(): Promise<void> {
		this.switchGeneration += 1;
		const workspace = this.status.workspace ?? null;
		if (this.oauthLoginInProgress) {
			await this.cancelOAuthLogin();
		}
		for (const slot of this.slots.values()) {
			await slot.backend.stop().catch(() => {});
		}
		this.slots.clear();
		this.activeKey = null;
		this.setStatus({ phase: "stopped", workspace });
	}

	/** Stop every cached backend without touching status (session storage changed). */
	async stopAllBackends(): Promise<void> {
		this.switchGeneration += 1;
		if (this.oauthLoginInProgress) {
			await this.cancelOAuthLogin();
		}
		for (const slot of this.slots.values()) {
			await slot.backend.stop().catch(() => {});
		}
		this.slots.clear();
		this.activeKey = null;
	}

	/** Stop the cached backend for a workspace that is being removed. */
	async discardWorkspace(workspace: string): Promise<void> {
		const key = workspacePathKey(workspace);
		const slot = this.slots.get(key);
		if (!slot) {
			return;
		}
		if (this.oauthLoginInProgress && this.activeKey === key) {
			await this.cancelOAuthLogin();
		}
		this.slots.delete(key);
		if (this.activeKey === key) {
			this.activeKey = null;
		}
		await slot.backend.stop().catch(() => {});
	}

	async sendMessage(message: UserMessage): Promise<void> {
		await this.requireActive().sendMessage(message);
	}

	async abort(): Promise<void> {
		await this.requireActive().abort();
	}

	async newSession(): Promise<SessionInfo> {
		return this.requireActive().createSession();
	}

	async listSessions(): Promise<SessionInfo[]> {
		return this.requireActive().listSessions();
	}

	async switchSession(sessionId: string): Promise<SessionInfo> {
		return this.requireActive().switchSession(sessionId);
	}

	async renameSession(sessionId: string, name: string): Promise<SessionInfo[]> {
		const state = await this.requireActive().getState();
		if (state.isStreaming) {
			throw new Error("Cannot rename sessions while the agent is running");
		}
		await this.requireActive().renameSession(sessionId, name);
		return this.requireActive().listSessions();
	}

	async deleteSession(sessionId: string): Promise<SessionInfo[]> {
		const state = await this.requireActive().getState();
		if (state.isStreaming) {
			throw new Error("Cannot delete sessions while the agent is running");
		}
		if (state.sessionId === sessionId) {
			throw new Error("Cannot delete the current session");
		}

		const target = (await this.requireActive().listSessions()).find((session) => session.id === sessionId);
		if (!target?.file) {
			throw new Error(`Session not found: ${sessionId}`);
		}
		await shell.trashItem(target.file);
		return this.requireActive().listSessions();
	}

	async getState() {
		return this.requireActive().getState();
	}

	async getMessages() {
		return this.requireActive().getMessages();
	}

	async getSessionUsage(): Promise<SessionUsage> {
		return this.requireActive().getSessionUsage();
	}

	async listModels(): Promise<ModelInfo[]> {
		return this.requireActive().listModels();
	}

	async setModel(model: ModelRef): Promise<ModelInfo | null> {
		return this.requireActive().setModel(model);
	}

	async listThinkingLevels(): Promise<string[]> {
		return this.requireActive().listThinkingLevels();
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.requireActive().setThinkingLevel(level);
	}

	async listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
		const backend = this.activeSlot?.backend ?? (await this.ensureCatalogBackend());
		return backend.listProviderAuthStatus();
	}

	/**
	 * Store an api key through the credential API on every pooled backend so
	 * both warm workspace backends observe the change, then refresh their
	 * model catalogs. The key is never returned to the renderer.
	 */
	async setApiKey(provider: string, apiKey: string): Promise<void> {
		if (!this.activeSlot) {
			// No workspace is open: make sure a backend exists that can store
			// the credential (and later report it back via listProviderAuthStatus).
			await this.ensureCatalogBackend();
		}
		const errors: string[] = [];
		for (const slot of this.slots.values()) {
			if (!slot.backend.isRunning) continue;
			try {
				await slot.backend.setApiKey(provider, apiKey);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (errors.length > 0) {
			throw new Error(errors.join("; "));
		}
	}

	/** Remove the stored credential on every pooled backend. */
	async removeCredential(provider: string): Promise<void> {
		if (!this.activeSlot) {
			await this.ensureCatalogBackend();
		}
		const errors: string[] = [];
		for (const slot of this.slots.values()) {
			if (!slot.backend.isRunning) continue;
			try {
				await slot.backend.removeCredential(provider);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (errors.length > 0) {
			throw new Error(errors.join("; "));
		}
	}

	/**
	 * Run an OAuth login on the active backend. The promise resolves when the
	 * flow completes; progress streams to the renderer as auth_flow events.
	 * After success, every other warm backend refreshes its model catalog so
	 * the shared credential store change is observed everywhere.
	 */
	async loginWithOAuth(provider: string): Promise<void> {
		const active = this.activeSlot;
		if (!active) {
			throw new Error("Backend not started");
		}
		this.oauthLoginInProgress = true;
		try {
			await active.backend.loginWithOAuth(provider);
		} finally {
			this.oauthLoginInProgress = false;
		}
		// Credentials live in the shared auth.json: refresh every other warm
		// backend so their model catalogs observe the new credential.
		const errors: string[] = [];
		for (const slot of this.slots.values()) {
			if (!slot.backend.isRunning || slot.backend === active.backend) continue;
			try {
				await slot.backend.refreshAuth(provider);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (errors.length > 0) {
			throw new Error(errors.join("; "));
		}
	}

	/** Cancel the in-flight OAuth login (idempotent). */
	async cancelOAuthLogin(): Promise<void> {
		const active = this.activeSlot;
		if (active) {
			await active.backend.cancelOAuthLogin().catch(() => {});
		}
	}

	/** Forward an auth prompt answer to the active backend. */
	async respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
		await this.requireActive().respondToAuthPrompt(requestId, response);
	}

	async respondInteraction(id: string, response: InteractionResponse): Promise<void> {
		await this.requireActive().respondToInteraction(id, response);
	}

	/**
	 * Return the workspace-independent catalog backend, launching it on first
	 * use. It runs the agent with a neutral cwd (home directory) and a
	 * throwaway session dir, so auth queries and credential writes work even
	 * when no workspace is open. Pooled under a sentinel key: it never
	 * activates, never appears in status updates, and its events are dropped
	 * by the active-slot filter.
	 */
	private async ensureCatalogBackend(): Promise<PiBackend> {
		const existing = this.slots.get(CATALOG_WORKSPACE_KEY);
		if (existing?.backend.isRunning) {
			existing.lastUsedAt = Date.now();
			return existing.backend;
		}
		if (existing) {
			// Cached but dead: replace it.
			this.slots.delete(CATALOG_WORKSPACE_KEY);
			await existing.backend.stop().catch(() => {});
		}
		if (!this.catalogStartPromise) {
			const slot = this.createSlot(homedir());
			slot.workspaceKey = CATALOG_WORKSPACE_KEY;
			slot.catalog = true;
			this.slots.set(slot.workspaceKey, slot);
			slot.startPromise = this.launch(slot);
			this.catalogStartPromise = slot.startPromise
				.then(() => slot)
				.catch((error) => {
					this.slots.delete(CATALOG_WORKSPACE_KEY);
					void slot.backend.stop().catch(() => {});
					throw error;
				})
				.finally(() => {
					this.catalogStartPromise = null;
				});
		}
		const slot = await this.catalogStartPromise;
		return slot.backend;
	}

	private requireActive(): PiBackend {
		const slot = this.activeSlot;
		if (!slot) {
			throw new Error("Backend not started");
		}
		return slot.backend;
	}

	private createSlot(workspace: string): BackendSlot {
		const backend = new PiBackend();
		const slot: BackendSlot = { workspaceKey: workspacePathKey(workspace), workspace, backend, lastUsedAt: 0 };
		backend.subscribe((event) => this.handleBackendEvent(slot, event));
		return slot;
	}

	private async launch(slot: BackendSlot): Promise<void> {
		const launch = resolveLaunch();
		// The catalog backend always uses its throwaway temp session dir, so
		// its startup session never leaks into the user's session catalog.
		const sessionDirectory = slot.catalog
			? catalogSessionDirectory()
			: resolveSessionDirectory(slot.workspace, this.sessionStorage);
		await slot.backend.start({
			workspacePath: slot.workspace,
			executable: launch.executable,
			args: sessionDirectory ? [...launch.args, "--session-dir", sessionDirectory] : launch.args,
		});
		slot.handshake = await slot.backend.getHandshake();
	}

	private activate(slot: BackendSlot): void {
		slot.lastUsedAt = Date.now();
		this.activeKey = slot.workspaceKey;
		this.setStatus({ phase: "running", workspace: slot.workspace, handshake: slot.handshake });
		void this.evictIfNeeded();
	}

	/** Stop the least recently used non-active backend when the pool is full. */
	private async evictIfNeeded(): Promise<void> {
		if (this.slots.size <= MAX_WARM_BACKENDS) {
			return;
		}
		let oldest: BackendSlot | null = null;
		for (const slot of this.slots.values()) {
			if (slot.workspaceKey === this.activeKey) {
				continue;
			}
			if (oldest === null || slot.lastUsedAt < oldest.lastUsedAt) {
				oldest = slot;
			}
		}
		if (oldest) {
			this.slots.delete(oldest.workspaceKey);
			await oldest.backend.stop().catch(() => {});
		}
	}

	private handleBackendEvent(slot: BackendSlot, event: AgentEvent): void {
		// A crashed backend leaves the pool; the next visit relaunches it.
		if (event.type === "error" && event.source === "process") {
			this.slots.delete(slot.workspaceKey);
			if (this.activeKey === slot.workspaceKey) {
				this.activeKey = null;
				this.setStatus({ phase: "error", workspace: slot.workspaceKey, error: event.message });
			}
			return;
		}
		// Only the active backend may drive the renderer.
		if (slot.workspaceKey !== this.activeKey) {
			return;
		}
		// OAuth login: open authorization urls in the system browser from the
		// main process (the renderer never gets raw URL-open privileges).
		if (event.type === "custom" && event.name === "auth_flow") {
			const flow = event.payload as { kind?: string; event?: { type?: string; url?: string } };
			if (flow?.kind === "event" && flow.event?.type === "auth_url" && typeof flow.event.url === "string") {
				void shell.openExternal(flow.event.url).catch(() => {});
			}
		}
		if (event.type === "custom" && event.name === "backend_stderr") {
			const line = typeof event.payload === "string" ? event.payload : String(event.payload);
			for (const handler of this.logListeners) {
				handler(line);
			}
			return;
		}
		for (const handler of this.eventListeners) {
			handler(event);
		}
	}

	private setStatus(status: BackendStatus): void {
		this.status = status;
		for (const handler of this.statusListeners) {
			handler(status);
		}
	}
}
