/**
 * Session file helpers: pure JSONL operations delegated to the coding-agent
 * SDK's own parsing implementation (parseSessionEntries / buildSessionContext
 * / buildSessionPath) so the Desktop never re-implements session format,
 * branch, compaction or leaf-selection semantics.
 *
 * The single entry point for persisted sessions is `readSessionProjection`:
 * it reads and parses the JSONL exactly once and derives messages, stable
 * entry ids, persisted model/thinking state, usage and editable entries
 * from that one parse.
 */

import { readFile } from "node:fs/promises";
import type {
	AgentMessage,
	EditableUserMessage,
	ModelInfo,
	SessionProjection,
} from "@earendil-works/pi-agent-protocol";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadSdk } from "./sdk-loader.ts";
import { normalizeSdkMessage, normalizeSdkModel } from "./sdk-normalizer.ts";
import { computeSessionUsageFromEntries } from "./sdk-session-usage.ts";

export interface SessionFileIdentity {
	sessionId: string;
	sessionFile: string;
}

export interface ReadSessionProjectionOptions {
	/** Session id the projection belongs to (usage is keyed by it). */
	sessionId: string;
	/** Shared runtime promise; used to resolve the file-recorded model. */
	modelRuntime: Promise<ModelRuntime>;
	/**
	 * Resolve the context window for the session's model from the model
	 * catalog. Return 0 or undefined to omit contextUsage.
	 */
	resolveContextWindow(model: { provider: string; modelId: string } | null): number | undefined;
}

/**
 * One-pass projection of a persisted JSONL session. The file is read and
 * parsed exactly once; messages, entry ids, persisted model/thinking state,
 * usage and editable entries all derive from that single parse. Branch,
 * compaction and leaf selection come from the SDK's authoritative helpers
 * (buildSessionContext / buildContextEntries / buildSessionPath).
 */
export async function readSessionProjection(
	filePath: string,
	options: ReadSessionProjectionOptions,
): Promise<SessionProjection> {
	const sdk = await loadSdk();
	const content = await readFile(filePath, "utf8");
	const entries = sdk.parseSessionEntries(content).filter((entry): entry is SessionEntry => entry.type !== "session");

	// Messages and their stable entry ids, normalized per context entry so
	// the association is structural, never inferred from timestamps.
	const contextEntries = sdk.buildContextEntries(entries);
	const messages: AgentMessage[] = [];
	const entryIds: Array<string | undefined> = [];
	for (const entry of contextEntries) {
		const entryMessages = entry.type === "message" ? [entry.message] : sdk.sessionEntryToContextMessages(entry);
		for (const message of entryMessages) {
			const normalized = normalizeSdkMessage(message);
			if (normalized === null) continue;
			messages.push(normalized);
			entryIds.push(entry.type === "message" && entry.message.role === "user" ? entry.id : undefined);
		}
	}

	// Persisted model/thinking state, mirroring createAgentSession's restore
	// path: the recorded model only applies when the runtime knows it and its
	// provider has configured auth; the recorded thinking level only applies
	// when the branch contains an explicit thinking_level_change entry.
	const context = sdk.buildSessionContext(entries);
	let model: ModelInfo | null = null;
	if (context.model !== null) {
		const modelRuntime = await options.modelRuntime;
		const restored = modelRuntime.getModel(context.model.provider, context.model.modelId);
		if (restored && modelRuntime.hasConfiguredAuth(restored.provider)) {
			model = normalizeSdkModel(restored);
		}
	}
	const thinkingLevel = entries.some((entry) => entry.type === "thinking_level_change")
		? context.thinkingLevel
		: undefined;

	const usage = computeSessionUsageFromEntries(sdk, entries, {
		sessionId: options.sessionId,
		resolveContextWindow: options.resolveContextWindow,
	});

	// Editable entries come from the full leaf path (same source as the live
	// SessionManager.getBranch()), via the SDK's own leaf/branch walk.
	const editable = extractEditableUserMessages(sdk.buildSessionPath(entries));

	const projection: SessionProjection = { messages, entryIds, model, usage, editable };
	if (thinkingLevel !== undefined) projection.thinkingLevel = thinkingLevel;
	return projection;
}

/**
 * Create a new persisted session identity (方案 A): the SessionManager writes
 * a valid header-only JSONL immediately, so the session exists on disk and in
 * the catalog before any AgentSession is materialized. The AgentSession is
 * created lazily on first activation/prompt.
 */
export async function createSessionFile(workspacePath: string, sessionDir?: string): Promise<SessionFileIdentity> {
	const sdk = await loadSdk();
	const manager = sdk.SessionManager.create(workspacePath, sessionDir);
	const sessionFile = manager.persistSession();
	if (sessionFile === undefined) {
		throw new Error("SessionManager refused to persist the new session");
	}
	return { sessionId: manager.getSessionId(), sessionFile };
}

export interface FreshSessionDefaultsOptions {
	workspacePath: string;
	agentDir: string;
	/** Shared runtime promise; resolved lazily inside this call. */
	modelRuntime: Promise<ModelRuntime>;
	/** A model the user picked for the not-yet-materialized session, if any. */
	pendingModel?: { provider: string; modelId: string };
}
export interface FreshSessionDefaults {
	model: ModelInfo | null;
	thinkingLevel: string;
}

/**
 * Predict the model and thinking level a fresh (message-less) session will
 * materialize with, mirroring createAgentSession: the settings default
 * thinking level, clamped to the model that findInitialModel would pick (or
 * to an explicitly pending model). Used so a not-yet-materialized session can
 * display its real defaults instead of selector fallbacks.
 */
export async function resolveFreshSessionDefaults(options: FreshSessionDefaultsOptions): Promise<FreshSessionDefaults> {
	const sdk = await loadSdk();
	const settingsManager = sdk.SettingsManager.create(options.workspacePath, options.agentDir);
	const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel() ?? sdk.DEFAULT_THINKING_LEVEL;
	const modelRuntime = await options.modelRuntime;

	let model: Model<Api> | undefined;
	if (options.pendingModel) {
		model = modelRuntime.getModel(options.pendingModel.provider, options.pendingModel.modelId);
	} else {
		const initial = await sdk.findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = initial.model;
	}

	if (!model) {
		return { model: null, thinkingLevel: "off" };
	}
	return {
		model: normalizeSdkModel(model),
		thinkingLevel: clampThinkingLevel(model, defaultThinkingLevel),
	};
}

// ---------------------------------------------------------------------------
// Editable user messages
// ---------------------------------------------------------------------------

/**
 * Extract the plain text of a user message's content, mirroring the
 * runtime's own `extractUserMessageText`: only `text` blocks are joined;
 * image blocks are not carried back (v1).
 */
export function extractUserMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/**
 * Build the editable user messages from a branch's entries (the leaf path).
 * Filters to `message` entries whose role is `user` and whose text is
 * non-empty, mapping each to `{ entryId, text, timestamp }`. The timestamp
 * comes from the embedded message (the same value `getMessages()` reports).
 */
export function extractEditableUserMessages(branch: readonly SessionEntry[]): EditableUserMessage[] {
	const result: EditableUserMessage[] = [];
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown; timestamp?: number };
		if (message.role !== "user") continue;
		const text = extractUserMessageText(message.content);
		if (text.length === 0) continue;
		const editable: EditableUserMessage = { entryId: entry.id, text };
		if (typeof message.timestamp === "number") editable.timestamp = message.timestamp;
		result.push(editable);
	}
	return result;
}
