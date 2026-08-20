/**
 * Main process: window lifecycle, workspace dialog, IPC wiring.
 *
 * Two backend management implementations exist behind one facade:
 * - SDK mode (default): Electron Main embeds the Pi SDK; multi-session,
 *   host services with zero-backend availability, no extra pi.exe.
 * - Legacy mode (PI_DESKTOP_LEGACY_BACKEND=1): the original one-workspace /
 *   one-active-session RPC subprocess behavior, kept for regression
 *   comparison.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	AuthPromptResponse,
	InteractionResponse,
	ModelRef,
	SessionInfo,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { readSessionProjection, resolveFreshSessionDefaults, SdkHostServices } from "@earendil-works/pi-sdk-adapter";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { CustomProviderConfig, CustomProviderFetchRequest, CustomProviderMatchRequest } from "../shared/ipc.ts";
import { DEFAULT_SESSION_STORAGE, IPC, type SessionStorageConfig } from "../shared/ipc.ts";
import { workspacePathsEqual } from "../shared/workspace-path.ts";
import { createAgentEventForwarder } from "./agent-event-forwarder.ts";
import { AgentHost, agentDirPath } from "./agent-host.ts";
import type { DesktopAgentRuntime } from "./agent-runtime.ts";
import { fetchProviderModels } from "./custom-provider-fetch.ts";
import { mergeMatchedModels } from "./custom-provider-match.ts";
import { deleteCustomProvider, listCustomProviders, saveCustomProvider } from "./custom-providers-store.ts";
import {
	type DesktopSettings,
	loadDesktopSettings,
	rememberDesktopWorkspace,
	removeDesktopWorkspace,
	removeDesktopWorkspaceIfEmpty,
	saveDesktopSettings,
} from "./desktop-settings.ts";
import { toCommandResult } from "./ipc-command.ts";
import { LegacyBackendManager } from "./legacy-backend-manager.ts";
import { SdkBackendManager } from "./sdk-backend-manager.ts";
import { runSdkSpike } from "./sdk-spike.ts";
import { listSessionCatalog, renameCatalogSession } from "./session-catalog.ts";
import { normalizeSessionStorageConfig } from "./session-storage.ts";

app.setName("Jip-pi");

const sdkMode = process.env.PI_DESKTOP_LEGACY_BACKEND !== "1";

let mainWindow: BrowserWindow | null = null;
let quitting = false;
let cleanupComplete = false;
let desktopSettings: DesktopSettings = {
	sessionStorage: { ...DEFAULT_SESSION_STORAGE },
	recentWorkspaces: [],
	hiddenWorkspaces: [],
};

// Dev-only hooks (used by the acceptance harness):
// - PI_DESKTOP_AUTOSTART_WORKSPACE: skip the workspace dialog and start immediately
// - PI_DESKTOP_DEBUG_PORT: expose the Chrome DevTools protocol for scripted checks
const autoStartWorkspace = process.env.PI_DESKTOP_AUTOSTART_WORKSPACE;
const debugPort = process.env.PI_DESKTOP_DEBUG_PORT;
if (debugPort) {
	app.commandLine.appendSwitch("remote-debugging-port", debugPort);
}

function desktopSettingsPath(): string {
	return join(app.getPath("userData"), "desktop-settings.json");
}

function saveCurrentDesktopSettings(): void {
	saveDesktopSettings(desktopSettingsPath(), desktopSettings);
}

function rememberWorkspace(workspace: string): void {
	const nextSettings = rememberDesktopWorkspace(desktopSettings, workspace);
	if (nextSettings === desktopSettings) return;
	desktopSettings = nextSettings;
	saveCurrentDesktopSettings();
}

function removeWorkspace(workspace: string): void {
	const nextSettings = removeDesktopWorkspace(desktopSettings, workspace);
	if (nextSettings === desktopSettings) return;
	desktopSettings = nextSettings;
	saveCurrentDesktopSettings();
}

function removeWorkspaceIfEmpty(workspace: string | undefined, sessions: SessionInfo[]): void {
	if (!workspace) return;
	const nextSettings = removeDesktopWorkspaceIfEmpty(
		desktopSettings,
		workspace,
		sessions.map((session) => session.workspacePath),
	);
	if (nextSettings === desktopSettings) return;
	desktopSettings = nextSettings;
	saveCurrentDesktopSettings();
}

function sessionCatalogOptions() {
	return {
		sessionStorage: desktopSettings.sessionStorage,
		recentWorkspaces: desktopSettings.recentWorkspaces,
		hiddenWorkspaces: desktopSettings.hiddenWorkspaces,
	};
}

const agentHost = new AgentHost({
	listCatalog: () => listSessionCatalog(sessionCatalogOptions()),
	renameCatalogSession: (sessionId, name) => renameCatalogSession(sessionCatalogOptions(), sessionId, name),
});

async function deleteSessionFile(file: string): Promise<void> {
	await shell.trashItem(file);
	agentHost.invalidate();
}

/** Path to the shared models.json the GUI edits for custom providers. */
function modelsJsonPath(): string {
	return join(agentDirPath(), "models.json");
}

