/**
 * SdkHostServices: app-scoped AgentHostServices over a shared ModelRuntime.
 *
 * Models, auth status, credentials and OAuth live on ONE shared runtime
 * (credential storage + model catalog), so they are available with zero
 * session backends alive and credential changes never fan out to sessions.
 *
 * Owner scope: application. The credential store (agentDir/auth.json) and
 * model catalog (agentDir/models.json) are app-global in the Pi runtime;
 * no workspace-level state influences them. The legacy Desktop path made the
 * same call implicitly by answering auth/model queries from a backend with
 * a neutral cwd (homedir).
 */

import { join } from "node:path";
import type {
	AgentEvent,
	AgentHostServices,
	AuthFlowEvent,
	AuthFlowPrompt,
	AuthPromptResponse,
	BackendHandshake,
	ModelInfo,
	ProviderAuthStatus,
} from "@earendil-works/pi-agent-protocol";
import { AGENT_PROTOCOL_VERSION } from "@earendil-works/pi-agent-protocol";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadSdk } from "./sdk-loader.ts";
import { normalizeSdkModel } from "./sdk-normalizer.ts";

export interface SdkHostServicesOptions {
	/** Shared agent config directory (~/.pi/agent). */
	agentDir: string;
	/** Shared model runtime override (tests). */
	modelRuntime?: ModelRuntime;
	/** Open an authorization URL in the system browser (provided by the host). */
	openExternalUrl?(url: string): void | Promise<void>;
}

/** Origin hint for a login started from a session view (UI prompting only). */
export interface OAuthOrigin {
	workspaceId?: string;
	sessionId?: string;
}

interface PendingAuthPrompt {
	settled: boolean;
	resolve: (value: string) => void;
	reject: (reason: Error) => void;
}

interface OAuthTransaction {
	providerId: string;
	loginId: string;
	origin?: OAuthOrigin;
	controller: AbortController;
	/** Settles when the whole login flow finishes (success or failure). */
	promise: Promise<void>;
}

export class SdkHostServices implements AgentHostServices {
	private readonly options: SdkHostServicesOptions;
	private readonly subscribers = new Set<(event: AgentEvent) => void>();
	/** Shared runtime promise: session backends and host state share one instance. */
	private runtimePromise: Promise<ModelRuntime> | null;

	/** One in-flight OAuth transaction per provider; concurrent requests join it. */
	private readonly oauthTransactions = new Map<string, OAuthTransaction>();
	/** Auth prompts awaiting a response, routed by requestId. */
	private readonly pendingAuthPrompts = new Map<string, PendingAuthPrompt>();
	/** Prompt answer values, collected so they can be scrubbed from error text. */
	private readonly authPromptValues: string[] = [];

	constructor(options: SdkHostServicesOptions) {
		this.options = options;
		this.runtimePromise = options.modelRuntime !== undefined ? Promise.resolve(options.modelRuntime) : null;
	}

	/** The shared runtime promise (exposed to session backends). */
	get sharedRuntime(): Promise<ModelRuntime> {
		return this.ensureRuntime();
	}

	/** Resolve the shared runtime (created lazily on first use). */
	ensureRuntime(): Promise<ModelRuntime> {
		this.runtimePromise ??= this.createRuntime();
		return this.runtimePromise;
	}

	subscribe(handler: (event: AgentEvent) => void): () => void {
		this.subscribers.add(handler);
		return () => this.subscribers.delete(handler);
	}

	getHandshake(): Promise<BackendHandshake> {
		return this.withSdk(async (sdk) => ({
			protocolVersion: AGENT_PROTOCOL_VERSION,
			backend: { id: "pi", name: "Pi", version: sdk.VERSION },
			capabilities: {
				// The SDK path has no process-level session switching: the
				// Desktop session catalog owns sessions on disk.
				sessions: false,
				sessionPersistence: true,
				sessionUsage: true,
				models: true,
				abort: true,
				tools: true,
				compaction: true,
				reasoningLevels: true,
				extensionUI: true,
			},
		}));
	}

