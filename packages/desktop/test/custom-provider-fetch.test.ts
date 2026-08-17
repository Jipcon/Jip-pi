import { afterEach, describe, expect, test, vi } from "vitest";
import { buildFetchHeaders, buildModelsUrlCandidates, fetchProviderModels } from "../src/main/custom-provider-fetch.ts";

/** A minimal Response stand-in for the stubbed global fetch. */
function fakeResponse(status: number, body: string): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
	} as unknown as Response;
}

function stubFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
	const mock = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
	vi.stubGlobal("fetch", mock);
	return mock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("buildModelsUrlCandidates", () => {
	test("plain root gets {base}/v1/models", () => {
		expect(buildModelsUrlCandidates("https://api.example.com", "openai-completions")).toEqual([
			"https://api.example.com/v1/models",
		]);
	});

	test("trailing slash is trimmed", () => {
		expect(buildModelsUrlCandidates("https://api.example.com/", "openai-completions")).toEqual([
			"https://api.example.com/v1/models",
		]);
	});

	test("base ending in /v1 keeps {base}/models only", () => {
		expect(buildModelsUrlCandidates("https://api.example.com/v1", "openai-completions")).toEqual([
			"https://api.example.com/v1/models",
		]);
	});

	test("base ending in a non-v1 version segment tries {base}/models first", () => {
		expect(buildModelsUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4", "openai-completions")).toEqual([
			"https://open.bigmodel.cn/api/coding/paas/v4/models",
			"https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
		]);
	});

	test("anthropic-compat suffix is stripped into extra candidates", () => {
		expect(buildModelsUrlCandidates("https://api.deepseek.com/anthropic", "openai-completions")).toEqual([
			"https://api.deepseek.com/anthropic/v1/models",
			"https://api.deepseek.com/v1/models",
			"https://api.deepseek.com/models",
		]);
	});

	test("longest compat suffix wins over a shorter one", () => {
		expect(buildModelsUrlCandidates("https://api.z.ai/api/anthropic", "openai-completions")).toEqual([
			"https://api.z.ai/api/anthropic/v1/models",
			"https://api.z.ai/v1/models",
			"https://api.z.ai/models",
		]);
	});

	test("google gets exactly {base}/models", () => {
		expect(
			buildModelsUrlCandidates("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"),
		).toEqual(["https://generativelanguage.googleapis.com/v1beta/models"]);
	});

	test("rejects non-http(s) schemes", () => {
		expect(() => buildModelsUrlCandidates("file:///etc", "openai-completions")).toThrow(/http/);
		expect(() => buildModelsUrlCandidates("not a url", "openai-completions")).toThrow(/Invalid base URL/);
		expect(() => buildModelsUrlCandidates("  ", "openai-completions")).toThrow(/empty/);
	});
});

describe("buildFetchHeaders", () => {
	test("openai-style apis use Bearer", () => {
		const headers = buildFetchHeaders("openai-completions", "sk-test");
		expect(headers.get("Authorization")).toBe("Bearer sk-test");
		expect(headers.get("x-api-key")).toBeNull();
	});

	test("anthropic uses x-api-key", () => {
		const headers = buildFetchHeaders("anthropic-messages", "ant-key");
		expect(headers.get("x-api-key")).toBe("ant-key");
		expect(headers.get("Authorization")).toBeNull();
	});

	test("google uses x-goog-api-key", () => {
		const headers = buildFetchHeaders("google-generative-ai", "goog-key");
		expect(headers.get("x-goog-api-key")).toBe("goog-key");
	});

	test("empty key sends no auth header", () => {
		const headers = buildFetchHeaders("openai-completions", "");
		expect(headers.get("Authorization")).toBeNull();
	});
});

