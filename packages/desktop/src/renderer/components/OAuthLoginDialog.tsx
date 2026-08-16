/**
 * OAuthLoginDialog: modal for running a provider's OAuth login flow.
 *
 * The view is driven by auth_flow events streamed from the backend through
 * the store (authorization url, device code, info/progress, prompts); the
 * dialog adds the local input state (draft text, select pick) and the
 * submit/cancel actions. Tokens never pass through the GUI: the flow only
 * carries display metadata and the dialog answers prompts with plain strings.
 */

import { useEffect, useState } from "react";
import type { AuthFlowPrompt, AuthPromptResponse, ProviderAuthStatus } from "@earendil-works/pi-agent-protocol";
import type { AuthFlowState } from "../state/store.ts";
import { Icon } from "./Icon.tsx";

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element {
	const [copied, setCopied] = useState(false);
	const copy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can be unavailable; the text stays selectable.
		}
	};
	return (
		<button
			type="button"
			className="btn btn-small oauth-copy"
			onClick={() => void copy()}
			data-testid="oauth-copy"
		>
			<Icon name="copy" size={13} />
			{copied ? "Copied" : label}
		</button>
	);
}

function PromptView({
	prompt,
	disabled,
	onRespond,
}: {
	prompt: AuthFlowPrompt;
	disabled: boolean;
	onRespond: (response: AuthPromptResponse) => Promise<void>;
}): React.JSX.Element {
	const [draft, setDraft] = useState("");
	// A new prompt (new requestId) resets the draft.
	useEffect(() => {
		setDraft("");
	}, [prompt]);

	if (prompt.type === "select") {
		return (
			<div className="oauth-prompt" data-testid="oauth-prompt-select">
				<p className="settings-note">{prompt.message}</p>
				<div className="oauth-options">
					{prompt.options.map((option) => (
						<button
							type="button"
							key={option.id}
							className="btn oauth-option"
							disabled={disabled}
							onClick={() => void onRespond({ kind: "value", value: option.id })}
							data-testid={`oauth-option-${option.id}`}
						>
							<span className="oauth-option-label">{option.label}</span>
							{option.description && (
								<span className="oauth-option-description">{option.description}</span>
							)}
						</button>
					))}
				</div>
			</div>
		);
	}

	const isSecret = prompt.type === "secret";
	const placeholder =
		prompt.placeholder ?? (prompt.type === "manual_code" ? "Paste the authorization code…" : undefined);
	const submit = (): void => {
		const value = draft.trim();
		if (!value || disabled) return;
		setDraft("");
		void onRespond({ kind: "value", value });
	};
	return (
		<div className="oauth-prompt" data-testid="oauth-prompt-input">
			<label className="settings-field">
				<span>{prompt.message}</span>
				<input
					type={isSecret ? "password" : "text"}
					className="modal-input"
					placeholder={placeholder}
					value={draft}
					autoComplete="off"
					spellCheck={false}
					autoFocus
					disabled={disabled}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") submit();
					}}
					data-testid={`oauth-prompt-input-${prompt.type}`}
				/>
			</label>
			<div className="oauth-prompt-actions">
				<button
					type="button"
					className="btn btn-small btn-primary"
					disabled={disabled || !draft.trim()}
					onClick={submit}
					data-testid="oauth-prompt-submit"
				>
					Submit
				</button>
			</div>
		</div>
	);
}

export function OAuthLoginDialog({
	status,
	flow,
	error,
	disabled,
	onRespond,
	onCancel,
	onClose,
}: {
	status: ProviderAuthStatus;
	flow: AuthFlowState | null;
	error: string | null;
	/** True once the flow ended (error shown): inputs are locked. */
	disabled: boolean;
	onRespond: (requestId: string, response: AuthPromptResponse) => Promise<void>;
	onCancel: () => Promise<void>;
	onClose: () => void;
}): React.JSX.Element {
	const [cancelling, setCancelling] = useState(false);
	const title = status.oauthName ?? status.name ?? status.provider;

	const cancel = async (): Promise<void> => {
		if (cancelling) return;
		setCancelling(true);
		try {
			await onCancel();
		} finally {
			setCancelling(false);
		}
	};

	const display = flow?.display;
	const pendingPrompt = flow?.prompt;
	const statusMessage = flow?.message;

	let body: React.JSX.Element;
	if (!display && !pendingPrompt && !statusMessage) {
		body = (
			<div className="oauth-view" data-testid="oauth-progress">
				<p className="settings-note">Starting login…</p>
			</div>
		);
	} else {
		body = (
			<div className="oauth-view">
				{display?.type === "auth_url" && (
					<div data-testid="oauth-auth-url">
						<p className="settings-note">
							{display.instructions ?? "Open this URL in your browser to authorize access, then return here."}
						</p>
						<div className="oauth-url-row">
							<input
								type="text"
								className="modal-input"
								readOnly
								value={display.url}
								onFocus={(input) => input.target.select()}
								data-testid="oauth-url"
							/>
							<button
								type="button"
								className="btn btn-small"
								disabled={disabled}
								onClick={() => window.open(display.url, "_blank")}
								data-testid="oauth-open-browser"
							>
								Open in browser
							</button>
							<CopyButton text={display.url} label="Copy" />
						</div>
					</div>
				)}
				{display?.type === "device_code" && (
					<div data-testid="oauth-device-code">
						<p className="settings-note">Enter this code at {display.verificationUri}:</p>
						<div className="oauth-device-code" data-testid="oauth-user-code">
							{display.userCode}
						</div>
						<div className="oauth-url-row">
							<span className="settings-note oauth-verification-uri">{display.verificationUri}</span>
							<CopyButton text={display.userCode} label="Copy code" />
						</div>
						<p className="settings-note">Waiting for authentication…</p>
					</div>
				)}
				{pendingPrompt && (
					<PromptView
						prompt={pendingPrompt.prompt}
						disabled={disabled}
						onRespond={(response) => onRespond(pendingPrompt.requestId, response)}
					/>
				)}
				{statusMessage && (
					<p className="settings-note" data-testid="oauth-progress">
						{statusMessage}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="modal-backdrop modal-backdrop-nested" data-testid="oauth-login-dialog">
			<div className="modal modal-nested">
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Provider authentication</span>
						<h3 className="modal-title">Sign in with {title}</h3>
					</div>
					<button
						type="button"
						className="icon-button"
						onClick={onClose}
						aria-label="Close dialog"
						disabled={cancelling}
					>
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<div className="auth-dialog-meta">
						<span className={`auth-status-badge auth-status-badge-${status.source}`}>
							{status.configured ? status.source : "not configured"}
						</span>
						{status.isSubscription && (
							<p className="settings-note">Uses your {status.oauthName ?? status.name ?? status.provider} subscription.</p>
						)}
						{error && <p className="settings-error" data-testid="oauth-error">{error}</p>}
					</div>
					{body}
				</div>
				<div className="modal-actions">
					<button type="button" className="btn btn-small" onClick={onClose} disabled={cancelling}>
						Close
					</button>
					<button
						type="button"
						className="btn btn-small btn-danger"
						onClick={() => void cancel()}
						disabled={cancelling}
						data-testid="oauth-cancel"
					>
						{cancelling ? "Cancelling…" : "Cancel login"}
					</button>
				</div>
			</div>
		</div>
	);
}
