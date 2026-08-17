/**
 * Catalog-metadata merge for fetched custom models.
 *
 * The backend returns raw catalog hits by model id (possibly several, one
 * per provider that has the id). This module merges them into a single
 * pre-fill entry per id:
 *
 * - a field is auto-filled only when EVERY hit agrees on the same value;
 * - hits missing the field break agreement (treated as "unknown");
 * - conflicting fields are omitted so the user specifies them manually.
 *
 * Matching is a pre-fill convenience: models.json is always the authority.
 */

import type { ModelInfo } from "@earendil-works/pi-agent-protocol";
import type { CustomProviderMatchedModel } from "../shared/ipc.ts";

/** True when two field values are structurally equal (objects via JSON). */
function sameValue(a: unknown, b: unknown): boolean {
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return a === b;
}

/**
 * The value every hit agrees on, or undefined when any hit lacks the field
 * or disagrees.
 */
function agreedValue<T>(hits: readonly ModelInfo[], read: (hit: ModelInfo) => T | undefined): T | undefined {
	let agreed: T | undefined;
	for (const hit of hits) {
		const value = read(hit);
		if (value === undefined) {
			return undefined;
		}
		if (agreed === undefined) {
			agreed = value;
		} else if (!sameValue(agreed, value)) {
			return undefined;
		}
	}
	return agreed;
}

/**
 * Merge raw catalog hits into per-id pre-fill entries. Ids without any hit
 * are dropped (the caller treats them as "no match, specify manually").
 */
export function mergeMatchedModels(
	hits: readonly ModelInfo[],
	requestedIds: readonly string[],
): CustomProviderMatchedModel[] {
	const byId = new Map<string, ModelInfo[]>();
	for (const hit of hits) {
		const list = byId.get(hit.id);
		if (list) {
			list.push(hit);
		} else {
			byId.set(hit.id, [hit]);
		}
	}

	const merged: CustomProviderMatchedModel[] = [];
	for (const id of requestedIds) {
		const matches = byId.get(id);
		if (!matches || matches.length === 0) {
			continue;
		}
		const entry: CustomProviderMatchedModel = { id };
		const name = agreedValue(matches, (hit) => hit.name);
		if (name !== undefined) entry.name = name;
		const reasoning = agreedValue(matches, (hit) => hit.reasoning);
		if (reasoning !== undefined) entry.reasoning = reasoning;
		const contextWindow = agreedValue(matches, (hit) => hit.contextWindow);
		if (contextWindow !== undefined) entry.contextWindow = contextWindow;
		const maxTokens = agreedValue(matches, (hit) => hit.maxTokens);
		if (maxTokens !== undefined) entry.maxTokens = maxTokens;
		const input = agreedValue(matches, (hit) => hit.input);
		if (input !== undefined) entry.input = input;
		const thinkingLevelMap = agreedValue(matches, (hit) => hit.thinkingLevelMap);
		if (thinkingLevelMap !== undefined) entry.thinkingLevelMap = thinkingLevelMap;
		merged.push(entry);
	}
	return merged;
}
