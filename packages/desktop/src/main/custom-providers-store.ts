/**
 * Custom providers store: reads and writes the `providers` object of
 * ~/.pi/agent/models.json for the GUI's custom-provider management.
 *
 * GUI-owned fields (provider: id, name, baseUrl, api, authHeader, headers,
 * models; model: id, name, reasoning, input, contextWindow, maxTokens,
 * thinkingLevelMap) are written exactly as edited. Everything else is
 * unmanaged and preserved verbatim: provider-level compat, modelOverrides,
 * oauth, apiKey, …, and model-level api, baseUrl, cost, samplingParams,
 * headers, compat and unknown fields. Model entries are matched by their
 * original id, so renaming a model never drags another model's unmanaged
 * fields along, deleting a model drops its raw entry, and reordering is
 * idempotent. Other providers and any other top-level keys in the file are
 * left untouched.
 *
 * Writes are atomic (temp file + rename) and the complete candidate file is
 * validated against Pi's authoritative models.json schema before anything is
 * written, so a failed validation, write or reload never leaves a half-
 * written config behind.
 *
 * API keys are intentionally not part of this schema: credentials are stored
 * through the shared credential API (auth.json) via the existing API-key
 * dialog, so secrets never land in models.json through the GUI.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-agent-protocol";
import { loadSdk } from "@earendil-works/pi-sdk-adapter";
import type { CustomProviderApi, CustomProviderConfig, CustomProviderModelConfig } from "../shared/ipc.ts";

const SUPPORTED_APIS: readonly CustomProviderApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

/** Narrow an unknown value to the GUI-supported API set (no bare casts). */
function isSupportedApi(value: unknown): value is CustomProviderApi {
	return typeof value === "string" && (SUPPORTED_APIS as readonly string[]).includes(value);
}

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Copy only valid thinking-level entries from a raw models.json model. */
function sanitizeThinkingLevelMap(raw: unknown): Partial<Record<ModelThinkingLevel, string | null>> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
	for (const level of THINKING_LEVELS) {
		const entry = (raw as Record<string, unknown>)[level];
		if (typeof entry === "string") map[level] = entry;
		else if (entry === null) map[level] = null;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

interface ModelsJsonFile {
	providers?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

/** Read the raw models.json file, or return an empty shell when absent. */
function readModelsJson(modelsPath: string): ModelsJsonFile {
	try {
		const raw = readFileSync(modelsPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const file = parsed as Record<string, unknown>;
			const providers = file.providers;
			return {
				...file,
				providers:
					providers && typeof providers === "object" && !Array.isArray(providers)
						? (providers as Record<string, Record<string, unknown>>)
						: {},
			};
		}
	} catch {
		// Missing or malformed: start from an empty providers shell. A malformed
		// file is never overwritten silently — save() writes only when the read
		// succeeded (or the file was absent), so a corrupt file surfaces as an
		// error at save time instead of being wiped.
		if (existsSync(modelsPath)) {
			throw new Error(`models.json exists but could not be parsed: ${modelsPath}`);
		}
	}
	return { providers: {} };
}

function writeModelsJson(modelsPath: string, content: string): void {
	mkdirSync(dirname(modelsPath), { recursive: true });
	// Atomic replacement: the temp file lands next to the target (same
	// volume) and is renamed over it, so readers only ever see the old or the
	// complete new document. A failed write removes the temp file and leaves
	// the original untouched.
	const tempPath = `${modelsPath}.tmp-${process.pid}`;
	try {
		writeFileSync(tempPath, content, "utf8");
		renameSync(tempPath, modelsPath);
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Cleanup is best-effort; the original file is still intact.
		}
		throw error;
	}
}

/** Project a raw models.json provider entry onto the GUI-owned subset. */
function projectProvider(id: string, raw: Record<string, unknown>): CustomProviderConfig | null {
	if (typeof raw.baseUrl !== "string" || !Array.isArray(raw.models)) {
		// Pure override entries (e.g. a baseUrl-only proxy for a builtin) are
		// not representable in the GUI form and are hidden from the list.
		return null;
	}
	if (!isSupportedApi(raw.api)) {
		// Providers using an API the dialog cannot represent are hidden: a
		// save would otherwise rewrite the hand-written api value.
		return null;
	}
	const models: CustomProviderModelConfig[] = [];
	for (const entry of raw.models) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const model = entry as Record<string, unknown>;
		if (typeof model.id !== "string") continue;
		const projected: CustomProviderModelConfig = { id: model.id };
		if (typeof model.name === "string") projected.name = model.name;
		if (typeof model.reasoning === "boolean") projected.reasoning = model.reasoning;
		if (Array.isArray(model.input)) {
			const input = model.input.filter((v): v is "text" | "image" => v === "text" || v === "image");
			if (input.length > 0) projected.input = input;
		}
		if (typeof model.contextWindow === "number") projected.contextWindow = model.contextWindow;
		if (typeof model.maxTokens === "number") projected.maxTokens = model.maxTokens;
		const thinkingLevelMap = sanitizeThinkingLevelMap(model.thinkingLevelMap);
		if (thinkingLevelMap !== undefined) projected.thinkingLevelMap = thinkingLevelMap;
		models.push(projected);
	}
	const config: CustomProviderConfig = {
		id,
		baseUrl: raw.baseUrl,
		api: raw.api,
		models,
	};
	if (typeof raw.name === "string") config.name = raw.name;
	if (raw.authHeader === true) config.authHeader = true;
	if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
			if (typeof value === "string") headers[key] = value;
		}
		if (Object.keys(headers).length > 0) config.headers = headers;
	}
	return config;
}

