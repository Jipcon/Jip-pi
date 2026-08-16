/**
 * ProvidersSection: searchable, grouped provider list for the Settings
 * Providers page.
 *
 * Connected providers (configured === true) are grouped on top, environment-
 * sourced credentials first; everything else goes under "Other providers".
 * Rows only navigate: editing happens in the ApiKeyDialog.
 */

import { useMemo, useState } from "react";
import type { ProviderAuthStatus } from "@earendil-works/pi-agent-protocol";
import { Icon } from "../Icon.tsx";

function byName(a: ProviderAuthStatus, b: ProviderAuthStatus): number {
	return (a.name ?? a.provider).toLowerCase().localeCompare((b.name ?? b.provider).toLowerCase());
}

export function ProvidersSection({
	statuses,
	onSelect,
}: {
	statuses: ProviderAuthStatus[];
	onSelect: (provider: string) => void;
}): React.JSX.Element {
	const [search, setSearch] = useState("");

	const groups = useMemo(() => {
		const query = search.trim().toLowerCase();
		const list = query
			? statuses.filter(
					(status) =>
						status.provider.toLowerCase().includes(query) ||
						(status.name ?? "").toLowerCase().includes(query),
				)
			: statuses;
		const connected = list
			.filter((status) => status.configured)
			.sort((a, b) => {
				const aEnvFirst = a.source === "environment" ? 0 : 1;
				const bEnvFirst = b.source === "environment" ? 0 : 1;
				if (aEnvFirst !== bEnvFirst) return aEnvFirst - bEnvFirst;
				return byName(a, b);
			});
		const other = list.filter((status) => !status.configured).sort(byName);
		return { connected, other };
	}, [statuses, search]);

	const hasAny = groups.connected.length > 0 || groups.other.length > 0;

	const renderGroup = (title: string, entries: ProviderAuthStatus[]): React.JSX.Element | null => {
		if (entries.length === 0) {
			return null;
		}
		return (
			<>
				<div className="provider-group-title">{title}</div>
				<div className="provider-list-card">
					{entries.map((status) => (
						<button
							type="button"
							className="provider-row"
							key={status.provider}
							onClick={() => onSelect(status.provider)}
							data-testid={`auth-provider-row-${status.provider}`}
						>
							<span className="provider-row-name">{status.name ?? status.provider}</span>
							<span className={`auth-status-badge auth-status-badge-${status.source}`}>
								{status.configured ? status.source : "not configured"}
							</span>
							<span className="provider-row-chevron" aria-hidden="true">
								<Icon name="chevron-right" size={14} />
							</span>
						</button>
					))}
				</div>
			</>
		);
	};

	return (
		<div className="providers-section" data-testid="providers-section">
			<input
				type="search"
				className="modal-input auth-provider-search"
				placeholder="Search providers…"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				data-testid="auth-provider-search"
			/>
			{statuses.length === 0 ? (
				<p className="settings-note">(no provider auth status available)</p>
			) : !hasAny ? (
				<p className="settings-note">(no providers match)</p>
			) : (
				<>
					{renderGroup("Connected providers", groups.connected)}
					{renderGroup("Other providers", groups.other)}
				</>
			)}
			<p className="settings-note">
				Stored keys are written through Jip-pi's credential store and never shown back to the UI.
			</p>
		</div>
	);
}
