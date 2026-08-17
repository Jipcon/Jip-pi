/**
 * DesktopAgentRuntime: the facade both backend management implementations
 * (SDK multi-session and legacy RPC) expose to the main process wiring.
 *
 * Session-specific operations carry `{ workspaceId, sessionId }`; host
 * services (models/auth/credentials/OAuth) carry none and must work with
 * zero session backends alive.
 */

import type {
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
import type { BackendStatus, RoutedAgentEvent, SessionSnapshot, SessionStorageConfig } from "../shared/ipc.ts";

export interface DesktopAgentRuntime {
	readonly currentStatus: BackendStatus;
	readonly currentSessionStorage: SessionStorageConfig;
	readonly isRunning: boolean;
	/** Whether any live backend still exists (app-quit cleanup). */
	readonly hasLiveBackends: boolean;
	/** Whether any live session is currently streaming. */
	readonly isAnySessionStreaming: boolean;

	setSessionStorage(config: SessionStorageConfig): void;
	/** Record the UI-focused session (pinning + eviction decisions). */
	setActiveSession(workspace: string, sessionId: string): void;

	onEvent(handler: (event: RoutedAgentEvent) => void): () => void;
	onStatus(handler: (status: BackendStatus) => void): () => void;
	onLog(handler: (line: string) => void): () => void;

	// Workspace lifecycle
	/** Activate a workspace (launching only what the mode requires). */
	start(workspace: string): Promise<string | undefined>;
	/** Stop cached state for a removed workspace. */
	discardWorkspace(workspace: string): Promise<void>;
	/** Reset status to no-workspace after the active workspace was removed (backends already discarded). */
	deactivateWorkspace(workspace: string): void;
	/** Stop everything (app quit). */
	stop(): Promise<void>;
	/** Stop every backend without touching status (session storage changed). */
	stopAllBackends(): Promise<void>;

	// Session execution
	openSession(workspaceId: string, sessionId: string): Promise<SessionSnapshot>;
	sendMessage(workspaceId: string, sessionId: string, message: UserMessage): Promise<void>;
	abort(workspaceId: string, sessionId: string): Promise<void>;
	getState(workspaceId: string, sessionId: string): Promise<AgentState>;
	getMessages(workspaceId: string, sessionId: string): Promise<AgentMessage[]>;
	getSessionUsage(workspaceId: string, sessionId: string): Promise<SessionUsage | null>;
	setModel(workspaceId: string, sessionId: string, model: ModelRef): Promise<ModelInfo | null>;
	listThinkingLevels(workspaceId: string, sessionId: string): Promise<string[]>;
	setThinkingLevel(workspaceId: string, sessionId: string, level: string): Promise<void>;
	respondInteraction(workspaceId: string, sessionId: string, id: string, response: InteractionResponse): Promise<void>;

	// Session administration (mode-specific guards live in the managers)
	createSession(workspaceId: string): Promise<SessionInfo>;
	/** Live session list for a workspace (active backends over the catalog). */
	listSessions(workspaceId: string): Promise<SessionInfo[]>;
	renameSession(workspaceId: string, sessionId: string, name: string): Promise<void>;
	deleteSession(workspaceId: string, sessionId: string): Promise<void>;

	// Host services (zero-backend availability)
	listModels(): Promise<ModelInfo[]>;
	/** Reload the model catalog from disk (e.g. after models.json changes). */
	reloadModels(): Promise<void>;
	/** Full-catalog model metadata by id, independent of credential state. */
	listModelsByIds(ids: string[]): Promise<ModelInfo[]>;
	listProviderAuthStatus(): Promise<ProviderAuthStatus[]>;
	setApiKey(provider: string, apiKey: string): Promise<void>;
	removeCredential(provider: string): Promise<void>;
	loginWithOAuth(provider: string): Promise<void>;
	cancelOAuthLogin(): Promise<void>;
	respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void>;
}
