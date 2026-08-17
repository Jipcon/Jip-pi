import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as hooks from "../src/renderer/state/hooks.ts";
import type { UiMessage } from "../src/renderer/state/store.ts";

import { Composer } from "../src/renderer/components/Composer.tsx";
import { MarkdownContent } from "../src/renderer/components/MarkdownContent.tsx";
import { ChatView } from "../src/renderer/components/ChatView.tsx";
import { GenericToolRenderer } from "../src/renderer/components/GenericToolRenderer.tsx";
import { MessageItem } from "../src/renderer/components/MessageItem.tsx";
import { CustomProviderDialog } from "../src/renderer/components/settings/CustomProviderDialog.tsx";
import { CustomProvidersSection } from "../src/renderer/components/settings/CustomProvidersSection.tsx";
import { SettingsPanel } from "../src/renderer/components/SettingsPanel.tsx";
import { Sidebar, MAX_SESSION_TITLE_LENGTH, truncateSessionTitle } from "../src/renderer/components/Sidebar.tsx";
import { TopBar } from "../src/renderer/components/TopBar.tsx";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("MarkdownContent code blocks", () => {
	test("code block copy button copies the code text", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		render(<MarkdownContent text={"```ts\nconst a = 1;\n```"} />);
		fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("const a = 1;\n"));
		expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
	});

	test("inline code has no copy button", () => {
		render(<MarkdownContent text={"use `npm run check` here"} />);
		expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
	});
});

describe("GenericToolRenderer", () => {
	test("renders an unknown tool without breaking", () => {
		render(
			<GenericToolRenderer
				tool={{ id: "t1", name: "mystery_tool", args: { optionA: 1, optionB: "x" }, status: "completed", result: "done" }}
			/>,
		);
		expect(screen.getByTestId("tool-name").textContent).toBe("mystery_tool");
		expect(screen.getByTestId("tool-status").textContent).toBe("Completed");
		expect(screen.getByText(/"optionA"/)).toBeTruthy();
		expect(screen.getByText("done")).toBeTruthy();
	});

	test("renders bash with command and streaming output", () => {
		render(
			<GenericToolRenderer
				tool={{ id: "t2", name: "bash", args: { command: "ls -la" }, status: "running", partialResult: "total 48\n" }}
			/>,
		);
		expect(screen.getByTestId("tool-command").textContent).toBe("ls -la");
		expect(screen.getByTestId("tool-partial").textContent).toBe("total 48\n");
		expect(screen.getByTestId("tool-status").textContent).toBe("Running...");
	});

	test("shows error state", () => {
		render(
			<GenericToolRenderer
				tool={{ id: "t3", name: "read", args: { path: "x.ts" }, status: "error", result: "ENOENT", isError: true }}
			/>,
		);
		expect(screen.getByTestId("tool-status").textContent).toBe("Error");
	});
});

describe("MessageItem", () => {
	test("shows compact tool status and hides output by default", () => {
		const { container } = render(
			<MessageItem
				message={{
					id: "m1",
					role: "assistant",
					blocks: [{ type: "toolCall", id: "c1", name: "edit", arguments: { file: "a.ts" } }],
					complete: true,
				}}
				tools={{
					c1: { id: "c1", name: "edit", args: { file: "a.ts" }, status: "completed", result: "ok" },
				}}
			/>,
		);
		expect(screen.getByTestId("tool-activity").textContent).toContain("edit");
		expect(screen.getByTestId("tool-activity").textContent).toContain("completed");
		expect(container.querySelector(".tool-card")).toBeNull();
		expect(screen.queryByText("ok")).toBeNull();
	});

	test("shows full tool details when enabled", () => {
		render(
			<MessageItem
				message={{
					id: "m1",
					role: "assistant",
					blocks: [{ type: "toolCall", id: "c1", name: "edit", arguments: { file: "a.ts" } }],
					complete: true,
				}}
				tools={{
					c1: { id: "c1", name: "edit", args: { file: "a.ts" }, status: "completed", result: "ok" },
				}}
				showToolDetails
			/>,
		);
		expect(screen.getByTestId("tool-card")).toBeTruthy();
		expect(screen.getByTestId("tool-name").textContent).toBe("edit");
		expect(screen.getByText("ok")).toBeTruthy();
	});

	test("hides thinking by default and reveals it when enabled", () => {
		const message = {
			id: "m-thinking",
			role: "assistant" as const,
			blocks: [
				{ type: "thinking" as const, thinking: "private reasoning" },
				{ type: "text" as const, text: "final answer" },
			],
			complete: true,
		};
		const { rerender } = render(<MessageItem message={message} tools={{}} />);
		expect(screen.queryByText("Thinking")).toBeNull();
		expect(screen.queryByText("private reasoning")).toBeNull();
		expect(screen.getByText("final answer")).toBeTruthy();

		rerender(<MessageItem message={message} tools={{}} showThinking />);
		fireEvent.click(screen.getByText("Thinking"));
		expect(screen.getByText("private reasoning")).toBeTruthy();
	});

	test("renders assistant Markdown and GFM without raw HTML", () => {
		const { container } = render(
			<MessageItem
				message={{
					id: "m-markdown",
					role: "assistant",
					blocks: [
						{
							type: "text",
							text: [
								"# Result",
								"",
								"**bold** and [docs](https://example.com)",
								"",
								"| Name | Value |",
								"| --- | --- |",
								"| alpha | 1 |",
								"",
								"- [x] complete",
								"",
								"```ts",
								"const answer = 42;",
								"```",
								"",
								"<script>alert('unsafe')</script>",
							].join("\n"),
						},
					],
					complete: true,
				}}
				tools={{}}
			/>,
		);

		expect(screen.getByRole("heading", { level: 1, name: "Result" })).toBeTruthy();
		expect(container.querySelector("strong")?.textContent).toBe("bold");
		const link = screen.getByRole("link", { name: "docs" });
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noreferrer noopener");
		expect(container.querySelector("table")).toBeTruthy();
		expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
		const code = container.querySelector("pre code");
		expect(code?.textContent).toBe("const answer = 42;\n");
		expect(code?.classList.contains("hljs")).toBe(true);
		expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");
		expect(code?.querySelector(".hljs-number")?.textContent).toBe("42");
		expect(container.querySelector("script")).toBeNull();
	});

	test("renders inline and display LaTeX across supported delimiters", () => {
		const { container } = render(
			<MessageItem
				message={{
					id: "m-math",
					role: "assistant",
					blocks: [
						{
							type: "text",
							text: String.raw`Inline $E=mc^2$ and \(a^2+b^2=c^2\).

$$\frac{1}{2}$$

\[
\int_0^1 x\,dx
\]`,
						},
					],
					complete: true,
				}}
				tools={{}}
			/>,
		);

		expect(container.querySelectorAll(".katex")).toHaveLength(4);
		expect(container.querySelectorAll(".katex-display")).toHaveLength(2);
	});

	test("preserves currency, shell variables, code math, and incomplete streaming math", () => {
		const message = {
			id: "m-streaming-math",
			role: "assistant" as const,
			blocks: [
				{
					type: "text" as const,
					text: "Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and ${PATH}. Streaming \\(x^2",
				},
			],
			complete: false,
		};
		const { container, rerender } = render(<MessageItem message={message} tools={{}} />);

		expect(container.querySelector(".katex")).toBeNull();
		expect(container.textContent).toContain("Costs $5 and $10 or $8k–$12k");
		expect(container.textContent).toContain("$HOME");
		expect(container.textContent).toContain("Streaming \\(x^2");

		rerender(
			<MessageItem
				message={{
					...message,
					blocks: [{ type: "text", text: String.raw`Streaming \(x^2\)` }],
					complete: true,
				}}
				tools={{}}
			/>,
		);
		expect(container.querySelectorAll(".katex")).toHaveLength(1);
	});

	test("renders image blocks in user history", () => {
		render(
			<MessageItem
				message={{
					id: "m-image",
					role: "user",
					blocks: [
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "sample.png" },
						{ type: "text", text: "Inspect this" },
					],
					complete: true,
				}}
				tools={{}}
			/>,
		);
		expect(screen.getByAltText("sample.png").getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
		expect(screen.getByText("Inspect this")).toBeTruthy();
	});
});

