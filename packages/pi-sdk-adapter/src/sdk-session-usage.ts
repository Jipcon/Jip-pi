/**
 * Historical session usage: aggregate token/cost totals and context-window
 * usage directly from a persisted JSONL session without materializing an
 * AgentSession. Mirrors AgentSession.getSessionStats()/getContextUsage()
 * semantics, using the coding-agent SDK's own parsing primitives
 * (parseSessionEntries / buildSessionContext / compaction helpers).
 */

import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage, SessionUsage } from "@earendil-works/pi-agent-protocol";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadSdk } from "./sdk-loader.ts";

export interface ReadSessionUsageOptions {
	/** Session id the usage belongs to (the desktop keys usage by session). */
	sessionId: string;
	/**
	 * Resolve the context window for the session's model from the model
	 * catalog. Return 0 or undefined to omit contextUsage.
	 */
	resolveContextWindow(model: { provider: string; modelId: string } | null): number | undefined;
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Extract a complete Usage from a JSON-parsed entry payload. Old sessions may
 * omit cache counters or the cost block; those default to zero so token
 * totals still accumulate.
 */
function extractUsage(raw: unknown): Usage | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.input !== "number" || typeof value.output !== "number") {
		return undefined;
	}
	const input = value.input;
	const output = value.output;
	const cacheRead = numeric(value.cacheRead);
	const cacheWrite = numeric(value.cacheWrite);
	const totalTokens = numeric(value.totalTokens) || input + output + cacheRead + cacheWrite;
	const cost = typeof value.cost === "object" && value.cost !== null ? (value.cost as Record<string, unknown>) : {};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: numeric(cost.input),
			output: numeric(cost.output),
			cacheRead: numeric(cost.cacheRead),
			cacheWrite: numeric(cost.cacheWrite),
			total: numeric(cost.total),
		},
	};
}

function addTotals(totals: Totals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/**
 * Aggregate session usage from already-parsed entries (no file access).
 * Shared by the file-reading entry point and the one-pass session
 * projection, so usage never needs its own read/parse of the JSONL.
 *
 * Token/cost totals aggregate every session entry (including entries that
 * were compacted away), matching getSessionStats(). Context usage mirrors
 * getContextUsage(): after the latest compaction it is unknown (null) until
 * a valid assistant response; otherwise it estimates from the current context
 * messages. The context window comes from the caller-provided model catalog
 * lookup, so a session whose model is unknown simply omits contextUsage.
 */
export function computeSessionUsageFromEntries(
	sdk: Awaited<ReturnType<typeof loadSdk>>,
	entries: readonly SessionEntry[],
	options: ReadSessionUsageOptions,
): SessionUsage {
	// Valid assistant usage: not aborted/error and with real context tokens.
	const validAssistantUsage = (message: AgentMessage): Usage | undefined => {
		if (message.role !== "assistant") {
			return undefined;
		}
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			return undefined;
		}
		const usage = extractUsage(message.usage);
		return usage && sdk.calculateContextTokens(usage) > 0 ? usage : undefined;
	};

	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of entries) {
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			const usage = extractUsage(entry.usage);
			if (usage) {
				addTotals(totals, usage);
			}
		}
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message;
		if (message.role === "assistant") {
			const usage = extractUsage(message.usage);
			if (usage) {
				addTotals(totals, usage);
			}
		} else if (message.role === "toolResult" && message.usage) {
			const usage = extractUsage(message.usage);
			if (usage) {
				addTotals(totals, usage);
			}
		}
	}

	const usage: SessionUsage = {
		sessionId: options.sessionId,
		tokens: {
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		},
		cost: totals.cost,
	};

	// Context usage: resolve the branch the same way the runtime does.
	const context = sdk.buildSessionContext([...entries]);
	const contextWindow = options.resolveContextWindow(context.model);
	if (contextWindow !== undefined && contextWindow > 0) {
		usage.contextUsage = computeContextUsage(sdk, [...entries], context.messages, contextWindow, validAssistantUsage);
	}

	return usage;
}

/**
 * Read the full usage of a persisted JSONL session.
 */
export async function readSessionUsage(filePath: string, options: ReadSessionUsageOptions): Promise<SessionUsage> {
	const sdk = await loadSdk();
	const content = await readFile(filePath, "utf8");
	const entries = sdk.parseSessionEntries(content).filter((entry): entry is SessionEntry => entry.type !== "session");
	return computeSessionUsageFromEntries(sdk, entries, options);
}

function computeContextUsage(
	sdk: Awaited<ReturnType<typeof loadSdk>>,
	entries: SessionEntry[],
	messages: AgentMessage[],
	contextWindow: number,
	validAssistantUsage: (message: AgentMessage) => Usage | undefined,
): ContextUsage {
	// After the latest compaction, context tokens are unknown until a valid
	// assistant response arrives (mirrors AgentSession.getContextUsage()).
	const latestCompaction = sdk.getLatestCompactionEntry(entries);
	if (latestCompaction) {
		const compactionIndex = entries.lastIndexOf(latestCompaction);
		let hasPostCompactionUsage = false;
		for (let i = entries.length - 1; i > compactionIndex; i--) {
			const entry = entries[i];
			if (entry.type === "message" && validAssistantUsage(entry.message)) {
				hasPostCompactionUsage = true;
				break;
			}
		}
		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const tokens = estimateContextTokens(sdk, messages, validAssistantUsage);
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/**
 * Estimate context tokens from messages, using the last valid assistant usage
 * and estimating the tokens of everything after it (mirrors the SDK's
 * estimateContextTokens(), which is not part of the public SDK surface).
 */
function estimateContextTokens(
	sdk: Awaited<ReturnType<typeof loadSdk>>,
	messages: AgentMessage[],
	validAssistantUsage: (message: AgentMessage) => Usage | undefined,
): number {
	let lastUsage: Usage | undefined;
	let lastIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = validAssistantUsage(messages[i]);
		if (usage) {
			lastUsage = usage;
			lastIndex = i;
			break;
		}
	}

	if (!lastUsage) {
		let tokens = 0;
		for (const message of messages) {
			tokens += sdk.estimateTokens(message);
		}
		return tokens;
	}

	let tokens = sdk.calculateContextTokens(lastUsage);
	for (let i = lastIndex + 1; i < messages.length; i++) {
		tokens += sdk.estimateTokens(messages[i]);
	}
	return tokens;
}
