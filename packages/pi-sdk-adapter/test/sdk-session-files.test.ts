import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-protocol";
import {
	type Api,
	clampThinkingLevel,
	type FauxModelDefinition,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, test } from "vitest";
import { loadSdk } from "../src/sdk-loader.ts";
import { normalizeSdkMessages } from "../src/sdk-normalizer.ts";
import { createSessionFile, readSessionHistory, resolveFreshSessionDefaults } from "../src/sdk-session-files.ts";

const tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-files-"));
const workspace = join(tempDir, "workspace");
const sessionDir = join(tempDir, "sessions");

afterAll(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function textOf(messages: AgentMessage[]): string {
	return messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join(" "),
		)
		.join(" | ");
}

describe("session file helpers", () => {
	test("createSessionFile writes a valid header-only JSONL and catalogs it", async () => {
		const { sessionId, sessionFile } = await createSessionFile(workspace, sessionDir);
		expect(sessionId.length).toBeGreaterThan(0);
		expect(sessionFile.endsWith(".jsonl")).toBe(true);
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const header = JSON.parse(lines[0]) as { type: string; id: string; cwd: string };
		expect(header.type).toBe("session");
		expect(header.id).toBe(sessionId);
		expect(header.cwd).toBe(workspace);
		// The SDK can reopen the identity (single-writer consistency).
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getSessionId()).toBe(sessionId);
	});

	test("readSessionHistory matches runtime getMessages for the same file", async () => {
		const sdk = await loadSdk();
		const credentials = new InMemoryCredentialStore();
		const faux = fauxProvider({ provider: "history-faux" });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		new ModelRegistry(runtime).registerProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });

		// Persist a session with a real agent turn, then close it.
		const manager = sdk.SessionManager.create(workspace, sessionDir, { id: "history-session" });
		const { session } = await sdk.createAgentSession({
			cwd: workspace,
			agentDir: tempDir,
			modelRuntime: runtime,
			settingsManager: sdk.SettingsManager.inMemory(),
			sessionManager: manager,
			model: faux.getModel(),
		});
		faux.setResponses([fauxAssistantMessage("The answer is 42")]);
		await session.prompt("What is the answer?");
		await session.waitForIdle();
		const runtimeMessages = normalizeSdkMessages(session.messages);
		const file = session.sessionFile;
		expect(file).toBeDefined();
		session.dispose();

		const history = await readSessionHistory(file as string);
		expect(history.length).toBe(runtimeMessages.length);
		expect(textOf(history)).toBe(textOf(runtimeMessages));
	});
});

async function createDefaultsRuntime(models: FauxModelDefinition[]): Promise<ModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	const faux = fauxProvider({ provider: "defaults-faux", models });
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	new ModelRegistry(runtime).registerProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("resolveFreshSessionDefaults", () => {
	const workspace = join(tempDir, "defaults-workspace");
	const agentDir = join(tempDir, "defaults-agent");

	function writeSettings(settings: Record<string, unknown>): void {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	}

	test("falls back to the built-in default when no thinking default is set", async () => {
		const sdk = await loadSdk();
		writeSettings({ defaultProvider: "defaults-faux", defaultModel: "faux-1" });
		const runtime = await createDefaultsRuntime([{ id: "faux-1", reasoning: true }]);
		const defaults = await resolveFreshSessionDefaults({
			workspacePath: workspace,
			agentDir,
			modelRuntime: Promise.resolve(runtime),
		});
		const model = runtime.getModel("defaults-faux", "faux-1") as Model<Api>;
		expect(defaults.model?.id).toBe("faux-1");
		expect(defaults.thinkingLevel).toBe(clampThinkingLevel(model, sdk.DEFAULT_THINKING_LEVEL));
	});

	test("clamps the settings default down to what the model supports", async () => {
		writeSettings({ defaultProvider: "defaults-faux", defaultModel: "faux-1", defaultThinkingLevel: "max" });
		const runtime = await createDefaultsRuntime([{ id: "faux-1", reasoning: true }]);
		const defaults = await resolveFreshSessionDefaults({
			workspacePath: workspace,
			agentDir,
			modelRuntime: Promise.resolve(runtime),
		});
		// The faux model has no thinkingLevelMap, so max and xhigh are unsupported.
		expect(defaults.thinkingLevel).toBe("high");
	});

	test("a non-reasoning model clamps every default to off", async () => {
		writeSettings({
			defaultProvider: "defaults-faux",
			defaultModel: "plain",
			defaultThinkingLevel: "max",
		});
		const runtime = await createDefaultsRuntime([{ id: "plain", reasoning: false }]);
		const defaults = await resolveFreshSessionDefaults({
			workspacePath: workspace,
			agentDir,
			modelRuntime: Promise.resolve(runtime),
		});
		expect(defaults.model?.id).toBe("plain");
		expect(defaults.thinkingLevel).toBe("off");
	});

	test("an unresolvable pending model reports off", async () => {
		writeSettings({ defaultThinkingLevel: "max" });
		const runtime = await createDefaultsRuntime([{ id: "faux-1", reasoning: true }]);
		const defaults = await resolveFreshSessionDefaults({
			workspacePath: workspace,
			agentDir,
			modelRuntime: Promise.resolve(runtime),
			pendingModel: { provider: "defaults-faux", modelId: "missing" },
		});
		expect(defaults.model).toBeNull();
		expect(defaults.thinkingLevel).toBe("off");
	});

	test("a pending model wins over the settings default model", async () => {
		writeSettings({
			defaultProvider: "defaults-faux",
			defaultModel: "faux-1",
			defaultThinkingLevel: "max",
		});
		const runtime = await createDefaultsRuntime([
			{ id: "plain", reasoning: false },
			{ id: "faux-1", reasoning: true },
		]);
		const defaults = await resolveFreshSessionDefaults({
			workspacePath: workspace,
			agentDir,
			modelRuntime: Promise.resolve(runtime),
			pendingModel: { provider: "defaults-faux", modelId: "plain" },
		});
		expect(defaults.model?.id).toBe("plain");
		expect(defaults.thinkingLevel).toBe("off");
	});
});
