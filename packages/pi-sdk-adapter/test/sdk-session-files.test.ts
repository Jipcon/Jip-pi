import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, EditableUserMessage } from "@earendil-works/pi-agent-protocol";
import {
	type Api,
	clampThinkingLevel,
	type FauxModelDefinition,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, test, vi } from "vitest";
import { loadSdk } from "../src/sdk-loader.ts";
import { normalizeSdkMessages } from "../src/sdk-normalizer.ts";
import {
	createSessionFile,
	extractEditableUserMessages,
	type ReadSessionProjectionOptions,
	readSessionProjection,
	resolveFreshSessionDefaults,
} from "../src/sdk-session-files.ts";

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

	test("projection messages match runtime getMessages and carry structural entry ids", async () => {
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

		const projection = await readSessionProjection(file as string, {
			sessionId: "history-session",
			modelRuntime: Promise.resolve(runtime),
			resolveContextWindow: () => undefined,
		});
		expect(projection.messages.length).toBe(runtimeMessages.length);
		expect(textOf(projection.messages)).toBe(textOf(runtimeMessages));
		// Entry ids pair structurally: exactly the user messages carry one.
		expect(projection.entryIds).toHaveLength(projection.messages.length);
		projection.messages.forEach((message, index) => {
			if (message.role === "user") {
				expect(projection.entryIds[index]).toBeTypeOf("string");
			} else {
				expect(projection.entryIds[index]).toBeUndefined();
			}
		});
		expect(projection.editable.map((entry) => entry.text)).toEqual(["What is the answer?"]);
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

// ---------------------------------------------------------------------------
// Editable user messages & forking
// ---------------------------------------------------------------------------

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "user", content: text, timestamp },
	};
}

function assistantEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp,
			api: "anthropic-messages",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		},
	};
}

function imageUserEntry(id: string, parentId: string | null, text: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "user",
			content: [
				{ type: "text", text },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			timestamp,
		},
	};
}

function imageOnlyUserEntry(id: string, parentId: string | null, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "user",
			content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			timestamp,
		},
	};
}

