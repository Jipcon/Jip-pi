/**
 * Generic model information, produced by the backend's model discovery.
 *
 * The GUI must never hardcode a provider list; the set of models is whatever
 * the backend reports through `listModels()` and its handshake capabilities.
 */

/** Pi thinking levels ("off" through "max"). */
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Generic model information, produced by the backend's model discovery.
 *
 * The GUI must never hardcode a provider list; the set of models is whatever
 * the backend reports through `listModels()` and its handshake capabilities.
 */
export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	/** Supported input content types, e.g. ["text", "image"]. */
	input?: string[];
	/** Maps pi thinking levels to provider-specific values; null hides a level. */
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

/** A reference to a model, used with `setModel`. */
export interface ModelRef {
	provider: string;
	modelId: string;
}
