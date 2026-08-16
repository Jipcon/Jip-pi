import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/renderer/App.tsx";
import { store } from "../src/renderer/state/hooks.ts";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test("shows grouped historical projects on startup instead of the full workspace picker", async () => {
	vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([
		{
			id: "official-gui",
			name: "Official GUI",
			workspacePath: "D:\\pi",
			updatedAt: Date.parse("2026-08-08T02:00:00.000Z"),
			messageCount: 104,
		},
		{
			id: "dict-session",
			name: "Dictionary work",
			workspacePath: "D:\\Dict_app",
			updatedAt: Date.parse("2026-08-07T02:00:00.000Z"),
			messageCount: 2,
		},
	]);
	store.dispatch({ type: "status", status: { phase: "no-workspace", workspace: null } });
	store.dispatch({ type: "sessions", sessions: [] });

	render(<App />);

	await waitFor(() => expect(screen.getByText("Official GUI")).toBeTruthy());
	expect(screen.queryByTestId("workspace-picker")).toBeNull();
	expect(screen.getByTestId("session-home")).toBeTruthy();
	expect(screen.getByRole("heading", { name: "pi" })).toBeTruthy();
	expect(screen.getByRole("heading", { name: "Dict_app" })).toBeTruthy();
});

test("clicking a startup catalog session activates its workspace and shows the chat", async () => {
	// Regression: opening a session from the startup catalog used to leave the
	// workspace status at no-workspace, so the chat stayed hidden until a new
	// workspace was added manually.
	vi.mocked(window.agent.listSessionCatalog).mockResolvedValue([
		{ id: "history-session", name: "History", workspacePath: "D:\\pi", messageCount: 3 },
	]);
	vi.mocked(window.agent.listWorkspaces).mockResolvedValue(["D:\\pi"]);
	vi.mocked(window.agent.start).mockResolvedValue();
	vi.mocked(window.agent.openSession).mockResolvedValue({
		state: {
			model: null,
			isStreaming: false,
			isCompacting: false,
			sessionId: "history-session",
			messageCount: 1,
		},
		messages: [{ role: "user", content: "previous message" }],
		usage: null,
	});
	vi.mocked(window.agent.listThinkingLevels).mockResolvedValue([]);
	store.dispatch({ type: "status", status: { phase: "no-workspace", workspace: null } });
	store.dispatch({ type: "sessions", sessions: [] });

	render(<App />);
	await waitFor(() => expect(screen.getByText("History")).toBeTruthy());
	expect(screen.getByTestId("session-home")).toBeTruthy();

	fireEvent.click(screen.getAllByTestId("session-item")[0]);

	await waitFor(() => expect(window.agent.start).toHaveBeenCalledWith("D:\\pi"));
	await waitFor(() => expect(screen.queryByTestId("session-home")).toBeNull());
	expect(screen.getByTestId("chat")).toBeTruthy();
});