describe("fetchProviderModels", () => {
	test("parses the openai-compatible data shape", async () => {
		stubFetch(() => fakeResponse(200, JSON.stringify({ object: "list", data: [{ id: "b" }, { id: "a" }] })));
		const models = await fetchProviderModels({ baseUrl: "https://api.example.com/v1", api: "openai-completions" });
		expect(models).toEqual([{ id: "a" }, { id: "b" }]);
	});

	test("maps anthropic display_name onto the model name", async () => {
		stubFetch(() => fakeResponse(200, JSON.stringify({ data: [{ id: "claude-x", display_name: "Claude X" }] })));
		const models = await fetchProviderModels({ baseUrl: "https://api.anthropic.com", api: "anthropic-messages" });
		expect(models).toEqual([{ id: "claude-x", name: "Claude X" }]);
	});

	test("parses the google shape with token limits", async () => {
		stubFetch(() =>
			fakeResponse(
				200,
				JSON.stringify({
					models: [
						{
							name: "models/gemini-2.5-flash",
							displayName: "Gemini 2.5 Flash",
							inputTokenLimit: 1_000_000,
							outputTokenLimit: 65_536,
						},
					],
				}),
			),
		);
		const models = await fetchProviderModels({
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			api: "google-generative-ai",
		});
		expect(models).toEqual([
			{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, maxTokens: 65_536 },
		]);
	});

	test("sends the auth header for the selected api and the api key", async () => {
		const mock = stubFetch(() => fakeResponse(200, JSON.stringify({ data: [] })));
		await fetchProviderModels({
			baseUrl: "https://api.example.com",
			api: "anthropic-messages",
			apiKey: "ant-key",
		});
		expect(mock).toHaveBeenCalledTimes(1);
		const init = mock.mock.calls[0][1] as RequestInit;
		expect(new Headers(init.headers).get("x-api-key")).toBe("ant-key");
	});

	test("falls through 404/405 to the next candidate", async () => {
		const mock = stubFetch((url: string) =>
			url === "https://api.example.com/v4/models"
				? fakeResponse(404, "not found")
				: fakeResponse(200, JSON.stringify({ data: [{ id: "m1" }] })),
		);
		const models = await fetchProviderModels({
			baseUrl: "https://api.example.com/v4",
			api: "openai-responses",
		});
		expect(models).toEqual([{ id: "m1" }]);
		expect(mock.mock.calls.map((call) => call[0])).toEqual([
			"https://api.example.com/v4/models",
			"https://api.example.com/v4/v1/models",
		]);
	});

	test("non-404 errors fail immediately with the redacted body", async () => {
		const mock = stubFetch(() => fakeResponse(401, "invalid api key sk-secret-12345678"));
		await expect(
			fetchProviderModels({
				baseUrl: "https://api.example.com",
				api: "openai-completions",
				apiKey: "sk-secret-12345678",
			}),
		).rejects.toThrow(/HTTP 401/);
		expect(mock).toHaveBeenCalledTimes(1);
	});

	test("the api key is redacted from error bodies", async () => {
		stubFetch(() => fakeResponse(403, "key sk-very-secret-key-123 is wrong"));
		await expect(
			fetchProviderModels({
				baseUrl: "https://api.example.com",
				api: "openai-completions",
				apiKey: "sk-very-secret-key-123",
			}),
		).rejects.toThrow(/\[REDACTED\]/);
	});

	test("oversized error bodies are truncated", async () => {
		stubFetch(() => fakeResponse(404, "x".repeat(2000)));
		await expect(
			fetchProviderModels({ baseUrl: "https://api.example.com", api: "openai-completions" }),
		).rejects.toThrow(/All candidates failed/);
	});

	test("network failures surface as request errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
		);
		await expect(
			fetchProviderModels({ baseUrl: "https://api.example.com", api: "openai-completions" }),
		).rejects.toThrow(/Request failed: ECONNREFUSED/);
	});

	test("invalid response bodies are rejected", async () => {
		stubFetch(() => fakeResponse(200, "not json"));
		await expect(
			fetchProviderModels({ baseUrl: "https://api.example.com", api: "openai-completions" }),
		).rejects.toThrow(/not JSON/);
	});
});
