/**
 * OpenCode Go catalog drift test.
 *
 * Baseline snapshot of the current official 18-model Go catalog. Any change
 * to the model set, endpoint, or high-risk model compatibility is a signal
 * that real-network validation is required before shipping: update this test
 * only after re-validating against the live Go endpoint and recording the
 * validation date in the comment.
 *
 * Real-network validation consumes quota and must be authorized separately;
 * this test never makes network requests.
 */

import { describe, expect, test } from "vitest";
import { getModels } from "../src/compat.ts";

type CatalogEntry = {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl?: string;
	reasoning?: boolean;
};

function goCatalog(): Record<string, CatalogEntry> {
	const models = getModels("opencode-go");
	return Object.fromEntries(models.map((model) => [model.id, model as CatalogEntry]));
}

/** Verified against the live Go endpoint on 2026-08-08 (no network here). */
const BASELINE_IDS = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5.1",
	"glm-5.2",
	"gpt-5.6-luna",
	"grok-4.5",
	"hy3",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k3",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"minimax-m2.7",
	"minimax-m3",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
];

/** Endpoints that were confirmed for real model traffic (per provider table). */
const BASELINE_ENDPOINTS: Record<string, string> = {
	"anthropic-messages": "https://opencode.ai/zen/go",
	"openai-completions": "https://opencode.ai/zen/go/v1",
	"openai-responses": "https://opencode.ai/zen/go/v1",
};

describe("OpenCode Go catalog baseline", () => {
	test("the official 18-model set is present with no unexpected additions", () => {
		const catalog = goCatalog();
		expect(Object.keys(catalog).sort()).toEqual([...BASELINE_IDS].sort());
	});

	test("every model routes through the official Go endpoints", () => {
		const catalog = goCatalog();
		for (const model of Object.values(catalog)) {
			expect(model.baseUrl, `${model.id} endpoint`).toBe(BASELINE_ENDPOINTS[model.api]);
		}
	});

	test("high-risk models keep their expected API surface and reasoning", () => {
		const catalog = goCatalog();
		const expectations: Record<string, Partial<CatalogEntry>> = {
			"kimi-k3": { api: "openai-completions", reasoning: true },
			"deepseek-v4-flash": { api: "anthropic-messages", reasoning: true },
			"grok-4.5": { api: "openai-responses", reasoning: true },
			"minimax-m2.7": { api: "openai-completions", reasoning: true },
			"qwen3.6-plus": { api: "openai-completions", reasoning: true },
		};
		for (const [id, expected] of Object.entries(expectations)) {
			expect(catalog[id], `model ${id}`).toMatchObject(expected);
		}
	});

	test("Go models never carry Zen-only endpoints or the opencode provider", () => {
		const catalog = goCatalog();
		for (const model of Object.values(catalog)) {
			expect(model.baseUrl).not.toMatch(/api\.opencode\.ai/i);
			expect(model.provider, `${model.id} provider`).toBe("opencode-go");
		}
	});
});
