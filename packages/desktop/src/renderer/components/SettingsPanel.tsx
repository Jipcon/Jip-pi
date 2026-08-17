/**
 * Settings panel: two-column layout with a left navigation and one content
 * section at a time.
 *
 * Sections: General (Display and Storage subsections), Providers
 * (provider auth status + key management) and Diagnostics
 * (stderr log + structured provider diagnostics).
 */

import { useEffect, useState } from "react";
import type { ProviderAuthStatus } from "@earendil-works/pi-agent-protocol";
import type { DiagnosticEntry } from "../state/store.ts";
import type {
	CustomProviderConfig,
	CustomProviderFetchedModel,
	CustomProviderFetchRequest,
	CustomProviderMatchedModel,
	SessionStorageConfig,
	SessionStorageMode,
} from "../../shared/ipc.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { ApiKeyDialog } from "./settings/ApiKeyDialog.tsx";
import { CustomProviderDialog } from "./settings/CustomProviderDialog.tsx";
import { CustomProvidersSection } from "./settings/CustomProvidersSection.tsx";
import { ProvidersSection } from "./settings/ProvidersSection.tsx";
import { redactCredentialText } from "../state/redact.ts";

type SettingsSection = "general" | "providers" | "diagnostics";

const NAV_ITEMS: { id: SettingsSection; label: string; icon: IconName }[] = [
	{ id: "general", label: "General", icon: "settings" },
	{ id: "providers", label: "Providers", icon: "sparkles" },
	{ id: "diagnostics", label: "Diagnostics", icon: "alert" },
];

