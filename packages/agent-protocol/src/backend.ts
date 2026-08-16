/**
 * Backend contracts between a GUI and an agent runtime.
 *
 * The contracts are split by scope so that runtime lifetime and service
 * availability stay independent:
 *
 * - `AgentSessionBackend`: one agent session's execution (messages, state,
 *   tools, abort, interactions, session-local model/thinking state).
 * - `AgentHostServices`: app/workspace services (models, auth, credentials,
 *   OAuth) that must work with zero session backends alive.
 * - `AgentSessionAdmin`: legacy process-level session administration
 *   (create/list/switch/rename). The Desktop SDK path manages sessions
 *   through its catalog + runtime manager instead and does not use it.
 *
 * `AgentBackend` is the legacy combined contract over one RPC subprocess
 * (used by PiBackend and the legacy Desktop path) and remains for
 * migration/regression comparison.
 */

import type { AgentEvent, InteractionKind, UserInteractionRequest } from "./events.ts";
import type { AgentHostServices } from "./host-services.ts";
import type { AgentMessage, UserMessage } from "./messages.ts";
import type { ModelInfo, ModelRef } from "./models.ts";
import type { AgentState, SessionInfo, SessionUsage } from "./sessions.ts";

/** Response payload for an answered interaction request. */
export type InteractionResponse =
	| { kind: "value"; value: string }
	| { kind: "confirmed"; confirmed: boolean }
	| { kind: "cancelled" };

/**
 * Session identity for a session backend instance.
 *
 * Runtime-independent: how a runtime is launched (executables, arguments,
 * environments) is adapter-specific and never part of this contract.
 */
export interface SessionBackendConfig {
	/** Absolute path of the workspace the session belongs to. */
	workspacePath: string;
	/** Session identity the backend should load, when known upfront. */
	sessionId?: string;
	/** Absolute path of the session JSONL file, when known upfront. */
	sessionFile?: string;
	/** Optional display name for the session. */
	name?: string;
	/** Optional initial model selection. */
	model?: ModelRef;
}

/**
 * One agent session's execution surface.
 *
 * An instance owns exactly one session. Events delivered through
 * `subscribe()` belong to that session only; the host routes them to the
 * right consumer by the backend instance it subscribed on.
 */
export interface AgentSessionBackend {
	/** Initialize the backend for the given session and wait until ready. */
	start(config: SessionBackendConfig): Promise<void>;
	/** Stop the backend and clean up its resources (processes, listeners). */
	stop(): Promise<void>;

	sendMessage(message: UserMessage): Promise<void>;
	abort(): Promise<void>;

	getState(): Promise<AgentState>;
	getMessages(): Promise<AgentMessage[]>;
	getSessionUsage(): Promise<SessionUsage>;

	// Session-local model/thinking state.
	setModel(model: ModelRef): Promise<ModelInfo | null>;
	/** Thinking levels available for the session's current model. */
	listThinkingLevels(): Promise<string[]>;
	setThinkingLevel(level: string): Promise<void>;

	/** Answer a pending interaction request (select/confirm/input/editor). */
	respondToInteraction(id: string, response: InteractionResponse): Promise<void>;

	/** Subscribe to this session's normalized event stream. Returns an unsubscribe function. */
	subscribe(handler: (event: AgentEvent) => void): () => void;
}

/**
 * Legacy process-level session administration over one backend process.
 *
 * The Desktop SDK path does not use these: its session catalog manages
 * session identity on disk and its backend manager manages runtime
 * instances, so process-level switching is never faked.
 */
export interface AgentSessionAdmin {
	createSession(): Promise<SessionInfo>;
	listSessions(): Promise<SessionInfo[]>;
	switchSession(sessionId: string): Promise<SessionInfo>;
	renameSession(sessionId: string, name: string): Promise<void>;
}

/**
 * Legacy RPC factory config: how to launch the backend executable.
 * Only the RPC subprocess adapter consumes this; it is not part of the
 * runtime-independent session contract.
 */
export interface StartConfig extends SessionBackendConfig {
	/** Fully resolved backend executable (node binary, pi.exe, ...). */
	executable: string;
	/** Arguments for the executable (excluding the executable itself). */
	args?: string[];
	/** Extra environment variables merged over the parent environment. */
	env?: Record<string, string | undefined>;
}

/**
 * Legacy combined backend contract: one RPC subprocess serving one active
 * session plus app/workspace services, with process-level session switching.
 *
 * Kept intact for migration/regression comparison of the legacy Desktop
 * path; new code targets `AgentSessionBackend` and `AgentHostServices`
 * directly.
 */
export interface AgentBackend extends AgentSessionBackend, AgentHostServices, AgentSessionAdmin {
	start(config: StartConfig): Promise<void>;
	/**
	 * Re-read shared credentials and refresh the model catalog. Legacy
	 * fan-out synchronization only: the SDK architecture keeps shared
	 * host-level state instead of fanning out to pooled backends.
	 */
	refreshAuth(provider?: string): Promise<void>;
}

export type { UserInteractionRequest, InteractionKind };
