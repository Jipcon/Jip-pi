/**
 * Test setup: installs a mock for the constrained `window.agent` API and
 * polyfills browser APIs jsdom does not implement.
 */

import { vi } from "vitest";
import type { AgentApi } from "../src/preload/preload.ts";
import type { SessionStorageConfig } from "../src/shared/ipc.ts";

// jsdom has no layout, so scrollIntoView is unimplemented.
if (typeof Element.prototype.scrollIntoView !== "function") {
	Element.prototype.scrollIntoView = () => {};
}

const mockAgent: AgentApi = {
	pickWorkspace: vi.fn(async () => null),
	getWorkspace: vi.fn(async () => null),
	getStatus: vi.fn(async () => ({ phase: "no-workspace" as const, workspace: null })),

	listWorkspaces: vi.fn(async () => []),
	removeWorkspace: vi.fn(async () => []),
	start: vi.fn(async () => {}),
	openSession: vi.fn(async () => ({
		state: {
			model: null,
			isStreaming: false,
			isCompacting: false,
			sessionId: "mock-session",
			messageCount: 0,
		},
		messages: [],
		usage: null,
	})),
	sendMessage: vi.fn(async () => {}),
	abort: vi.fn(async () => {}),
	createSession: vi.fn(async () => ({ id: "mock-session" })),
	renameSession: vi.fn(async () => {}),
	deleteSession: vi.fn(async () => {}),
	listSessions: vi.fn(async () => []),
	listSessionCatalog: vi.fn(async () => []),
	renameCatalogSession: vi.fn(async () => []),
	deleteCatalogSession: vi.fn(async () => []),
	getState: vi.fn(async () => ({
		model: null,
		isStreaming: false,
		isCompacting: false,
		sessionId: "mock-session",
		messageCount: 0,
	})),
	getMessages: vi.fn(async () => []),
	getSessionUsage: vi.fn(async () => ({
		sessionId: "mock-session",
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		contextUsage: { tokens: 0, contextWindow: 128_000, percent: 0 },
	})),
	listModels: vi.fn(async () => []),
	reloadModels: vi.fn(async () => {}),
	listCustomProviders: vi.fn(async () => []),
	saveCustomProvider: vi.fn(async () => {}),
	deleteCustomProvider: vi.fn(async () => {}),
	fetchCustomProviderModels: vi.fn(async () => []),
	matchCustomProviderModels: vi.fn(async () => []),
	setModel: vi.fn(async () => null),
	listThinkingLevels: vi.fn(async () => ["off", "medium", "high"]),
	setThinkingLevel: vi.fn(async () => {}),
	listEditableUserMessages: vi.fn(async () => []),
	editUserMessage: vi.fn(async (_workspaceId: string, _sessionId: string, _entryId: string, _text: string) => ({
		status: "cancelled" as const,
	})),
	listProviderAuthStatus: vi.fn(async () => []),
	setApiKey: vi.fn(async () => {}),
	removeCredential: vi.fn(async () => {}),
	loginWithOAuth: vi.fn(async () => {}),
	cancelOAuthLogin: vi.fn(async () => {}),
	respondToAuthPrompt: vi.fn(async () => {}),
	respondInteraction: vi.fn(async () => {}),
	getSessionStorage: vi.fn(async (): Promise<SessionStorageConfig> => ({ mode: "default" })),
	setSessionStorage: vi.fn(async (config) => config),
	pickSessionStorageRoot: vi.fn(async () => null),
	subscribe: vi.fn(() => () => {}),
	onHostEvent: vi.fn(() => () => {}),
	onStatus: vi.fn(() => () => {}),
	onLog: vi.fn(() => () => {}),
};

export function resetMockAgent(): void {
	vi.mocked(mockAgent.pickWorkspace).mockClear().mockResolvedValue(null);
	vi.mocked(mockAgent.getWorkspace).mockClear().mockResolvedValue(null);
	vi.mocked(mockAgent.getStatus)
		.mockClear()
		.mockResolvedValue({ phase: "no-workspace" as const, workspace: null });
	vi.mocked(mockAgent.listWorkspaces).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.removeWorkspace).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.start).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.openSession)
		.mockClear()
		.mockResolvedValue({
			state: {
				model: null,
				isStreaming: false,
				isCompacting: false,
				sessionId: "mock-session",
				messageCount: 0,
			},
			messages: [],
			usage: null,
		});
	vi.mocked(mockAgent.sendMessage).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.abort).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.createSession).mockClear().mockResolvedValue({ id: "mock-session" });
	vi.mocked(mockAgent.renameSession).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.deleteSession).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.listSessions).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.listSessionCatalog).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.renameCatalogSession).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.deleteCatalogSession).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.getState).mockClear().mockResolvedValue({
		model: null,
		isStreaming: false,
		isCompacting: false,
		sessionId: "mock-session",
		messageCount: 0,
	});
	vi.mocked(mockAgent.getMessages).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.getSessionUsage)
		.mockClear()
		.mockResolvedValue({
			sessionId: "mock-session",
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			contextUsage: { tokens: 0, contextWindow: 128_000, percent: 0 },
		});
	vi.mocked(mockAgent.listModels).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.reloadModels).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.listCustomProviders).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.saveCustomProvider).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.deleteCustomProvider).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.fetchCustomProviderModels).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.matchCustomProviderModels).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.setModel).mockClear().mockResolvedValue(null);
	vi.mocked(mockAgent.listThinkingLevels).mockClear().mockResolvedValue(["off", "medium", "high"]);
	vi.mocked(mockAgent.setThinkingLevel).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.listEditableUserMessages).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.editUserMessage)
		.mockClear()
		.mockImplementation(async (_workspaceId: string, _sessionId: string, _entryId: string, _text: string) => ({
			status: "cancelled" as const,
		}));
	vi.mocked(mockAgent.listProviderAuthStatus).mockClear().mockResolvedValue([]);
	vi.mocked(mockAgent.setApiKey).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.removeCredential).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.loginWithOAuth).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.cancelOAuthLogin).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.respondToAuthPrompt).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.respondInteraction).mockClear().mockResolvedValue();
	vi.mocked(mockAgent.getSessionStorage).mockClear().mockResolvedValue({ mode: "default" });
	vi.mocked(mockAgent.setSessionStorage)
		.mockClear()
		.mockImplementation(async (config) => config);
	vi.mocked(mockAgent.pickSessionStorageRoot).mockClear().mockResolvedValue(null);
}

Object.defineProperty(window, "agent", {
	value: mockAgent,
	writable: true,
	configurable: true,
});