export function SettingsPanel({
	logs,
	diagnostics = [],
	authStatuses = [],
	showThinking,
	showToolDetails,
	showTurnStatus,
	sessionStorage,
	storageBusy,
	onShowThinkingChange,
	onShowToolDetailsChange,
	onShowTurnStatusChange,
	onPickSessionStorageRoot,
	onSessionStorageChange,
	onSaveApiKey,
	onRemoveCredential,
	onStartOAuthLogin,
	onListCustomProviders,
	onSaveCustomProvider,
	onDeleteCustomProvider,
	onReloadModels,
	onFetchCustomProviderModels,
	onMatchCustomProviderModels,
	onClose,
}: {
	logs: string[];
	diagnostics?: DiagnosticEntry[];
	authStatuses?: ProviderAuthStatus[];
	showThinking: boolean;
	showToolDetails: boolean;
	showTurnStatus: boolean;
	sessionStorage: SessionStorageConfig;
	storageBusy: boolean;
	onShowThinkingChange: (show: boolean) => void;
	onShowToolDetailsChange: (show: boolean) => void;
	onShowTurnStatusChange: (show: boolean) => void;
	onPickSessionStorageRoot: () => Promise<string | null>;
	onSessionStorageChange: (config: SessionStorageConfig) => Promise<void>;
	onSaveApiKey?: (provider: string, apiKey: string) => Promise<void>;
	onRemoveCredential?: (provider: string) => Promise<void>;
	onStartOAuthLogin?: (provider: string) => void;
	onListCustomProviders?: () => Promise<CustomProviderConfig[]>;
	onSaveCustomProvider?: (config: CustomProviderConfig) => Promise<void>;
	onDeleteCustomProvider?: (providerId: string) => Promise<void>;
	onReloadModels?: () => Promise<void>;
	onFetchCustomProviderModels?: (request: CustomProviderFetchRequest) => Promise<CustomProviderFetchedModel[]>;
	onMatchCustomProviderModels?: (ids: string[]) => Promise<CustomProviderMatchedModel[]>;
	onClose: () => void;
}): React.JSX.Element {
	const [activeSection, setActiveSection] = useState<SettingsSection>("general");
	const [storageMode, setStorageMode] = useState<SessionStorageMode>(sessionStorage.mode);
	const [customRoot, setCustomRoot] = useState(sessionStorage.customRoot ?? "");
	const [savingStorage, setSavingStorage] = useState(false);
	const [storageError, setStorageError] = useState<string | null>(null);

	// Provider key dialog: only one dialog is open at a time, so the draft is
	// a single string owned by the dialog and discarded on close.
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	const [authBusyProvider, setAuthBusyProvider] = useState<string | null>(null);
	const [authError, setAuthError] = useState<string | null>(null);

	// Custom providers (models.json). Only the GUI owns this list; the
	// backend-driven auth status list lives separately below it.
	const customProvidersEnabled =
		onListCustomProviders !== undefined &&
		onSaveCustomProvider !== undefined &&
		onDeleteCustomProvider !== undefined &&
		onReloadModels !== undefined;
	const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
	const [customBusy, setCustomBusy] = useState(false);
	const [customError, setCustomError] = useState<string | null>(null);
	const [customDialog, setCustomDialog] = useState<
		{ mode: "add" } | { mode: "edit"; config: CustomProviderConfig } | null
	>(null);

	const refreshCustomProviders = async (): Promise<void> => {
		if (!onListCustomProviders) return;
		try {
			const providers = await onListCustomProviders();
			setCustomProviders(providers);
		} catch (error) {
			setCustomError(error instanceof Error ? error.message : String(error));
		}
	};

	useEffect(() => {
		if (customProvidersEnabled && activeSection === "providers") {
			void refreshCustomProviders();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [customProvidersEnabled, activeSection]);

	useEffect(() => {
		setStorageMode(sessionStorage.mode);
		setCustomRoot(sessionStorage.customRoot ?? "");
	}, [sessionStorage]);

	const storageChanged =
		storageMode !== sessionStorage.mode ||
		(storageMode === "custom" && customRoot.trim() !== (sessionStorage.customRoot ?? ""));
	const storageControlsDisabled = storageBusy || savingStorage;

	const pickStorageRoot = async (): Promise<void> => {
		setStorageError(null);
		try {
			const root = await onPickSessionStorageRoot();
			if (root) {
				setCustomRoot(root);
				setStorageMode("custom");
			}
		} catch (error) {
			setStorageError(error instanceof Error ? error.message : String(error));
		}
	};

	const applySessionStorage = async (): Promise<void> => {
		setSavingStorage(true);
		setStorageError(null);
		try {
			const config: SessionStorageConfig =
				storageMode === "custom" ? { mode: storageMode, customRoot: customRoot.trim() } : { mode: storageMode };
			await onSessionStorageChange(config);
		} catch (error) {
			setStorageError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingStorage(false);
		}
	};

	// Defense in depth: credential-shaped fragments are stripped from auth
	// errors before they reach the DOM, even if a backend forgot to redact.
	const redactAuthError = (message: string): string => redactCredentialText(message);

	const selectedStatus = selectedProvider
		? (authStatuses.find((status) => status.provider === selectedProvider) ?? null)
		: null;

	const saveApiKey = async (provider: string, apiKey: string): Promise<void> => {
		if (!onSaveApiKey) {
			return;
		}
		setAuthBusyProvider(provider);
		setAuthError(null);
		try {
			await onSaveApiKey(provider, apiKey);
			// Success: close the dialog; the refreshed auth status shows behind it.
			setSelectedProvider(null);
		} catch (error) {
			setAuthError(redactAuthError(error instanceof Error ? error.message : String(error)));
		} finally {
			setAuthBusyProvider(null);
		}
	};

	const removeCredential = async (provider: string): Promise<void> => {
		if (!onRemoveCredential) {
			return;
		}
		setAuthBusyProvider(provider);
		setAuthError(null);
		try {
			await onRemoveCredential(provider);
			setSelectedProvider(null);
		} catch (error) {
			setAuthError(redactAuthError(error instanceof Error ? error.message : String(error)));
		} finally {
			setAuthBusyProvider(null);
		}
	};

	const closeDialog = (): void => {
		setSelectedProvider(null);
		setAuthError(null);
		setAuthBusyProvider(null);
	};

	const saveCustomProvider = async (config: CustomProviderConfig, apiKey?: string): Promise<void> => {
		if (!onSaveCustomProvider) return;
		setCustomBusy(true);
		setCustomError(null);
		try {
			await onSaveCustomProvider(config);
			// The dialog's optional API key powers the model-list fetch; store it
			// through the credential API (auth.json) so models.json stays
			// secret-free. Saving is idempotent (upsert), so a retry after a key
			// failure re-applies both steps safely.
			const trimmedKey = apiKey?.trim();
			if (trimmedKey && onSaveApiKey) {
				await onSaveApiKey(config.id, trimmedKey);
			}
			setCustomDialog(null);
			await refreshCustomProviders();
		} catch (error) {
			setCustomError(error instanceof Error ? error.message : String(error));
		} finally {
			setCustomBusy(false);
		}
	};

	const deleteCustomProvider = async (providerId: string): Promise<void> => {
		if (!onDeleteCustomProvider) return;
		setCustomBusy(true);
		setCustomError(null);
		try {
			await onDeleteCustomProvider(providerId);
			await refreshCustomProviders();
		} catch (error) {
			setCustomError(error instanceof Error ? error.message : String(error));
		} finally {
			setCustomBusy(false);
		}
	};

	const reloadModels = async (): Promise<void> => {
		if (!onReloadModels) return;
		setCustomBusy(true);
		setCustomError(null);
		try {
			await onReloadModels();
			await refreshCustomProviders();
		} catch (error) {
			setCustomError(error instanceof Error ? error.message : String(error));
		} finally {
			setCustomBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" data-testid="settings-panel">
			<div className="modal modal-wide modal-settings">
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Jip-pi</span>
						<h3 className="modal-title">Settings</h3>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
						<Icon name="close" />
					</button>
				</div>
				<div className="settings-layout">
					<nav className="settings-nav" aria-label="Settings sections">
						{NAV_ITEMS.map((item) => (
							<button
								type="button"
								key={item.id}
								className={`settings-nav-item${activeSection === item.id ? " settings-nav-item-active" : ""}`}
								onClick={() => setActiveSection(item.id)}
								aria-current={activeSection === item.id ? "page" : undefined}
								data-testid={`settings-nav-${item.id}`}
							>
								<Icon name={item.icon} size={15} />
								<span>{item.label}</span>
							</button>
						))}
					</nav>
					<div className="settings-content">
						{activeSection === "general" && (
							<>
								<h4 className="inspector-subheading">Display</h4>
								<div className="settings-options">
									<label className="settings-toggle">
										<input
											type="checkbox"
											checked={showThinking}
											onChange={(event) => onShowThinkingChange(event.target.checked)}
										/>
										<span>
											<strong>Show thinking blocks</strong>
											<small>Hidden by default to keep the transcript focused.</small>
										</span>
									</label>
									<label className="settings-toggle">
										<input
											type="checkbox"
											checked={showToolDetails}
											onChange={(event) => onShowToolDetailsChange(event.target.checked)}
										/>
										<span>
											<strong>Show tool arguments and output</strong>
											<small>When off, chat only shows tool name and execution status.</small>
										</span>
									</label>
									<label className="settings-toggle">
										<input
											type="checkbox"
											checked={showTurnStatus}
											onChange={(event) => onShowTurnStatusChange(event.target.checked)}
										/>
										<span>
											<strong>Show Turn Status</strong>
											<small>Shows token usage and speed statistics after each turn.</small>
										</span>
									</label>
								</div>
								<h4 className="inspector-subheading">Storage</h4>
								<div className="settings-storage">
									<label className="settings-field">
										<span>Location</span>
										<select
											className="modal-input"
											value={storageMode}
											disabled={storageControlsDisabled}
											onChange={(event) => setStorageMode(event.target.value as SessionStorageMode)}
											data-testid="session-storage-mode"
										>
											<option value="default">Jip-pi user directory</option>
											<option value="workspace">Inside each workspace (recommended)</option>
											<option value="custom">Custom root</option>
										</select>
									</label>
									{storageMode === "custom" && (
										<div className="settings-storage-path">
											<input
												type="text"
												className="modal-input"
												value={customRoot}
												disabled={storageControlsDisabled}
												onChange={(event) => setCustomRoot(event.target.value)}
												placeholder="Choose an absolute directory"
												data-testid="session-storage-root"
											/>
											<button
												type="button"
												className="btn"
												disabled={storageControlsDisabled}
												onClick={() => void pickStorageRoot()}
											>
												Browse
											</button>
										</div>
									)}
									<p className={`settings-note ${storageMode === "workspace" ? "settings-note-warning" : ""}`}>
										{storageMode === "default" &&
											"Sessions stay under Jip-pi's user directory, separated by workspace."}
										{storageMode === "workspace" &&
											"Sessions are written to .pi/sessions. Exclude this directory from version control."}
										{storageMode === "custom" &&
											"Jip-pi creates one encoded subdirectory per workspace under this root."}
									</p>
									<p className="settings-note">
									Applying this setting restarts the backend. Existing sessions in Jip-pi's default directory remain visible.
									</p>
									{storageBusy && <p className="settings-error">Wait for the current response to finish.</p>}
									{storageError && <p className="settings-error">{storageError}</p>}
									<button
										type="button"
										className="btn btn-small"
										disabled={
											!storageChanged ||
											storageControlsDisabled ||
											(storageMode === "custom" && customRoot.trim().length === 0)
										}
										onClick={() => void applySessionStorage()}
										data-testid="apply-session-storage"
									>
										{savingStorage ? "Applying…" : "Apply storage setting"}
									</button>
								</div>
							</>
						)}
						{activeSection === "providers" && (
							<>
								<h4 className="inspector-subheading">Providers</h4>
								{customProvidersEnabled && (
									<CustomProvidersSection
										providers={customProviders}
										busy={customBusy}
										onAdd={() => setCustomDialog({ mode: "add" })}
										onEdit={(providerId) => {
											const config = customProviders.find((entry) => entry.id === providerId);
											if (config) setCustomDialog({ mode: "edit", config });
										}}
										onDelete={(providerId) => void deleteCustomProvider(providerId)}
										onReload={() => void reloadModels()}
									/>
								)}
								{customError && <p className="settings-error">{customError}</p>}
								<ProvidersSection statuses={authStatuses} onSelect={setSelectedProvider} />
							</>
						)}
						{activeSection === "diagnostics" && (
							<>
								<h4 className="inspector-subheading">Diagnostics (stderr)</h4>
								<pre className="log-viewer" data-testid="log-viewer">
									{logs.length === 0 ? "(no diagnostics)" : logs.slice(-200).join("\n")}
								</pre>
								<h4 className="inspector-subheading">Provider diagnostics</h4>
								<div className="provider-diagnostics" data-testid="provider-diagnostics">
									{diagnostics.length === 0 ? (
										<p className="settings-note">(no structured provider diagnostics)</p>
									) : (
										diagnostics.slice(-100).map((entry) => (
											<div className="provider-diagnostic" key={entry.id}>
												<span className={`provider-diagnostic-source provider-diagnostic-source-${entry.source}`}>
													{entry.source === "backend" ? "backend" : entry.label}
												</span>
												{entry.type && <span className="provider-diagnostic-type">{entry.type}</span>}
												<span className="provider-diagnostic-message">{entry.message}</span>
											</div>
										))
									)}
								</div>
							</>
						)}
					</div>
				</div>
				<div className="modal-actions">
					<button type="button" className="btn btn-primary" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
			{selectedStatus && (
				<ApiKeyDialog
					status={selectedStatus}
					busy={authBusyProvider === selectedStatus.provider}
					error={authError}
					onSave={(apiKey) => saveApiKey(selectedStatus.provider, apiKey)}
					onRemove={() => removeCredential(selectedStatus.provider)}
					onStartOAuthLogin={
						onStartOAuthLogin
							? () => {
									const provider = selectedStatus.provider;
									closeDialog();
									onStartOAuthLogin?.(provider);
							  }
							: undefined
					}
					onClose={closeDialog}
				/>
			)}
			{customDialog && (
				<CustomProviderDialog
					initial={customDialog.mode === "edit" ? customDialog.config : undefined}
					busy={customBusy}
					error={customError}
					onSave={(config, apiKey) => saveCustomProvider(config, apiKey)}
					onFetchModels={onFetchCustomProviderModels}
					onMatchModels={onMatchCustomProviderModels}
					onClose={() => {
						setCustomDialog(null);
						setCustomError(null);
					}}
				/>
			)}
		</div>
	);
}
