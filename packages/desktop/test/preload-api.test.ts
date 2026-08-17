/**
 * Preload boundary tests: the renderer-facing API must be exactly the
 * constrained surface — no raw IPC, no sendRaw, no extra channels.
 */

import { describe, expect, test, vi } from "vitest";

const { exposed, listeners, invoked } = vi.hoisted(() => {
	const exposed: Record<string, unknown> = {};
	const listeners = new Map<string, Array<(event: unknown, payload: unknown) => void>>();
	const invoked: Array<{ channel: string; args: unknown[] }> = [];
	return { exposed, listeners, invoked };
});

vi.mock("electron", () => ({
	contextBridge: {
		exposeInMainWorld: (key: string, value: unknown) => {
			exposed[key] = value;
		},
	},
	ipcRenderer: {
		invoke: (channel: string, ...args: unknown[]) => {
			invoked.push({ channel, args });
			return Promise.resolve({ ok: true });
		},
		on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(listener);
			listeners.set(channel, list);
		},
		removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
			const list = listeners.get(channel) ?? [];
			listeners.set(
				channel,
				list.filter((entry) => entry !== listener),
			);
		},
	},
}));

// Importing the preload runs exposeInMainWorld at module scope.
import "../src/preload/preload.ts";

const api = exposed.agent as Record<string, unknown>;

function emit(channel: string, payload: unknown): void {
	for (const listener of listeners.get(channel) ?? []) {
		listener({}, payload);
	}
}

