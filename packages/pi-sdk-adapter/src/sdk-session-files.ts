/**
 * Session file helpers: pure JSONL operations delegated to the coding-agent
 * SDK's own parsing implementation (parseSessionEntries / buildSessionContext)
 * so the Desktop never re-implements session format semantics.
 */

import { readFile } from "node:fs/promises";
import type { AgentMessage, EditableUserMessage, ModelInfo } from "@earendil-works/pi-agent-protocol";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadSdk } from "./sdk-loader.ts";
import { normalizeSdkMessages, normalizeSdkModel } from "./sdk-normalizer.ts";

export interface SessionFileIdentity {
	sessionId: string;
	sessionFile: string;
}

/**
 * Read the full message history of a persisted JSONL session using Pi's own
 * parsing (compaction-aware branch resolution). The result matches what a
 * runtime getMessages() reports for the same session.
 */
export async function readSessionHistory(filePath: string): Promise<AgentMessage[]> {
	const sdk = await loadSdk();
	const content = await readFile(filePath, "utf8");
	const entries = sdk.parseSessionEntries(content).filter((entry) => entry.type !== "session");
	const context = sdk.buildSessionContext(entries);
	return normalizeSdkMessages(context.messages);
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

export interface PersistedSessionState {
	/** File-recorded model, when it exists in the runtime and has configured auth. */
	model: ModelInfo | null;
	/** File-recorded thinking level, only when the branch changed it explicitly. */
	thinkingLevel?: string;
}

/**
 * Read the model/thinking state a persisted (history-bearing) session will
 * materialize with, mirroring createAgentSession's restore path: the recorded
 * model only applies when the runtime knows it and its provider has
 * configured auth; the recorded thinking level only applies when the branch
 * contains an explicit thinking_level_change entry. Used so a reopened
 * historical session can display its real model before materialization.
 */
export async function readPersistedSessionState(
	filePath: string,
	options: { modelRuntime: Promise<ModelRuntime> },
): Promise<PersistedSessionState> {
	const sdk = await loadSdk();
	const content = await readFile(filePath, "utf8");
	const entries = sdk.parseSessionEntries(content).filter((entry) => entry.type !== "session");
	const context = sdk.buildSessionContext(entries);

	let model: ModelInfo | null = null;
	if (context.model !== null) {
		const modelRuntime = await options.modelRuntime;
		const restored = modelRuntime.getModel(context.model.provider, context.model.modelId);
		if (restored && modelRuntime.hasConfiguredAuth(restored.provider)) {
			model = normalizeSdkModel(restored);
		}
	}

	const state: PersistedSessionState = { model };
	if (entries.some((entry) => entry.type === "thinking_level_change")) {
		state.thinkingLevel = context.thinkingLevel;
	}
	return state;
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
 * comes from the embedded message (the same value `getMessages()` reports),
 * so the renderer can align entries to rendered messages exactly.
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

/**
 * Read the editable user messages of a persisted JSONL session without a
 * live backend. Mirrors `SessionManager.getBranch()`: the leaf is the last
 * appended entry (the current branch tip), and the path is walked via
 * `parentId` to the root. Only the current leaf path is editable, so entries
 * on abandoned in-file branches never appear.
 */
export async function readEditableUserMessages(filePath: string): Promise<EditableUserMessage[]> {
	const sdk = await loadSdk();
	const content = await readFile(filePath, "utf8");
	const fileEntries = sdk.parseSessionEntries(content).filter((entry) => entry.type !== "session");
	if (fileEntries.length === 0) {
		return [];
	}
	const byId = new Map<string, SessionEntry>();
	for (const entry of fileEntries) {
		byId.set(entry.id, entry as SessionEntry);
	}
	// _buildIndex sets leafId to the last file entry; replicate that here.
	const branch: SessionEntry[] = [];
	let current: SessionEntry | undefined = fileEntries[fileEntries.length - 1] as SessionEntry;
	while (current) {
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	return extractEditableUserMessages(branch);
}
