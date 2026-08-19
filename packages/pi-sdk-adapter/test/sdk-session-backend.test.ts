import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage, ModelRef } from "@earendil-works/pi-agent-protocol";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SdkSessionBackend } from "../src/sdk-session-backend.ts";

/**
 * Test runtime: a shared ModelRuntime with registered faux providers and an
 * in-memory credential store. No real provider APIs are touched.
 */
interface TestRuntime {
	runtime: ModelRuntime;
	agentDir: string;
}

function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("waitFor timed out"));
				return;
			}
			setTimeout(poll, 10);
		};
		poll();
	});
}

async function createTestRuntime(): Promise<TestRuntime> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-sdk-adapter-"));
	const credentials = new InMemoryCredentialStore();
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	return { runtime, agentDir };
}

/** Register a fresh faux provider with a unique id and return its handle. */
function registerFaux(runtime: ModelRuntime, providerId: string, tokensPerSecond = 0): FauxProviderHandle {
	const faux = fauxProvider({ provider: providerId, tokensPerSecond });
	new ModelRegistry(runtime).registerProvider(faux.provider);
	return faux;
}

function modelOf(faux: FauxProviderHandle): ModelRef {
	const model = faux.getModel();
	return { provider: model.provider, modelId: model.id };
}

function createBackend(runtime: TestRuntime): SdkSessionBackend {
	return new SdkSessionBackend({
		modelRuntime: runtime.runtime,
		agentDir: runtime.agentDir,
		resolveSessionDirectory: () => undefined,
		sessionManager: SessionManager.inMemory(process.cwd()),
		settingsManager: SettingsManager.inMemory(),
	});
}

function collectEvents(backend: SdkSessionBackend): { events: AgentEvent[]; unsubscribe: () => void } {
	const events: AgentEvent[] = [];
	const unsubscribe = backend.subscribe((event) => {
		events.push(event);
	});
	return { events, unsubscribe };
}

function textOf(events: AgentEvent[]): string {
	return events
		.filter((event) => event.type === "message_delta" && event.kind === "text")
		.map((event) => (event.type === "message_delta" ? (event.delta ?? "") : ""))
		.join("");
}

let runtime: TestRuntime;
let activeBackends: SdkSessionBackend[];

beforeAll(async () => {
	runtime = await createTestRuntime();
	activeBackends = [];
});

afterAll(() => {
	for (const backend of activeBackends) {
		void backend.stop();
	}
	rmSync(runtime.agentDir, { recursive: true, force: true });
});