describe("TopBar", () => {
	test("keeps runtime selectors visible and wires model and thinking changes", () => {
		const setModel = vi.spyOn(hooks, "setModel").mockResolvedValue();
		const setThinkingLevel = vi.spyOn(hooks, "setThinkingLevel").mockResolvedValue();
		const baseProps = {
			workspaceId: "D:\\pi",
			sessionId: "session-1",
			phase: "running" as const,
			onOpenSettings: vi.fn(),
		};
		const { rerender } = render(
			<TopBar {...baseProps} models={[]} currentModel={null} thinkingLevels={[]} thinkingLevel={undefined} />,
		);
		expect(screen.queryByTestId("status-pill")).toBeNull();
		expect((screen.getByTestId("model-select") as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId("thinking-select") as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId("provider-select") as HTMLButtonElement).disabled).toBe(true);

		rerender(
			<TopBar
				{...baseProps}
				models={[
					{ id: "m1", name: "Model One", provider: "provider", reasoning: true },
					{ id: "m2", name: "Model Two", provider: "provider", reasoning: true },
				]}
				currentModel={{ id: "m1", name: "Model One", provider: "provider", reasoning: true }}
				thinkingLevels={["off", "high"]}
				thinkingLevel="off"
			/>,
		);
		fireEvent.click(screen.getByTestId("model-select"));
		fireEvent.click(screen.getByTestId("model-select-option-provider/m2"));
		fireEvent.click(screen.getByTestId("thinking-select"));
		fireEvent.click(screen.getByTestId("thinking-select-option-high"));
		expect(setModel).toHaveBeenCalledWith("D:\\pi", "session-1", { provider: "provider", modelId: "m2" });
		expect(setThinkingLevel).toHaveBeenCalledWith("D:\\pi", "session-1", "high");
	});

	test("splits providers from models; Go and Zen never share one list", () => {
		const setModel = vi.spyOn(hooks, "setModel").mockResolvedValue();
		const goModel = { id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", reasoning: true };
		const zenModel = { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "opencode", reasoning: true };
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[goModel, zenModel]}
				currentModel={goModel}
				thinkingLevels={["off"]}
				thinkingLevel="off"
				onOpenSettings={vi.fn()}
			/>,
		);
		// Provider trigger shows the current provider; the panel labels the
		// subscription vs balance distinction.
		expect(screen.getByTestId("provider-select").textContent).toContain("OpenCode Go · subscription");
		fireEvent.click(screen.getByTestId("provider-select"));
		expect(screen.getByText("OpenCode Zen · balance")).toBeTruthy();
		expect(screen.getByText("Pay-per-use Zen models billed to your account balance")).toBeTruthy();
		fireEvent.keyDown(screen.getByTestId("provider-select"), { key: "Escape" });
		// Model list only contains the current provider's models.
		expect(screen.getByTestId("model-select").textContent).toContain("Kimi K3");
		fireEvent.click(screen.getByTestId("model-select"));
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.getByTestId("model-select-option-opencode-go/kimi-k3")).toBeTruthy();
		expect(setModel).not.toHaveBeenCalled();
	});

	test("switching to OpenCode Zen switches directly without confirmation", async () => {
		const setModel = vi.spyOn(hooks, "setModel").mockResolvedValue();
		const goModel = { id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", reasoning: true };
		const zenModel = { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "opencode", reasoning: true };
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[goModel, zenModel]}
				currentModel={goModel}
				thinkingLevels={["off"]}
				thinkingLevel="off"
				onOpenSettings={vi.fn()}
			/>,
		);

		// Picking Zen switches to the Zen provider's first model immediately.
		fireEvent.click(screen.getByTestId("provider-select"));
		fireEvent.click(screen.getByTestId("provider-select-option-opencode"));
		await waitFor(() =>
			expect(setModel).toHaveBeenCalledWith("D:\\pi", "session-1", { provider: "opencode", modelId: "claude-sonnet-4" }),
		);
		expect(screen.queryByTestId("zen-confirm")).toBeNull();
	});

	test("shows the pending provider's first model instead of the placeholder during a provider switch", async () => {
		// setModel never settles: the trigger must keep showing the user's pick
		// for the whole in-flight window instead of "Select a model".
		vi.spyOn(hooks, "setModel").mockReturnValue(new Promise(() => {}));
		const goModel = { id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", reasoning: true };
		const zenModel = { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "opencode", reasoning: true };
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[goModel, zenModel]}
				currentModel={goModel}
				thinkingLevels={["off"]}
				thinkingLevel="off"
				onOpenSettings={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByTestId("provider-select"));
		fireEvent.click(screen.getByTestId("provider-select-option-opencode"));
		await waitFor(() => expect(screen.getByTestId("model-select").textContent).toContain("Claude Sonnet 4"));
		expect(screen.getByTestId("model-select").textContent).not.toContain("Select a model");
	});

	test("failed model switch rolls back the selection and shows an error", async () => {
		const notify = vi.spyOn(hooks.store, "dispatch");
		vi.spyOn(hooks, "setModel").mockRejectedValue(new Error("set_model rejected"));
		const goModel = { id: "kimi-k3", name: "Kimi K3", provider: "opencode-go", reasoning: true };
		const goModel2 = { id: "grok-4.5", name: "Grok 4.5", provider: "opencode-go", reasoning: true };
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[goModel, goModel2]}
				currentModel={goModel}
				thinkingLevels={["off"]}
				thinkingLevel="off"
				onOpenSettings={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("model-select"));
		fireEvent.click(screen.getByTestId("model-select-option-opencode-go/grok-4.5"));
		await waitFor(() =>
			expect(notify).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "notify",
					notification: expect.objectContaining({ message: "Failed to switch model: set_model rejected" }),
				}),
			),
		);
		// The trigger still reflects the store's current model (rollback).
		expect(screen.getByTestId("model-select").textContent).toContain("Kimi K3");
	});

	test("thinking panel shows the full level matrix with unsupported levels disabled", () => {
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[{ id: "m1", name: "Model One", provider: "provider", reasoning: true }]}
				currentModel={{ id: "m1", name: "Model One", provider: "provider", reasoning: true }}
				thinkingLevels={["off", "low", "high"]}
				thinkingLevel="high"
				onOpenSettings={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("thinking-select"));
		// All seven canonical levels render, even the unsupported ones.
		expect(screen.getAllByRole("option")).toHaveLength(7);
		const max = screen.getByTestId("thinking-select-option-max") as HTMLButtonElement;
		expect(max.disabled).toBe(true);
		expect(max.title).toBe("This model supports up to high");
		expect((screen.getByTestId("thinking-select-option-high") as HTMLButtonElement).disabled).toBe(false);
	});

	test("model options format context windows with k and M suffixes", () => {
		const million = { id: "m1", name: "Model One", provider: "provider", contextWindow: 1_000_000 };
		const hundredK = { id: "m2", name: "Model Two", provider: "provider", contextWindow: 128_000 };
		render(
			<TopBar
				workspaceId="D:\pi"
				sessionId="session-1"
				phase="running"
				models={[million, hundredK]}
				currentModel={million}
				thinkingLevels={["off"]}
				thinkingLevel="off"
				onOpenSettings={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("model-select"));
		expect(screen.getByText("1M")).toBeTruthy();
		expect(screen.getByText("128k")).toBeTruthy();
	});
});

