/**
 * Shared IPC contract between main, preload and renderer.
 *
 * The renderer only ever sees the constrained `window.agent` API exposed by
 * the preload script; these channel names are an internal implementation
 * detail that the renderer never touches directly.
 *
 * Session-specific requests carry `{ workspaceId, sessionId }`; events are
 * routed back in a `RoutedAgentEvent` envelope so the renderer never has to
 * guess which session an event belongs to.
 */

import type {
	AgentEvent,
	AgentMessage,
	AgentState,
	BackendHandshake,
	ModelThinkingLevel,
	SessionUsage,
} from "@earendil-works/pi-agent-protocol";

export const IPC = {
	workspacePick: "workspace:pick",
	workspaceGet: "workspace:get",
	workspaceList: "workspace:list",
	workspaceRemove: "workspace:remove",
	agentStart: "agent:start",
	agentOpenSession: "agent:openSession",
	agentSendMessage: "agent:sendMessage",
	agentAbort: "agent:abort",
	agentCreateSession: "agent:createSession",
	agentRenameSession: "agent:renameSession",
	agentDeleteSession: "agent:deleteSession",
	agentListSessions: "agent:listSessions",
	sessionCatalogList: "sessionCatalog:list",
	sessionCatalogRename: "sessionCatalog:rename",
	sessionCatalogDelete: "sessionCatalog:delete",
	agentGetState: "agent:getState",
	agentGetStatus: "agent:getStatus",
	agentGetMessages: "agent:getMessages",
	agentGetSessionUsage: "agent:getSessionUsage",
	agentListModels: "agent:listModels",
	agentSetModel: "agent:setModel",
	modelsReload: "models:reload",
	customProvidersList: "customProviders:list",
	customProvidersSave: "customProviders:save",
	customProvidersDelete: "customProviders:delete",
	customProvidersFetchModels: "customProviders:fetchModels",
	customProvidersMatchModels: "customProviders:matchModels",
	agentListThinkingLevels: "agent:listThinkingLevels",
	agentSetThinkingLevel: "agent:setThinkingLevel",
	authListStatus: "auth:listStatus",
	authSetApiKey: "auth:setApiKey",
	authRemoveCredential: "auth:removeCredential",
	authLoginOAuth: "auth:loginOAuth",
	authCancelLogin: "auth:cancelLogin",
	authRespondPrompt: "auth:respondPrompt",
	agentRespondInteraction: "agent:respondInteraction",
	sessionStorageGet: "sessionStorage:get",
	sessionStorageSet: "sessionStorage:set",
	sessionStoragePickRoot: "sessionStorage:pickRoot",
	agentEvent: "agent:event",
	agentHostEvent: "agent:hostEvent",
	agentStatus: "agent:status",
	agentLog: "agent:log",
} as const;

export type BackendPhase = "no-workspace" | "starting" | "running" | "stopped" | "error";

export interface BackendStatus {
	phase: BackendPhase;
	workspace: string | null;
	error?: string;
	handshake?: BackendHandshake;
}

export type SessionStorageMode = "default" | "workspace" | "custom";

export interface SessionStorageConfig {
	mode: SessionStorageMode;
	/** Absolute parent directory used when mode is custom. */
	customRoot?: string;
}

export const DEFAULT_SESSION_STORAGE: SessionStorageConfig = { mode: "workspace" };

/**
 * Custom provider configuration managed by the GUI and persisted to
 * ~/.pi/agent/models.json. Deliberately a subset of Pi's ProviderConfig:
 * the API key is not part of this schema — credentials are stored through
 * the shared credential API (auth.json) via the existing API-key dialog, so
 * secrets never land in models.json through the GUI.
 */
export type CustomProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface CustomProviderModelConfig {
	/** Model identifier passed to the API. */
	id: string;
	/** Display name. Defaults to id when omitted. */
	name?: string;
	/** Whether the model supports extended thinking. */
	reasoning?: boolean;
	/** Supported input content types. */
	input?: ("text" | "image")[];
	/** Context window size in tokens. */
	contextWindow?: number;
	/** Maximum output tokens. */
	maxTokens?: number;
	/** Maps pi thinking levels to provider-specific values; null hides a level. */
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

export interface CustomProviderConfig {
	/** Provider id (also the key in models.json `providers`). */
	id: string;
	/** Display name shown in /login and the provider list. */
	name?: string;
	/** API endpoint URL. */
	baseUrl: string;
	/** API streaming implementation to use. */
	api: CustomProviderApi;
	/** Add `Authorization: Bearer <apiKey>` to requests. */
	authHeader?: boolean;
	/** Custom headers (values use models.json value-resolution syntax). */
	headers?: Record<string, string>;
	/** Models to register under this provider. Replaces the provider's list. */
	models: CustomProviderModelConfig[];
}

/**
 * One-shot model-list fetch request. The apiKey is used only for the fetch
 * request itself and is never persisted to models.json by this path; the
 * dialog stores it through the credential API on save instead.
 */
export interface CustomProviderFetchRequest {
	baseUrl: string;
	api: CustomProviderApi;
	apiKey?: string;
}

/** One model returned by the provider's model-list endpoint. */
export interface CustomProviderFetchedModel {
	id: string;
	/** Display name, when the endpoint provides one. */
	name?: string;
	/** Context window in tokens, when the endpoint provides one. */
	contextWindow?: number;
	/** Maximum output tokens, when the endpoint provides one. */
	maxTokens?: number;
}

/**
 * Local-catalog metadata merged for one fetched model id. Fields are filled
 * only when every catalog hit with that id agrees; conflicting fields are
 * omitted so the user decides manually.
 */
export interface CustomProviderMatchedModel {
	id: string;
	/** Display name, when all catalog hits agree. */
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

export interface CommandResult<T = undefined> {
	ok: boolean;
	value?: T;
	error?: string;
}

/**
 * An agent event routed to the session it belongs to. `workspaceId` is the
 * workspace path; `sessionId` is the session the event came from.
 */
export interface RoutedAgentEvent {
	workspaceId: string;
	sessionId: string;
	event: AgentEvent;
}

/** Initial view of a session returned by openSession. */
export interface SessionSnapshot {
	state: AgentState;
	messages: AgentMessage[];
	usage: SessionUsage | null;
}
