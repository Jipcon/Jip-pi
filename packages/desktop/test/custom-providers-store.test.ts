import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	test("save creates models.json with a providers entry", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
		expect(existsSync(path)).toBe(true);
		const file = readJson(path);
		const providers = file.providers as Record<string, Record<string, unknown>>;
		expect(providers["my-local"]).toBeDefined();
		expect(providers["my-local"].baseUrl).toBe("http://localhost:11434/v1");
		expect(providers["my-local"].api).toBe("openai-completions");
		expect(Array.isArray(providers["my-local"].models)).toBe(true);
	});

	test("list projects saved providers back into the GUI subset", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
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

	test("save preserves unmanaged provider fields (compat, apiKey, modelOverrides)", async () => {
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
		await saveCustomProvider(path, { ...fullConfig, baseUrl: "http://new:11434/v1" });
		const entry = readJson(path).providers["my-local"] as Record<string, unknown>;
		expect(entry.baseUrl).toBe("http://new:11434/v1");
		expect(entry.apiKey).toBe("$MY_KEY");
		expect(entry.compat).toEqual({ supportsDeveloperRole: false });
		expect(entry.modelOverrides).toEqual({ "qwen2.5-coder:7b": { maxTokens: 9999 } });
	});

	test("save preserves unmanaged model-level fields when the display name changes", async () => {
		const path = modelsPath();
		// Hand-written model-level advanced configuration the GUI does not surface.
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"my-local": {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-completions",
						models: [
							{
								id: "qwen2.5-coder:7b",
								name: "Qwen 2.5 Coder",
								api: "openai-responses",
								baseUrl: "http://localhost:11434/override",
								cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
								samplingParams: { temperature: 0.2 },
								headers: { "x-model-header": "$MODEL_KEY" },
								compat: { supportsDeveloperRole: true },
								customExtension: { keep: true },
							},
						],
					},
				},
			}),
		);
		// The GUI edit changes only the display name.
		const renamed = {
			...fullConfig,
			models: [{ ...fullConfig.models[0], name: "Renamed Display" }],
		};
		await saveCustomProvider(path, renamed);
		const models = (readJson(path).providers["my-local"] as Record<string, unknown>).models as Array<
			Record<string, unknown>
		>;
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "qwen2.5-coder:7b",
			name: "Renamed Display",
			api: "openai-responses",
			baseUrl: "http://localhost:11434/override",
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
			samplingParams: { temperature: 0.2 },
			headers: { "x-model-header": "$MODEL_KEY" },
			compat: { supportsDeveloperRole: true },
			customExtension: { keep: true },
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 32000,
		});
	});

	test("deleting a model removes its raw entry", async () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"my-local": {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-completions",
						models: [
							{ id: "qwen2.5-coder:7b", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
							{ id: "doomed-model", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } },
						],
					},
				},
			}),
		);
		await saveCustomProvider(path, fullConfig);
		const models = (readJson(path).providers["my-local"] as Record<string, unknown>).models as Array<{
			id: string;
		}>;
		expect(models.map((model) => model.id)).toEqual(["qwen2.5-coder:7b"]);
	});

	test("renaming a model does not inherit another model's unmanaged fields", async () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"my-local": {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-completions",
						models: [{ id: "old-id", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
					},
				},
			}),
		);
		await saveCustomProvider(path, { ...fullConfig, models: [{ id: "new-id", name: "Fresh" }] });
		const models = (readJson(path).providers["my-local"] as Record<string, unknown>).models as Array<
			Record<string, unknown>
		>;
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "new-id", name: "Fresh" });
		// The renamed model starts clean: no cost carried over from old-id.
		expect("cost" in models[0]).toBe(false);
	});

	test("reordering models keeps each entry's unmanaged fields on the right model", async () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					"my-local": {
						baseUrl: "http://localhost:11434/v1",
						api: "openai-completions",
						models: [
							{ id: "a", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
							{ id: "b", cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
						],
					},
				},
			}),
		);
		await saveCustomProvider(path, { ...fullConfig, models: [{ id: "b" }, { id: "a" }] });
		const models = (readJson(path).providers["my-local"] as Record<string, unknown>).models as Array<
			Record<string, unknown>
		>;
		expect(models.map((model) => model.id)).toEqual(["b", "a"]);
		expect(models[0].cost).toEqual({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 });
		expect(models[1].cost).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
	});

	test("save preserves other providers in the file", async () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: { other: { baseUrl: "http://other", api: "openai-completions", models: [{ id: "o" }] } },
			}),
		);
		await saveCustomProvider(path, fullConfig);
		const providers = readJson(path).providers as Record<string, unknown>;
		expect(providers.other).toBeDefined();
		expect(providers["my-local"]).toBeDefined();
	});

	test("save upserts an existing provider and preserves its unmanaged fields", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
		// Hand-edit advanced fields onto the saved provider.
		const file = readJson(path);
		(file.providers["my-local"] as Record<string, unknown>).compat = { supportsDeveloperRole: false };
		writeFileSync(path, JSON.stringify(file));
		// Re-save via the GUI with a new model list.
		await saveCustomProvider(path, { ...fullConfig, models: [{ id: "new-model" }] });
		const entry = readJson(path).providers["my-local"] as Record<string, unknown>;
		expect((entry.models as Array<{ id: string }>)[0].id).toBe("new-model");
		expect(entry.compat).toEqual({ supportsDeveloperRole: false });
	});

	test("list hides pure override entries (no models array)", () => {
		const path = modelsPath();
		writeFileSync(path, JSON.stringify({ providers: { anthropic: { baseUrl: "https://proxy.example.com" } } }));
		expect(listCustomProviders(path)).toEqual([]);
	});

	test("list hides providers with an API the dialog cannot represent", () => {
		const path = modelsPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					mistral: {
						baseUrl: "https://api.mistral.ai/v1",
						api: "mistral-conversations",
						models: [{ id: "mistral-large" }],
					},
				},
			}),
		);
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

	test("delete removes a provider and preserves the rest", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
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

	test("delete is a no-op when the provider is absent", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
		const before = readFileSync(path, "utf8");
		deleteCustomProvider(path, "nonexistent");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("save omits name and authHeader when not set", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, {
			id: "bare",
			baseUrl: "http://x",
			api: "openai-completions",
			models: [{ id: "m" }],
		});
		const entry = readJson(path).providers.bare as Record<string, unknown>;
		expect("name" in entry).toBe(false);
		expect("authHeader" in entry).toBe(false);
		expect("headers" in entry).toBe(false);
	});

	test("save serializes headers", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, {
			id: "h",
			baseUrl: "http://x",
			api: "openai-completions",
			headers: { "x-portkey-key": "$PORTKEY" },
			models: [{ id: "m" }],
		});
		const entry = readJson(path).providers.h as Record<string, unknown>;
		expect(entry.headers).toEqual({ "x-portkey-key": "$PORTKEY" });
	});

	test("validation rejects empty id", async () => {
		const path = modelsPath();
		await expect(
			saveCustomProvider(path, { id: "  ", baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] }),
		).rejects.toThrow(/id/);
	});

	test("validation rejects empty baseUrl", async () => {
		const path = modelsPath();
		await expect(
			saveCustomProvider(path, { id: "p", baseUrl: "  ", api: "openai-completions", models: [{ id: "m" }] }),
		).rejects.toThrow(/baseUrl/);
	});

	test("validation rejects unsupported api", async () => {
		const path = modelsPath();
		await expect(
			saveCustomProvider(path, {
				id: "p",
				baseUrl: "http://x",
				api: "mistral-conversations" as never,
				models: [{ id: "m" }],
			}),
		).rejects.toThrow(/api/);
	});

	test("validation rejects zero models", async () => {
		const path = modelsPath();
		await expect(
			saveCustomProvider(path, { id: "p", baseUrl: "http://x", api: "openai-completions", models: [] }),
		).rejects.toThrow(/model/);
	});

	test("validation rejects a model with empty id", async () => {
		const path = modelsPath();
		await expect(
			saveCustomProvider(path, { id: "p", baseUrl: "http://x", api: "openai-completions", models: [{ id: "  " }] }),
		).rejects.toThrow(/model.*id/);
	});

	test("a schema-invalid candidate leaves the original file untouched", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
		const before = readFileSync(path, "utf8");
		// Another provider in the file violates Pi's models.json schema, so
		// the complete candidate fails validation and nothing is written.
		const poisoned = readJson(path);
		(poisoned.providers as Record<string, unknown>).broken = {
			baseUrl: "http://x",
			api: "openai-completions",
			models: "not-an-array",
		};
		writeFileSync(path, JSON.stringify(poisoned));
		await expect(saveCustomProvider(path, { ...fullConfig, name: "New Name" })).rejects.toThrow(
			/invalid models\.json/i,
		);
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(poisoned));
		expect(readFileSync(path, "utf8")).not.toBe(before);
	});

	test("a failed write leaves the original file intact and no temp file behind", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, fullConfig);
		const before = readFileSync(path, "utf8");
		// Occupy the store's temp path with a directory so the atomic write
		// fails before the target is ever touched.
		const tempPath = `${path}.tmp-${process.pid}`;
		mkdirSync(tempPath);
		try {
			await expect(saveCustomProvider(path, { ...fullConfig, name: "Changed" })).rejects.toThrow();
		} finally {
			rmSync(tempPath, { recursive: true, force: true });
		}
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(readdirSync(dirname(path)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
	});

	test("reading a malformed models.json throws instead of being silently wiped", async () => {
		const path = modelsPath();
		writeFileSync(path, "{ not valid json");
		expect(() => listCustomProviders(path)).toThrow(/could not be parsed/);
		await expect(saveCustomProvider(path, fullConfig)).rejects.toThrow(/could not be parsed/);
	});

	test("thinkingLevelMap round-trips through save and list", async () => {
		const path = modelsPath();
		await saveCustomProvider(path, {
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