/** Raw model entries of a previous provider, keyed by model id. */
function previousModelsById(previous: Record<string, unknown> | undefined): Map<string, Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	if (!previous || !Array.isArray(previous.models)) return byId;
	for (const entry of previous.models) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const model = entry as Record<string, unknown>;
		if (typeof model.id === "string") byId.set(model.id, model);
	}
	return byId;
}

/**
 * Serialize one GUI model entry, overlaying the GUI-owned fields onto the
 * raw entry with the same id. Unmanaged model-level fields (api, baseUrl,
 * cost, samplingParams, headers, compat, unknown keys) survive; a renamed
 * model matches no previous entry and starts clean.
 */
function serializeModel(
	model: CustomProviderModelConfig,
	previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...(previous ?? {}) };
	out.id = model.id;
	if (model.name !== undefined) out.name = model.name;
	else delete out.name;
	if (model.reasoning !== undefined) out.reasoning = model.reasoning;
	else delete out.reasoning;
	if (model.input !== undefined) out.input = [...model.input];
	else delete out.input;
	if (model.contextWindow !== undefined) out.contextWindow = model.contextWindow;
	else delete out.contextWindow;
	if (model.maxTokens !== undefined) out.maxTokens = model.maxTokens;
	else delete out.maxTokens;
	if (model.thinkingLevelMap !== undefined) out.thinkingLevelMap = { ...model.thinkingLevelMap };
	else delete out.thinkingLevelMap;
	return out;
}

/** Serialize a GUI provider config into a models.json provider entry, preserving unmanaged fields. */
function serializeProvider(
	config: CustomProviderConfig,
	previous: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...(previous ?? {}) };
	next.baseUrl = config.baseUrl;
	next.api = config.api;
	if (config.name !== undefined && config.name.length > 0) {
		next.name = config.name;
	} else {
		delete next.name;
	}
	if (config.authHeader === true) {
		next.authHeader = true;
	} else {
		delete next.authHeader;
	}
	if (config.headers && Object.keys(config.headers).length > 0) {
		next.headers = { ...config.headers };
	} else {
		delete next.headers;
	}
	const previousModels = previousModelsById(previous);
	next.models = config.models.map((model) => serializeModel(model, previousModels.get(model.id)));
	return next;
}

/** Validate a config before persisting. Throws on invalid input. */
function validateConfig(config: CustomProviderConfig): void {
	if (config.id.trim().length === 0) {
		throw new Error("Provider id must not be empty");
	}
	if (config.baseUrl.trim().length === 0) {
		throw new Error("Provider baseUrl must not be empty");
	}
	if (!SUPPORTED_APIS.includes(config.api)) {
		throw new Error(`Unsupported api "${config.api}"`);
	}
	if (!Array.isArray(config.models) || config.models.length === 0) {
		throw new Error("At least one model is required");
	}
	for (const model of config.models) {
		if (typeof model.id !== "string" || model.id.trim().length === 0) {
			throw new Error("Every model must have a non-empty id");
		}
	}
}

/** Resolve a models.json path relative to cwd for stable test output. */
function resolveModelsPath(modelsPath: string): string {
	return resolve(modelsPath);
}

/** List GUI-managed custom providers from models.json. */
export function listCustomProviders(modelsPath: string): CustomProviderConfig[] {
	const file = readModelsJson(resolveModelsPath(modelsPath));
	const providers = file.providers ?? {};
	const configs: CustomProviderConfig[] = [];
	for (const [id, raw] of Object.entries(providers)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const config = projectProvider(id, raw as Record<string, unknown>);
		if (config) configs.push(config);
	}
	configs.sort((a, b) => (a.name ?? a.id).toLowerCase().localeCompare((b.name ?? b.id).toLowerCase()));
	return configs;
}

/**
 * Upsert a custom provider into models.json, preserving unmanaged fields.
 * The complete candidate file is validated against Pi's authoritative
 * models.json schema before the atomic write, so a validation or write
 * failure never leaves a half-written config behind.
 */
export async function saveCustomProvider(modelsPath: string, config: CustomProviderConfig): Promise<void> {
	validateConfig(config);
	const path = resolveModelsPath(modelsPath);
	const file = readModelsJson(path);
	const providers = file.providers ?? {};
	const previous = providers[config.id];
	providers[config.id] = serializeProvider(config, previous);
	file.providers = providers;
	const content = `${JSON.stringify(file, null, 2)}\n`;
	const { validateModelsJsonContent } = await loadSdk();
	const schemaError = validateModelsJsonContent(content);
	if (schemaError !== undefined) {
		throw new Error(`Refusing to write invalid models.json: ${schemaError}`);
	}
	writeModelsJson(path, content);
}

/** Remove a custom provider from models.json. No-op if the provider is absent. */
export function deleteCustomProvider(modelsPath: string, providerId: string): void {
	const id = providerId.trim();
	if (id.length === 0) {
		throw new Error("Provider id must not be empty");
	}
	const path = resolveModelsPath(modelsPath);
	const file = readModelsJson(path);
	const providers = file.providers ?? {};
	if (!(id in providers)) {
		return;
	}
	delete providers[id];
	file.providers = providers;
	writeModelsJson(path, `${JSON.stringify(file, null, 2)}\n`);
}
