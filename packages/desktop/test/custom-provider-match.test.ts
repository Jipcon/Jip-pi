import type { ModelInfo } from "@earendil-works/pi-agent-protocol";
import { describe, expect, test } from "vitest";
import { mergeMatchedModels } from "../src/main/custom-provider-match.ts";
import type { CustomProviderMatchRequest } from "../src/shared/ipc.ts";

function hit(id: string, fields: Partial<ModelInfo>): ModelInfo {
	return { id, name: `Name ${id}`, provider: "p", ...fields };
}

function request(ids: string[], fields: Partial<CustomProviderMatchRequest> = {}): CustomProviderMatchRequest {
	return {
		ids,
		baseUrl: "https://proxy.example/v1",
		api: "openai-completions",
		...fields,
	};
}

describe("mergeMatchedModels", () => {
	test("unique hits are passed through with their metadata", () => {
		const merged = mergeMatchedModels(
			[
				hit("qwen-plus", {
					contextWindow: 131072,
					maxTokens: 8192,
					reasoning: false,
					thinkingLevelMap: undefined,
				}),
			],
			request(["qwen-plus"]),
		);
		expect(merged).toEqual([
			{
				id: "qwen-plus",
				status: "matched",
				sourceProvider: "p",
				name: "Name qwen-plus",
				contextWindow: 131072,
				maxTokens: 8192,
				reasoning: false,
			},
		]);
	});

	test("agreeing hits across providers fill the fields", () => {
		const merged = mergeMatchedModels(
			[
				hit("deepseek-v3", {
					provider: "deepseek",
					contextWindow: 65536,
					reasoning: true,
					thinkingLevelMap: { high: "high" },
				}),
				hit("deepseek-v3", {
					provider: "proxy",
					contextWindow: 65536,
					reasoning: true,
					thinkingLevelMap: { high: "high" },
				}),
			],
			request(["deepseek-v3"]),
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].status).toBe("matched");
		expect(merged[0].contextWindow).toBe(65536);
		expect(merged[0].reasoning).toBe(true);
		expect(merged[0].thinkingLevelMap).toEqual({ high: "high" });
	});

	test("conflicting fields are marked ambiguous while agreeing fields survive", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", { provider: "a", contextWindow: 128000, maxTokens: 4096 }),
				hit("model-x", { provider: "b", contextWindow: 262144, maxTokens: 4096 }),
			],
			request(["model-x"]),
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].status).toBe("ambiguous");
		expect(merged[0].conflictingFields).toEqual(["contextWindow"]);
		expect(merged[0].candidateProviders).toEqual(["a", "b"]);
		expect(merged[0].contextWindow).toBeUndefined();
		expect(merged[0].maxTokens).toBe(4096);
	});

	test("a hit missing a field makes that field ambiguous", () => {
		const merged = mergeMatchedModels(
			[hit("model-x", { contextWindow: 128000 }), hit("model-x", { contextWindow: undefined })],
			request(["model-x"]),
		);
		expect(merged[0].status).toBe("ambiguous");
		expect(merged[0].conflictingFields).toContain("contextWindow");
		expect(merged[0].contextWindow).toBeUndefined();
	});

	test("conflicting thinking maps are omitted entirely", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", { reasoning: true, thinkingLevelMap: { high: "high", max: "max" } }),
				hit("model-x", { reasoning: true, thinkingLevelMap: { high: "high", max: null } }),
			],
			request(["model-x"]),
		);
		expect(merged[0].status).toBe("ambiguous");
		expect(merged[0].reasoning).toBe(true);
		expect(merged[0].thinkingLevelMap).toBeUndefined();
		expect(merged[0].conflictingFields).toContain("thinkingLevelMap");
	});

	test("an exact base URL and API disambiguate duplicate ids", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", {
					provider: "official",
					api: "openai-responses",
					baseUrl: "https://api.example.com/v1",
					contextWindow: 128000,
				}),
				hit("model-x", {
					provider: "compatible",
					api: "openai-completions",
					baseUrl: "https://proxy.example/v1/",
					contextWindow: 262144,
				}),
			],
			request(["model-x"]),
		);
		expect(merged[0]).toMatchObject({
			id: "model-x",
			status: "matched",
			sourceProvider: "compatible",
			contextWindow: 262144,
		});
	});

	test("same-origin base URLs outrank unrelated API matches", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", {
					provider: "same-origin",
					api: "openai-responses",
					baseUrl: "https://proxy.example/models",
					contextWindow: 128000,
				}),
				hit("model-x", {
					provider: "same-api",
					api: "openai-completions",
					baseUrl: "https://other.example/v1",
					contextWindow: 262144,
				}),
			],
			request(["model-x"]),
		);
		expect(merged[0]).toMatchObject({
			status: "matched",
			sourceProvider: "same-origin",
			contextWindow: 128000,
		});
	});

	test("API is used as a fallback disambiguator when URL does not match", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", {
					provider: "responses",
					api: "openai-responses",
					baseUrl: "https://one.example/v1",
					contextWindow: 128000,
				}),
				hit("model-x", {
					provider: "completions",
					api: "openai-completions",
					baseUrl: "https://two.example/v1",
					contextWindow: 262144,
				}),
			],
			request(["model-x"]),
		);
		expect(merged[0]).toMatchObject({
			status: "matched",
			sourceProvider: "completions",
			contextWindow: 262144,
		});
	});

	test("ids without any hit are returned as unmatched", () => {
		expect(mergeMatchedModels([hit("known", {})], request(["known", "unknown"]))).toEqual([
			expect.objectContaining({ id: "known", status: "matched" }),
			{ id: "unknown", status: "unmatched" },
		]);
	});

	test("case differences still match while the requested id casing is preserved", () => {
		const merged = mergeMatchedModels([hit("Qwen-Plus", { contextWindow: 131072 })], request(["qwen-plus"]));
		expect(merged).toEqual([expect.objectContaining({ id: "qwen-plus", status: "matched", contextWindow: 131072 })]);
	});

	test("exact-case hits are preferred over case-insensitive ones", () => {
		const merged = mergeMatchedModels(
			[
				hit("MODEL-X", { provider: "upper", name: "Model X", contextWindow: 128000 }),
				hit("model-x", { provider: "lower", name: "Model X", contextWindow: 262144 }),
			],
			request(["model-x"]),
		);
		expect(merged[0]).toMatchObject({
			status: "matched",
			sourceProvider: "lower",
			contextWindow: 262144,
		});
	});

	test("empty inputs produce an empty result", () => {
		expect(mergeMatchedModels([], request([]))).toEqual([]);
	});
});