describe("SettingsPanel", () => {
	test("updates conversation display preferences", () => {
		const onShowThinkingChange = vi.fn();
		const onShowToolDetailsChange = vi.fn();
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				onShowThinkingChange={onShowThinkingChange}
				onShowToolDetailsChange={onShowToolDetailsChange}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);
		const toggles = screen.getAllByRole("checkbox");
		fireEvent.click(toggles[0]);
		fireEvent.click(toggles[1]);
		expect(onShowThinkingChange).toHaveBeenCalledWith(true);
		expect(onShowToolDetailsChange).toHaveBeenCalledWith(true);
		expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
		expect(screen.queryByTestId("app-theme-select")).toBeNull();
		expect(screen.queryByTestId("code-theme-select")).toBeNull();
	});

	test("toggles Show Turn Status off", () => {
		const onShowTurnStatusChange = vi.fn();
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onShowTurnStatusChange={onShowTurnStatusChange}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("checkbox", { name: /show turn status/i }));
		expect(onShowTurnStatusChange).toHaveBeenCalledWith(false);
	});

	test("applies a session storage mode change", async () => {
		const onSessionStorageChange = vi.fn(async () => {});
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={onSessionStorageChange}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByTestId("session-storage-mode"), { target: { value: "workspace" } });
		fireEvent.click(screen.getByTestId("apply-session-storage"));
		await waitFor(() => expect(onSessionStorageChange).toHaveBeenCalledWith({ mode: "workspace" }));
	});

	test("settings opens on General; Providers nav shows grouped, env-first provider list", () => {
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
					},
					{
						provider: "opencode",
						name: "OpenCode Zen",
						configured: true,
						source: "environment",
						mutable: false,
						supportsApiKey: true,
					},
					{
						provider: "anthropic",
						name: "Anthropic",
						configured: true,
						source: "stored",
						mutable: true,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={vi.fn(async () => {})}
				onRemoveCredential={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);

		// Default section is General: conversation toggles, no provider list.
		expect(screen.getByRole("checkbox", { name: /show thinking/i })).toBeTruthy();
		expect(screen.getByRole("checkbox", { name: /show turn status/i })).toBeTruthy();
		expect(screen.getByTestId("session-storage-mode")).toBeTruthy();
		expect(screen.queryByTestId("providers-section")).toBeNull();
		expect(screen.getByTestId("settings-nav-general").getAttribute("aria-current")).toBe("page");

		// Switch to Providers.
		fireEvent.click(screen.getByTestId("settings-nav-providers"));
		expect(screen.getByTestId("providers-section")).toBeTruthy();
		expect(screen.queryByRole("checkbox", { name: /show thinking/i })).toBeNull();

		// Connected group: environment source first, then stored; unconfigured
		// providers live in the Other group (rendered after Connected).
		expect(screen.getByText("Connected providers")).toBeTruthy();
		expect(screen.getByText("Other providers")).toBeTruthy();
		const rows = screen.getAllByTestId(/^auth-provider-row-/);
		expect(rows).toHaveLength(3);
		expect(rows[0].textContent).toContain("OpenCode Zen");
		expect(rows[0].textContent).toContain("environment");
		expect(rows[1].textContent).toContain("Anthropic");
		expect(rows[1].textContent).toContain("stored");
		expect(rows[2].textContent).toContain("OpenCode Go");
		expect(rows[2].textContent).toContain("not configured");

		// No row expanded: no dialog anywhere.
		expect(screen.queryByTestId("auth-api-key-dialog")).toBeNull();
	});

	test("provider search filters both groups", () => {
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
					},
					{
						provider: "opencode",
						name: "OpenCode Zen",
						configured: true,
						source: "environment",
						mutable: false,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={vi.fn(async () => {})}
				onRemoveCredential={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));
		expect(screen.getAllByTestId(/^auth-provider-row-/)).toHaveLength(2);

		const search = screen.getByTestId("auth-provider-search");
		fireEvent.change(search, { target: { value: "go" } });
		expect(screen.getAllByTestId(/^auth-provider-row-/)).toHaveLength(1);
		expect(screen.getByTestId("auth-provider-row-opencode-go")).toBeTruthy();
		expect(screen.queryByTestId("auth-provider-row-opencode")).toBeNull();
		// Empty group titles are not rendered.
		expect(screen.queryByText("Connected providers")).toBeNull();

		fireEvent.change(search, { target: { value: "zen" } });
		expect(screen.getAllByTestId(/^auth-provider-row-/)).toHaveLength(1);
		expect(screen.getByTestId("auth-provider-row-opencode")).toBeTruthy();

		fireEvent.change(search, { target: { value: "nope" } });
		expect(screen.queryByTestId(/^auth-provider-row-/)).toBeNull();
		expect(screen.getByText("(no providers match)")).toBeTruthy();

		fireEvent.change(search, { target: { value: "" } });
		expect(screen.getAllByTestId(/^auth-provider-row-/)).toHaveLength(2);
	});

	test("clicking a provider row opens the api key dialog; closing discards the draft", () => {
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={vi.fn(async () => {})}
				onRemoveCredential={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));

		// No dialog before clicking a row.
		expect(screen.queryByTestId("auth-api-key-dialog")).toBeNull();
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode-go"));
		expect(screen.getByTestId("auth-api-key-dialog")).toBeTruthy();
		expect(screen.getByTestId("auth-key-input-opencode-go")).toBeTruthy();

		fireEvent.change(screen.getByTestId("auth-key-input-opencode-go"), { target: { value: "sk-draft" } });
		expect((screen.getByTestId("auth-key-input-opencode-go") as HTMLInputElement).value).toBe("sk-draft");

		// Closing the dialog discards the draft: reopening starts empty.
		fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
		expect(screen.queryByTestId("auth-api-key-dialog")).toBeNull();
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode-go"));
		expect((screen.getByTestId("auth-key-input-opencode-go") as HTMLInputElement).value).toBe("");
	});

	test("saves an api key one-way; success closes the dialog; env rows have no Remove", async () => {
		const onSaveApiKey = vi.fn(async () => {});
		const onRemoveCredential = vi.fn(async () => {});
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
					},
					{
						provider: "opencode",
						name: "OpenCode Zen",
						configured: true,
						source: "environment",
						mutable: false,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={onSaveApiKey}
				onRemoveCredential={onRemoveCredential}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));

		// Environment-sourced credentials: badge and note, no Remove button.
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode"));
		expect(screen.getByTestId("auth-api-key-dialog").textContent).toContain("environment");
		expect(screen.getByTestId("auth-api-key-dialog").textContent).toContain("system environment");
		expect(screen.queryByTestId("auth-remove-opencode")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

		// Saving a key submits one-way and closes the dialog on success.
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode-go"));
		const input = screen.getByTestId("auth-key-input-opencode-go") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "sk-secret-value" } });
		fireEvent.click(screen.getByTestId("auth-save-opencode-go"));
		await waitFor(() => expect(onSaveApiKey).toHaveBeenCalledWith("opencode-go", "sk-secret-value"));
		await waitFor(() => expect(screen.queryByTestId("auth-api-key-dialog")).toBeNull());
		expect(screen.getByTestId("providers-section").textContent).not.toContain("sk-secret-value");
	});

	test("shows a Sign in with OAuth entry when the provider supports it", () => {
		const onStartOAuthLogin = vi.fn();
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
						supportsOAuth: true,
						oauthName: "Sign in with OAuth Provider",
						isSubscription: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={vi.fn(async () => {})}
				onRemoveCredential={vi.fn(async () => {})}
				onStartOAuthLogin={onStartOAuthLogin}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode-go"));

		// The provider row opens the api key dialog, which offers OAuth login.
		expect(screen.getByTestId("auth-api-key-dialog")).toBeTruthy();
		expect(screen.getByTestId("auth-api-key-dialog").textContent).toContain("subscription");
		fireEvent.click(screen.getByTestId("auth-oauth-login-opencode-go"));
		expect(onStartOAuthLogin).toHaveBeenCalledWith("opencode-go");
	});

	test("keeps the dialog open and redacts the error when saving fails; Remove works for stored", async () => {
		const onSaveApiKey = vi.fn().mockRejectedValue(new Error("set_api_key failed: Bearer sk-leaked"));
		const onRemoveCredential = vi.fn(async () => {});
		const { rerender } = render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: false,
						source: "none",
						mutable: true,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={onSaveApiKey}
				onRemoveCredential={onRemoveCredential}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));
		fireEvent.click(screen.getByTestId("auth-provider-row-opencode-go"));
		fireEvent.change(screen.getByTestId("auth-key-input-opencode-go"), { target: { value: "sk-my-key" } });
		fireEvent.click(screen.getByTestId("auth-save-opencode-go"));

		// Failure keeps the dialog open with the redacted error.
		await waitFor(() =>
			expect(screen.getByTestId("auth-api-key-dialog").textContent).toContain("set_api_key failed"),
		);
		const dialogText = screen.getByTestId("auth-api-key-dialog").textContent ?? "";
		expect(dialogText).not.toContain("sk-my-key");
		expect(dialogText).not.toContain("sk-leaked");

		// After the backend confirms the stored credential, Remove is available
		// and closes the dialog.
		rerender(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				authStatuses={[
					{
						provider: "opencode-go",
						name: "OpenCode Go",
						configured: true,
						source: "stored",
						mutable: true,
						supportsApiKey: true,
					},
				]}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onSaveApiKey={onSaveApiKey}
				onRemoveCredential={onRemoveCredential}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByTestId("auth-api-key-dialog").textContent).toContain("stored");
		fireEvent.click(screen.getByTestId("auth-remove-opencode-go"));
		await waitFor(() => expect(onRemoveCredential).toHaveBeenCalledWith("opencode-go"));
		await waitFor(() => expect(screen.queryByTestId("auth-api-key-dialog")).toBeNull());
	});
});

