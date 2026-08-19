/**
 * Catalog-metadata matching for fetched custom models.
 *
 * Catalog ids can occur under several providers with different limits. The
 * custom provider's base URL and API are therefore used as confidence hints
 * before field-level agreement is calculated. No arbitrary first match is
 * selected: unresolved conflicts remain blank and are reported as ambiguous.
 *
 * Matching is a pre-fill convenience: models.json is always the authority.
 */

import type { ModelInfo } from "@earendil-works/pi-agent-protocol";
import type { CustomProviderMatchedModel, CustomProviderMatchRequest } from "../shared/ipc.ts";

type MatchField = NonNullable<CustomProviderMatchedModel["conflictingFields"]>[number];

interface ComparableUrl {
	exact: string;
	origin: string;
}

interface ResolvedField<T> {
	value?: T;
	conflict: boolean;
}

/** True when two field values are structurally equal (objects via JSON). */
function sameValue(a: unknown, b: unknown): boolean {
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return a === b;
}

function normalizeModelId(id: string): string {
	return id.trim().toLocaleLowerCase();
}

/** Normalize URL syntax while retaining path information for exact matches. */
function comparableUrl(value: string | undefined): ComparableUrl | undefined {
	if (!value) return undefined;
	try {
		const parsed = new URL(value);
		const origin = parsed.origin.toLocaleLowerCase();
		const path = parsed.pathname.replace(/\/+$/, "");
		return { exact: `${origin}${path}`, origin };
	} catch {
		return undefined;
	}
}

/** Resolve a field only when every selected candidate supplies and agrees on it. */
function resolveField<T>(hits: readonly ModelInfo[], read: (hit: ModelInfo) => T | undefined): ResolvedField<T> {
	const values = hits.map(read);
	const defined = values.filter((value): value is T => value !== undefined);
	if (defined.length === 0) {
		return { conflict: false };
	}
	if (defined.length !== values.length) {
		return { conflict: true };
	}
	const value = defined[0];
	return defined.every((candidate) => sameValue(value, candidate)) ? { value, conflict: false } : { conflict: true };
}

/** Score a catalog candidate against the custom provider connection details. */
function candidateScore(
	hit: ModelInfo,
	request: CustomProviderMatchRequest,
	requestedUrl: ComparableUrl | undefined,
): number {
	let score = 0;
	const hitUrl = comparableUrl(hit.baseUrl);
	if (requestedUrl && hitUrl) {
		if (requestedUrl.exact === hitUrl.exact) {
			score += 4;
		} else if (requestedUrl.origin === hitUrl.origin) {
			score += 2;
		}
	}
	if (hit.api === request.api) {
		score += 1;
	}
	return score;
}

/** Keep only the highest-confidence candidates when URL/API hints distinguish them. */
function selectCandidates(hits: readonly ModelInfo[], request: CustomProviderMatchRequest): ModelInfo[] {
	if (hits.length <= 1) return [...hits];
	const requestedUrl = comparableUrl(request.baseUrl);
	const scored = hits.map((hit) => ({ hit, score: candidateScore(hit, request, requestedUrl) }));
	const highest = Math.max(...scored.map((entry) => entry.score));
	return highest > 0 ? scored.filter((entry) => entry.score === highest).map((entry) => entry.hit) : [...hits];
}

/**
 * Merge raw catalog hits into one result per requested id. URL/API hints first
 * reduce duplicate-id ambiguity; fields that still disagree are omitted.
 */
export function mergeMatchedModels(
	hits: readonly ModelInfo[],
	request: CustomProviderMatchRequest,
): CustomProviderMatchedModel[] {
	const byId = new Map<string, ModelInfo[]>();
	for (const hit of hits) {
		const normalizedId = normalizeModelId(hit.id);
		if (!normalizedId) continue;
		const list = byId.get(normalizedId);
		if (list) {
			list.push(hit);
		} else {
			byId.set(normalizedId, [hit]);
		}
	}

	const merged: CustomProviderMatchedModel[] = [];
	for (const id of request.ids) {
		const matches = byId.get(normalizeModelId(id));
		if (!matches || matches.length === 0) {
			merged.push({ id, status: "unmatched" });
			continue;
		}

		// Preserve exact case-sensitive ids when available. Case-insensitive
		// matching is only a fallback for backends that return normalized ids.
		const exactMatches = matches.filter((hit) => hit.id === id);
		const candidates = selectCandidates(exactMatches.length > 0 ? exactMatches : matches, request);
		const entry: CustomProviderMatchedModel = { id, status: "matched" };
		const conflictingFields: MatchField[] = [];

		const name = resolveField(candidates, (hit) => hit.name);
		if (name.value !== undefined) entry.name = name.value;
		if (name.conflict) conflictingFields.push("name");

		const reasoning = resolveField(candidates, (hit) => hit.reasoning);
		if (reasoning.value !== undefined) entry.reasoning = reasoning.value;
		if (reasoning.conflict) conflictingFields.push("reasoning");

		const contextWindow = resolveField(candidates, (hit) => hit.contextWindow);
		if (contextWindow.value !== undefined) entry.contextWindow = contextWindow.value;
		if (contextWindow.conflict) conflictingFields.push("contextWindow");

		const maxTokens = resolveField(candidates, (hit) => hit.maxTokens);
		if (maxTokens.value !== undefined) entry.maxTokens = maxTokens.value;
		if (maxTokens.conflict) conflictingFields.push("maxTokens");

		const input = resolveField(candidates, (hit) =>
			hit.input?.filter((value): value is "text" | "image" => value === "text" || value === "image"),
		);
		if (input.value !== undefined) entry.input = input.value;
		if (input.conflict) conflictingFields.push("input");

		const thinkingLevelMap = resolveField(candidates, (hit) => hit.thinkingLevelMap);
		if (thinkingLevelMap.value !== undefined) entry.thinkingLevelMap = thinkingLevelMap.value;
		if (thinkingLevelMap.conflict) conflictingFields.push("thinkingLevelMap");

		const providers = [...new Set(candidates.map((candidate) => candidate.provider))].sort();
		if (providers.length === 1) entry.sourceProvider = providers[0];
		if (conflictingFields.length > 0) {
			entry.status = "ambiguous";
			entry.conflictingFields = conflictingFields;
			entry.candidateProviders = providers;
		}
		merged.push(entry);
	}
	return merged;
}
