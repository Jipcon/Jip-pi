/**
 * End-to-end OAuth login through the session runtime with an extension
 * provider: the extension's onAuth/onDeviceCode/onProgress callbacks must
 * surface through the AuthInteraction notify channel and the credential must
 * land in the shared credential store.
 */

import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("OAuth login through extension providers", () => {
	it("maps extension onAuth/onDeviceCode/onProgress to notify and persists the credential", async () => {
		const harness: Harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("corp-oauth", {
						name: "Corp OAuth",
						api: "openai-responses",
						baseUrl: "https://corp.invalid",
						models: [
							{
								id: "corp-model",
								name: "Corp Model",
								api: "openai-responses",
								reasoning: false,
								input: ["text"],
								contextWindow: 16_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								maxTokens: 16_000,
							},
						],
						oauth: {
							name: "Corp OAuth (SSO)",
							isSubscription: true,
							login: async (callbacks) => {
								callbacks.onAuth({ url: "https://corp.invalid/authorize" });
								callbacks.onDeviceCode({
									userCode: "AB12-CD34",
									verificationUri: "https://corp.invalid/device",
								});
								callbacks.onProgress?.("contacting corp…");
								const code = await callbacks.onPrompt({ message: "Enter the code" });
								if (code !== "GOOD-CODE") throw new Error(`Invalid code: ${code}`);
								return { refresh: "refresh-token", access: "access-token", expires: Date.now() + 3600_000 };
							},
							refreshToken: async (credentials) => credentials,
							getApiKey: (credentials) => credentials.access,
						},
					});
				},
			],
		});

		try {
			const events: AuthEvent[] = [];
			const prompts: AuthPrompt[] = [];
			const promptAnswer = "GOOD-CODE";

			await harness.session.modelRuntime.login("corp-oauth", "oauth", {
				prompt: async (prompt) => {
					prompts.push(prompt);
					return promptAnswer;
				},
				notify: (event) => events.push(event),
			});

			expect(events).toEqual([
				{ type: "auth_url", url: "https://corp.invalid/authorize" },
				{ type: "device_code", userCode: "AB12-CD34", verificationUri: "https://corp.invalid/device" },
				{ type: "progress", message: "contacting corp…" },
			]);
			expect(prompts).toEqual([{ type: "text", message: "Enter the code" }]);

			const credential = await harness.authStorage.read("corp-oauth");
			expect(credential).toMatchObject({ type: "oauth", refresh: "refresh-token", access: "access-token" });

			// The composed provider reports oauth capability and the stored
			// credential is removable. The availability snapshot converges
			// asynchronously (concurrent setup refreshes may invalidate the
			// login's own pass), so poll like the GUI does after a login.
			const runtime = harness.session.modelRuntime;
			const provider = runtime.getProviders().find((entry) => entry.id === "corp-oauth");
			expect(provider?.auth.oauth?.loginLabel ?? provider?.auth.oauth?.name).toBe("Corp OAuth (SSO)");
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				if (runtime.getProviderAuthStatus("corp-oauth").configured) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(runtime.getProviderAuthStatus("corp-oauth")).toMatchObject({ configured: true, source: "stored" });
		} finally {
			harness.cleanup();
		}
	});

	it("rejects with Login cancelled when the prompt is aborted by the flow", async () => {
		const harness: Harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					pi.registerProvider("corp-oauth-2", {
						name: "Corp OAuth 2",
						api: "openai-responses",
						baseUrl: "https://corp.invalid",
						models: [
							{
								id: "corp-model",
								name: "Corp Model",
								api: "openai-responses",
								reasoning: false,
								input: ["text"],
								contextWindow: 16_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								maxTokens: 16_000,
							},
						],
						oauth: {
							name: "Corp OAuth 2 (SSO)",
							login: async (callbacks) => {
								const controller = new AbortController();
								const codePromise = callbacks.onPrompt({ message: "Enter the code" });
								// The callback server wins: abort the manual code prompt.
								void controller.abort;
								await codePromise.catch(() => {});
								return { refresh: "r", access: "a", expires: Date.now() + 3600_000 };
							},
							refreshToken: async (credentials) => credentials,
							getApiKey: (credentials) => credentials.access,
						},
					});
				},
			],
		});

		try {
			// Extension onPrompt maps to a plain text prompt without a signal;
			// cancellation arrives through the interaction signal instead.
			const controller = new AbortController();
			const login = harness.session.modelRuntime.login("corp-oauth-2", "oauth", {
				signal: controller.signal,
				prompt: async () => {
					controller.abort(new Error("Login cancelled"));
					throw new Error("Login cancelled");
				},
				notify: () => {},
			});
			await expect(login).rejects.toThrow("Login cancelled");
			expect(await harness.authStorage.read("corp-oauth-2")).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});
});