describe("preload API surface", () => {
	test("exposes exactly the constrained agent API", () => {
		const methods = [
			"pickWorkspace",
			"getWorkspace",
			"listWorkspaces",
			"removeWorkspace",
			"start",
			"openSession",
			"sendMessage",
			"abort",
			"createSession",
			"renameSession",
			"deleteSession",
			"listSessions",
			"listSessionCatalog",
			"renameCatalogSession",
			"deleteCatalogSession",
			"getState",
			"getStatus",
			"getMessages",
			"getSessionUsage",
			"listModels",
			"reloadModels",
			"listCustomProviders",
			"saveCustomProvider",
			"deleteCustomProvider",
			"setModel",
			"listThinkingLevels",
			"setThinkingLevel",
			"listProviderAuthStatus",
			"setApiKey",
			"removeCredential",
			"loginWithOAuth",
			"cancelOAuthLogin",
			"respondToAuthPrompt",
			"respondInteraction",
			"getSessionStorage",
			"setSessionStorage",
			"pickSessionStorageRoot",
			"subscribe",
			"onHostEvent",
			"onStatus",
			"onLog",
		];
		expect(Object.keys(api).sort()).toEqual(methods.sort());
	});

	test("does not expose raw RPC or ipcRenderer", () => {
		expect(api.sendRaw).toBeUndefined();
		expect(api.ipcRenderer).toBeUndefined();
		expect(api.require).toBeUndefined();
		expect(api.child_process).toBeUndefined();
	});

	test("invokes the workspace pick channel", async () => {
		await (api.pickWorkspace as () => Promise<unknown>)();
		expect(invoked.at(-1)?.channel).toBe("workspace:pick");
		await (api.listWorkspaces as () => Promise<unknown>)();
		expect(invoked.at(-1)?.channel).toBe("workspace:list");
		await (api.removeWorkspace as (workspace: string) => Promise<unknown>)("D:\\old-project");
		expect(invoked.at(-1)).toEqual({ channel: "workspace:remove", args: ["D:\\old-project"] });
	});

	test("invokes agent commands with payloads", async () => {
		const message = { role: "user", content: "hello" };
		await (api.sendMessage as (w: string, s: string, m: unknown) => Promise<unknown>)(
			"D:\\work",
			"session-1",
			message,
		);
		expect(invoked.at(-1)).toEqual({ channel: "agent:sendMessage", args: ["D:\\work", "session-1", message] });
		await (api.getSessionUsage as (w: string, s: string) => Promise<unknown>)("D:\\work", "session-1");
		expect(invoked.at(-1)).toEqual({ channel: "agent:getSessionUsage", args: ["D:\\work", "session-1"] });
		await (api.getStatus as () => Promise<unknown>)();
		expect(invoked.at(-1)).toEqual({ channel: "agent:getStatus", args: [] });
		await (api.setModel as (w: string, s: string, m: unknown) => Promise<unknown>)("D:\\work", "session-1", {
			provider: "p",
			modelId: "m",
		});
		expect(invoked.at(-1)).toEqual({
			channel: "agent:setModel",
			args: ["D:\\work", "session-1", { provider: "p", modelId: "m" }],
		});
		await (api.setThinkingLevel as (w: string, s: string, l: string) => Promise<unknown>)(
			"D:\\work",
			"session-1",
			"high",
		);
		expect(invoked.at(-1)).toEqual({
			channel: "agent:setThinkingLevel",
			args: ["D:\\work", "session-1", "high"],
		});
		await (api.deleteSession as (w: string, s: string) => Promise<unknown>)("D:\\work", "old-session");
		expect(invoked.at(-1)).toEqual({ channel: "agent:deleteSession", args: ["D:\\work", "old-session"] });
		await (api.listSessions as (w: string) => Promise<unknown>)("D:\\work");
		expect(invoked.at(-1)).toEqual({ channel: "agent:listSessions", args: ["D:\\work"] });
		await (api.renameSession as (w: string, s: string, n: string) => Promise<unknown>)(
			"D:\\work",
			"old-session",
			"Renamed",
		);
		expect(invoked.at(-1)).toEqual({
			channel: "agent:renameSession",
			args: ["D:\\work", "old-session", "Renamed"],
		});
		await (api.openSession as (w: string, s: string) => Promise<unknown>)("D:\\work", "old-session");
		expect(invoked.at(-1)).toEqual({ channel: "agent:openSession", args: ["D:\\work", "old-session"] });
		await (api.renameCatalogSession as (sessionId: string, name: string) => Promise<unknown>)(
			"other-session",
			"Other renamed",
		);
		expect(invoked.at(-1)).toEqual({
			channel: "sessionCatalog:rename",
			args: ["other-session", "Other renamed"],
		});
		await (api.deleteCatalogSession as (sessionId: string) => Promise<unknown>)("other-session");
		expect(invoked.at(-1)).toEqual({ channel: "sessionCatalog:delete", args: ["other-session"] });
		await (api.setSessionStorage as (config: unknown) => Promise<unknown>)({ mode: "workspace" });
		expect(invoked.at(-1)).toEqual({ channel: "sessionStorage:set", args: [{ mode: "workspace" }] });
		await (api.listProviderAuthStatus as () => Promise<unknown>)();
		expect(invoked.at(-1)).toEqual({ channel: "auth:listStatus", args: [] });
		await (api.setApiKey as (provider: string, key: string) => Promise<unknown>)("opencode-go", "sk-test");
		expect(invoked.at(-1)).toEqual({ channel: "auth:setApiKey", args: ["opencode-go", "sk-test"] });
		await (api.removeCredential as (provider: string) => Promise<unknown>)("opencode-go");
		expect(invoked.at(-1)).toEqual({ channel: "auth:removeCredential", args: ["opencode-go"] });
		await (api.reloadModels as () => Promise<unknown>)();
		expect(invoked.at(-1)).toEqual({ channel: "models:reload", args: [] });
		await (api.listCustomProviders as () => Promise<unknown>)();
		expect(invoked.at(-1)).toEqual({ channel: "customProviders:list", args: [] });
		const customConfig = { id: "my-local", baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] };
		await (api.saveCustomProvider as (config: unknown) => Promise<unknown>)(customConfig);
		expect(invoked.at(-1)).toEqual({ channel: "customProviders:save", args: [customConfig] });
		await (api.deleteCustomProvider as (providerId: string) => Promise<unknown>)("my-local");
		expect(invoked.at(-1)).toEqual({ channel: "customProviders:delete", args: ["my-local"] });
	});

	test("subscribe forwards agent events and unsubscribes cleanly", () => {
		const received: unknown[] = [];
		const unsubscribe = (api.subscribe as (cb: (event: unknown) => void) => () => void)((event) =>
			received.push(event),
		);
		emit("agent:event", { type: "agent_started" });
		expect(received).toEqual([{ type: "agent_started" }]);
		unsubscribe();
		emit("agent:event", { type: "agent_stopped" });
		expect(received).toHaveLength(1);
	});

	test("status and log subscriptions map to their channels", () => {
		const statuses: unknown[] = [];
		const logs: unknown[] = [];
		(api.onStatus as (cb: (s: unknown) => void) => () => void)((s) => statuses.push(s));
		(api.onLog as (cb: (l: unknown) => void) => () => void)((l) => logs.push(l));
		emit("agent:status", { phase: "running" });
		emit("agent:log", "diag");
		expect(statuses).toEqual([{ phase: "running" }]);
		expect(logs).toEqual(["diag"]);
	});
});