describe("ChatView conversation turns", () => {
	test("anchors the working status to the top of the assistant area while streaming", () => {
		const userMessage = {
			id: "u-working",
			role: "user" as const,
			blocks: [{ type: "text" as const, text: "Do the thing" }],
			complete: true,
		};
		const baseProps = {
			workspaceId: "D:\\pi",
			tools: {},
			disabled: false,
			showThinking: false,
			showToolDetails: false,
		};

		// No assistant content yet: the status still renders inside the assistant row.
		const { rerender } = render(<ChatView {...baseProps} messages={[userMessage]} streaming />);
		const status = screen.getByTestId("assistant-working");
		expect(status.textContent).toContain("Jip-pi is working");
		expect(status.compareDocumentPosition(screen.getByTestId("assistant-message")) & Node.DOCUMENT_POSITION_CONTAINS).toBeTruthy();

		// Once the final answer is streaming, the in-message dots take over.
		const streamingAnswer = {
			id: "a-working",
			role: "assistant" as const,
			blocks: [{ type: "text" as const, text: "Partial" }],
			complete: false,
		};
		rerender(<ChatView {...baseProps} messages={[userMessage, streamingAnswer]} streaming />);
		expect(screen.queryByTestId("assistant-working")).toBeNull();

		// Idle: no working status.
		rerender(<ChatView {...baseProps} messages={[userMessage, { ...streamingAnswer, complete: true }]} streaming={false} />);
		expect(screen.queryByTestId("assistant-working")).toBeNull();
	});

	test("re-renders a turn when its referenced tool status changes", () => {
		const messages = [
			{ id: "u1", role: "user" as const, blocks: [{ type: "text" as const, text: "Run it" }], complete: true },
			{
				id: "a1",
				role: "assistant" as const,
				blocks: [{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "ls" } }],
				complete: true,
			},
		];
		const { rerender } = render(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={{
					"call-1": { id: "call-1", name: "bash", args: {}, status: "running" as const },
				}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.getByTestId("assistant-process-toggle").textContent).toContain("Running");

		// Tool execution is a separate lifecycle from message completion: the
		// turn must refresh even when the message is already complete.
		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={{
					"call-1": { id: "call-1", name: "bash", args: {}, status: "completed" as const, result: "ok" },
				}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.getByTestId("assistant-process-toggle").textContent).toContain("Completed");
	});

	test("bounds the mounted turn window on long conversations", async () => {
		// 1000 messages → 1000 turns (every message starts a turn). Only the
		// most recent MAX_MOUNTED_TURNS turns are ever mounted.
		const messages: UiMessage[] = Array.from({ length: 1000 }, (_, index) => ({
			id: `m-${index}`,
			role: "user" as const,
			blocks: [{ type: "text" as const, text: `Message ${index}` }],
			complete: true,
		}));
		const { rerender } = render(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);

		expect(screen.getAllByTestId("conversation-turn")).toHaveLength(100);
		expect(screen.getByText("Message 999")).toBeTruthy();
		expect(screen.queryByText("Message 0")).toBeNull();
		expect(screen.queryByText("Message 899")).toBeNull();

		// Streaming must not mount the whole history either.
		const streamingMessages = [...messages, { ...messages[999], id: "m-live", complete: false }];
		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={streamingMessages}
				tools={{}}
				streaming
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.getAllByTestId("conversation-turn")).toHaveLength(100);
	});

	test("resets the window and turn cache when the session changes", async () => {
		const bigSession: UiMessage[] = Array.from({ length: 300 }, (_, index) => ({
			id: `big-${index}`,
			role: "user" as const,
			blocks: [{ type: "text" as const, text: `Big ${index}` }],
			complete: true,
		}));
		const smallSession: UiMessage[] = [
			{ id: "small-0", role: "user", blocks: [{ type: "text", text: "Small 0" }], complete: true },
			{ id: "small-1", role: "user", blocks: [{ type: "text", text: "Small 1" }], complete: true },
		];
		const { rerender } = render(
			<ChatView
				workspaceId="D:\pi"
				messages={bigSession}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				sessionKey="session-big"
			/>,
		);
		expect(screen.getAllByTestId("conversation-turn")).toHaveLength(100);
		expect(screen.getByText("Big 299")).toBeTruthy();

		// Switching to the small session resets the window: the big session's
		// turns are gone and the small session renders fully.
		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={smallSession}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				sessionKey="session-small"
			/>,
		);
		expect(screen.getAllByTestId("conversation-turn")).toHaveLength(2);
		expect(screen.getByText("Small 1")).toBeTruthy();
		expect(screen.queryByText("Big 299")).toBeNull();

		// And back: the big session re-mounts its tail window without growing
		// the turn cache (still exactly 100 mounted turns).
		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={bigSession}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				sessionKey="session-big"
			/>,
		);
		expect(screen.getAllByTestId("conversation-turn")).toHaveLength(100);
		expect(screen.getByText("Big 299")).toBeTruthy();
	});

	test("shows cumulative tokens and remaining context above the composer", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				sessionUsage={{
					sessionId: "s1",
					tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 },
					cost: 0.1,
					contextUsage: { tokens: 60_000, contextWindow: 128_000, percent: 46.875 },
				}}
			/>,
		);
		const usage = screen.getByTestId("usage-bar");
		expect(usage.textContent).toContain("Session105k tokens");
		expect(usage.textContent).toContain("Context left68k / 128k");
		expect(usage.compareDocumentPosition(screen.getByTestId("composer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	test("labels the local cost as an estimate and never as Go quota", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[{ id: "u-cost", role: "user", blocks: [{ type: "text", text: "hi" }], complete: true }]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				sessionUsage={{
					sessionId: "s1",
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					cost: 0.0234,
				}}
			/>,
		);
		const cost = screen.getByTestId("usage-cost");
		expect(cost.textContent).toContain("Est. cost");
		// 0.0234 USD at the static 7.2 CNY/USD display rate rounds to ¥0.17.
		expect(cost.textContent).toContain("¥0.17");
		expect(cost.getAttribute("title") ?? "").toContain("estimate");
		// No fabricated remaining quota or reset time anywhere.
		expect(screen.queryByText(/quota left/i)).toBeNull();
		expect(screen.queryByText(/resets/i)).toBeNull();
	});

	test("usage-limit failures show the OpenCode console hint with no fabricated quota", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{ id: "u-quota", role: "user", blocks: [{ type: "text", text: "Go" }], complete: true },
					{
						id: "a-quota",
						role: "assistant",
						blocks: [{ type: "text", text: "" }],
						stopReason: "error",
						errorMessage: "GoUsageLimitError: monthly usage limit reached",
						complete: true,
					},
				]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		const hint = screen.getByTestId("go-limit-hint");
		expect(hint.textContent).toContain("OpenCode usage-limit error");
		expect(hint.querySelector("a")?.getAttribute("href")).toBe("https://opencode.ai/console");
		expect(hint.textContent).toContain("never a remaining quota");
	});

	test("shows one Pi header and collapses tool activity when the final answer completes", async () => {
		const messages = [
			{ id: "u1", role: "user" as const, blocks: [{ type: "text" as const, text: "Inspect it" }], complete: true },
			{
				id: "a-tool",
				role: "assistant" as const,
				blocks: [{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				complete: true,
			},
			{
				id: "a-final",
				role: "assistant" as const,
				blocks: [{ type: "text" as const, text: "Final answer" }],
				complete: true,
			},
		];
		const tools = {
			"call-1": { id: "call-1", name: "bash", args: { command: "pwd" }, status: "completed" as const },
		};
		const { rerender } = render(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={tools}
				streaming
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);

		expect(screen.getAllByTestId("assistant-message")).toHaveLength(1);
		// Process activity is collapsed by default, even while streaming.
		expect(screen.queryByTestId("assistant-process-content")).toBeNull();
		expect(screen.getByText("Final answer")).toBeTruthy();

		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={tools}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.queryByTestId("assistant-process-content")).toBeNull();
		expect(screen.getByTestId("assistant-process-toggle").textContent).toContain("1 tool call · Completed");
		expect(screen.getByRole("button", { name: "Copy final response" })).toBeTruthy();
		fireEvent.click(screen.getByTestId("assistant-process-toggle"));
		expect(screen.getByTestId("tool-activity").textContent).toContain("bash");
	});

	test("copies only the completed final response as source Markdown", async () => {
		const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{
						id: "u-copy",
						role: "user",
						blocks: [{ type: "text", text: "Summarize it" }],
						complete: true,
					},
					{
						id: "a-process",
						role: "assistant",
						blocks: [
							{ type: "thinking", thinking: "private reasoning" },
							{ type: "toolCall", id: "copy-tool", name: "read", arguments: { path: "a.ts" } },
						],
						complete: true,
					},
					{
						id: "a-copy-final",
						role: "assistant",
						blocks: [
							{ type: "text", text: "# Result\n\n```ts\nconst answer = 42;\n```" },
							{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
							{ type: "text", text: "Second section" },
						],
						complete: true,
					},
				]}
				tools={{
					"copy-tool": { id: "copy-tool", name: "read", args: { path: "a.ts" }, status: "completed" },
				}}
				streaming={false}
				disabled={false}
				showThinking
				showToolDetails={false}
			/>,
		);

		const copyButton = screen.getByRole("button", { name: "Copy final response" });
		fireEvent.click(copyButton);
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith("# Result\n\n```ts\nconst answer = 42;\n```\n\nSecond section"),
		);
		expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("Copied");

		fireEvent.click(copyButton);
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copy failed"));
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	test("hides copy until a text response has finished streaming", () => {
		const textMessage = {
			id: "a-streaming-copy",
			role: "assistant" as const,
			blocks: [{ type: "text" as const, text: "Partial answer" }],
			complete: false,
		};
		const baseProps = {
			workspaceId: "D:\\pi",
			tools: {},
			disabled: false,
			showThinking: false,
			showToolDetails: false,
		};
		const { rerender } = render(<ChatView {...baseProps} messages={[textMessage]} streaming />);
		expect(screen.queryByRole("button", { name: "Copy final response" })).toBeNull();

		rerender(<ChatView {...baseProps} messages={[{ ...textMessage, complete: true }]} streaming={false} />);
		expect(screen.getByRole("button", { name: "Copy final response" })).toBeTruthy();

		rerender(
			<ChatView
				{...baseProps}
				messages={[
					{
						id: "a-image-only",
						role: "assistant",
						blocks: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
						complete: true,
					},
				]}
				streaming={false}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Copy final response" })).toBeNull();
	});

	test("shows one failure summary for retried attempts and never allows copy", () => {
		const failedAttempts = [1, 2, 3, 4].map((attempt) => ({
			id: `a-fail-${attempt}`,
			role: "assistant" as const,
			blocks: [{ type: "text" as const, text: `partial answer from attempt ${attempt}` }],
			stopReason: "error" as const,
			errorMessage: `attempt ${attempt} failed: Go usage limit reached`,
			complete: true,
		}));
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{ id: "u-fail", role: "user", blocks: [{ type: "text", text: "Do it" }], complete: true },
					...failedAttempts,
				]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		const failure = screen.getByTestId("assistant-failure");
		expect(failure.textContent).toContain("Generation failed after 4 attempts");
		expect(failure.textContent).toContain("attempt 4 failed: Go usage limit reached");
		// Failed partial text is not a formal answer: no copy button anywhere.
		expect(screen.queryByRole("button", { name: "Copy final response" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
		// One failure summary, not four ghost answers.
		expect(screen.getAllByTestId("assistant-failure")).toHaveLength(1);
	});

	test("failed attempts fold into the work log when a later retry succeeds", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{ id: "u-retry", role: "user", blocks: [{ type: "text", text: "Do it" }], complete: true },
					{
						id: "a-failed",
						role: "assistant",
						blocks: [{ type: "text", text: "partial failed text" }],
						stopReason: "error",
						errorMessage: "upstream 429",
						complete: true,
					},
					{
						id: "a-ok",
						role: "assistant",
						blocks: [{ type: "text", text: "final answer" }],
						stopReason: "stop",
						complete: true,
					},
				]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		// No failure banner: the turn ultimately succeeded.
		expect(screen.queryByTestId("assistant-failure")).toBeNull();
		// The successful answer is copyable and contains only the final text.
		expect(screen.getByRole("button", { name: "Copy final response" })).toBeTruthy();
		// The failed attempt lives in the collapsed work log, not as an answer.
		const toggle = screen.getByTestId("assistant-process-toggle");
		expect(toggle.textContent).toContain("Work log");
		fireEvent.click(toggle);
		expect(screen.getByTestId("assistant-process-content").textContent).toContain("partial failed text");
	});

	test("aborted turns show a distinct stop state, not an error banner", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{ id: "u-stop", role: "user", blocks: [{ type: "text", text: "Go" }], complete: true },
					{
						id: "a-aborted",
						role: "assistant",
						blocks: [{ type: "text", text: "partial before stop" }],
						stopReason: "aborted",
						complete: true,
					},
				]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.queryByTestId("assistant-failure")).toBeNull();
		expect(screen.getByTestId("assistant-aborted").textContent).toContain("Stopped by user");
	});

	test("shows the auto-retry progress banner above the composer", () => {
		render(
			<ChatView
				workspaceId="D:\pi"
				messages={[
					{ id: "u-r", role: "user", blocks: [{ type: "text", text: "Go" }], complete: true },
					{
						id: "a-r",
						role: "assistant",
						blocks: [{ type: "text", text: "partial" }],
						stopReason: "error",
						errorMessage: "upstream 429",
						complete: true,
					},
				]}
				tools={{}}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
				retry={{ attempt: 2, maxAttempts: 4, delayMs: 5000, errorMessage: "upstream 429" }}
			/>,
		);
		const banner = screen.getByTestId("retry-banner");
		expect(banner.textContent).toContain("Retrying (2/4)");
		expect(banner.textContent).toContain("in 5s");
		expect(banner.textContent).toContain("upstream 429");
	});

	test("keeps a completed error tool group collapsed after a manual toggle", async () => {
		const messages = [
			{ id: "u-error", role: "user" as const, blocks: [{ type: "text" as const, text: "Run it" }], complete: true },
			{
				id: "a-error-tool",
				role: "assistant" as const,
				blocks: [{ type: "toolCall" as const, id: "call-error", name: "bash", arguments: { command: "exit 1" } }],
				complete: true,
			},
			{
				id: "a-error-final",
				role: "assistant" as const,
				blocks: [{ type: "text" as const, text: "The command failed." }],
				complete: true,
			},
		];
		const tools = {
			"call-error": {
				id: "call-error",
				name: "bash",
				args: { command: "exit 1" },
				status: "error" as const,
				result: "exit code 1",
				isError: true,
			},
		};
		const { rerender } = render(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={tools}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);

		expect(screen.getByTestId("assistant-process-toggle").textContent).toContain("1 tool call · Error");
		// A completed error group is collapsed by default; the label carries the error.
		expect(screen.queryByTestId("assistant-process-content")).toBeNull();
		fireEvent.click(screen.getByTestId("assistant-process-toggle"));
		expect(screen.getByTestId("assistant-process-content")).toBeTruthy();
		fireEvent.click(screen.getByTestId("assistant-process-toggle"));
		expect(screen.queryByTestId("assistant-process-content")).toBeNull();

		rerender(
			<ChatView
				workspaceId="D:\pi"
				messages={messages}
				tools={tools}
				streaming={false}
				disabled={false}
				showThinking={false}
				showToolDetails={false}
			/>,
		);
		expect(screen.queryByTestId("assistant-process-content")).toBeNull();
		expect(screen.getByTestId("assistant-process-toggle").getAttribute("aria-expanded")).toBe("false");
	});
});

