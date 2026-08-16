/**
 * Lazy loader for the coding-agent SDK.
 *
 * The SDK is ESM-only and relies on import.meta.url / createRequire /
 * jiti. The Desktop main bundle is CJS and externalizes the SDK package
 * (see vite.main.config.mjs), so this module must load it through a real
 * dynamic import at runtime. A dedicated loader module keeps that single
 * dynamic import away from the rest of the adapter code.
 */

import type {
	AgentSession,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Events delivered to AgentSession.subscribe listeners. */
export type SdkSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/**
 * The SDK module's own type (type-only reference). The value is loaded
 * through the dynamic import below — this loader module is the single place
 * where the ESM-only SDK is referenced dynamically.
 */
type SdkModule = typeof import("@earendil-works/pi-coding-agent");

export interface SdkExports {
	createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
	SessionManager: typeof SessionManager;
	SettingsManager: typeof SettingsManager;
	ModelRuntime: typeof ModelRuntime;
	findInitialModel: SdkModule["findInitialModel"];
	DEFAULT_THINKING_LEVEL: SdkModule["DEFAULT_THINKING_LEVEL"];
	parseSessionEntries: SdkModule["parseSessionEntries"];
	buildSessionContext: SdkModule["buildSessionContext"];
	getLatestCompactionEntry: SdkModule["getLatestCompactionEntry"];
	estimateTokens: SdkModule["estimateTokens"];
	calculateContextTokens: SdkModule["calculateContextTokens"];
	VERSION: string;
}

const sdkPromise: Promise<SdkExports> = import("@earendil-works/pi-coding-agent").then((module) => ({
	createAgentSession: module.createAgentSession,
	SessionManager: module.SessionManager,
	SettingsManager: module.SettingsManager,
	ModelRuntime: module.ModelRuntime,
	findInitialModel: module.findInitialModel,
	DEFAULT_THINKING_LEVEL: module.DEFAULT_THINKING_LEVEL,
	parseSessionEntries: module.parseSessionEntries,
	buildSessionContext: module.buildSessionContext,
	getLatestCompactionEntry: module.getLatestCompactionEntry,
	estimateTokens: module.estimateTokens,
	calculateContextTokens: module.calculateContextTokens,
	VERSION: module.VERSION,
}));

/** Resolve the SDK exports (memoized; the load happens once per process). */
export function loadSdk(): Promise<SdkExports> {
	return sdkPromise;
}

export type { AgentSession };
export type { ModelRuntime } from "@earendil-works/pi-coding-agent";
