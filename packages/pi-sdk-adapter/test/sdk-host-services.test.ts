import type { AgentEvent, AuthFlowUpdate } from "@earendil-works/pi-agent-protocol";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	createProvider,
	fauxProvider,
	InMemoryCredentialStore,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { SdkHostServices } from "../src/sdk-host-services.ts";

/**
 * A provider with an OAuth login that reports every call and drives the flow
 * through the AuthInteraction (notify + prompt). No real network is touched.
 */
function createOAuthTestProvider(loginCalls: { count: number }) {
	const core = createFauxCore({ provider: "oauth-test", models: [{ id: "oauth-model", name: "OAuth Model" }] });
	const provider = createProvider({
		id: "oauth-test",
		name: "OAuth Test",
		auth: {
			oauth: {
				name: "OAuth Test login",
				login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
					loginCalls.count += 1;
					interaction.notify({ type: "auth_url", url: "https://example.com/authorize" });
					await interaction.prompt({ type: "text", message: "Paste the code" });
					return {
						type: "oauth",
						refresh: "refresh-token",
						access: "access-token",
						expires: Date.now() + 3600_000,
					};
				},
				refresh: async (credential) => credential,
				toAuth: async () => ({ headers: {} }),
			},
		},
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return provider;
}

/** A provider whose api_key auth accepts interactive login. */
function createApiKeyTestProvider() {
	const core = createFauxCore({ provider: "key-faux", models: [{ id: "key-model", name: "Key Model" }] });
	const provider = createProvider({
		id: "key-faux",
		name: "Key Faux",
		auth: {
			apiKey: {
				name: "Key Faux key",
				login: async (interaction: ProviderAuthInteraction) => {
					const key = await interaction.prompt({ type: "text", message: "Enter the key" });
					return { type: "api_key", key };
				},
				resolve: async ({ credential }) => (credential ? { auth: { apiKey: credential.key } } : undefined),
			},
		},
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return provider;
}

async function createTestRuntime() {
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
	});
	return { credentials, runtime };
}

function collectAuthEvents(services: SdkHostServices): {
	updates: AuthFlowUpdate[];
	unsubscribe: () => void;
} {
	const updates: AuthFlowUpdate[] = [];
	const unsubscribe = services.subscribe((event: AgentEvent) => {
		if (event.type === "custom" && event.namespace === "pi" && event.name === "auth_flow") {
			updates.push(event.payload as AuthFlowUpdate);
		}
	});
	return { updates, unsubscribe };
}

describe("SdkHostServices", () => {
	test("models and auth status work with zero session backends", async () => {
		const { runtime } = await createTestRuntime();
		const faux = fauxProvider({ provider: "host-faux" });
		new ModelRegistry(runtime).registerProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });

		const models = await services.listModels();
		expect(models.some((model) => model.provider === "host-faux")).toBe(true);
		const statuses = await services.listProviderAuthStatus();
		const status = statuses.find((entry) => entry.provider === "host-faux");
		expect(status).toBeDefined();
		expect(typeof status?.configured).toBe("boolean");
		// No session backend was ever created (host services are standalone).
	});

	test("setApiKey stores through the shared runtime and updates the catalog once (no fan-out)", async () => {
		const { runtime, credentials } = await createTestRuntime();
		new ModelRegistry(runtime).registerProvider(createApiKeyTestProvider());
		await runtime.refresh({ allowNetwork: false });
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });

		await services.setApiKey("key-faux", "test-key");
		const stored = await credentials.read("key-faux");
		expect(stored).toMatchObject({ type: "api_key", key: "test-key" });
		const statuses = await services.listProviderAuthStatus();
		console.log("STATUSES:", JSON.stringify(statuses.map((s) => ({ p: s.provider, c: s.configured }))));
		expect(statuses.find((status) => status.provider === "key-faux")?.configured).toBe(true);
		// Removing it updates the same shared state.
		await services.removeCredential("key-faux");
		expect(
			(await services.listProviderAuthStatus()).find((status) => status.provider === "key-faux")?.configured,
		).toBe(false);
	});

	test("concurrent OAuth logins for the same provider join one transaction", async () => {
		const { runtime } = await createTestRuntime();
		const loginCalls = { count: 0 };
		new ModelRegistry(runtime).registerProvider(createOAuthTestProvider(loginCalls));
		await runtime.refresh({ allowNetwork: false });
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });
		const { updates, unsubscribe } = collectAuthEvents(services);

		const first = services.loginWithOAuth("oauth-test");
		const second = services.loginWithOAuth("oauth-test");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(loginCalls.count).toBe(1);

		// The flow asked for a prompt; answer it through the host-level routing.
		const prompt = updates.find((update) => update.kind === "prompt");
		expect(prompt).toBeDefined();
		if (prompt?.kind === "prompt") {
			await services.respondToAuthPrompt(prompt.requestId, { kind: "value", value: "the-code" });
		}
		await Promise.all([first, second]);
		expect(loginCalls.count).toBe(1);
		unsubscribe();
	});

	test("authRequestId routes answers and rejects unknown ids", async () => {
		const { runtime } = await createTestRuntime();
		const loginCalls = { count: 0 };
		new ModelRegistry(runtime).registerProvider(createOAuthTestProvider(loginCalls));
		await runtime.refresh({ allowNetwork: false });
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });
		const { updates, unsubscribe } = collectAuthEvents(services);

		const login = services.loginWithOAuth("oauth-test");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const prompt = updates.find((update) => update.kind === "prompt");
		expect(prompt?.kind).toBe("prompt");
		// Unknown ids never resolve a prompt.
		await expect(services.respondToAuthPrompt("no-such-request", { kind: "value", value: "x" })).rejects.toThrow(
			"Auth prompt not found",
		);
		if (prompt?.kind === "prompt") {
			await services.respondToAuthPrompt(prompt.requestId, { kind: "value", value: "the-code" });
		}
		await login;
		unsubscribe();
	});

	test("cancelling OAuth aborts the in-flight flow", async () => {
		const { runtime } = await createTestRuntime();
		const loginCalls = { count: 0 };
		new ModelRegistry(runtime).registerProvider(createOAuthTestProvider(loginCalls));
		await runtime.refresh({ allowNetwork: false });
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });

		const login = services.loginWithOAuth("oauth-test");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await services.cancelOAuthLogin();
		await expect(login).rejects.toThrow();
	});

	test("handshake reports the SDK capabilities", async () => {
		const { runtime } = await createTestRuntime();
		const services = new SdkHostServices({ agentDir: "C:\\agent", modelRuntime: runtime });
		const handshake = await services.getHandshake();
		expect(handshake.backend.id).toBe("pi");
		expect(handshake.capabilities.sessions).toBe(false);
		expect(handshake.capabilities.models).toBe(true);
	});
});
