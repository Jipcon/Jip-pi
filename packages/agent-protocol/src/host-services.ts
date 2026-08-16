/**
 * App/workspace services contract.
 *
 * These services are available with zero session backends alive: the GUI
 * can query models, auth status, store credentials and run OAuth before any
 * session exists (e.g. the model picker on the session home screen).
 *
 * Implementations own shared state (credential storage, model catalog)
 * directly instead of fanning operations out to session backends.
 */

import type { AuthPromptResponse, ProviderAuthStatus } from "./auth.ts";
import type { BackendHandshake } from "./capabilities.ts";
import type { AgentEvent } from "./events.ts";
import type { ModelInfo } from "./models.ts";

export interface AgentHostServices {
	/** Runtime capability description (constant per runtime implementation). */
	getHandshake(): Promise<BackendHandshake>;

	/** Model catalog, based on the shared credential state. */
	listModels(): Promise<ModelInfo[]>;

	/** Read-only auth status for every known provider (never key values). */
	listProviderAuthStatus(): Promise<ProviderAuthStatus[]>;
	/** Store an api key for a provider through the shared credential API. */
	setApiKey(provider: string, apiKey: string): Promise<void>;
	/** Remove the stored credential for a provider. */
	removeCredential(provider: string): Promise<void>;

	/**
	 * Run a provider's OAuth login flow. Progress (auth urls, device codes,
	 * prompts) streams through `subscribe()` as custom "auth_flow" events;
	 * this promise resolves when the flow completes and the credential is
	 * stored, and rejects when the flow is cancelled or fails.
	 */
	loginWithOAuth(provider: string): Promise<void>;
	/** Cancel the in-flight OAuth login flow (idempotent). */
	cancelOAuthLogin(): Promise<void>;
	/** Answer a pending OAuth auth prompt, routed by its request id. */
	respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void>;

	/**
	 * Subscribe to host-level events (custom "auth_flow" events for OAuth
	 * progress and prompts). Returns an unsubscribe function.
	 */
	subscribe(handler: (event: AgentEvent) => void): () => void;
}
