/**
 * Preload script: the only bridge between the renderer and the main process.
 *
 * The renderer gets a constrained `window.agent` API via contextBridge.
 * It never receives raw ipcRenderer access, Node builtins, or the ability to
 * send arbitrary messages to the backend.
 *
 * Session-specific calls carry `{ workspaceId, sessionId }`; events arrive
 * wrapped in a RoutedAgentEvent envelope so the renderer routes them by
 * session instead of guessing.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	AuthPromptResponse,
	InteractionResponse,
	ModelInfo,
	ModelRef,
	ProviderAuthStatus,
	SessionInfo,
	SessionUsage,
	UserMessage,
} from "@earendil-works/pi-agent-protocol";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
	type BackendStatus,
	type CommandResult,
	type CustomProviderConfig,
	IPC,
	type RoutedAgentEvent,
	type SessionSnapshot,
	type SessionStorageConfig,
} from "../shared/ipc.ts";

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
	const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

/** Invoke a main-process command and unwrap the CommandResult envelope. */
async function invokeCommand<T>(channel: string, ...args: unknown[]): Promise<T> {
	const result = (await ipcRenderer.invoke(channel, ...args)) as CommandResult<T>;
	if (!result.ok) {
		throw new Error(result.error ?? "command failed");
	}
	return result.value as T;
}

const api = {
	pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.workspacePick),
	getWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.workspaceGet),
	getStatus: (): Promise<BackendStatus> => ipcRenderer.invoke(IPC.agentGetStatus),
	listWorkspaces: (): Promise<string[]> => invokeCommand<string[]>(IPC.workspaceList),
	removeWorkspace: (workspace: string): Promise<string[]> => invokeCommand<string[]>(IPC.workspaceRemove, workspace),

	start: (workspace: string): Promise<void> => invokeCommand<void>(IPC.agentStart, workspace),

	openSession: (workspaceId: string, sessionId: string): Promise<SessionSnapshot> =>
		invokeCommand<SessionSnapshot>(IPC.agentOpenSession, workspaceId, sessionId),
	sendMessage: (workspaceId: string, sessionId: string, message: UserMessage): Promise<void> =>
		invokeCommand<void>(IPC.agentSendMessage, workspaceId, sessionId, message),
	abort: (workspaceId: string, sessionId: string): Promise<void> =>
		invokeCommand<void>(IPC.agentAbort, workspaceId, sessionId),
	createSession: (workspaceId: string): Promise<SessionInfo> =>
		invokeCommand<SessionInfo>(IPC.agentCreateSession, workspaceId),
	renameSession: (workspaceId: string, sessionId: string, name: string): Promise<void> =>
		invokeCommand<void>(IPC.agentRenameSession, workspaceId, sessionId, name),
	deleteSession: (workspaceId: string, sessionId: string): Promise<void> =>
		invokeCommand<void>(IPC.agentDeleteSession, workspaceId, sessionId),
	listSessions: (workspaceId: string): Promise<SessionInfo[]> =>
		invokeCommand<SessionInfo[]>(IPC.agentListSessions, workspaceId),

	listSessionCatalog: (): Promise<SessionInfo[]> => invokeCommand<SessionInfo[]>(IPC.sessionCatalogList),
	renameCatalogSession: (sessionId: string, name: string): Promise<SessionInfo[]> =>
		invokeCommand<SessionInfo[]>(IPC.sessionCatalogRename, sessionId, name),
	deleteCatalogSession: (sessionId: string): Promise<SessionInfo[]> =>
		invokeCommand<SessionInfo[]>(IPC.sessionCatalogDelete, sessionId),

	getState: (workspaceId: string, sessionId: string): Promise<AgentState> =>
		invokeCommand<AgentState>(IPC.agentGetState, workspaceId, sessionId),
	getMessages: (workspaceId: string, sessionId: string): Promise<AgentMessage[]> =>
		invokeCommand<AgentMessage[]>(IPC.agentGetMessages, workspaceId, sessionId),
	getSessionUsage: (workspaceId: string, sessionId: string): Promise<SessionUsage | null> =>
		invokeCommand<SessionUsage | null>(IPC.agentGetSessionUsage, workspaceId, sessionId),
	listModels: (): Promise<ModelInfo[]> => invokeCommand<ModelInfo[]>(IPC.agentListModels),
	reloadModels: (): Promise<void> => invokeCommand<void>(IPC.modelsReload),
	listCustomProviders: (): Promise<CustomProviderConfig[]> =>
		invokeCommand<CustomProviderConfig[]>(IPC.customProvidersList),
	saveCustomProvider: (config: CustomProviderConfig): Promise<void> =>
		invokeCommand<void>(IPC.customProvidersSave, config),
	deleteCustomProvider: (providerId: string): Promise<void> =>
		invokeCommand<void>(IPC.customProvidersDelete, providerId),
	setModel: (workspaceId: string, sessionId: string, model: ModelRef): Promise<ModelInfo | null> =>
		invokeCommand<ModelInfo | null>(IPC.agentSetModel, workspaceId, sessionId, model),
	listThinkingLevels: (workspaceId: string, sessionId: string): Promise<string[]> =>
		invokeCommand<string[]>(IPC.agentListThinkingLevels, workspaceId, sessionId),
	setThinkingLevel: (workspaceId: string, sessionId: string, level: string): Promise<void> =>
		invokeCommand<void>(IPC.agentSetThinkingLevel, workspaceId, sessionId, level),
	listProviderAuthStatus: (): Promise<ProviderAuthStatus[]> => invokeCommand<ProviderAuthStatus[]>(IPC.authListStatus),
	setApiKey: (provider: string, apiKey: string): Promise<void> =>
		invokeCommand<void>(IPC.authSetApiKey, provider, apiKey),
	removeCredential: (provider: string): Promise<void> => invokeCommand<void>(IPC.authRemoveCredential, provider),
	loginWithOAuth: (provider: string): Promise<void> => invokeCommand<void>(IPC.authLoginOAuth, provider),
	cancelOAuthLogin: (): Promise<void> => invokeCommand<void>(IPC.authCancelLogin),
	respondToAuthPrompt: (requestId: string, response: AuthPromptResponse): Promise<void> =>
		invokeCommand<void>(IPC.authRespondPrompt, requestId, response),
	respondInteraction: (
		workspaceId: string,
		sessionId: string,
		id: string,
		response: InteractionResponse,
	): Promise<void> => invokeCommand<void>(IPC.agentRespondInteraction, workspaceId, sessionId, id, response),
	getSessionStorage: (): Promise<SessionStorageConfig> => invokeCommand<SessionStorageConfig>(IPC.sessionStorageGet),
	setSessionStorage: (config: SessionStorageConfig): Promise<SessionStorageConfig> =>
		invokeCommand<SessionStorageConfig>(IPC.sessionStorageSet, config),
	pickSessionStorageRoot: (): Promise<string | null> => ipcRenderer.invoke(IPC.sessionStoragePickRoot),

	subscribe: (callback: (event: RoutedAgentEvent) => void): (() => void) => subscribe(IPC.agentEvent, callback),
	onHostEvent: (callback: (event: AgentEvent) => void): (() => void) => subscribe(IPC.agentHostEvent, callback),
	onStatus: (callback: (status: BackendStatus) => void): (() => void) => subscribe(IPC.agentStatus, callback),
	onLog: (callback: (line: string) => void): (() => void) => subscribe(IPC.agentLog, callback),
};

export type AgentApi = typeof api;

contextBridge.exposeInMainWorld("agent", api);
