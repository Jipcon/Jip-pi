/**
 * Custom provider model-list fetch: main-process one-shot GET against the
 * provider's model listing endpoint (OpenAI-compatible GET /v1/models and
 * Google's GET /models). Runs in the main process because the renderer is
 * subject to CORS; the surface is deliberately narrow: http/https only,
 * fixed GET paths derived from the api type, ONE shared deadline across all
 * endpoint candidates, named response-size and model-count limits, and every
 * error path is redacted before it can reach the renderer or logs.
 *
 * The fetch receives the complete connection draft (api, key, authHeader,
 * custom headers) and derives request headers with the same rules a real
 * provider request uses: custom headers first, `authHeader` forces
 * `Authorization: Bearer <key>`, and the per-api default credential header
 * only fills in when neither is present.
 *
 * The endpoint-candidate strategy follows cc-switch's model_fetch service
 * (https://github.com/farion1231/cc-switch): candidates are tried in order,
 * falling through on 404/405 only; base URLs ending in an OpenAI-style
 * version segment (/v{N}) already contain the version path, so {base}/models
 * is tried before {base}/v1/models; base URLs ending in a known
 * Anthropic-protocol compat suffix get extra candidates with the suffix
 * stripped (DeepSeek /anthropic, Zhipu /api/anthropic, etc.).
 */

import type { CustomProviderApi, CustomProviderFetchedModel, CustomProviderFetchRequest } from "../shared/ipc.ts";

/** Total deadline shared by every endpoint candidate (never per candidate). */
export const FETCH_TIMEOUT_MS = 15_000;
/** Response bodies above this size are rejected before parsing. */
export const MAX_RESPONSE_BYTES = 5_000_000;
/** Model lists above this length are rejected. */
export const MAX_FETCHED_MODELS = 1_000;
/** 404/405 bodies are truncated so HTML error pages never bloat error text. */
const ERROR_BODY_MAX_CHARS = 512;

/**
 * Known Anthropic-protocol compat path suffixes, longest first so the
 * longest prefix wins (e.g. /api/anthropic before /anthropic).
 */
const ANTHROPIC_COMPAT_SUFFIXES = [
	"/api/claudecode",
	"/api/anthropic",
	"/apps/anthropic",
	"/api/coding",
	"/claudecode",
	"/anthropic",
	"/step_plan",
	"/coding",
	"/claude",
] as const;

/** Validate that baseUrl is an absolute http/https URL. */
function validateBaseUrl(raw: string): void {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid base URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only http/https base URLs are supported: ${parsed.protocol}//`);
	}
}

/** True when the URL ends in an OpenAI-style version segment /v{N} (digits only). */
function endsWithVersionSegment(url: string): boolean {
	const last = url.split("/").pop() ?? "";
	if (!last.startsWith("v")) return false;
	const digits = last.slice(1);
	return digits.length > 0 && /^\d+$/.test(digits);
}

/** Strip a known Anthropic-compat suffix from baseUrl, longest match first. */
function stripCompatSuffix(baseUrl: string): string | undefined {
	for (const suffix of ANTHROPIC_COMPAT_SUFFIXES) {
		if (baseUrl.endsWith(suffix)) {
			return baseUrl.slice(0, -suffix.length);
		}
	}
	return undefined;
}

function dedupe(candidates: string[]): string[] {
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!unique.includes(candidate)) {
			unique.push(candidate);
		}
	}
	return unique;
}

/**
 * Build the model-list endpoint candidates in priority order.
 *
 * Google serves {base}/models with its own response shape and gets exactly
 * that one candidate; every other api uses the OpenAI-style candidate list.
 */
export function buildModelsUrlCandidates(baseUrl: string, api: CustomProviderApi): string[] {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (trimmed.length === 0) {
		throw new Error("Base URL is empty");
	}
	validateBaseUrl(trimmed);

	if (api === "google-generative-ai") {
		return [`${trimmed}/models`];
	}

	const candidates: string[] = [];
	if (endsWithVersionSegment(trimmed)) {
		// The version is already in the path (e.g. Zhipu .../coding/paas/v4):
		// OpenAI convention puts the endpoint at {base}/models, and appending
		// /v1 again would 404.
		candidates.push(`${trimmed}/models`);
		if (!trimmed.endsWith("/v1")) {
			candidates.push(`${trimmed}/v1/models`);
		}
	} else {
		candidates.push(`${trimmed}/v1/models`);
	}
	const stripped = stripCompatSuffix(trimmed);
	if (stripped !== undefined) {
		const root = stripped.replace(/\/+$/, "");
		if (root.includes("://")) {
			candidates.push(`${root}/v1/models`);
			candidates.push(`${root}/models`);
		}
	}
	return dedupe(candidates);
}

/** Header names that already carry credentials (case-insensitive). */
const CREDENTIAL_HEADER_NAMES = ["authorization", "x-api-key", "x-goog-api-key"];

