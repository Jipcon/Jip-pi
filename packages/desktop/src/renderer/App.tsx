/**
 * App: overall layout shell.
 *
 * ┌─────────── TopBar (60px) ───────────┐
 * ├ Sidebar ┬ Chat (flex) ┬ Inspector ──┤
 * │ 256px   │  720px col  │  340px      │
 * │         ├ UsageBar ───┤ collapsible │
 * │         ├ Composer ───┤             │
 * └─────────┴─────────────┴─────────────┘
 *
 * The sidebar defaults to 256px and is resizable (200px–480px). The chat column is capped and The chat column is capped and
 * centered; the usage strip is a full-width status bar pinned above the
 * composer.
 *
 * Inspector is closed by default and becomes an overlay drawer below 1280px,
 * while the sidebar stays visible.
 *
 * Sessions are independent: the active session is only UI focus. Background
 * sessions keep streaming and show sidebar indicators (running / needs
 * interaction) without stealing the visible view.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView.tsx";
import { InteractionDialog, NotificationToasts } from "./components/InteractionModal.tsx";
import { OAuthLoginDialog } from "./components/OAuthLoginDialog.tsx";
import { SessionHome } from "./components/SessionHome.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { WorkspacePicker } from "./components/WorkspacePicker.tsx";
import {
	cancelEditMessage,
	cancelOAuthLogin,
	deleteCustomProvider,
	fetchCustomProviderModels,
	listCustomProviders,
	loginProviderOAuth,
	matchCustomProviderModels,
	pickWorkspaceAndStart,
	reloadModelCatalog,
	removeProviderCredential,
	resendEditedMessage,
	respondToAuthPrompt,
	saveCustomProvider,
	saveProviderApiKey,
	setSessionStorage as applySessionStorage,
	startEditMessage,
	startWorkspace,
	store,
	useAgentBridge,
	useAppState,
} from "./state/hooks.ts";
import { redactCredentialText } from "./state/redact.ts";
import { sessionIndicator, type UiMessage } from "./state/store.ts";
import { DEFAULT_SESSION_STORAGE, type SessionStorageConfig } from "../shared/ipc.ts";

const SHOW_THINKING_KEY = "pi-desktop.show-thinking";
const SHOW_TOOL_DETAILS_KEY = "pi-desktop.show-tool-details";
const SHOW_TURN_STATUS_KEY = "pi-desktop.show-turn-status";

// Memoized shells: during streaming, only the chat subtree receives per-frame
// store updates, so these components must not re-render on every delta.
const MemoTopBar = memo(TopBar);
const MemoSidebar = memo(Sidebar);
const MemoSessionHome = memo(SessionHome);
const MemoWorkspacePicker = memo(WorkspacePicker);
const MemoSettingsPanel = memo(SettingsPanel);
const MemoNotificationToasts = memo(NotificationToasts);
const MemoInteractionDialog = memo(InteractionDialog);

function loadDisplayPreference(key: string): boolean {
	try {
		return window.localStorage.getItem(key) === "true";
	} catch {
		return false;
	}
}

function saveDisplayPreference(key: string, value: boolean): void {
	try {
		window.localStorage.setItem(key, String(value));
	} catch {
		// Preferences are optional when local storage is unavailable.
	}
}

export function App(): React.JSX.Element {
	useAgentBridge();
	const state = useAppState();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [picking, setPicking] = useState(false);
	const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(null);
	const [showThinking, setShowThinking] = useState(() => loadDisplayPreference(SHOW_THINKING_KEY));
	const [showToolDetails, setShowToolDetails] = useState(() => loadDisplayPreference(SHOW_TOOL_DETAILS_KEY));
	const [showTurnStatus, setShowTurnStatus] = useState(() => {
		try {
			const stored = window.localStorage.getItem(SHOW_TURN_STATUS_KEY);
			return stored === null ? true : stored === "true";
		} catch {
			return true;
		}
	});
	const [sessionStorageConfig, setSessionStorageConfig] = useState<SessionStorageConfig>({
		...DEFAULT_SESSION_STORAGE,
	});
	// In-flight OAuth login: provider + last error. The flow view (auth url,
	// device code, prompts) comes from the store's authFlow updates.
	const [oauthLogin, setOauthLogin] = useState<{ provider: string; error: string | null } | null>(null);

	const running = state.status.phase === "running";
	const activeSessionId = state.activeSessionId;
	const activeSession = activeSessionId !== null ? state.sessionStateById[activeSessionId] : undefined;
	const workspace = state.status.workspace;
	const streaming = activeSession?.agentState?.isStreaming === true;
	const busy = state.status.phase === "starting";
	const visibleNotifications = showTurnStatus
		? state.notifications
		: state.notifications.filter(
				(notification) =>
					!notification.message.startsWith("Turn Stats") &&
					!notification.message.startsWith("Turn Statistics"),
			);

	// Sidebar indicators for every known session (running / needs-attention).
	const indicators = useMemo(() => {
		const result: Record<string, "running" | "needs-attention" | null> = {};
		for (const session of Object.values(state.sessionStateById)) {
			result[session.sessionId] = sessionIndicator(session);
		}
		return result;
	}, [state.sessionStateById]);

	// Auto-dismiss notifications after a few seconds.
	useEffect(() => {
		if (state.notifications.length === 0) {
			return;
		}
		const timers = state.notifications.map((notification) =>
			setTimeout(() => store.dispatch({ type: "dismiss-notification", id: notification.id }), 6000),
		);
		return () => timers.forEach(clearTimeout);
	}, [state.notifications]);

	useEffect(() => {
		saveDisplayPreference(SHOW_THINKING_KEY, showThinking);
	}, [showThinking]);

	useEffect(() => {
		saveDisplayPreference(SHOW_TOOL_DETAILS_KEY, showToolDetails);
	}, [showToolDetails]);

	useEffect(() => {
		saveDisplayPreference(SHOW_TURN_STATUS_KEY, showTurnStatus);
	}, [showTurnStatus]);

	useEffect(() => {
		void window.agent
			.getSessionStorage()
			.then(setSessionStorageConfig)
			.catch((error) =>
				store.dispatch({
					type: "host-event",
					event: {
						type: "error",
						message: `Failed to load session storage settings: ${error instanceof Error ? error.message : String(error)}`,
						source: "protocol",
					},
				}),
			);
	}, []);

	const saveSessionStorage = useCallback(async (config: SessionStorageConfig): Promise<void> => {
		const saved = await applySessionStorage(config);
		setSessionStorageConfig(saved);
	}, []);

	const onPickWorkspace = useCallback(async () => {
		setPicking(true);
		try {
			await pickWorkspaceAndStart();
		} finally {
			setPicking(false);
		}
	}, []);

	const onStartWorkspace = useCallback(async (workspace: string) => {
		setSwitchingWorkspace(workspace);
		setPicking(true);
		try {
			await startWorkspace(workspace);
		} finally {
			setSwitchingWorkspace(null);
			setPicking(false);
		}
	}, []);

	const dismissNotification = useCallback((id: string) => {
		store.dispatch({ type: "dismiss-notification", id });
	}, []);

	const openSettings = useCallback(() => setSettingsOpen(true), []);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const pickSessionStorageRoot = useCallback(() => window.agent.pickSessionStorageRoot(), []);

	const closeOAuthFlow = useCallback(async () => {
		// Cancelling is idempotent on the backend: harmless when the flow
		// already ended.
		await cancelOAuthLogin().catch(() => {});
		setOauthLogin(null);
		store.dispatch({ type: "auth-flow", flow: null });
	}, []);

	const startOAuthLogin = useCallback(async (provider: string) => {
		setOauthLogin({ provider, error: null });
		try {
			await loginProviderOAuth(provider);
			setOauthLogin(null);
			store.dispatch({ type: "auth-flow", flow: null });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Login cancelled") {
				// Cancelled (dialog button, workspace switch, quit): close quietly.
				setOauthLogin(null);
				store.dispatch({ type: "auth-flow", flow: null });
				return;
			}
			setOauthLogin((previous) =>
				previous ? { ...previous, error: redactCredentialText(message) } : previous,
			);
		}
	}, []);

	// Message editing is capability-gated; ChatView additionally hides the
	// button while the session is streaming or the message has no entry id.
	const canEditMessages = state.status.handshake?.capabilities?.messageEdit === true;

	const onEditMessage = useCallback(
		(message: UiMessage) => {
			if (message.entryId === undefined || activeSessionId === null) {
				return;
			}
			// The inline editor opens with the message's own text blocks (v1: text
			// only — images are shown read-only and not resent).
			const text = message.blocks
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			startEditMessage(activeSessionId, message.entryId, text);
		},
		[activeSessionId],
	);

	const onEditCancel = useCallback(() => {
		if (activeSessionId !== null) {
			cancelEditMessage(activeSessionId);
		}
	}, [activeSessionId]);

	// The commit receives the final text from the editor; the edit target is
	// read from the store at call time so this callback stays stable while
	// the user types.
	const onEditSend = useCallback(
		(text: string) => {
			if (activeSessionId === null) {
				return;
			}
			const session = store.getSnapshot().sessionStateById[activeSessionId];
			const workspaceId = session?.workspaceId ?? workspace ?? "";
			if (!session?.editing || !workspaceId) {
				return;
			}
			void resendEditedMessage(workspaceId, activeSessionId, session.editing.entryId, text).catch((error) => {
				store.dispatch({
					type: "notify",
					notification: {
						message: `Failed to edit message: ${error instanceof Error ? error.message : String(error)}`,
						type: "error",
					},
				});
			});
		},
		[activeSessionId, workspace],
	);

	const noWorkspace =
		state.status.phase === "no-workspace" ||
		(!running && !state.status.workspace && (activeSession === undefined || activeSession.messages.length === 0));
	if (
		noWorkspace &&
		state.sessionCatalogStatus === "ready" &&
		state.sessionCatalog.length === 0 &&
		state.workspaces.length === 0
	) {
		return (
			<div className="app-shell">
				<MemoWorkspacePicker busy={picking || busy} error={state.error} onPick={() => void onPickWorkspace()} />
				<MemoNotificationToasts notifications={visibleNotifications} onDismiss={dismissNotification} />
			</div>
		);
	}

	const activeInteraction = activeSession?.interactions[0] ?? null;
	const currentModel = activeSession?.agentState?.model ?? null;

	return (
		<div className="app-shell" data-testid="app-shell">
			<MemoTopBar
				workspaceId={activeSession?.workspaceId ?? workspace ?? ""}
				sessionId={activeSessionId ?? ""}
				phase={state.status.phase}
				models={state.models}
				currentModel={currentModel}
				thinkingLevels={activeSession?.thinkingLevels ?? []}
				thinkingLevel={activeSession?.agentState?.thinkingLevel}
				onOpenSettings={openSettings}
				locked={streaming || activeSession?.agentState?.isCompacting === true || activeSession?.retry !== null}
			/>
			<MemoSidebar
				workspace={workspace}
				workspaces={state.workspaces}
				sessions={state.sessions}
				catalogSessions={state.sessionCatalog}
				catalogLoading={state.sessionCatalogStatus === "loading"}
				currentSessionId={activeSessionId}
				indicators={indicators}
				busy={picking || busy}
				running={running}
			switchingWorkspace={switchingWorkspace}
			onAddWorkspace={() => void onPickWorkspace()}
				onOpenWorkspace={(workspace) => void onStartWorkspace(workspace)}
			/>
			{noWorkspace ? (
				<MemoSessionHome
					busy={picking || busy}
					loading={state.sessionCatalogStatus === "loading"}
					onPickWorkspace={() => void onPickWorkspace()}
				/>
			) : (
				<ChatView
					workspaceId={activeSession?.workspaceId ?? workspace ?? ""}
					messages={activeSession?.messages ?? []}
					tools={activeSession?.tools ?? {}}
					streaming={streaming}
					disabled={!running}
					showThinking={showThinking}
					showToolDetails={showToolDetails}
					sessionUsage={activeSession?.sessionUsage ?? null}
					supportsImages={currentModel?.input?.includes("image") === true}
					retry={activeSession?.retry ?? null}
					sessionKey={activeSessionId ?? ""}
					canEdit={canEditMessages}
					onEditMessage={onEditMessage}
					editing={activeSession?.editing ?? null}
					onEditSend={onEditSend}
					onEditCancel={onEditCancel}
				/>
			)}
			{activeInteraction && activeSession && (
				<MemoInteractionDialog
					workspaceId={activeSession.workspaceId}
					sessionId={activeSession.sessionId}
					request={activeInteraction}
					onClose={() =>
						store.dispatch({
							type: "dismiss-interaction",
							sessionId: activeSession.sessionId,
							id: activeInteraction.id,
						})
					}
				/>
			)}
			{settingsOpen && (
				<MemoSettingsPanel
					logs={state.logs}
					diagnostics={state.diagnostics}
					authStatuses={state.authStatuses}
					showThinking={showThinking}
					showToolDetails={showToolDetails}
					showTurnStatus={showTurnStatus}
					sessionStorage={sessionStorageConfig}
					storageBusy={streaming}
					onShowThinkingChange={setShowThinking}
					onShowToolDetailsChange={setShowToolDetails}
					onShowTurnStatusChange={setShowTurnStatus}
					onPickSessionStorageRoot={pickSessionStorageRoot}
					onSessionStorageChange={saveSessionStorage}
					onSaveApiKey={(provider, apiKey) => saveProviderApiKey(provider, apiKey)}
					onRemoveCredential={(provider) => removeProviderCredential(provider)}
					onStartOAuthLogin={(provider) => void startOAuthLogin(provider)}
					onListCustomProviders={listCustomProviders}
					onSaveCustomProvider={saveCustomProvider}
					onDeleteCustomProvider={deleteCustomProvider}
					onReloadModels={reloadModelCatalog}
					onFetchCustomProviderModels={fetchCustomProviderModels}
					onMatchCustomProviderModels={matchCustomProviderModels}
					onClose={closeSettings}
				/>
			)}
			{oauthLogin && (
				<OAuthLoginDialog
					status={
						state.authStatuses.find((status) => status.provider === oauthLogin.provider) ?? {
							provider: oauthLogin.provider,
							configured: false,
							source: "none",
							mutable: false,
						}
					}
					flow={state.authFlow}
					error={oauthLogin.error}
					disabled={oauthLogin.error !== null}
					onRespond={respondToAuthPrompt}
					onCancel={closeOAuthFlow}
					onClose={closeOAuthFlow}
				/>
			)}
			<MemoNotificationToasts notifications={visibleNotifications} onDismiss={dismissNotification} />
		</div>
	);
}