describe("SdkSessionBackend concurrency", () => {
	test("two backends stream simultaneously and events stay isolated", async () => {
		const fauxA = registerFaux(runtime.runtime, "faux-a", 30);
		const fauxB = registerFaux(runtime.runtime, "faux-b", 30);
		fauxA.setResponses([fauxAssistantMessage("A response ".repeat(40))]);
		fauxB.setResponses([fauxAssistantMessage("B response ".repeat(40))]);

		const backendA = createBackend(runtime);
		const backendB = createBackend(runtime);
		activeBackends.push(backendA, backendB);
		await backendA.start({ workspacePath: process.cwd(), model: modelOf(fauxA) });
		await backendB.start({ workspacePath: process.cwd(), model: modelOf(fauxB) });

		const a = collectEvents(backendA);
		const b = collectEvents(backendB);

		await backendA.sendMessage({ role: "user", content: "hello from A" });
		await backendB.sendMessage({ role: "user", content: "hello from B" });

		// Both sessions are streaming at the same time.
		expect(backendA.isStreaming).toBe(true);
		expect(backendB.isStreaming).toBe(true);

		await waitFor(() => !backendA.isStreaming && !backendB.isStreaming);

		// A's event stream only contains A's text; B's only B's.
		const aText = textOf(a.events);
		const bText = textOf(b.events);
		expect(aText).toContain("A response");
		expect(aText).not.toContain("B response");
		expect(bText).toContain("B response");
		expect(bText).not.toContain("A response");

		// Each backend reports its own messages only.
		const aMessages = await backendA.getMessages();
		const bMessages = await backendB.getMessages();
		expect(JSON.stringify(aMessages)).toContain("hello from A");
		expect(JSON.stringify(aMessages)).not.toContain("hello from B");
		expect(JSON.stringify(bMessages)).toContain("hello from B");
		expect(JSON.stringify(bMessages)).not.toContain("hello from A");

		a.unsubscribe();
		b.unsubscribe();
		await backendA.stop();
		await backendB.stop();
	});

	test("aborting A does not affect B", async () => {
		const fauxA = registerFaux(runtime.runtime, "faux-abort-a", 10);
		const fauxB = registerFaux(runtime.runtime, "faux-abort-b");
		fauxA.setResponses([fauxAssistantMessage("A long response ".repeat(200))]);
		fauxB.setResponses([fauxAssistantMessage("B finished response")]);

		const backendA = createBackend(runtime);
		const backendB = createBackend(runtime);
		activeBackends.push(backendA, backendB);
		await backendA.start({ workspacePath: process.cwd(), model: modelOf(fauxA) });
		await backendB.start({ workspacePath: process.cwd(), model: modelOf(fauxB) });

		const b = collectEvents(backendB);

		await backendA.sendMessage({ role: "user", content: "A start" });
		await waitFor(() => backendA.isStreaming);
		await backendA.abort();
		await waitFor(() => !backendA.isStreaming);

		await backendB.sendMessage({ role: "user", content: "B start" });
		await waitFor(() => !backendB.isStreaming);

		expect(textOf(b.events)).toContain("B finished response");
		expect(JSON.stringify(await backendB.getMessages())).toContain("B start");

		b.unsubscribe();
		await backendA.stop();
		await backendB.stop();
	});

	test("a provider error on A settles A; B completes normally", async () => {
		const fauxA = registerFaux(runtime.runtime, "faux-error-a");
		const fauxB = registerFaux(runtime.runtime, "faux-error-b");
		// No queued response on A → its first prompt errors out.
		fauxA.setResponses([]);
		fauxB.setResponses([fauxAssistantMessage("B clean response")]);

		const backendA = createBackend(runtime);
		const backendB = createBackend(runtime);
		activeBackends.push(backendA, backendB);
		await backendA.start({ workspacePath: process.cwd(), model: modelOf(fauxA) });
		await backendB.start({ workspacePath: process.cwd(), model: modelOf(fauxB) });

		const b = collectEvents(backendB);

		await backendA.sendMessage({ role: "user", content: "A fails" });
		await waitFor(() => !backendA.isStreaming);

		const aErrors = (await backendA.getMessages()).filter(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		expect(aErrors.length).toBeGreaterThan(0);

		await backendB.sendMessage({ role: "user", content: "B works" });
		await waitFor(() => !backendB.isStreaming);
		expect(textOf(b.events)).toContain("B clean response");

		b.unsubscribe();
		await backendA.stop();
		await backendB.stop();
	});

	test("a throwing event consumer does not break the session pipeline", async () => {
		const fauxA = registerFaux(runtime.runtime, "faux-consumer-a");
		fauxA.setResponses([fauxAssistantMessage("still delivered")]);

		const backendA = createBackend(runtime);
		activeBackends.push(backendA);
		await backendA.start({ workspacePath: process.cwd(), model: modelOf(fauxA) });

		const delivered: string[] = [];
		const throwing = backendA.subscribe(() => {
			throw new Error("consumer exploded");
		});
		const observer = backendA.subscribe((event) => {
			if (event.type === "message_delta" && event.kind === "text" && event.delta) {
				delivered.push(event.delta);
			}
		});

		await backendA.sendMessage({ role: "user", content: "hello" });
		await waitFor(() => !backendA.isStreaming);
		expect(delivered.join("")).toContain("still delivered");

		throwing();
		observer();
		await backendA.stop();
	});

	test("interactions route through the backend that owns the extension", async () => {
		class InteractionProbeBackend extends SdkSessionBackend {
			exposeUiContext() {
				return this.createUiContext();
			}
		}

		const backendA = new InteractionProbeBackend({
			modelRuntime: runtime.runtime,
			agentDir: runtime.agentDir,
			resolveSessionDirectory: () => undefined,
			sessionManager: SessionManager.inMemory(process.cwd()),
			settingsManager: SettingsManager.inMemory(),
		});
		const backendB = createBackend(runtime);
		activeBackends.push(backendA, backendB);
		await backendA.start({ workspacePath: process.cwd() });
		await backendB.start({ workspacePath: process.cwd() });

		const aEvents = collectEvents(backendA);
		const bEvents = collectEvents(backendB);

		const uiContext = backendA.exposeUiContext();
		const confirmation = uiContext.confirm("Proceed?", "yes or no");
		await waitFor(() => aEvents.events.some((event) => event.type === "interaction_requested"));

		const request = aEvents.events.find(
			(event): event is Extract<AgentEvent, { type: "interaction_requested" }> =>
				event.type === "interaction_requested" && event.request.kind === "confirm",
		);
		expect(request).toBeDefined();
		expect(bEvents.events.some((event) => event.type === "interaction_requested")).toBe(false);

		await backendA.respondToInteraction(request!.request.id, { kind: "confirmed", confirmed: true });
		await expect(confirmation).resolves.toBe(true);

		aEvents.unsubscribe();
		bEvents.unsubscribe();
		await backendA.stop();
		await backendB.stop();
	});

	test("editableUserMessages reports the leaf path with timestamps matching getMessages", async () => {
		const faux = registerFaux(runtime.runtime, "faux-editable");
		faux.setResponses([fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two")]);

		const backend = createBackend(runtime);
		activeBackends.push(backend);
		await backend.start({ workspacePath: process.cwd(), model: modelOf(faux) });
		const collector = collectEvents(backend);

		await backend.sendMessage({ role: "user", content: "first question" });
		await waitFor(() => collector.events.filter((event) => event.type === "agent_stopped").length >= 1);
		await backend.sendMessage({ role: "user", content: "second question" });
		await waitFor(() => collector.events.filter((event) => event.type === "agent_stopped").length >= 2);

		const editable = backend.editableUserMessages();
		expect(editable.map((entry) => entry.text)).toEqual(["first question", "second question"]);
		expect(editable.every((entry) => entry.entryId.length > 0)).toBe(true);
		// Timestamps are the embedded message's, so the renderer can align
		// entry ids to rendered messages exactly.
		const userTimestamps = (await backend.getMessages())
			.filter((message) => message.role === "user")
			.map((message) => message.timestamp);
		expect(editable.map((entry) => entry.timestamp)).toEqual(userTimestamps);

		collector.unsubscribe();
		await backend.stop();
	});

	test("editAndResend branches before the edited message and resends in place", async () => {
		const faux = registerFaux(runtime.runtime, "faux-edit-resend");
		faux.setResponses([
			fauxAssistantMessage("answer one"),
			fauxAssistantMessage("answer two"),
			fauxAssistantMessage("answer three"),
		]);

		const backend = createBackend(runtime);
		activeBackends.push(backend);
		await backend.start({ workspacePath: process.cwd(), model: modelOf(faux) });
		const collector = collectEvents(backend);

		await backend.sendMessage({ role: "user", content: "first question" });
		await waitFor(() => collector.events.filter((event) => event.type === "agent_stopped").length >= 1);
		await backend.sendMessage({ role: "user", content: "second question" });
		await waitFor(() => collector.events.filter((event) => event.type === "agent_stopped").length >= 2);

		// Edit the second question in place: the tree branches before it, the
		// edited text is resent, and the old "answer two" leaves the leaf path.
		const editable = backend.editableUserMessages();
		const result = await backend.editAndResend(editable[1].entryId, "second question (edited)");
		expect(result).toEqual({ status: "sent" });
		await waitFor(() => collector.events.filter((event) => event.type === "agent_stopped").length >= 3);

		const messages = await backend.getMessages();
		const plainText = (message: AgentMessage): string =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("");
		expect(messages.filter((message) => message.role === "user").map(plainText)).toEqual([
			"first question",
			"second question (edited)",
		]);
		expect(messages.filter((message) => message.role === "assistant").map(plainText)).toEqual([
			"answer one",
			"answer three",
		]);

		collector.unsubscribe();
		await backend.stop();
	});

	test("editAndResend rejects unknown entries and while streaming", async () => {
		const faux = registerFaux(runtime.runtime, "faux-edit-guard", 10);
		faux.setResponses([fauxAssistantMessage("long answer ".repeat(200))]);

		const backend = createBackend(runtime);
		activeBackends.push(backend);
		await backend.start({ workspacePath: process.cwd(), model: modelOf(faux) });

		await expect(backend.editAndResend("missing", "text")).rejects.toThrow("Entry missing not found");

		await backend.sendMessage({ role: "user", content: "start" });
		await waitFor(() => backend.isStreaming);
		await expect(backend.editAndResend("whatever", "text")).rejects.toThrow(
			"Wait for the current response to finish before editing a message",
		);
		await backend.abort();
		await waitFor(() => !backend.isStreaming);
		await backend.stop();
	});
});
