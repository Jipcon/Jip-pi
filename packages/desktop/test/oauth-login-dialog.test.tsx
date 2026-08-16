import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderAuthStatus } from "@earendil-works/pi-agent-protocol";
import { OAuthLoginDialog } from "../src/renderer/components/OAuthLoginDialog.tsx";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const status: ProviderAuthStatus = {
	provider: "opencode-go",
	name: "OpenCode Go",
	configured: false,
	source: "none",
	mutable: true,
	supportsOAuth: true,
	oauthName: "Sign in with OAuth Provider",
	isSubscription: true,
};



function renderDialog(overrides: {
	flow?: Parameters<typeof OAuthLoginDialog>[0]["flow"];
	error?: string | null;
	disabled?: boolean;
	onRespond?: (requestId: string, response: unknown) => Promise<void>;
	onCancel?: () => Promise<void>;
	onClose?: () => void;
} = {}) {
	const onRespond = overrides.onRespond ?? vi.fn(async () => {});
	const onCancel = overrides.onCancel ?? vi.fn(async () => {});
	const onClose = overrides.onClose ?? vi.fn();
	render(
		<OAuthLoginDialog
			status={status}
			flow={overrides.flow ?? null}
			error={overrides.error ?? null}
			disabled={overrides.disabled ?? false}
			onRespond={onRespond}
			onCancel={onCancel}
			onClose={onClose}
		/>,
	);
	return { onRespond, onCancel, onClose };
}

describe("OAuthLoginDialog", () => {
	test("renders the provider title and subscription note", () => {
		renderDialog();
		expect(screen.getByTestId("oauth-login-dialog").textContent).toContain("Sign in with OAuth Provider");
		expect(screen.getByTestId("oauth-login-dialog").textContent).toContain("subscription");
	});

	test("shows the auth url with copy and open-in-browser actions", () => {
		const openSpy = vi.fn();
		Object.defineProperty(window, "open", { value: openSpy, writable: true, configurable: true });
		renderDialog({
			flow: {
				loginId: "l",
				display: { type: "auth_url", url: "https://example.invalid/oauth", instructions: "Open it" },
			},
		});
		expect(screen.getByTestId("oauth-auth-url")).toBeTruthy();
		expect((screen.getByTestId("oauth-url") as HTMLInputElement).value).toBe("https://example.invalid/oauth");

		fireEvent.click(screen.getByTestId("oauth-open-browser"));
		expect(openSpy).toHaveBeenCalledWith("https://example.invalid/oauth", "_blank");

		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		fireEvent.click(screen.getByTestId("oauth-copy"));
		expect(writeText).toHaveBeenCalledWith("https://example.invalid/oauth");
	});

	test("shows the device code with a copy action", () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		renderDialog({
			flow: {
				loginId: "l",
				display: {
					type: "device_code",
					userCode: "CODE-123",
					verificationUri: "https://example.invalid/device",
				},
			},
		});
		expect(screen.getByTestId("oauth-device-code")).toBeTruthy();
		expect(screen.getByTestId("oauth-user-code").textContent).toBe("CODE-123");
		expect(screen.getByTestId("oauth-device-code").textContent).toContain("https://example.invalid/device");
		fireEvent.click(screen.getByTestId("oauth-copy"));
		expect(writeText).toHaveBeenCalledWith("CODE-123");
	});

	test("submits a text prompt answer", async () => {
		const { onRespond } = renderDialog({
			flow: {
				loginId: "l",
				prompt: { requestId: "prompt-1", prompt: { type: "text", message: "Enter the code" } },
			},
		});
		fireEvent.change(screen.getByTestId("oauth-prompt-input-text"), { target: { value: "abc-123" } });
		fireEvent.click(screen.getByTestId("oauth-prompt-submit"));
		expect(onRespond).toHaveBeenCalledWith("prompt-1", { kind: "value", value: "abc-123" });
	});

	test("renders select prompts as option buttons answering with the option id", () => {
		const { onRespond } = renderDialog({
			flow: {
				loginId: "l",
				prompt: {
					requestId: "prompt-2",
					prompt: {
						type: "select",
						message: "Pick an account",
						options: [
							{ id: "acc-a", label: "Account A", description: "first" },
							{ id: "acc-b", label: "Account B" },
						],
					},
				},
			},
		});
		expect(screen.getByTestId("oauth-prompt-select")).toBeTruthy();
		fireEvent.click(screen.getByTestId("oauth-option-acc-b"));
		expect(onRespond).toHaveBeenCalledWith("prompt-2", { kind: "value", value: "acc-b" });
	});

	test("keeps the auth url visible while a manual code prompt is pending", () => {
		// The codex flow emits auth_url and manual_code back to back; both must
		// stay on screen so the user can open the url and paste the code.
		renderDialog({
			flow: {
				loginId: "l",
				display: { type: "auth_url", url: "https://example.invalid/oauth" },
				prompt: { requestId: "mc-1", prompt: { type: "manual_code", message: "Paste the code" } },
			},
		});
		expect(screen.getByTestId("oauth-auth-url")).toBeTruthy();
		expect(screen.getByTestId("oauth-prompt-input-manual_code")).toBeTruthy();
	});

	test("cancels the login from the dialog button", async () => {
		const { onCancel } = renderDialog();
		fireEvent.click(screen.getByTestId("oauth-cancel"));
		expect(onCancel).toHaveBeenCalled();
	});

	test("shows errors and disables inputs when the flow ended", () => {
		renderDialog({
			error: "Access denied",
			disabled: true,
			flow: {
				loginId: "l",
				prompt: { requestId: "prompt-9", prompt: { type: "text", message: "Enter the code" } },
			},
		});
		expect(screen.getByTestId("oauth-error").textContent).toContain("Access denied");
		const input = screen.getByTestId("oauth-prompt-input-text") as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect((screen.getByTestId("oauth-prompt-submit") as HTMLButtonElement).disabled).toBe(true);
		// Cancelling must stay possible after an error (the backend flow may be orphaned).
		expect((screen.getByTestId("oauth-cancel") as HTMLButtonElement).disabled).toBe(false);
	});
});