const hostServices = new SdkHostServices({
	agentDir: agentDirPath(),
	openExternalUrl: (url) => shell.openExternal(url),
});

const runtime: DesktopAgentRuntime = sdkMode
	? new SdkBackendManager({
			agentDir: agentDirPath(),
			hostServices,
			readSessionProjection: (file, options) =>
				readSessionProjection(file, {
					sessionId: options.sessionId,
					modelRuntime: hostServices.sharedRuntime,
					resolveContextWindow: options.resolveContextWindow,
				}),
			findSession: (sessionId) => agentHost.findSession(sessionId),
			listCatalogSessions: () => agentHost.listSessions(),
			createSessionFile: (workspace, sessionDir) => agentHost.createSessionFile(workspace, sessionDir),
			renameCatalogSession: (sessionId, name) => agentHost.renameCatalogSession(sessionId, name),
			deleteCatalogFile: deleteSessionFile,
			resolveFreshSessionDefaults: (workspacePath, pendingModel) =>
				resolveFreshSessionDefaults({
					workspacePath,
					agentDir: agentDirPath(),
					modelRuntime: hostServices.sharedRuntime,
					pendingModel,
				}),
		})
	: new LegacyBackendManager({
			findSession: (sessionId) => agentHost.findSession(sessionId),
			renameCatalogSession: (sessionId, name) => agentHost.renameCatalogSession(sessionId, name),
			deleteCatalogFile: deleteSessionFile,
		});

async function startWorkspace(workspace: string): Promise<string | undefined> {
	const error = await runtime.start(workspace);
	if (error === undefined) {
		rememberWorkspace(workspace);
	}
	return error;
}

async function loadSessionCatalog(): Promise<SessionInfo[]> {
	const sessions = await agentHost.listSessions();
	let nextSettings = desktopSettings;
	for (const session of sessions) {
		if (session.workspacePath) {
			nextSettings = rememberDesktopWorkspace(nextSettings, session.workspacePath);
		}
	}
	if (nextSettings !== desktopSettings) {
		desktopSettings = nextSettings;
		saveCurrentDesktopSettings();
	}
	return sessions;
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1080,
		minHeight: 720,
		title: "Jip-pi",
		icon: join(app.getAppPath(), "assets", "icon.png"),
		backgroundColor: "#121416",
		titleBarStyle: "hidden",
		...(process.platform !== "darwin"
			? {
					titleBarOverlay: {
						color: "#191c1f",
						symbolColor: "#c7c7c7",
						height: 60,
					},
				}
			: {}),
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			// The preload is bundled as ESM-compatible CJS; keep the renderer
			// itself fully isolated from Node (no require/child_process/fs).
			sandbox: false,
		},
	});

	// Forward backend activity to the renderer over the constrained IPC
	// surface, wrapped in a RoutedAgentEvent envelope. tool_updated events are
	// throttled latest-wins so cumulative partialResult payloads cannot flood
	// the renderer during long-running tools.
	const eventForwarder = createAgentEventForwarder((routed) => {
		mainWindow?.webContents.send(IPC.agentEvent, routed);
	});
	runtime.onEvent((routed) => eventForwarder.forward(routed));
	// Host-level events (auth flow updates/prompts) travel on a separate
	// channel and never depend on a session backend.
	const hostEventUnsubscriber = hostServices.subscribe((event) => {
		mainWindow?.webContents.send(IPC.agentHostEvent, event);
	});
	runtime.onStatus((status) => {
		mainWindow?.webContents.send(IPC.agentStatus, status);
	});
	runtime.onLog((line) => {
		mainWindow?.webContents.send(IPC.agentLog, line);
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
		eventForwarder.dispose();
		hostEventUnsubscriber();
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		try {
			const protocol = new URL(url).protocol;
			if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
				void shell.openExternal(url).catch(() => {});
			}
		} catch {
			// Ignore malformed and relative URLs rather than opening them in Electron.
		}
		return { action: "deny" };
	});

	if (autoStartWorkspace) {
		mainWindow.webContents.once("did-finish-load", () => {
			void startWorkspace(autoStartWorkspace);
		});
	}

	const devServerUrl =
		process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL ??
		(!app.isPackaged ? `http://localhost:${process.env.PI_DESKTOP_VITE_PORT ?? 5173}` : undefined);
	if (devServerUrl !== undefined) {
		void mainWindow.loadURL(devServerUrl);
	} else {
		void mainWindow.loadFile(join(__dirname, "..", "renderer", "main_window", "index.html"));
	}
}

