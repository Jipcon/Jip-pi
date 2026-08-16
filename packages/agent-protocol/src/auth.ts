/**
 * Provider authentication status model shared with the GUI.
 *
 * The GUI only ever receives metadata about credentials — never key values.
 * Stored credentials are written through the runtime's credential API, never
 * by editing auth.json directly.
 */

/** Where a provider's credential comes from. */
export type CredentialSource = "stored" | "environment" | "runtime" | "oauth" | "none";

/** Read-only status of one provider's authentication. */
export interface ProviderAuthStatus {
	provider: string;
	/** Human-readable provider name, when the backend knows it. */
	name?: string;
	configured: boolean;
	source: CredentialSource;
	/** True when the GUI may store/replace/remove this credential. */
	mutable: boolean;
	/** True when the provider accepts an api_key credential. */
	supportsApiKey?: boolean;
	/** True when the provider supports interactive OAuth login. */
	supportsOAuth?: boolean;
	/** Selector label for the OAuth login option, when OAuth is available. */
	oauthName?: string;
	/** True when OAuth access is backed by a provider subscription. */
	isSubscription?: boolean;
	/** Redacted error when the last auth check failed. */
	error?: string;
}

// ---------------------------------------------------------------------------
// OAuth login flow (serialized mirror of the runtime's auth types)
//
// The GUI never sees tokens: the flow only carries display metadata
// (authorization URLs, device codes, prompts) and answers prompts with
// plain strings. Everything flows through the existing `subscribe()` stream
// as custom AgentEvents named "auth_flow".
// ---------------------------------------------------------------------------

export interface AuthFlowInfoLink {
	url: string;
	label?: string;
}

/** One OAuth login event, mirrored from the backend runtime (no secrets). */
export type AuthFlowEvent =
	| { type: "info"; message: string; links?: readonly AuthFlowInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string }
	/** An earlier auth prompt was cancelled out-of-band (e.g. the callback server won). */
	| { type: "prompt_cancelled"; requestId: string };

/** One OAuth login prompt, mirrored from the backend runtime (no signal). */
export type AuthFlowPrompt =
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  }
	| { type: "manual_code"; message: string; placeholder?: string };

/**
 * Auth flow update delivered as a custom AgentEvent
 * (`{ type: "custom", namespace: "pi", name: "auth_flow" }`).
 */
export type AuthFlowUpdate =
	| { kind: "event"; loginId: string; event: AuthFlowEvent }
	| { kind: "prompt"; loginId: string; requestId: string; prompt: AuthFlowPrompt };

/** Answer to a pending OAuth auth prompt. */
export type AuthPromptResponse = { kind: "value"; value: string } | { kind: "cancelled" };