/** Write a session JSONL fixture (header + entries) and return its path. */
function writeSessionFixture(id: string, entries: SessionEntry[]): string {
	const file = join(sessionDir, `fixture-${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: workspace,
	};
	writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("extractEditableUserMessages", () => {
	test("keeps only text-bearing user messages and maps entry ids", () => {
		const branch: SessionEntry[] = [
			userEntry("u1", null, "first", 100),
			assistantEntry("a1", "u1", "answer one", 200),
			imageOnlyUserEntry("u2", "a1", 300),
			imageUserEntry("u3", "u2", "look at this", 400),
			userEntry("u4", "u3", "", 500),
		];
		const editable = extractEditableUserMessages(branch);
		expect(editable).toEqual([
			{ entryId: "u1", text: "first", timestamp: 100 },
			{ entryId: "u3", text: "look at this", timestamp: 400 },
		]);
	});

	test("joins multiple text blocks and drops a timestamp-less message gracefully", () => {
		const entry: SessionEntry = {
			type: "message",
			id: "u-multi",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: {
				role: "user",
				content: [
					{ type: "text", text: "part one " },
					{ type: "text", text: "part two" },
				],
				timestamp: 1,
			},
		};
		const editable = extractEditableUserMessages([entry]);
		expect(editable).toEqual([{ entryId: "u-multi", text: "part one part two", timestamp: 1 }]);
	});
});

describe("readSessionProjection", () => {
	let fixtureRuntime: ModelRuntime | undefined;

	async function projectionRuntime(): Promise<ModelRuntime> {
		if (fixtureRuntime) return fixtureRuntime;
		const credentials = new InMemoryCredentialStore();
		const faux = fauxProvider({ provider: "projection-faux" });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		new ModelRegistry(runtime).registerProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		fixtureRuntime = runtime;
		return runtime;
	}

	async function project(file: string, sessionId = "fixture") {
		const options: ReadSessionProjectionOptions = {
			sessionId,
			modelRuntime: projectionRuntime(),
			resolveContextWindow: () => undefined,
		};
		return readSessionProjection(file, options);
	}

	test("reads and parses the JSONL exactly once", async () => {
		const file = writeSessionFixture("single-parse", [
			userEntry("u1", null, "first", 100),
			assistantEntry("a1", "u1", "answer one", 200),
		]);
		const sdk = await loadSdk();
		const parseSpy = vi.spyOn(sdk, "parseSessionEntries");
		try {
			await project(file, "single-parse");
			expect(parseSpy).toHaveBeenCalledTimes(1);
		} finally {
			parseSpy.mockRestore();
		}
	});

	test("reports only the current leaf path, never abandoned branches", async () => {
		// Two branches: u1 → a1 → u2 → a2 and u1 → a1 → u3. The last entry
		// (u3) is the leaf, so only its path is active; the old continuation
		// (u2/a2) stays in the file but leaves the projection.
		const file = writeSessionFixture("branchy", [
			userEntry("u1", null, "first", 100),
			assistantEntry("a1", "u1", "answer one", 200),
			userEntry("u2", "a1", "second", 300),
			assistantEntry("a2", "u2", "answer two", 400),
			userEntry("u3", "a1", "alternative", 500),
		]);
		const projection = await project(file);
		expect(projection.editable.map((entry: EditableUserMessage) => entry.entryId)).toEqual(["u1", "u3"]);
		expect(projection.editable[1].text).toBe("alternative");
		expect(textOf(projection.messages)).toBe("first | answer one | alternative");
		// The entry ids pair with the projected messages by position.
		const userIds = projection.messages.map((message, index) =>
			message.role === "user" ? projection.entryIds[index] : undefined,
		);
		expect(userIds.filter((id) => id !== undefined)).toEqual(["u1", "u3"]);
	});

	test("compaction keeps the kept tail on the active branch and drops the summarized head", async () => {
		// u1 → a1 → u2 → compaction(firstKept=u2) → a2. The compacted-away
		// head disappears from the context messages but its user message stays
		// editable on the leaf path.
		const compaction: SessionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp: new Date(350).toISOString(),
			summary: "earlier context",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
		};
		const file = writeSessionFixture("compacted", [
			userEntry("u1", null, "first", 100),
			assistantEntry("a1", "u1", "answer one", 200),
			userEntry("u2", "a1", "second", 300),
			compaction,
			assistantEntry("a2", "c1", "answer two", 400),
		]);
		const projection = await project(file);
		const text = textOf(projection.messages);
		expect(text).toContain("second");
		expect(text).toContain("answer two");
		expect(text).not.toContain("first");
		expect(text).not.toContain("answer one");
		expect(projection.editable.map((entry) => entry.entryId)).toEqual(["u1", "u2"]);
	});

	test("user messages with identical timestamps still pair with their own entry ids", async () => {
		const file = writeSessionFixture("same-timestamp", [
			userEntry("u1", null, "twin one", 100),
			userEntry("u2", "u1", "twin two", 100),
		]);
		const projection = await project(file);
		const paired = projection.messages
			.map((message, index) =>
				message.role === "user" ? { text: textOf([message]), entryId: projection.entryIds[index] } : undefined,
			)
			.filter((entry): entry is { text: string; entryId: string | undefined } => entry !== undefined);
		expect(paired).toEqual([
			{ text: "twin one", entryId: "u1" },
			{ text: "twin two", entryId: "u2" },
		]);
	});

	test("projects an empty result for a header-only file", async () => {
		const file = writeSessionFixture("empty", []);
		const projection = await project(file);
		expect(projection.messages).toEqual([]);
		expect(projection.entryIds).toEqual([]);
		expect(projection.editable).toEqual([]);
	});
});
