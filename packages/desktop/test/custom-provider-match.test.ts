import type { ModelInfo } from "@earendil-works/pi-agent-protocol";
import { describe, expect, test } from "vitest";
import { mergeMatchedModels } from "../src/main/custom-provider-match.ts";

function hit(id: string, fields: Partial<ModelInfo>): ModelInfo {
	return { id, name: `Name ${id}`, provider: "p", ...fields };
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
			["qwen-plus"],
		);
		expect(merged).toEqual([
			{ id: "qwen-plus", name: "Name qwen-plus", contextWindow: 131072, maxTokens: 8192, reasoning: false },
		]);
	});

	test("agreeing hits across providers fill the fields", () => {
		const merged = mergeMatchedModels(
			[
				hit("deepseek-v3", { contextWindow: 65536, reasoning: true, thinkingLevelMap: { high: "high" } }),
				hit("deepseek-v3", { contextWindow: 65536, reasoning: true, thinkingLevelMap: { high: "high" } }),
			],
			["deepseek-v3"],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].contextWindow).toBe(65536);
		expect(merged[0].reasoning).toBe(true);
		expect(merged[0].thinkingLevelMap).toEqual({ high: "high" });
	});

	test("conflicting fields are omitted while agreeing fields survive", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", { contextWindow: 128000, maxTokens: 4096 }),
				hit("model-x", { contextWindow: 262144, maxTokens: 4096 }),
			],
			["model-x"],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0].contextWindow).toBeUndefined();
		expect(merged[0].maxTokens).toBe(4096);
	});

	test("a hit missing a field breaks agreement on that field", () => {
		const merged = mergeMatchedModels(
			[hit("model-x", { contextWindow: 128000 }), hit("model-x", { contextWindow: undefined })],
			["model-x"],
		);
		expect(merged[0].contextWindow).toBeUndefined();
	});

	test("conflicting thinking maps are omitted entirely", () => {
		const merged = mergeMatchedModels(
			[
				hit("model-x", { reasoning: true, thinkingLevelMap: { high: "high", max: "max" } }),
				hit("model-x", { reasoning: true, thinkingLevelMap: { high: "high", max: null } }),
			],
			["model-x"],
		);
		expect(merged[0].reasoning).toBe(true);
		expect(merged[0].thinkingLevelMap).toBeUndefined();
	});

	test("ids without any hit are dropped", () => {
		expect(mergeMatchedModels([hit("known", {})], ["known", "unknown"])).toHaveLength(1);
	});

	test("empty inputs produce an empty result", () => {
		expect(mergeMatchedModels([], [])).toEqual([]);
	});
});