function registerIpc(): void {
	ipcMain.handle(IPC.workspacePick, async () => {
		const result = await dialog.showOpenDialog({
			title: "Select Workspace",
			properties: ["openDirectory", "createDirectory"],
		});
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});

	ipcMain.handle(IPC.workspaceGet, () => runtime.currentStatus.workspace ?? null);
	ipcMain.handle(IPC.workspaceList, () => toCommandResult(() => [...desktopSettings.recentWorkspaces]));
	ipcMain.handle(IPC.workspaceRemove, (_event, workspace: string) =>
		toCommandResult(async () => {
			const activeWorkspace = runtime.currentStatus.workspace;
			const wasActive = activeWorkspace !== null && workspacePathsEqual(activeWorkspace, workspace);
			// Stop any cached backends for the removed workspace so no session
			// is streaming when its files are deleted. Must run before trashing
			// the directory: the legacy RPC subprocess uses the workspace as
			// its cwd, which Windows locks while the process is alive.
			await runtime.discardWorkspace(workspace);
			// Delete every session that belongs to the workspace, then drop the
			// workspace from the recent list.
			agentHost.invalidate();
			const sessions = await agentHost.listSessions();
			const workspaceSessionFiles = sessions
				.filter((session) => session.workspacePath && workspacePathsEqual(session.workspacePath, workspace))
				.map((session) => session.file)
				.filter((file): file is string => file !== undefined);
			await Promise.all(workspaceSessionFiles.map((file) => deleteSessionFile(file)));
			// Move the workspace directory itself to the Trash as well. Sessions
			// stored outside it (default/custom session root) were handled above.
			if (existsSync(workspace)) {
				await shell.trashItem(workspace);
			}
			// If the removed workspace was the active one, reset the runtime
			// status so the renderer leaves the (now deleted) chat view.
			if (wasActive) {
				runtime.deactivateWorkspace(workspace);
			}
			removeWorkspace(workspace);
			agentHost.invalidate();
			return [...desktopSettings.recentWorkspaces];
		}),
	);

	ipcMain.handle(IPC.agentStart, (_event, workspace: string) =>
		toCommandResult(async () => {
			const error = await startWorkspace(workspace);
			if (error !== undefined) {
				throw new Error(error);
			}
		}),
	);

	ipcMain.handle(IPC.agentOpenSession, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(async () => {
			// Opening a session activates its workspace (defense-in-depth for
			// any caller; the renderer also starts the workspace first).
			if (workspaceId) {
				const activeWorkspace = runtime.currentStatus.workspace;
				const workspaceRunning =
					runtime.currentStatus.phase === "running" &&
					activeWorkspace !== null &&
					workspacePathsEqual(activeWorkspace, workspaceId);
				if (!workspaceRunning) {
					const error = await startWorkspace(workspaceId);
					if (error !== undefined) {
						throw new Error(error);
					}
				}
			}
			runtime.setActiveSession(workspaceId, sessionId);
			return runtime.openSession(workspaceId, sessionId);
		}),
	);

	ipcMain.handle(IPC.agentSendMessage, (_event, workspaceId: string, sessionId: string, message: UserMessage) =>
		toCommandResult(() => runtime.sendMessage(workspaceId, sessionId, message)),
	);

	ipcMain.handle(IPC.agentAbort, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.abort(workspaceId, sessionId)),
	);

	ipcMain.handle(IPC.agentCreateSession, (_event, workspaceId: string) =>
		toCommandResult(async () => {
			const session = await runtime.createSession(workspaceId);
			agentHost.invalidate();
			rememberWorkspace(workspaceId);
			return session;
		}),
	);

	ipcMain.handle(IPC.agentRenameSession, (_event, workspaceId: string, sessionId: string, name: string) =>
		toCommandResult(async () => {
			await runtime.renameSession(workspaceId, sessionId, name);
			agentHost.invalidate();
		}),
	);

	ipcMain.handle(IPC.agentDeleteSession, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(async () => {
			await runtime.deleteSession(workspaceId, sessionId);
			agentHost.invalidate();
			const sessions = await loadSessionCatalog();
			removeWorkspaceIfEmpty(workspaceId, sessions);
		}),
	);

	ipcMain.handle(IPC.agentListSessions, (_event, workspaceId: string) =>
		toCommandResult(() => runtime.listSessions(workspaceId)),
	);

	ipcMain.handle(IPC.sessionCatalogList, () =>
		toCommandResult(async () => {
			agentHost.invalidate();
			return loadSessionCatalog();
		}),
	);

	ipcMain.handle(IPC.agentGetState, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.getState(workspaceId, sessionId)),
	);

	ipcMain.handle(IPC.agentGetStatus, () => runtime.currentStatus);

	ipcMain.handle(IPC.agentGetMessages, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.getMessages(workspaceId, sessionId)),
	);

	ipcMain.handle(IPC.agentGetSessionUsage, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.getSessionUsage(workspaceId, sessionId)),
	);

	ipcMain.handle(IPC.agentListModels, () => toCommandResult(() => runtime.listModels()));

	ipcMain.handle(IPC.modelsReload, () => toCommandResult(() => runtime.reloadModels()));

	ipcMain.handle(IPC.agentSetModel, (_event, workspaceId: string, sessionId: string, model: ModelRef) =>
		toCommandResult(() => runtime.setModel(workspaceId, sessionId, model)),
	);

	ipcMain.handle(IPC.agentListThinkingLevels, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.listThinkingLevels(workspaceId, sessionId)),
	);

	ipcMain.handle(IPC.agentSetThinkingLevel, (_event, workspaceId: string, sessionId: string, level: string) =>
		toCommandResult(() => runtime.setThinkingLevel(workspaceId, sessionId, level)),
	);

	ipcMain.handle(IPC.authListStatus, () => toCommandResult(() => runtime.listProviderAuthStatus()));

	ipcMain.handle(IPC.authSetApiKey, (_event, provider: string, apiKey: string) =>
		toCommandResult(() => runtime.setApiKey(provider, apiKey)),
	);

	ipcMain.handle(IPC.authRemoveCredential, (_event, provider: string) =>
		toCommandResult(() => runtime.removeCredential(provider)),
	);

	ipcMain.handle(IPC.authLoginOAuth, (_event, provider: string) =>
		toCommandResult(() => runtime.loginWithOAuth(provider)),
	);

	ipcMain.handle(IPC.authCancelLogin, () => toCommandResult(() => runtime.cancelOAuthLogin()));

	ipcMain.handle(IPC.authRespondPrompt, (_event, requestId: string, response: AuthPromptResponse) =>
		toCommandResult(() => runtime.respondToAuthPrompt(requestId, response)),
	);

	ipcMain.handle(IPC.customProvidersList, () => toCommandResult(() => listCustomProviders(modelsJsonPath())));

	ipcMain.handle(IPC.customProvidersSave, (_event, config: CustomProviderConfig) =>
		toCommandResult(async () => {
			await saveCustomProvider(modelsJsonPath(), config);
			// Reload the backend catalog so the new provider is usable without
			// an app restart, then the renderer re-fetches models/auth status.
			await runtime.reloadModels();
		}),
	);

	ipcMain.handle(IPC.customProvidersDelete, (_event, providerId: string) =>
		toCommandResult(async () => {
			deleteCustomProvider(modelsJsonPath(), providerId);
			await runtime.reloadModels();
		}),
	);

	ipcMain.handle(IPC.customProvidersFetchModels, (_event, request: CustomProviderFetchRequest) =>
		toCommandResult(() => fetchProviderModels(request)),
	);

	ipcMain.handle(IPC.customProvidersMatchModels, (_event, request: CustomProviderMatchRequest) =>
		toCommandResult(async () => {
			const hits = await runtime.listModelsByIds(request.ids);
			return mergeMatchedModels(hits, request);
		}),
	);

	ipcMain.handle(
		IPC.agentRespondInteraction,
		(_event, workspaceId: string, sessionId: string, id: string, response: InteractionResponse) =>
			toCommandResult(() => runtime.respondInteraction(workspaceId, sessionId, id, response)),
	);

	ipcMain.handle(IPC.agentListEditableUserMessages, (_event, workspaceId: string, sessionId: string) =>
		toCommandResult(() => runtime.listEditableUserMessages(workspaceId, sessionId)),
	);

	ipcMain.handle(
		IPC.agentEditUserMessage,
		(_event, workspaceId: string, sessionId: string, entryId: string, text: string) =>
			toCommandResult(async () => {
				const result = await runtime.editUserMessage(workspaceId, sessionId, entryId, text);
				if (result.status === "sent") {
					// The session file changed (leaf moved, new entries): invalidate
					// the catalog so preview/message count refresh without waiting.
					agentHost.invalidate();
				}
				return result;
			}),
	);

	ipcMain.handle(IPC.sessionStorageGet, () => toCommandResult(() => runtime.currentSessionStorage));

	ipcMain.handle(IPC.sessionStoragePickRoot, async (): Promise<string | null> => {
		const result = await dialog.showOpenDialog({
			title: "Select Session Storage Root",
			properties: ["openDirectory", "createDirectory"],
		});
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
	});

	ipcMain.handle(IPC.sessionStorageSet, (_event, value: SessionStorageConfig) =>
		toCommandResult(async () => {
			const config = normalizeSessionStorageConfig(value);
			const workspace = runtime.currentStatus.workspace;
			const wasRunning = runtime.isRunning;
			if (wasRunning && runtime.isAnySessionStreaming) {
				throw new Error("Wait for the current response to finish before changing session storage");
			}
			runtime.setSessionStorage(config);
			desktopSettings = { ...desktopSettings, sessionStorage: config };
			saveCurrentDesktopSettings();
			agentHost.invalidate();
			if (wasRunning && workspace) {
				// Session directories changed: every materialized backend must
				// be rebuilt (lazily) under the new root.
				await runtime.stopAllBackends();
				const startError = await startWorkspace(workspace);
				if (startError) {
					throw new Error(startError);
				}
			}
			return config;
		}),
	);
}

app.whenReady().then(() => {
	desktopSettings = loadDesktopSettings(desktopSettingsPath());
	runtime.setSessionStorage(desktopSettings.sessionStorage);
	registerIpc();
	createWindow();

	if (process.env.PI_DESKTOP_SDK_SPIKE === "1") {
		void runSdkSpike();
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Phase 11 shutdown state machine: the first will-quit prevents default,
// waits for async cleanup (backends, auth transactions, subscriptions), then
// quits again; the guard prevents recursive re-entry. Running sessions are
// aborted/settled by backend disposal; their persistence flushes happen
// inside the SDK's own dispose path.
app.on("before-quit", (event) => {
	if (cleanupComplete) {
		return;
	}
	if (quitting) {
		event.preventDefault();
		return;
	}
	if (runtime.hasLiveBackends) {
		event.preventDefault();
		quitting = true;
		void runtime
			.stop()
			.catch(() => {})
			.finally(() => {
				cleanupComplete = true;
				app.quit();
			});
	}
});
