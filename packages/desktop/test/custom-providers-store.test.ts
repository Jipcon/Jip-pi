import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { deleteCustomProvider, listCustomProviders, saveCustomProvider } from "../src/main/custom-providers-store.ts";
import type { CustomProviderConfig } from "../src/shared/ipc.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-custom-providers-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function modelsPath(): string {
	return join(makeTemporaryDirectory(), "models.json");
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const fullConfig: CustomProviderConfig = {
	id: "my-local",
	name: "My Local",
	baseUrl: "http://localhost:11434/v1",
	api: "openai-completions",
	authHeader: false,
	models: [
		{
			id: "qwen2.5-coder:7b",
			name: "Qwen 2.5 Coder",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 32000,
		},
	],
};

describe("custom providers store", () => {
	test("list returns empty when models.json is absent", () => {
		expect(listCustomProviders(modelsPath())).toEqual([]);
	});

	test("save creates models.json with a providers entry", () => {
		const path = modelsPath();
		saveCustomProvider(path, fullConfig);
		expect(existsSync(path)).toBe(true);
		const file = readJson(path);
		const providers = file.providers as Record<string, Record<string, unknown>>;
		expect(providers["my-local"]).toBeDefined();
		expect(providers["my-local"].baseUrl).toBe("http://localhost:11434/v1");
		expect(providers["my-local"].api).toBe("openai-completions");
		expect(Array.isArray(providers["my-local"].models)).toBe(true);
	});

	test("list projects saved providers back into the GUI subset", () => {
		const path = modelsPath();
		saveCustomProvider(path, fullConfig);
		const [provider] = listCustomProviders(path);
		expect(provider.id).toBe("my-local");
		expect(provider.name).toBe("My Local");
		expect(provider.models[0]).toMatchObject({
			id: "qwen2.5-coder:7b",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 32000,
		});
	});

	test("save preserves unmanaged provider fields (compat, apiKey, modelOverrides)", () => {
		const path = modelsPath();
		// Seed a file with advanced hand-edited fields the GUI does not surface.
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"my-local": {
						baseUrl: "http://old:11434/v1",
						api: "openai-completions",
						apiKey: "$MY_KEY",
						compat: { supportsDeveloperRole: false },
						modelOverrides: { "qwen2.5-coder:7b": { maxTokens: 9999 } },
						models: [{ id: "qwen2.5-coder:7b" }],
					},
				},
			}),
		);
		saveCustomProvider(path, { ...fullConfig, baseUrl: "http://new:11434/v1" });
		const entry = readJson(path).providers["my-local"] as Record<string, unknown>;
		expect(entry.baseUrl).toBe("http://new:11434/v1");
		expect(entry.apiKey).toBe("$MY_KEY");
		expect(entry.compat).toEqual({ supportsDeveloperRole: false });
		expect(entry.modelOverrides).toEqual({ "qwen2.5-coder:7b": { maxTokens: 9999 } });
	});

	test("save preserves other providers in the file", () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: { other: { baseUrl: "http://other", api: "openai-completions", models: [{ id: "o" }] } },
			}),
		);
		saveCustomProvider(path, fullConfig);
		const providers = readJson(path).providers as Record<string, unknown>;
		expect(providers.other).toBeDefined();
		expect(providers["my-local"]).toBeDefined();
	});

	test("save upserts an existing provider and preserves its unmanaged fields", () => {
		const path = modelsPath();
		saveCustomProvider(path, fullConfig);
		// Hand-edit advanced fields onto the saved provider.
		const file = readJson(path);
		(file.providers["my-local"] as Record<string, unknown>).compat = { supportsDeveloperRole: false };
		writeFileSync(path, JSON.stringify(file));
		// Re-save via the GUI with a new model list.
		saveCustomProvider(path, { ...fullConfig, models: [{ id: "new-model" }] });
		const entry = readJson(path).providers["my-local"] as Record<string, unknown>;
		expect((entry.models as Array<{ id: string }>)[0].id).toBe("new-model");
		expect(entry.compat).toEqual({ supportsDeveloperRole: false });
	});

	test("list hides pure override entries (no models array)", () => {
		const path = modelsPath();
		writeFileSync(path, JSON.stringify({ providers: { anthropic: { baseUrl: "https://proxy.example.com" } } }));
		expect(listCustomProviders(path)).toEqual([]);
	});

	test("list includes a builtin-id provider when it has models (merge override)", () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://proxy.example.com",
						api: "anthropic-messages",
						models: [{ id: "claude-custom" }],
					},
				},
			}),
		);
		const providers = listCustomProviders(path);
		expect(providers).toHaveLength(1);
		expect(providers[0].id).toBe("anthropic");
	});

	test("delete removes a provider and preserves the rest", () => {
		const path = modelsPath();
		saveCustomProvider(path, fullConfig);
		writeFileSync(
			path,
			JSON.stringify({
				...readJson(path),
				providers: {
					...(readJson(path).providers as Record<string, unknown>),
					other: { baseUrl: "http://other", api: "openai-completions", models: [{ id: "o" }] },
				},
			}),
		);
		deleteCustomProvider(path, "my-local");
		const providers = readJson(path).providers as Record<string, unknown>;
		expect(providers["my-local"]).toBeUndefined();
		expect(providers.other).toBeDefined();
	});

	test("delete is a no-op when the provider is absent", () => {
		const path = modelsPath();
		saveCustomProvider(path, fullConfig);
		const before = readFileSync(path, "utf8");
		deleteCustomProvider(path, "nonexistent");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("save omits name and authHeader when not set", () => {
		const path = modelsPath();
		saveCustomProvider(path, { id: "bare", baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] });
		const entry = readJson(path).providers.bare as Record<string, unknown>;
		expect("name" in entry).toBe(false);
		expect("authHeader" in entry).toBe(false);
		expect("headers" in entry).toBe(false);
	});

	test("save serializes headers", () => {
		const path = modelsPath();
		saveCustomProvider(path, {
			id: "h",
			baseUrl: "http://x",
			api: "openai-completions",
			headers: { "x-portkey-key": "$PORTKEY" },
			models: [{ id: "m" }],
		});
		const entry = readJson(path).providers.h as Record<string, unknown>;
		expect(entry.headers).toEqual({ "x-portkey-key": "$PORTKEY" });
	});

	test("validation rejects empty id", () => {
		const path = modelsPath();
		expect(() =>
			saveCustomProvider(path, { id: "  ", baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] }),
		).toThrow(/id/);
	});

	test("validation rejects empty baseUrl", () => {
		const path = modelsPath();
		expect(() =>
			saveCustomProvider(path, { id: "p", baseUrl: "  ", api: "openai-completions", models: [{ id: "m" }] }),
		).toThrow(/baseUrl/);
	});

	test("validation rejects unsupported api", () => {
		const path = modelsPath();
		expect(() =>
			saveCustomProvider(path, {
				id: "p",
				baseUrl: "http://x",
				api: "mistral-conversations" as never,
				models: [{ id: "m" }],
			}),
		).toThrow(/api/);
	});

	test("validation rejects zero models", () => {
		const path = modelsPath();
		expect(() =>
			saveCustomProvider(path, { id: "p", baseUrl: "http://x", api: "openai-completions", models: [] }),
		).toThrow(/model/);
	});

	test("validation rejects a model with empty id", () => {
		const path = modelsPath();
		expect(() =>
			saveCustomProvider(path, { id: "p", baseUrl: "http://x", api: "openai-completions", models: [{ id: "  " }] }),
		).toThrow(/model.*id/);
	});

	test("reading a malformed models.json throws instead of being silently wiped", () => {
		const path = modelsPath();
		writeFileSync(path, "{ not valid json");
		expect(() => listCustomProviders(path)).toThrow(/could not be parsed/);
		expect(() => saveCustomProvider(path, fullConfig)).toThrow(/could not be parsed/);
	});

	test("thinkingLevelMap round-trips through save and list", () => {
		const path = modelsPath();
		saveCustomProvider(path, {
			id: "thinking",
			baseUrl: "http://x",
			api: "openai-completions",
			models: [
				{
					id: "m1",
					reasoning: true,
					thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
				},
			],
		});
		const [provider] = listCustomProviders(path);
		expect(provider.models[0].thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
		});
	});

	test("invalid thinkingLevelMap entries are dropped on projection", () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					thinking: {
						baseUrl: "http://x",
						api: "openai-completions",
						models: [
							{
								id: "m1",
								thinkingLevelMap: { high: "high", bogus: "x", max: 3 },
							},
						],
					},
				},
			}),
		);
		const [provider] = listCustomProviders(path);
		expect(provider.models[0].thinkingLevelMap).toEqual({ high: "high" });
	});
});