describe("Composer", () => {
	test("Enter sends the message and clears input after acceptance", async () => {
		const sendMessage = vi.spyOn(window.agent, "sendMessage").mockResolvedValue();
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} />);
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(sendMessage).toHaveBeenCalledWith("D:\\pi", "session-1", { role: "user", content: "hello" });
		// The draft clears only after the backend accepted the prompt.
		await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
		sendMessage.mockRestore();
	});

	test("restores the draft when the backend rejects the send", async () => {
		const sendMessage = vi
			.spyOn(window.agent, "sendMessage")
			.mockRejectedValue(new Error("prompt rejected: streaming"));
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} />);
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "keep me" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("prompt rejected"));
		expect((input as HTMLTextAreaElement).value).toBe("keep me");
		expect(sendMessage).toHaveBeenCalledTimes(1);
		sendMessage.mockRestore();
	});

	test("blocks duplicate sends while one is in flight", async () => {
		let resolveSend: ((value: void) => void) | undefined;
		const sendMessage = vi
			.spyOn(window.agent, "sendMessage")
			.mockImplementation(() => new Promise<void>((resolve) => {
				resolveSend = resolve;
			}));
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} />);
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "once" } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		resolveSend?.();
		await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
		sendMessage.mockRestore();
	});

	test("adds multiple photos, removes one, and sends the remaining image", async () => {
		const sendMessage = vi.spyOn(window.agent, "sendMessage").mockResolvedValue();
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} supportsImages />);
		const first = new File(["first"], "first.png", { type: "image/png" });
		const second = new File(["second"], "second.jpg", { type: "image/jpeg" });
		fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [first, second] } });

		await waitFor(() => expect(screen.getByAltText("first.png")).toBeTruthy());
		expect(screen.getByAltText("second.jpg")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
		expect(screen.queryByAltText("first.png")).toBeNull();
		expect(screen.getByAltText("second.jpg")).toBeTruthy();

		fireEvent.click(screen.getByTestId("send-button"));
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith("D:\\pi", "session-1", {
			role: "user",
			content: [expect.objectContaining({ type: "image", mimeType: "image/jpeg", name: "second.jpg" })],
		});
		await waitFor(() => expect(screen.queryByTestId("composer-attachments")).toBeNull());
		sendMessage.mockRestore();
	});

	test("allows photo selection when the current model has no image input, with a warning after attaching", async () => {
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} supportsImages={false} />);
		expect((screen.getByTestId("attach-images-button") as HTMLButtonElement).disabled).toBe(false);

		const image = new File(["pixels"], "image.png", { type: "image/png" });
		fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [image] } });

		await waitFor(() => expect(screen.getByAltText("image.png")).toBeTruthy());
		expect(screen.getByTestId("composer-image-warning").textContent).toContain("does not support image input");
	});

	test("pastes an image from the clipboard", async () => {
		const sendMessage = vi.spyOn(window.agent, "sendMessage").mockResolvedValue();
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} supportsImages />);
		const input = screen.getByTestId("composer-input");
		const image = new File(["pixels"], "image.png", { type: "image/png" });
		fireEvent.paste(input, { clipboardData: { files: [image] } });

		await waitFor(() => expect(screen.getByAltText("image.png")).toBeTruthy());
		fireEvent.click(screen.getByTestId("send-button"));
		expect(sendMessage).toHaveBeenCalledWith("D:\\pi", "session-1", {
			role: "user",
			content: [expect.objectContaining({ type: "image", mimeType: "image/png", name: "image.png" })],
		});
		sendMessage.mockRestore();
	});

	test("rejects pasted non-image files with an error", async () => {
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} supportsImages />);
		const input = screen.getByTestId("composer-input");
		const file = new File(["text"], "notes.txt", { type: "text/plain" });
		fireEvent.paste(input, { clipboardData: { files: [file] } });

		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("Only PNG, JPEG, WebP, GIF, and BMP"),
		);
		expect(screen.queryByTestId("composer-attachments")).toBeNull();
	});

	test("pasting an image without image support still attaches it with a warning", async () => {
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} supportsImages={false} />);
		const input = screen.getByTestId("composer-input");
		const image = new File(["pixels"], "image.png", { type: "image/png" });
		fireEvent.paste(input, { clipboardData: { files: [image] } });

		await waitFor(() => expect(screen.getByAltText("image.png")).toBeTruthy());
		expect(screen.getByTestId("composer-image-warning").textContent).toContain("does not support image input");
	});

	test("Shift+Enter inserts a newline instead of sending", () => {
		const sendMessage = vi.spyOn(window.agent, "sendMessage").mockResolvedValue();
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} />);
		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "line1" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(sendMessage).not.toHaveBeenCalled();
		sendMessage.mockRestore();
	});

	test("Send is disabled when empty or streaming; Stop is disabled when idle", () => {
		const { rerender } = render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={false} disabled={false} />);
		expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId("stop-button") as HTMLButtonElement).disabled).toBe(true);

		const input = screen.getByTestId("composer-input");
		fireEvent.change(input, { target: { value: "text" } });
		expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(false);

		rerender(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={true} disabled={false} />);
		expect((screen.getByTestId("send-button") as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId("stop-button") as HTMLButtonElement).disabled).toBe(false);
	});

	test("Stop triggers abort", () => {
		const abortAgent = vi.spyOn(window.agent, "abort").mockResolvedValue();
		render(<Composer workspaceId="D:\pi" sessionId="session-1" streaming={true} disabled={false} />);
		fireEvent.click(screen.getByTestId("stop-button"));
		expect(abortAgent).toHaveBeenCalled();
		abortAgent.mockRestore();
	});
});

