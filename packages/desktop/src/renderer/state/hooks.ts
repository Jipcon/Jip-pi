/**
 * React bindings: wires the constrained `window.agent` API into the store.
 */

import type {
	AuthPromptResponse,
	InteractionResponse,
	MessageDeltaEvent,
	SessionInfo,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { useEffect, useSyncExternalStore } from "react";
import type {
	BackendStatus,
	CustomProviderConfig,
	CustomProviderFetchedModel,
	CustomProviderFetchRequest,
	CustomProviderMatchedModel,
	CustomProviderMatchRequest,
	SessionStorageConfig,
} from "../../shared/ipc.ts";
import { workspacePathsEqual } from "../../shared/workspace-path.ts";
import { AgentStore } from "./store.ts";

export const store = new AgentStore();
let refreshGeneration = 0;
let catalogRefreshGeneration = 0;
let usageRefreshGeneration = 0;
let sessionsRefreshGeneration = 0;
let controlledBackendTransitions = 0;

/** Bumped when a lifecycle/state event could make an in-flight getState snapshot stale. */
let agentStateRevision = 0;
/** Bumped on every applied status, so late getStatus() snapshots cannot regress newer events. */
let statusRevision = 0;

// ---------------------------------------------------------------------------
// Streaming delta coalescing: message_delta events are buffered per session
// and applied as one store update per animation frame instead of one
// dispatch per event.
// ---------------------------------------------------------------------------

interface PendingDeltaBatch {
	workspaceId: string;
	sessionId: string;
	deltas: MessageDeltaEvent[];
}

const pendingDeltaBatches = new Map<string, PendingDeltaBatch>();
let pendingDeltaRafId: number | null = null;
const streamingSessions = new Set<string>();

function scheduleDeltaFlush(): void {
	if (pendingDeltaRafId !== null) {
		return;
	}
	pendingDeltaRafId = window.requestAnimationFrame(() => {
		pendingDeltaRafId = null;
		if (pendingDeltaBatches.size === 0) {
			return;
		}
		const batches = [...pendingDeltaBatches.values()];
		pendingDeltaBatches.clear();
		for (const batch of batches) {
			store.dispatch({
				type: "message-delta-batch",
				workspaceId: batch.workspaceId,
				sessionId: batch.sessionId,
				deltas: batch.deltas,
			});
		}
	});
}

/** Synchronously apply buffered deltas (used before agent_stopped / critical events). */
function flushPendingDeltas(): void {
	if (pendingDeltaRafId !== null) {
		window.cancelAnimationFrame(pendingDeltaRafId);
		pendingDeltaRafId = null;
	}
	if (pendingDeltaBatches.size === 0) {
		return;
	}
	const batches = [...pendingDeltaBatches.values()];
	pendingDeltaBatches.clear();
	for (const batch of batches) {
		store.dispatch({
			type: "message-delta-batch",
			workspaceId: batch.workspaceId,
			sessionId: batch.sessionId,
			deltas: batch.deltas,
		});
	}
}

/** Drop buffered deltas (message_completed supersedes them; session switches must not leak). */
function clearPendingDeltas(sessionId?: string): void {
	if (sessionId !== undefined) {
		pendingDeltaBatches.delete(sessionId);
		return;
	}
	if (pendingDeltaRafId !== null) {
		window.cancelAnimationFrame(pendingDeltaRafId);
		pendingDeltaRafId = null;
	}
	pendingDeltaBatches.clear();
}

function reportBridgeError(context: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	store.dispatch({
		type: "host-event",
		event: { type: "error", message: `${context}: ${message}`, source: "protocol" },
	});
}

export function useAppState() {
	return useSyncExternalStore(
		(callback) => store.subscribe(callback),
		() => store.getSnapshot(),
	);
}

/** Subscribe to routed/host events and hydrate initial data. */
export function useAgentBridge(): void {
	useEffect(() => {
		const unsubscribers: Array<() => void> = [];
		unsubscribers.push(
			window.agent.subscribe((routed) => {
				const { workspaceId, sessionId, event } = routed;
				// Streaming deltas are coalesced per session, one store update
				// per animation frame.
				if (event.type === "message_started" && event.message.role === "assistant") {
					clearPendingDeltas(sessionId);
					streamingSessions.add(sessionId);
				} else if (event.type === "message_delta" && streamingSessions.has(sessionId)) {
					const batch = pendingDeltaBatches.get(sessionId) ?? { workspaceId, sessionId, deltas: [] };
					batch.deltas.push(event);
					pendingDeltaBatches.set(sessionId, batch);
					scheduleDeltaFlush();
					return;
				} else if (event.type === "message_completed" && event.message.role === "assistant") {
					// The completed message is authoritative: drop unrendered deltas.
					clearPendingDeltas(sessionId);
					streamingSessions.delete(sessionId);
				} else if (event.type === "agent_stopped") {
					// Abnormal stop without message_completed: flush so no tail is lost.
					flushPendingDeltas();
					streamingSessions.delete(sessionId);
				}
				if (event.type === "agent_started" || event.type === "agent_stopped" || event.type === "state_changed") {
					agentStateRevision += 1;
				}
				store.dispatch({ type: "routed-event", workspaceId, sessionId, event });
				if (event.type === "agent_stopped") {
					// The new turn's messages now have entry ids on disk: re-align so
					// the just-completed user message becomes editable.
					void refreshEditableUserMessages(workspaceId, sessionId);
				}
				if (
					event.type === "turn_completed" ||
					(event.type === "custom" && event.namespace === "pi" && event.name === "compaction_end")
				) {
					void refreshSessionUsage(workspaceId, sessionId);
					const activeWorkspace = store.getSnapshot().status.workspace;
					if (activeWorkspace !== null && workspacePathsEqual(activeWorkspace, workspaceId)) {
						void refreshSessions(workspaceId);
					}
				}
			}),
		);
		unsubscribers.push(
			window.agent.onHostEvent((event) => {
				store.dispatch({ type: "host-event", event });
			}),
		);
		unsubscribers.push(window.agent.onStatus((status) => applyBackendStatus(status)));
		unsubscribers.push(
			window.agent.onLog((line) =>
				store.dispatch({
					type: "host-event",
					event: { type: "custom", namespace: "gui-adapter", name: "backend_stderr", payload: line },
				}),
			),
		);

		// Status push events only fire on transitions, so a renderer that loads
		// while the backend is already running would otherwise stay stuck in
		// no-workspace forever. Restore the phase from a status snapshot,
		// unless a newer status event arrived while the snapshot was in flight.
		const statusRevisionAtStart = statusRevision;
		void window.agent.getStatus().then((status) => {
			if (statusRevisionAtStart !== statusRevision) {
				return;
			}
			applyBackendStatus(status);
			if (status.phase !== "running" && status.phase !== "starting") {
				void refreshSessionCatalog();
				// Provider auth status also works without a workspace (host
				// services), so Settings shows the provider list on the home
				// screen too.
				void refreshProviderAuth().catch((error) =>
					reportBridgeError("Failed to load provider auth status", error),
				);
			}
		});

		// The host model catalog is zero-backend safe (SDK mode): load it at
		// startup so the top bar shows real providers/models during
		// initialization instead of waiting for a running workspace. Legacy
		// RPC mode has no backend yet, so its listModels fails here silently;
		// refreshAll reloads the catalog once a workspace runs.
		void refreshModels().catch(() => {});

		return () => {
			for (const unsubscribe of unsubscribers) {
				unsubscribe();
			}
		};
	}, []);
}

export async function pickWorkspaceAndStart(): Promise<string | undefined> {
	const workspace = await window.agent.pickWorkspace();
	if (!workspace) {
		return undefined;
	}
	await startWorkspace(workspace);
	return workspace;
}

export async function startWorkspace(workspace: string): Promise<void> {
	await runControlledBackendTransition(async () => {
		const previous = store.getSnapshot().status;
		applyBackendStatus({ phase: "starting", workspace });
		try {
			await window.agent.start(workspace);
		} catch (error) {
			applyBackendStatus(previous);
			store.dispatch({
				type: "notify",
				notification: {
					message: `Failed to open "${workspace}": ${error instanceof Error ? error.message : String(error)}`,
					type: "error",
				},
			});
			return;
		}
		await refreshAll(workspace);
	});
}

/** Dispatch a backend status and hydrate based on the resulting phase. */
function applyBackendStatus(status: BackendStatus): void {
	statusRevision += 1;
	store.dispatch({ type: "status", status });

	if (status.phase === "running" && controlledBackendTransitions === 0 && status.workspace) {
		void refreshAll(status.workspace).catch((error) => reportBridgeError("Failed to load workspace data", error));
	}
}

/**
 * Refresh the workspace view: session catalog, host model catalog and auth
 * status. Session views hydrate through openSession.
 */
export async function refreshAll(workspace: string): Promise<void> {
	const generation = ++refreshGeneration;
	if (generation !== refreshGeneration) {
		return;
	}
	void refreshSessionCatalog();
	void refreshSessions(workspace);
	void refreshModels().catch((error) => reportBridgeError("Failed to load model catalog", error));
	void refreshProviderAuth().catch((error) => reportBridgeError("Failed to load provider auth status", error));
}

/** Load the host-level model catalog (credential-aware, zero-backend safe). */
export async function refreshModels(): Promise<void> {
	const models = await window.agent.listModels();
	store.dispatch({ type: "models", models });
}

/**
 * Invalidate and refetch the host model catalog (after credential changes).
 * Returns true when the refresh produced a usable catalog.
 */
async function refreshModelCatalog(): Promise<boolean> {
	await refreshModels();
	return store.getSnapshot().models.length > 0;
}

/**
 * Reload the model catalog from disk (models.json) in the backend, then
 * refresh the GUI's cached model list and provider auth status. Use this
 * after models.json changes so new/edited custom providers appear without an
 * app restart.
 */
export async function reloadModelCatalog(): Promise<void> {
	await window.agent.reloadModels();
	await Promise.all([refreshModels(), refreshProviderAuth()]);
}

async function refreshSessionUsage(workspaceId: string, sessionId: string): Promise<void> {
	const generation = ++usageRefreshGeneration;
	try {
		const usage = await window.agent.getSessionUsage(workspaceId, sessionId);
		if (generation !== usageRefreshGeneration) {
			return;
		}
		const snapshot = store.getSnapshot();
		const session = snapshot.sessionStateById[sessionId];
		if (!session?.agentState) {
			return;
		}
		store.dispatch({ type: "session-state-update", workspaceId, state: session.agentState, usage });
	} catch {
		// Usage is best-effort.
	}
}

/**
 * Re-fetch the editable user message list for a session and re-align entry ids
 * onto the already-rendered messages. Used after `agent_stopped` so the
 * just-completed turn's user message becomes editable without re-snapshotting
 * the whole history.
 */
export async function refreshEditableUserMessages(workspaceId: string, sessionId: string): Promise<void> {
	try {
		const editable = await window.agent.listEditableUserMessages(workspaceId, sessionId);
		store.dispatch({ type: "session-editable-messages", sessionId, editableUserMessages: editable });
	} catch {
		// Editability is best-effort; the edit button just stays hidden.
	}
}

async function refreshSessionCatalog(): Promise<void> {
	const generation = ++catalogRefreshGeneration;
	try {
		const [sessions, workspaces] = await Promise.all([
			window.agent.listSessionCatalog(),
			window.agent.listWorkspaces(),
		]);
		if (generation === catalogRefreshGeneration) {
			store.dispatch({ type: "session-catalog", sessions });
			store.dispatch({ type: "workspaces", workspaces });
		}
	} catch (error) {
		if (generation === catalogRefreshGeneration) {
			store.dispatch({ type: "session-catalog-failed" });
			reportBridgeError("Failed to load session catalog", error);
		}
	}
}

/** Refresh the live session list for the active workspace. */
async function refreshSessions(workspaceId: string): Promise<void> {
	const generation = ++sessionsRefreshGeneration;
	try {
		const sessions = await window.agent.listSessions(workspaceId);
		if (generation === sessionsRefreshGeneration) {
			store.dispatch({ type: "sessions", sessions });
		}
	} catch {
		// The live session list is best-effort; the catalog remains the fallback.
	}
}

export async function removeWorkspaceEntry(workspace: string): Promise<void> {
	const wasActive = workspacePathsEqual(store.getSnapshot().status.workspace ?? "", workspace);
	const workspaces = await window.agent.removeWorkspace(workspace);
	if (wasActive) {
		store.dispatch({ type: "active-session", sessionId: null });
	}
	store.dispatch({ type: "workspaces", workspaces });
	await refreshSessionCatalog();
}

/**
 * Open a session (UI focus switch; never tears down other sessions).
 */ export async function openSession(workspaceId: string, sessionId: string): Promise<void> {
	if (!workspaceId) {
		throw new Error("This session does not record a workspace path");
	}
	// Opening a session implies activating its workspace: without this, a
	// startup catalog click would load the history but leave the status at
	// no-workspace, keeping the chat hidden until a workspace was added.
	const snapshot = store.getSnapshot();
	const activeWorkspace = snapshot.status.workspace;
	const workspaceRunning =
		snapshot.status.phase === "running" &&
		activeWorkspace !== null &&
		workspacePathsEqual(activeWorkspace, workspaceId);
	if (!workspaceRunning) {
		await startWorkspace(workspaceId);
	}
	store.dispatch({ type: "active-session", sessionId });
	try {
		await loadSessionSnapshot(workspaceId, sessionId);
	} catch (error) {
		store.dispatch({
			type: "session-open-failed",
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/**
 * Fetch a session's authoritative snapshot (state, history, thinking
 * levels, editable entries) and apply it to the store. Shared by
 * openSession and the edit-fork paths that must show authoritative history.
 */
async function loadSessionSnapshot(workspaceId: string, sessionId: string): Promise<void> {
	const [sessionSnapshot, thinkingLevels, editableUserMessages] = await Promise.all([
		window.agent.openSession(workspaceId, sessionId),
		window.agent.listThinkingLevels(workspaceId, sessionId).catch(() => []),
		window.agent.listEditableUserMessages(workspaceId, sessionId).catch(() => []),
	]);
	const revision = agentStateRevision;
	store.dispatch({
		type: "session-snapshot",
		workspaceId,
		state: sessionSnapshot.state,
		messages: sessionSnapshot.messages,
		usage: sessionSnapshot.usage,
		thinkingLevels,
		editableUserMessages,
	});
	if (revision === agentStateRevision) {
		void refreshSessionUsage(workspaceId, sessionId);
	}
}

/** Create a new session in the workspace and focus it. */
export async function newSession(workspaceId: string): Promise<string> {
	const session = await window.agent.createSession(workspaceId);
	await refreshSessionCatalog();
	void refreshSessions(workspaceId);
	await openSession(workspaceId, session.id);
	return session.id;
}

/**
 * Open the inline editor for a past user message. Pure UI state: nothing is
 * sent to the backend until resendEditedMessage commits the edit.
 */
export function startEditMessage(sessionId: string, entryId: string, text: string): void {
	store.dispatch({ type: "session-edit-start", sessionId, entryId, text });
}

/** Update the inline editor's draft text. */
export function updateEditDraft(sessionId: string, text: string): void {
	store.dispatch({ type: "session-edit-draft", sessionId, text });
}

/** Close the inline editor without changing anything. */
export function cancelEditMessage(sessionId: string): void {
	store.dispatch({ type: "session-edit-cancel", sessionId });
}

/**
 * Commit the inline edit: the session tree branches before the edited
 * message (same session file) and the edited text is resent in place. The
 * renderer truncates the history optimistically; on a backend rejection or
 * an extension veto the authoritative snapshot restores the original view.
 */
export async function resendEditedMessage(
	workspaceId: string,
	sessionId: string,
	entryId: string,
	text: string,
): Promise<void> {
	store.dispatch({ type: "session-edit-commit", sessionId, entryId });
	try {
		const result = await window.agent.editUserMessage(workspaceId, sessionId, entryId, text);
		if (result.status === "cancelled") {
			store.dispatch({
				type: "notify",
				notification: { message: "The edit was cancelled by an extension", type: "info" },
			});
			await loadSessionSnapshot(workspaceId, sessionId).catch(() => {});
			return;
		}
		// Sent: the optimistic truncation is the truth; the resent message and
		// the new assistant turn arrive through the normal event stream, and
		// editable entries realign after agent_stopped.
	} catch (error) {
		// The backend restored the previous leaf; put the original history
		// back before surfacing the error.
		await loadSessionSnapshot(workspaceId, sessionId).catch(() => {});
		throw error;
	}
}

export async function sendMessage(workspaceId: string, sessionId: string, message: UserMessage): Promise<void> {
	await window.agent.sendMessage(workspaceId, sessionId, message);
}

export async function renameSessionEntry(session: SessionInfo, name: string): Promise<void> {
	if (session.workspacePath) {
		await window.agent.renameSession(session.workspacePath, session.id, name);
	} else {
		await window.agent.renameCatalogSession(session.id, name);
	}
	await refreshSessionCatalog();
	await refreshSessionsForEntry(session);
}

/**
 * Delete a session, targeting its own workspace (§14.2). Deleting the active
 * idle session is allowed: the renderer falls back to another session (§14.3).
 */
export async function deleteSessionEntry(session: SessionInfo): Promise<void> {
	if (session.workspacePath) {
		await window.agent.deleteSession(session.workspacePath, session.id);
	} else {
		await window.agent.deleteCatalogSession(session.id);
	}
	const snapshot = store.getSnapshot();
	if (snapshot.activeSessionId === session.id) {
		const fallback = pickFallbackSession(snapshot, session);
		if (fallback) {
			await openSession(fallback.workspacePath ?? session.workspacePath ?? "", fallback.id);
		} else {
			store.dispatch({ type: "active-session", sessionId: null });
		}
	}
	await refreshSessionCatalog();
	await refreshSessionsForEntry(session);
	await refreshWorkspaceList();
}

/** Refresh the live session list when the entry belongs to the active workspace. */
async function refreshSessionsForEntry(session: SessionInfo): Promise<void> {
	const activeWorkspace = store.getSnapshot().status.workspace;
	if (!session.workspacePath || !activeWorkspace) {
		return;
	}
	if (workspacePathsEqual(activeWorkspace, session.workspacePath)) {
		await refreshSessions(activeWorkspace);
	}
}

function pickFallbackSession(
	snapshot: ReturnType<AgentStore["getSnapshot"]>,
	deleted: SessionInfo,
): SessionInfo | null {
	const sessions = snapshot.sessionCatalog.filter(
		(entry) => entry.id !== deleted.id && entry.workspacePath === deleted.workspacePath,
	);
	return sessions[0] ?? null;
}

async function refreshWorkspaceList(): Promise<void> {
	const workspaces = await window.agent.listWorkspaces();
	store.dispatch({ type: "workspaces", workspaces });
}

export async function setSessionStorage(config: SessionStorageConfig): Promise<SessionStorageConfig> {
	return runControlledBackendTransition(async () => {
		const saved = await window.agent.setSessionStorage(config);
		await refreshSessionCatalog();
		return saved;
	});
}

async function runControlledBackendTransition<T>(operation: () => Promise<T>): Promise<T> {
	controlledBackendTransitions += 1;
	try {
		return await operation();
	} finally {
		controlledBackendTransitions -= 1;
	}
}

export async function setModel(
	workspaceId: string,
	sessionId: string,
	model: { provider: string; modelId: string },
): Promise<void> {
	const selected = await window.agent.setModel(workspaceId, sessionId, model);
	const stateRevision = agentStateRevision;
	const [state, thinkingLevels] = await Promise.all([
		window.agent.getState(workspaceId, sessionId),
		window.agent.listThinkingLevels(workspaceId, sessionId).catch(() => []),
	]);
	const snapshot = store.getSnapshot();
	const session = snapshot.sessionStateById[sessionId];
	if (session && stateRevision === agentStateRevision) {
		store.dispatch({
			type: "session-state-update",
			workspaceId,
			state,
			usage: session.sessionUsage,
			thinkingLevels,
		});
	}
	void refreshSessionUsage(workspaceId, sessionId);
	if (selected && !snapshot.models.some((entry) => entry.provider === selected.provider && entry.id === selected.id)) {
		// The backend confirmed a model outside the current catalog: refresh it.
		void refreshModelCatalog();
	}
}

export async function setThinkingLevel(workspaceId: string, sessionId: string, level: string): Promise<void> {
	await window.agent.setThinkingLevel(workspaceId, sessionId, level);
	const stateRevision = agentStateRevision;
	const state = await window.agent.getState(workspaceId, sessionId);
	const snapshot = store.getSnapshot();
	const session = snapshot.sessionStateById[sessionId];
	if (session && stateRevision === agentStateRevision) {
		store.dispatch({ type: "session-state-update", workspaceId, state, usage: session.sessionUsage });
	}
}

export async function respondInteraction(
	workspaceId: string,
	sessionId: string,
	id: string,
	response: InteractionResponse,
): Promise<void> {
	await window.agent.respondInteraction(workspaceId, sessionId, id, response);
	store.dispatch({ type: "dismiss-interaction", sessionId, id });
}

/** Refresh the read-only provider auth status list. */
async function refreshProviderAuth(): Promise<void> {
	const statuses = await window.agent.listProviderAuthStatus();
	store.dispatch({ type: "auth-status", statuses });
}

/**
 * Store an api key through the shared credential API, then refresh the
 * model catalog and auth status so the change applies without an app restart.
 */
export async function saveProviderApiKey(provider: string, apiKey: string): Promise<void> {
	await window.agent.setApiKey(provider, apiKey);
	await refreshProviderAuth();
	await refreshModelCatalog();
}

/** Remove a stored credential, then refresh catalog and auth status. */
export async function removeProviderCredential(provider: string): Promise<void> {
	await window.agent.removeCredential(provider);
	await refreshProviderAuth();
	await refreshModelCatalog();
}

/** List GUI-managed custom providers from models.json. */
export async function listCustomProviders(): Promise<CustomProviderConfig[]> {
	return window.agent.listCustomProviders();
}

/**
 * Save (upsert) a custom provider to models.json, reload the backend catalog,
 * and refresh the GUI so the provider is immediately selectable.
 */
export async function saveCustomProvider(config: CustomProviderConfig): Promise<void> {
	await window.agent.saveCustomProvider(config);
	await Promise.all([refreshModels(), refreshProviderAuth()]);
}

/** Delete a custom provider from models.json, reload, and refresh the GUI. */
export async function deleteCustomProvider(providerId: string): Promise<void> {
	await window.agent.deleteCustomProvider(providerId);
	await Promise.all([refreshModels(), refreshProviderAuth()]);
}

/** Fetch the provider's available model list through the main process. */
export async function fetchCustomProviderModels(
	request: CustomProviderFetchRequest,
): Promise<CustomProviderFetchedModel[]> {
	return window.agent.fetchCustomProviderModels(request);
}

/** Match fetched model ids against the local catalog for pre-fill metadata. */
export async function matchCustomProviderModels(
	request: CustomProviderMatchRequest,
): Promise<CustomProviderMatchedModel[]> {
	return window.agent.matchCustomProviderModels(request);
}

/**
 * Run an OAuth login flow. Progress streams through the store as auth_flow
 * host events; this promise resolves when the flow completes and the
 * credential is stored. Afterwards the catalog and auth status are refreshed.
 */
export async function loginProviderOAuth(provider: string): Promise<void> {
	await window.agent.loginWithOAuth(provider);
	await refreshModelCatalog();
	await refreshProviderAuth();
}

/** Cancel the in-flight OAuth login and clear the flow view. */
export async function cancelOAuthLogin(): Promise<void> {
	await window.agent.cancelOAuthLogin();
	store.dispatch({ type: "auth-flow", flow: null });
}

/** Answer a pending OAuth auth prompt. */
export async function respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
	await window.agent.respondToAuthPrompt(requestId, response);
}
