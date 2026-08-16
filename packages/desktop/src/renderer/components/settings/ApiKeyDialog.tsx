/**
 * ApiKeyDialog: nested modal for managing one provider's api key.
 *
 * Rendered above the settings modal (higher z-index backdrop). The draft is
 * local state and dies with the dialog, so keys never linger in the list
 * after closing. Saving and removal are one-way submissions handled by the
 * parent; errors arrive pre-redacted.
 */

import { useState } from "react";
import type { ProviderAuthStatus } from "@earendil-works/pi-agent-protocol";
import { Icon } from "../Icon.tsx";

export function ApiKeyDialog({
	status,
	busy,
	error,
	onSave,
	onRemove,
	onStartOAuthLogin,
	onClose,
}: {
	status: ProviderAuthStatus;
	busy: boolean;
	error: string | null;
	onSave: (apiKey: string) => Promise<void>;
	onRemove: () => Promise<void>;
	onStartOAuthLogin?: () => void;
	onClose: () => void;
}): React.JSX.Element {
	const [keyDraft, setKeyDraft] = useState("");
	const provider = status.provider;
	const envManaged = status.source === "environment" && status.configured;

	const save = async (): Promise<void> => {
		if (!keyDraft.trim()) {
			return;
		}
		await onSave(keyDraft.trim());
	};

	return (
		<div className="modal-backdrop modal-backdrop-nested" data-testid="auth-api-key-dialog">
			<div className="modal modal-nested">
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Provider authentication</span>
						<h3 className="modal-title">{status.name ?? provider}</h3>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<div className="auth-dialog-meta">
						<span className={`auth-status-badge auth-status-badge-${status.source}`}>
							{status.configured ? status.source : "not configured"}
						</span>
						{envManaged && (
							<p className="settings-note">
								Managed by a system environment variable; edit it outside Jip-pi, then restart the
								workspace or update the key below to override it.
							</p>
						)}
						{status.error && <p className="settings-error">{status.error}</p>}
						{error && <p className="settings-error">{error}</p>}
					</div>
					{status.supportsApiKey && (
						<label className="settings-field">
							<span>API key</span>
							<input
								type="password"
								className="modal-input"
								placeholder={status.configured ? "Replace stored key…" : "Enter API key…"}
								value={keyDraft}
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
								onChange={(event) => setKeyDraft(event.target.value)}
								data-testid={`auth-key-input-${provider}`}
							/>
						</label>
					)}
					{status.supportsOAuth && (
						<div className="auth-oauth-entry">
							<button
								type="button"
								className="btn btn-small"
								disabled={busy}
								onClick={onStartOAuthLogin}
								data-testid={`auth-oauth-login-${provider}`}
							>
								Sign in with OAuth…
							</button>
							{status.isSubscription && (
								<span className="settings-note">
									Uses your {status.oauthName ?? status.name ?? provider} subscription.
								</span>
							)}
						</div>
					)}
				</div>
				<div className="modal-actions">
					{status.configured && status.mutable && (
						<button
							type="button"
							className="btn btn-small btn-danger auth-dialog-remove"
							disabled={busy}
							onClick={() => void onRemove()}
							data-testid={`auth-remove-${provider}`}
						>
							Remove
						</button>
					)}
					<button type="button" className="btn btn-small" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					{status.supportsApiKey && (
						<button
							type="button"
							className="btn btn-small btn-primary"
							disabled={busy || !keyDraft.trim()}
							onClick={() => void save()}
							data-testid={`auth-save-${provider}`}
						>
							{busy ? "Saving…" : "Save key"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