describe("Sidebar", () => {
	test("keeps the persisted workspace order when the active workspace changes", () => {
		render(
			<Sidebar
				workspace="D:\\second"
				workspaces={["D:\\first", "D:\\second"]}
				sessions={[
					{ id: "second-session", workspacePath: "D:\\second" },
					{ id: "first-session", workspacePath: "D:\\first" },
				]}
				currentSessionId="second-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		expect(screen.getAllByTestId("session-project-toggle").map((toggle) => toggle.textContent)).toEqual([
			"first",
			"second",
		]);
	});

	test("removes an inactive workspace from its context menu", async () => {
		const removeWorkspaceEntry = vi.spyOn(hooks, "removeWorkspaceEntry").mockResolvedValue();
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={["D:\\pi", "D:\\old-project"]}
				sessions={[
					{ id: "current-session", workspacePath: "D:\\pi" },
					{ id: "old-session", workspacePath: "D:\\old-project" },
				]}
				currentSessionId="current-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		fireEvent.contextMenu(screen.getByRole("button", { name: /old-project/i }), {
			clientX: 120,
			clientY: 160,
		});
		expect(screen.getByTestId("workspace-context-menu")).toBeTruthy();
		expect(screen.getByTestId("workspace-context-menu").firstElementChild?.className).toBe(
			"session-context-menu-surface",
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Remove workspace" }));
		// A confirmation dialog opens; confirm the removal.
		await waitFor(() => expect(screen.getByTestId("remove-workspace-dialog")).toBeTruthy());
		fireEvent.click(screen.getByTestId("remove-workspace-confirm"));
		await waitFor(() => expect(removeWorkspaceEntry).toHaveBeenCalledWith("D:\\old-project"));

		fireEvent.contextMenu(screen.getByRole("button", { name: /^pi$/i }), {
			clientX: 120,
			clientY: 160,
		});
		// The active workspace can be removed too; the runtime resets to
		// no-workspace afterward, so the menu item is no longer disabled.
		expect((screen.getByRole("menuitem", { name: "Remove workspace" }) as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(screen.getByRole("menuitem", { name: "Remove workspace" }));
		await waitFor(() => expect(screen.getByTestId("remove-workspace-dialog")).toBeTruthy());
		fireEvent.click(screen.getByTestId("remove-workspace-confirm"));
		await waitFor(() => expect(removeWorkspaceEntry).toHaveBeenCalledWith("D:\\pi"));
	});

	test("keeps a remembered workspace visible after its blank session is no longer active", () => {
		const onOpenWorkspace = vi.fn();
		render(
			<Sidebar
				workspace="D:\\other"
				workspaces={["D:\\new-project", "D:\\other"]}
				sessions={[{ id: "other-session", workspacePath: "D:\\other" }]}
				currentSessionId="other-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={onOpenWorkspace}
			/>,
		);

		const rememberedWorkspace = screen.getByRole("button", { name: /new-project/i });
		expect(rememberedWorkspace).toBeTruthy();
		fireEvent.click(rememberedWorkspace);
		expect(onOpenWorkspace).toHaveBeenCalledWith("D:\\new-project");
	});

	test("adds a workspace and creates sessions in the active workspace", () => {
		const onAddWorkspace = vi.fn();
		const newSession = vi.spyOn(hooks, "newSession").mockResolvedValue("fresh-session");
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[]}
				currentSessionId={null}
				busy={false}
				onAddWorkspace={onAddWorkspace}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByTestId("add-workspace-button"));
		fireEvent.click(screen.getByTestId("new-session-button"));
		expect(onAddWorkspace).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	test("collapses and expands every session in a workspace", () => {
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[
					{
						id: "pi-one",
						name: "Pi one",
						workspacePath: "D:\\pi",
						updatedAt: Date.parse("2026-08-08T03:00:00.000Z"),
					},
					{
						id: "pi-two",
						name: "Pi two",
						workspacePath: "D:\\pi",
						updatedAt: Date.parse("2026-08-08T02:00:00.000Z"),
					},
					{
						id: "dict-one",
						name: "Dictionary one",
						workspacePath: "D:\\Dict_app",
						updatedAt: Date.parse("2026-08-07T02:00:00.000Z"),
					},
				]}
				currentSessionId={null}
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		const projectToggles = screen.getAllByTestId("session-project-toggle");
		expect(projectToggles.map((toggle) => toggle.textContent)).toEqual(["pi", "Dict_app"]);
		expect(projectToggles[0].getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(projectToggles[0]);
		expect(projectToggles[0].getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Pi one")).toBeNull();
		expect(screen.queryByText("Pi two")).toBeNull();
		expect(screen.getByText("Dictionary one")).toBeTruthy();

		fireEvent.click(projectToggles[0]);
		expect(projectToggles[0].getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Pi one")).toBeTruthy();
		expect(screen.getByText("Pi two")).toBeTruthy();
	});

	test("shows a toast when opening a session fails", async () => {
		vi.spyOn(hooks, "openSession").mockRejectedValue(new Error("Session not found"));
		const dispatch = vi.spyOn(hooks.store, "dispatch");
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[{ id: "missing-session", name: "Missing session" }]}
				currentSessionId="current-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByTestId("session-item"));

		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: "notify",
				notification: {
					message: 'Failed to open "Missing session": Session not found',
					type: "error",
				},
			}),
		);
	});

	test("switches sessions and exposes rename/delete through the context menu", async () => {
		const openSession = vi.spyOn(hooks, "openSession").mockResolvedValue();
		const renameSessionEntry = vi.spyOn(hooks, "renameSessionEntry").mockResolvedValue();
		const deleteSessionEntry = vi.spyOn(hooks, "deleteSessionEntry").mockResolvedValue();
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[
					{
						id: "current-session",
						preview: "Current conversation",
						messageCount: 1,
						updatedAt: Date.parse("2026-08-08T02:00:00.000Z"),
					},
					{
						id: "history-session",
						name: "Historical session",
						messageCount: 3,
						updatedAt: Date.parse("2026-08-07T03:00:00.000Z"),
					},
				]}
				currentSessionId="current-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		const items = screen.getAllByTestId("session-item") as HTMLButtonElement[];
		expect(items).toHaveLength(2);
		expect(items[0].disabled).toBe(false);
		const activePointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
		items[0].dispatchEvent(activePointerDown);
		expect(activePointerDown.defaultPrevented).toBe(true);
		expect(screen.getByText("Historical session")).toBeTruthy();
		fireEvent.click(items[0]);
		expect(openSession).not.toHaveBeenCalled();
		fireEvent.click(items[1]);
		expect(openSession).toHaveBeenCalledWith("D:\\pi", "history-session");

		fireEvent.contextMenu(items[0], { clientX: 120, clientY: 160 });
		expect(screen.getByTestId("session-context-menu")).toBeTruthy();
		expect(screen.getByTestId("session-context-menu").firstElementChild?.className).toBe(
			"session-context-menu-surface",
		);
		// §14.3: the active idle session may be deleted (fallback active).
		expect((screen.getByRole("menuitem", { name: "Move to Trash" }) as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		expect(screen.getByTestId("rename-session-dialog")).toBeTruthy();
		fireEvent.change(screen.getByTestId("rename-session-input"), { target: { value: "Renamed current" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		await waitFor(() =>
			expect(renameSessionEntry).toHaveBeenCalledWith(
				expect.objectContaining({ id: "current-session" }),
				"Renamed current",
			),
		);
		await waitFor(() => expect(screen.queryByTestId("rename-session-dialog")).toBeNull());

		fireEvent.contextMenu(items[1], { clientX: 120, clientY: 190 });
		const deleteMenuItem = screen.getByRole("menuitem", { name: "Move to Trash" }) as HTMLButtonElement;
		expect(deleteMenuItem.disabled).toBe(false);
		fireEvent.click(deleteMenuItem);
		// Deletion is confirmed through an in-app dialog (no native confirm).
		expect(screen.getByTestId("delete-session-dialog")).toBeTruthy();
		fireEvent.click(screen.getByTestId("delete-session-confirm"));
		await waitFor(() =>
			expect(deleteSessionEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "history-session" })),
		);
		await waitFor(() => expect(screen.queryByTestId("delete-session-dialog")).toBeNull());
	});

	test("truncates long session titles in the delete dialog", () => {
		const longTitle = "x".repeat(200);
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[{ id: "long-session", name: longTitle, workspacePath: "D:\\pi" }]}
				currentSessionId={null}
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		fireEvent.contextMenu(screen.getByTestId("session-item"), { clientX: 120, clientY: 160 });
		fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

		const warning = screen.getByText(new RegExp(`^Move "x{${MAX_SESSION_TITLE_LENGTH}}…" to the system Trash`));
		expect(warning.textContent).not.toContain(longTitle);
		expect(warning.getAttribute("title")).toBe(longTitle);
	});

	test("shows a truncated preview as the session title in the list", () => {
		const longPreview = "y".repeat(200);
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[{ id: "preview-session", preview: longPreview, workspacePath: "D:\\pi" }]}
				currentSessionId={null}
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		const strong = screen.getByTestId("session-item").querySelector("strong");
		expect(strong?.textContent).toBe(`${"y".repeat(MAX_SESSION_TITLE_LENGTH)}…`);
	});

	test("live session entries override stale catalog titles", () => {
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[{ id: "merged-session", workspacePath: "D:\\pi", preview: "Fresh first prompt" }]}
				catalogSessions={[
					{ id: "merged-session", workspacePath: "D:\\pi", preview: "(no messages)" },
				]}
				currentSessionId={null}
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		const strong = screen.getByTestId("session-item").querySelector("strong");
		expect(strong?.textContent).toBe("Fresh first prompt");
	});

	test("truncates long session titles in error notifications", async () => {
		vi.spyOn(hooks, "openSession").mockRejectedValue(new Error("Session not found"));
		const dispatch = vi.spyOn(hooks.store, "dispatch");
		render(
			<Sidebar
				workspace="D:\pi"
				workspaces={[]}
				sessions={[{ id: "missing-session", name: "z".repeat(200) }]}
				currentSessionId="current-session"
				busy={false}
				onAddWorkspace={vi.fn()}
				onOpenWorkspace={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByTestId("session-item"));

		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: "notify",
				notification: {
					message: `Failed to open "${"z".repeat(MAX_SESSION_TITLE_LENGTH)}…": Session not found`,
					type: "error",
				},
			}),
		);
	});
});