	async listModels(): Promise<ModelInfo[]> {
		const runtime = await this.ensureRuntime();
		const models = await runtime.getAvailable();
		return models.map((model) => normalizeSdkModel(model)).filter((model): model is ModelInfo => model !== null);
	}

	async reloadModels(): Promise<void> {
		const runtime = await this.ensureRuntime();
		// Re-read models.json and recompose providers without a network refresh:
		// the GUI writes the file and calls this to pick up new custom providers
		// without an app restart.
		await runtime.refresh({ allowNetwork: false });
	}

	async listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
		const runtime = await this.ensureRuntime();
		return runtime.getProviders().map((provider) => {
			const status = runtime.getProviderAuthStatus(provider.id);
			const supportsApiKey = provider.auth.apiKey?.login !== undefined;
			const supportsOAuth = provider.auth.oauth?.login !== undefined;
			const oauthName = provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name;
			const source = runtime.isUsingOAuth(provider.id)
				? ("oauth" as const)
				: status.source === "stored"
					? ("stored" as const)
					: status.source === "runtime"
						? ("runtime" as const)
						: ("environment" as const);
			return {
				provider: provider.id,
				name: provider.name,
				configured: status.configured,
				source: status.configured ? source : ("none" as const),
				mutable: status.configured ? status.source !== "environment" : supportsApiKey || supportsOAuth,
				supportsApiKey,
				...(supportsOAuth ? { supportsOAuth: true as const } : {}),
				...(oauthName !== undefined ? { oauthName } : {}),
				...(provider.auth.oauth?.isSubscription !== undefined
					? { isSubscription: provider.auth.oauth.isSubscription }
					: {}),
			};
		});
	}

	async setApiKey(provider: string, apiKey: string): Promise<void> {
		if (apiKey.trim().length === 0) {
			throw new Error("apiKey must be a non-empty string");
		}
		const runtime = await this.ensureRuntime();
		try {
			await runtime.login(provider, "api_key", {
				prompt: async () => apiKey,
				notify: () => {},
			});
		} catch (cause) {
			// Never leak the key back into the GUI or any log.
			const message = cause instanceof Error ? cause.message : String(cause);
			throw new Error(message.replaceAll(apiKey, "[redacted]"));
		}
	}

	async removeCredential(provider: string): Promise<void> {
		const runtime = await this.ensureRuntime();
		await runtime.logout(provider);
	}

	/**
	 * Run an OAuth login. Concurrent requests for the same provider join the
	 * in-flight transaction instead of starting a second flow; different
	 * providers run in parallel (the runtime serializes credential mutations
	 * per provider internally).
	 */
	async loginWithOAuth(provider: string, origin?: OAuthOrigin): Promise<void> {
		const existing = this.oauthTransactions.get(provider);
		if (existing) {
			await existing.promise;
			return;
		}

		const transaction = this.startOAuthTransaction(provider, origin);
		this.oauthTransactions.set(provider, transaction);
		try {
			await transaction.promise;
		} finally {
			if (this.oauthTransactions.get(provider) === transaction) {
				this.oauthTransactions.delete(provider);
			}
		}
	}

	/** Cancel every in-flight OAuth login (idempotent). */
	async cancelOAuthLogin(): Promise<void> {
		for (const transaction of this.oauthTransactions.values()) {
			transaction.controller.abort(new Error("Login cancelled"));
		}
	}

	/** Route an auth prompt answer by requestId (never by active session). */
	async respondToAuthPrompt(requestId: string, response: AuthPromptResponse): Promise<void> {
		const pending = this.pendingAuthPrompts.get(requestId);
		if (!pending) {
			throw new Error(`Auth prompt not found: ${requestId}`);
		}
		if (pending.settled) {
			return;
		}
		pending.settled = true;
		this.pendingAuthPrompts.delete(requestId);
		if (response.kind === "value") {
			pending.resolve(response.value);
		} else {
			pending.reject(new Error("Login cancelled"));
		}
	}

	/** Origin of an in-flight login, if the caller recorded one. */
	getOAuthOrigin(provider: string): OAuthOrigin | undefined {
		return this.oauthTransactions.get(provider)?.origin;
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	private async createRuntime(): Promise<ModelRuntime> {
		const sdk = await loadSdk();
		return sdk.ModelRuntime.create({
			authPath: join(this.options.agentDir, "auth.json"),
			modelsPath: join(this.options.agentDir, "models.json"),
		});
	}

	private async withSdk<T>(task: (sdk: Awaited<ReturnType<typeof loadSdk>>) => Promise<T>): Promise<T> {
		return task(await loadSdk());
	}

	private emit(event: AgentEvent): void {
		for (const handler of this.subscribers) {
			try {
				handler(event);
			} catch {
				// Consumer exceptions are isolated per handler.
			}
		}
	}

	private emitAuthEvent(loginId: string, event: AuthFlowEvent): void {
		this.emit({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: { kind: "event", loginId, event },
		});
	}

	private emitAuthPrompt(loginId: string, requestId: string, prompt: AuthFlowPrompt): void {
		this.emit({
			type: "custom",
			namespace: "pi",
			name: "auth_flow",
			payload: { kind: "prompt", loginId, requestId, prompt },
		});
	}

	private startOAuthTransaction(provider: string, origin?: OAuthOrigin): OAuthTransaction {
		const loginId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const controller = new AbortController();

		const interaction = {
			signal: controller.signal,
			notify: (event: AuthEvent) => {
				this.emitAuthEvent(loginId, event);
				const authUrl = event.type === "auth_url" ? event.url : undefined;
				if (authUrl && this.options.openExternalUrl) {
					void Promise.resolve(this.options.openExternalUrl(authUrl)).catch(() => {});
				}
			},
			prompt: (authPrompt: AuthPrompt) =>
				new Promise<string>((resolve, reject) => {
					const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
					const serializable: AuthFlowPrompt =
						authPrompt.type === "select"
							? { type: authPrompt.type, message: authPrompt.message, options: authPrompt.options }
							: {
									type: authPrompt.type,
									message: authPrompt.message,
									placeholder: authPrompt.placeholder,
								};
					const entry: PendingAuthPrompt = {
						settled: false,
						resolve: (value) => {
							entry.settled = true;
							if (value.length > 0) this.authPromptValues.push(value);
							resolve(value);
						},
						reject: (reason) => {
							entry.settled = true;
							reject(reason);
						},
					};
					// The provider may abort the prompt out-of-band (e.g. a
					// callback server won the race): surface it and unblock the
					// waiting promise.
					const onAbort = (): void => {
						if (entry.settled) return;
						entry.settled = true;
						this.pendingAuthPrompts.delete(requestId);
						reject(new Error("Login cancelled"));
						this.emitAuthEvent(loginId, { type: "prompt_cancelled", requestId });
					};
					authPrompt.signal?.addEventListener("abort", onAbort, { once: true });
					this.pendingAuthPrompts.set(requestId, entry);
					this.emitAuthPrompt(loginId, requestId, serializable);
					if (authPrompt.signal?.aborted) {
						onAbort();
					}
				}),
		};

		const promise = this.ensureRuntime()
			.then((runtime) => runtime.login(provider, "oauth", interaction))
			.then(
				() => undefined,
				(cause: unknown) => {
					// Never leak credentials or prompt answers back to the GUI.
					let message = cause instanceof Error ? cause.message : String(cause);
					for (const value of this.authPromptValues) {
						if (value.length > 0) message = message.replaceAll(value, "[redacted]");
					}
					throw new Error(message);
				},
			)
			.finally(() => {
				// A failed or cancelled flow may leave prompts hanging.
				for (const [requestId, entry] of this.pendingAuthPrompts) {
					if (!entry.settled) {
						entry.settled = true;
						entry.reject(new Error("Login cancelled"));
					}
					this.pendingAuthPrompts.delete(requestId);
				}
			});

		return { providerId: provider, loginId, origin, controller, promise };
	}
}
