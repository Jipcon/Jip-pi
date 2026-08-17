/**
 * CustomProvidersSection: list of GUI-managed custom providers from
 * ~/.pi/agent/models.json, with add / edit / delete actions.
 *
 * Editing happens in the CustomProviderDialog. Deleting is immediate (the
 * row's delete button) after a confirm — provider definitions have no
 * credential-shaped data, so no redaction concerns. The section only renders
 * when the host provides the custom-provider callbacks (it is a GUI-only
 * concern layered on top of the backend-driven provider auth list).
 */

import type { CustomProviderConfig } from "../../../shared/ipc.ts";
import { Icon } from "../Icon.tsx";

export function CustomProvidersSection({
	providers,
	busy,
	onAdd,
	onEdit,
	onDelete,
	onReload,
}: {
	providers: CustomProviderConfig[];
	busy: boolean;
	onAdd: () => void;
	onEdit: (providerId: string) => void;
	onDelete: (providerId: string) => void;
	onReload: () => void;
}): React.JSX.Element {
	return (
		<div className="custom-providers-section" data-testid="custom-providers-section">
			<div className="custom-providers-section-header">
				<span className="provider-group-title">Custom providers</span>
				<div className="custom-providers-section-actions">
					<button
						type="button"
						className="btn btn-small"
						disabled={busy}
						onClick={onReload}
						data-testid="custom-providers-reload"
						title="Reload the model catalog from models.json"
					>
						Reload models
					</button>
					<button
						type="button"
						className="btn btn-small btn-primary"
						disabled={busy}
						onClick={onAdd}
						data-testid="custom-providers-add"
					>
						Add custom provider
					</button>
				</div>
			</div>
			{providers.length === 0 ? (
				<p className="settings-note">
					No custom providers configured. Add one to use a self-hosted, OpenAI-compatible, or proxied
					endpoint.
				</p>
			) : (
				<div className="provider-list-card">
					{providers.map((provider) => (
						<div className="provider-row custom-provider-row" key={provider.id}>
							<div className="custom-provider-row-info">
								<span className="provider-row-name">{provider.name ?? provider.id}</span>
								<span className="custom-provider-row-meta">
									<span className="custom-provider-row-id">{provider.id}</span>
									<span className="custom-provider-row-url">{provider.baseUrl}</span>
									<span className="custom-provider-row-count">
										{provider.models.length} model{provider.models.length === 1 ? "" : "s"}
									</span>
								</span>
							</div>
							<div className="custom-provider-row-actions">
								<button
									type="button"
									className="icon-button"
									aria-label={`Edit ${provider.name ?? provider.id}`}
									disabled={busy}
									onClick={() => onEdit(provider.id)}
									data-testid={`custom-provider-edit-${provider.id}`}
								>
									<Icon name="settings" size={14} />
								</button>
								<button
									type="button"
									className="icon-button"
									aria-label={`Delete ${provider.name ?? provider.id}`}
									disabled={busy}
									onClick={() => {
										if (
											window.confirm(
												`Remove custom provider "${provider.name ?? provider.id}" from models.json?`,
											)
										) {
											onDelete(provider.id);
										}
									}}
									data-testid={`custom-provider-delete-${provider.id}`}
								>
									<Icon name="close" size={14} />
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