describe("truncateSessionTitle", () => {
	test("keeps short titles intact", () => {
		expect(truncateSessionTitle("Short title")).toBe("Short title");
	});

	test("does not split surrogate pairs", () => {
		const title = "😀".repeat(MAX_SESSION_TITLE_LENGTH + 1);
		const truncated = truncateSessionTitle(title);
		expect(truncated).toBe(`${"😀".repeat(MAX_SESSION_TITLE_LENGTH)}…`);
	});

	test("keeps grapheme clusters intact", () => {
		const family = "👨‍👩‍👧‍👦";
		const title = family.repeat(MAX_SESSION_TITLE_LENGTH + 1);
		const truncated = truncateSessionTitle(title);
		expect(truncated).toBe(`${family.repeat(MAX_SESSION_TITLE_LENGTH)}…`);
	});

	test("trims trailing whitespace before the ellipsis", () => {
		const title = `${"a".repeat(MAX_SESSION_TITLE_LENGTH - 1)} ${"b".repeat(10)}`;
		expect(truncateSessionTitle(title)).toBe(`${"a".repeat(MAX_SESSION_TITLE_LENGTH - 1)}…`);
	});
});

describe("CustomProvidersSection", () => {
	const providers = [
		{ id: "my-local", name: "My Local", baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "a" }, { id: "b" }] },
		{ id: "proxy", baseUrl: "https://proxy.example.com", api: "anthropic-messages", models: [{ id: "c" }] },
	];

	test("renders the list and fires add", () => {
		const onAdd = vi.fn();
		render(<CustomProvidersSection providers={providers} busy={false} onAdd={onAdd} onEdit={vi.fn()} onDelete={vi.fn()} onReload={vi.fn()} />);
		expect(screen.getByTestId("custom-providers-section")).toBeTruthy();
		expect(screen.getByText("2 models")).toBeTruthy();
		expect(screen.getByText("1 model")).toBeTruthy();
		fireEvent.click(screen.getByTestId("custom-providers-add"));
		expect(onAdd).toHaveBeenCalledTimes(1);
	});

	test("edit and delete buttons fire with the provider id", () => {
		const onEdit = vi.fn();
		const onDelete = vi.fn();
		vi.stubGlobal("confirm", () => true);
		render(<CustomProvidersSection providers={providers} busy={false} onAdd={vi.fn()} onEdit={onEdit} onDelete={onDelete} onReload={vi.fn()} />);
		fireEvent.click(screen.getByTestId("custom-provider-edit-my-local"));
		expect(onEdit).toHaveBeenCalledWith("my-local");
		fireEvent.click(screen.getByTestId("custom-provider-delete-proxy"));
		expect(onDelete).toHaveBeenCalledWith("proxy");
	});

	test("delete is suppressed when confirm is dismissed", () => {
		const onDelete = vi.fn();
		vi.stubGlobal("confirm", () => false);
		render(<CustomProvidersSection providers={providers} busy={false} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={onDelete} onReload={vi.fn()} />);
		fireEvent.click(screen.getByTestId("custom-provider-delete-my-local"));
		expect(onDelete).not.toHaveBeenCalled();
	});
});