/**
 * Request headers for the model-list request, mirroring the rules real
 * provider requests use: the draft's custom headers are applied as-is,
 * `authHeader` forces `Authorization: Bearer <key>` on top, and the per-api
 * default credential header only fills in when no credential header exists.
 */
export function buildFetchHeaders(
	api: CustomProviderApi,
	apiKey: string,
	authHeader = false,
	customHeaders?: Record<string, string>,
): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(customHeaders ?? {})) {
		if (key.trim().length > 0) {
			headers.set(key, value);
		}
	}
	if (authHeader && apiKey.length > 0) {
		headers.set("Authorization", `Bearer ${apiKey}`);
		return headers;
	}
	if (apiKey.length === 0) {
		return headers;
	}
	for (const name of CREDENTIAL_HEADER_NAMES) {
		if (headers.has(name)) {
			return headers;
		}
	}
	if (api === "anthropic-messages") {
		headers.set("x-api-key", apiKey);
	} else if (api === "google-generative-ai") {
		headers.set("x-goog-api-key", apiKey);
	} else {
		headers.set("Authorization", `Bearer ${apiKey}`);
	}
	return headers;
}

/** Redact every known secret from error text and truncate oversized bodies. */
function redactAndTruncate(body: string, secrets: readonly string[]): string {
	let out = body;
	for (const secret of secrets) {
		if (secret.length > 0) {
			out = out.split(secret).join("[REDACTED]");
		}
	}
	if (out.length > ERROR_BODY_MAX_CHARS) {
		out = `${out.slice(0, ERROR_BODY_MAX_CHARS)}…`;
	}
	return out;
}

/** Parse the endpoint response for the given api type (ids deduplicated). */
function parseModelsResponse(api: CustomProviderApi, text: string): CustomProviderFetchedModel[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("response is not JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("unexpected response shape");
	}
	const body = parsed as Record<string, unknown>;
	const models: CustomProviderFetchedModel[] = [];
	const seenIds = new Set<string>();
	const pushUnique = (model: CustomProviderFetchedModel): void => {
		if (seenIds.has(model.id)) return;
		seenIds.add(model.id);
		models.push(model);
	};

	if (api === "google-generative-ai") {
		const list = body.models;
		if (!Array.isArray(list)) {
			throw new Error("unexpected response shape (missing models array)");
		}
		for (const entry of list) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.name !== "string") continue;
			const model: CustomProviderFetchedModel = { id: item.name.replace(/^models\//, "") };
			if (typeof item.displayName === "string") model.name = item.displayName;
			if (typeof item.inputTokenLimit === "number") model.contextWindow = item.inputTokenLimit;
			if (typeof item.outputTokenLimit === "number") model.maxTokens = item.outputTokenLimit;
			pushUnique(model);
		}
	} else {
		const list = body.data;
		if (!Array.isArray(list)) {
			throw new Error("unexpected response shape (missing data array)");
		}
		for (const entry of list) {
			if (!entry || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.id !== "string" || item.id.trim().length === 0) continue;
			const model: CustomProviderFetchedModel = { id: item.id };
			if (typeof item.display_name === "string") model.name = item.display_name;
			pushUnique(model);
		}
	}

	if (models.length > MAX_FETCHED_MODELS) {
		throw new Error(`Endpoint returned ${models.length} models; at most ${MAX_FETCHED_MODELS} are supported`);
	}
	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

/** Fetch the provider's model list, trying endpoint candidates in order. */
export async function fetchProviderModels(request: CustomProviderFetchRequest): Promise<CustomProviderFetchedModel[]> {
	const apiKey = request.apiKey?.trim() ?? "";
	const candidates = buildModelsUrlCandidates(request.baseUrl, request.api);
	const headers = buildFetchHeaders(request.api, apiKey, request.authHeader === true, request.headers);
	// Everything that travelled in the request as a credential must never
	// surface in error text (keys and secret-bearing custom header values).
	const secrets = [apiKey, ...Object.values(request.headers ?? {})].map((value) => value.trim());
	// One total deadline for the whole candidate walk: a slow candidate
	// consumes budget instead of every candidate restarting the clock.
	const deadline = Date.now() + FETCH_TIMEOUT_MS;
	let lastError: string | null = null;

	for (const url of candidates) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			break;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), remaining);
		let response: Response;
		try {
			response = await fetch(url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
			}
			throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			clearTimeout(timer);
		}

		const text = await response.text();
		if (text.length > MAX_RESPONSE_BYTES) {
			throw new Error(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`);
		}

		if (response.ok) {
			return parseModelsResponse(request.api, text);
		}

		const body = redactAndTruncate(text, secrets);
		if (response.status === 404 || response.status === 405) {
			lastError = `HTTP ${response.status}: ${body}`;
			continue;
		}
		throw new Error(`HTTP ${response.status}: ${body}`);
	}

	throw new Error(`All candidates failed: ${lastError ?? "deadline exceeded"}`);
}