describe("CustomProviderDialog", () => {
	test("add flow collects and serializes the config", async () => {
		const onSave = vi.fn(async () => {});
		render(<CustomProviderDialog busy={false} error={null} onSave={onSave} onClose={vi.fn()} />);
		fireEvent.change(screen.getByTestId("custom-provider-id"), { target: { value: "my-local" } });
		fireEvent.change(screen.getByTestId("custom-provider-base-url"), { target: { value: "http://localhost:11434/v1" } });
		fireEvent.change(screen.getByTestId("custom-provider-api"), { target: { value: "anthropic-messages" } });
		fireEvent.change(screen.getByTestId("custom-provider-model-id-0"), { target: { value: "qwen:7b" } });
		fireEvent.change(screen.getByTestId("custom-provider-model-context-0"), { target: { value: "128000" } });
		fireEvent.click(screen.getByTestId("custom-provider-model-reasoning-0"));
		fireEvent.click(screen.getByTestId("custom-provider-save"));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		const config = onSave.mock.calls[0][0];
		expect(config).toMatchObject({ id: "my-local", baseUrl: "http://localhost:11434/v1", api: "anthropic-messages" });
		expect(config.authHeader).toBeUndefined();
		expect(config.models[0]).toMatchObject({ id: "qwen:7b", reasoning: true, contextWindow: 128000 });
		// Text-only input is the default and is omitted from the serialized model.
		expect(config.models[0].input).toBeUndefined();
	});

	test("edit flow prefills initial values and disables the id field", async () => {
		const onSave = vi.fn(async () => {});
		const initial = {
			id: "my-local",
			name: "My Local",
			baseUrl: "http://x",
			api: "openai-completions" as const,
			authHeader: true,
			headers: { "x-key": "$K" },
			models: [{ id: "m1", reasoning: true, input: ["text", "image"] as ("text" | "image")[], contextWindow: 200000, maxTokens: 4096 }],
		};
		render(<CustomProviderDialog initial={initial} busy={false} error={null} onSave={onSave} onClose={vi.fn()} />);
		expect((screen.getByTestId("custom-provider-id") as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByTestId("custom-provider-id") as HTMLInputElement).value).toBe("my-local");
		expect((screen.getByTestId("custom-provider-base-url") as HTMLInputElement).value).toBe("http://x");
		expect((screen.getByTestId("custom-provider-auth-header") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByTestId("custom-provider-model-reasoning-0") as HTMLInputElement).checked).toBe(true);
		expect((screen.getByTestId("custom-provider-model-context-0") as HTMLInputElement).value).toBe("200000");
		fireEvent.click(screen.getByTestId("custom-provider-save"));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave.mock.calls[0][0]).toMatchObject({ id: "my-local", authHeader: true, headers: { "x-key": "$K" } });
		expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ id: "m1", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 4096 });
	});

	test("blocks save when no model id is provided", async () => {
		const onSave = vi.fn(async () => {});
		render(<CustomProviderDialog busy={false} error={null} onSave={onSave} onClose={vi.fn()} />);
		fireEvent.change(screen.getByTestId("custom-provider-id"), { target: { value: "p" } });
		fireEvent.change(screen.getByTestId("custom-provider-base-url"), { target: { value: "http://x" } });
		fireEvent.click(screen.getByTestId("custom-provider-save"));
		await waitFor(() => expect(screen.getByText(/at least one model/i)).toBeTruthy());
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe("SettingsPanel custom providers", () => {
	test("Providers section lists custom providers and adds one through the dialog", async () => {
		const onSaveCustomProvider = vi.fn(async () => {});
		const listCustomProviders = vi.fn(async () => [
			{ id: "my-local", name: "My Local", baseUrl: "http://x", api: "openai-completions", models: [{ id: "m" }] },
		]);
		render(
			<SettingsPanel
				logs={[]}
				showThinking={false}
				showToolDetails={false}
				showTurnStatus={true}
				onShowTurnStatusChange={vi.fn()}
				sessionStorage={{ mode: "default" }}
				storageBusy={false}
				onShowThinkingChange={vi.fn()}
				onShowToolDetailsChange={vi.fn()}
				onPickSessionStorageRoot={vi.fn(async () => null)}
				onSessionStorageChange={vi.fn(async () => {})}
				onListCustomProviders={listCustomProviders}
				onSaveCustomProvider={onSaveCustomProvider}
				onDeleteCustomProvider={vi.fn(async () => {})}
				onReloadModels={vi.fn(async () => {})}
				onClose={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTestId("settings-nav-providers"));
		await waitFor(() => expect(screen.getByTestId("custom-providers-section")).toBeTruthy());
		expect(listCustomProviders).toHaveBeenCalled();
		expect(screen.getByText("My Local")).toBeTruthy();
		fireEvent.click(screen.getByTestId("custom-providers-add"));
		expect(screen.getByTestId("custom-provider-dialog")).toBeTruthy();
		fireEvent.change(screen.getByTestId("custom-provider-id"), { target: { value: "new" } });
		fireEvent.change(screen.getByTestId("custom-provider-base-url"), { target: { value: "http://y" } });
		fireEvent.change(screen.getByTestId("custom-provider-model-id-0"), { target: { value: "m1" } });
		fireEvent.click(screen.getByTestId("custom-provider-save"));
		await waitFor(() => expect(onSaveCustomProvider).toHaveBeenCalledTimes(1));
		expect(onSaveCustomProvider.mock.calls[0][0]).toMatchObject({ id: "new", baseUrl: "http://y", api: "openai-completions" });
	});
});
