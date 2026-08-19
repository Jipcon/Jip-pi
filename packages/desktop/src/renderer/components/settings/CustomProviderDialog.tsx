/**
 * CustomProviderDialog: nested modal for adding or editing a custom provider
 * definition persisted to ~/.pi/agent/models.json.
 *
 * The form owns only the GUI-managed subset of a models.json provider entry
 * (id, name, baseUrl, api, authHeader, headers, models). An optional API key
 * input powers the one-shot model-list fetch and is stored through the
 * credential API (auth.json) on save — it is never written into models.json
 * by this dialog.
 */

import { useState } from "react";
import type { ModelThinkingLevel } from "@earendil-works/pi-agent-protocol";
import type {
	CustomProviderApi,
	CustomProviderConfig,
	CustomProviderFetchedModel,
	CustomProviderFetchRequest,
	CustomProviderMatchRequest,
	CustomProviderMatchedModel,
	CustomProviderModelConfig,
} from "../../../shared/ipc.ts";
import { redactCredentialText } from "../../state/redact.ts";
import { Icon } from "../Icon.tsx";

const API_OPTIONS: { value: CustomProviderApi; label: string }[] = [
	{ value: "openai-completions", label: "OpenAI Chat Completions (most compatible)" },
	{ value: "openai-responses", label: "OpenAI Responses API" },
	{ value: "anthropic-messages", label: "Anthropic Messages API" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
];

const THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Fetch lifecycle: the fetched checklist is only published once catalog
 * matching has settled, so models can never be added before `fetchedMeta`
 * is populated (adding early would create rows without the pre-fill).
 */
type FetchPhase = "idle" | "fetching" | "matching";

interface ModelDraft {
	id: string;
	name: string;
	reasoning: boolean;
	text: boolean;
	image: boolean;
	contextWindow: string;
	maxTokens: string;
	thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}

function toDraft(model: CustomProviderModelConfig): ModelDraft {
	return {
		id: model.id,
		name: model.name ?? "",
		reasoning: model.reasoning ?? false,
		text: model.input?.includes("text") ?? true,
		image: model.input?.includes("image") ?? false,
		contextWindow: model.contextWindow !== undefined ? String(model.contextWindow) : "",
		maxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : "",
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

function emptyDraft(): ModelDraft {
	return { id: "", name: "", reasoning: false, text: true, image: false, contextWindow: "", maxTokens: "" };
}

function parsePositiveInt(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Levels with a custom provider value, joined for checklist display. */
function thinkingSummary(map: Partial<Record<ModelThinkingLevel, string | null>>): string {
	return THINKING_LEVELS.filter((level) => map[level] !== null && map[level] !== undefined).join("/");
}

export function CustomProviderDialog({
	initial,
	busy,
	error,
	onSave,
	onFetchModels,
	onMatchModels,
	onClose,
}: {
	initial?: CustomProviderConfig;
	busy: boolean;
	error: string | null;
	onSave: (config: CustomProviderConfig, apiKey?: string) => Promise<void>;
	onFetchModels?: (request: CustomProviderFetchRequest) => Promise<CustomProviderFetchedModel[]>;
	onMatchModels?: (request: CustomProviderMatchRequest) => Promise<CustomProviderMatchedModel[]>;
	onClose: () => void;
}): React.JSX.Element {
	const editing = initial !== undefined;
	const [id, setId] = useState(initial?.id ?? "");
	const [name, setName] = useState(initial?.name ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [api, setApi] = useState<CustomProviderApi>(initial?.api ?? "openai-completions");
	const [apiKey, setApiKeyDraft] = useState("");
	const [authHeader, setAuthHeader] = useState(initial?.authHeader === true);
	const [headers, setHeaders] = useState<{ key: string; value: string }[]>(
		initial?.headers ? Object.entries(initial.headers).map(([key, value]) => ({ key, value })) : [],
	);
	const [models, setModels] = useState<ModelDraft[]>(initial?.models ? initial.models.map(toDraft) : [emptyDraft()]);
	const [validationError, setValidationError] = useState<string | null>(null);
	const [fetchPhase, setFetchPhase] = useState<FetchPhase>("idle");
	const [fetchedModels, setFetchedModels] = useState<CustomProviderFetchedModel[]>([]);
	const [selectedFetched, setSelectedFetched] = useState<ReadonlySet<string>>(new Set());
	const [fetchedMeta, setFetchedMeta] = useState<ReadonlyMap<string, CustomProviderMatchedModel>>(new Map());
	const [fetchError, setFetchError] = useState<string | null>(null);
	// Non-blocking: catalog matching failures still leave the fetched list
	// usable, the user just fills the parameters manually.
	const [matchError, setMatchError] = useState<string | null>(null);

	const addHeader = (): void => setHeaders((prev) => [...prev, { key: "", value: "" }]);
	const updateHeader = (index: number, field: "key" | "value", value: string): void =>
		setHeaders((prev) => prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
	const removeHeader = (index: number): void =>
		setHeaders((prev) => prev.filter((_, i) => i !== index));

	const addModel = (): void => setModels((prev) => [...prev, emptyDraft()]);
	const updateModel = (index: number, patch: Partial<ModelDraft>): void =>
		setModels((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
	const removeModel = (index: number): void =>
		setModels((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));

	const fetchModels = async (): Promise<void> => {
		if (!onFetchModels) return;
		const trimmedBaseUrl = baseUrl.trim();
		if (trimmedBaseUrl.length === 0) {
			setFetchError("Enter a base URL before fetching models");
			return;
		}
		setFetchPhase("fetching");
		setFetchError(null);
		setMatchError(null);
		try {
			const models = await onFetchModels({
				baseUrl: trimmedBaseUrl,
				api,
				apiKey: apiKey.trim() || undefined,
			});
			if (models.length === 0) {
				setFetchedModels([]);
				setSelectedFetched(new Set());
				setFetchError("The endpoint returned no models");
				return;
			}
			setFetchPhase("matching");
			// Local-catalog metadata matching is best-effort: failures never block
			// the fetched list itself, the user can fill the fields manually.
			let matches: CustomProviderMatchedModel[] = [];
			if (onMatchModels) {
				try {
					matches = await onMatchModels({ ids: models.map((model) => model.id), baseUrl: trimmedBaseUrl, api });
				} catch (error) {
					setMatchError(redactCredentialText(error instanceof Error ? error.message : String(error)));
				}
			}
			// Publish the list, its selection and the metadata atomically so
			// "Add selected" can never run against a half-matched result.
			setFetchedModels(models);
			setSelectedFetched(new Set(models.map((model) => model.id)));
			setFetchedMeta(
				new Map(matches.filter((match) => match.status !== "unmatched").map((match) => [match.id, match])),
			);
		} catch (error) {
			setFetchError(redactCredentialText(error instanceof Error ? error.message : String(error)));
		} finally {
			setFetchPhase("idle");
		}
	};

	const toggleFetched = (modelId: string): void =>
		setSelectedFetched((prev) => {
			const next = new Set(prev);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});

	const allSelected = fetchedModels.length > 0 && fetchedModels.every((model) => selectedFetched.has(model.id));

	const toggleAllFetched = (): void =>
		setSelectedFetched(allSelected ? new Set() : new Set(fetchedModels.map((model) => model.id)));

	/** Catalog-metadata chips for one fetched checklist row. */
	const metaChips = (model: CustomProviderFetchedModel): React.JSX.Element | null => {
		const meta = fetchedMeta.get(model.id);
		if (!meta) return null;
		return (
			<>
				{meta.status === "ambiguous" && (
					<span
						className="custom-provider-fetched-meta custom-provider-fetched-ambiguous"
						data-testid={`fetched-model-ambiguous-${model.id}`}
					>
						Catalog match ambiguous
					</span>
				)}
				{meta.reasoning === true && <span className="custom-provider-fetched-meta">thinking</span>}
				{meta.contextWindow !== undefined && (
					<span className="custom-provider-fetched-meta">catalog ctx {meta.contextWindow}</span>
				)}
				{meta.maxTokens !== undefined && (
					<span className="custom-provider-fetched-meta">catalog max {meta.maxTokens}</span>
				)}
				{meta.thinkingLevelMap && (
					<span className="custom-provider-fetched-meta">levels {thinkingSummary(meta.thinkingLevelMap)}</span>
				)}
			</>
		);
	};

	const setThinkingLevel = (index: number, level: ModelThinkingLevel, value: string | null | undefined): void =>
		setModels((prev) =>
			prev.map((draft, i) => {
				if (i !== index) return draft;
				const map: Partial<Record<ModelThinkingLevel, string | null>> = { ...(draft.thinkingLevelMap ?? {}) };
				if (value === undefined) delete map[level];
				else map[level] = value;
				return { ...draft, thinkingLevelMap: map };
			}),
		);

	const addSelectedFetched = (): void => {
		// Defensive guard for the button state: metadata must be settled before
		// rows are created, otherwise the pre-fill is lost for those rows.
		if (fetchPhase !== "idle") return;
		const existing = new Set(models.map((draft) => draft.id.trim()).filter((modelId) => modelId.length > 0));
		const additions = fetchedModels
			.filter((model) => selectedFetched.has(model.id) && !existing.has(model.id))
			.map((model) => {
				const meta = fetchedMeta.get(model.id);
				return toDraft({
					id: model.id,
					name: model.name ?? meta?.name,
					reasoning: meta?.reasoning,
					input: meta?.input,
					contextWindow: model.contextWindow ?? meta?.contextWindow,
					maxTokens: model.maxTokens ?? meta?.maxTokens,
					thinkingLevelMap: meta?.thinkingLevelMap,
				});
			});
		if (additions.length > 0) {
			setModels((prev) => [...prev, ...additions]);
		}
		setFetchedModels([]);
		setSelectedFetched(new Set());
		setFetchedMeta(new Map());
		setFetchError(null);
		setMatchError(null);
	};

	const save = async (): Promise<void> => {
		const trimmedId = id.trim();
		if (trimmedId.length === 0) {
			setValidationError("Provider id must not be empty");
			return;
		}
		if (baseUrl.trim().length === 0) {
			setValidationError("Base URL must not be empty");
			return;
		}
		const modelDrafts = models
			.map((draft) => ({ draft, trimmedId: draft.id.trim() }))
			.filter((entry) => entry.trimmedId.length > 0);
		if (modelDrafts.length === 0) {
			setValidationError("At least one model with a non-empty id is required");
			return;
		}
		const serializedModels: CustomProviderModelConfig[] = modelDrafts.map(({ draft, trimmedId }) => {
			const model: CustomProviderModelConfig = { id: trimmedId };
			const trimmedName = draft.name.trim();
			if (trimmedName.length > 0) model.name = trimmedName;
			if (draft.reasoning) model.reasoning = true;
			const input: ("text" | "image")[] = [];
			if (draft.text) input.push("text");
			if (draft.image) input.push("image");
			if (input.length > 0 && !(input.length === 1 && input[0] === "text")) model.input = input;
			const contextWindow = parsePositiveInt(draft.contextWindow);
			if (contextWindow !== undefined) model.contextWindow = contextWindow;
			const maxTokens = parsePositiveInt(draft.maxTokens);
			if (maxTokens !== undefined) model.maxTokens = maxTokens;
			if (draft.thinkingLevelMap) {
				const cleaned: Partial<Record<ModelThinkingLevel, string | null>> = {};
				for (const level of THINKING_LEVELS) {
					const value = draft.thinkingLevelMap[level];
					if (value === null || (typeof value === "string" && value.length > 0)) cleaned[level] = value;
				}
				if (Object.keys(cleaned).length > 0) model.thinkingLevelMap = cleaned;
			}
			return model;
		});
		const serializedHeaders: Record<string, string> = {};
		for (const entry of headers) {
			const key = entry.key.trim();
			if (key.length === 0) continue;
			serializedHeaders[key] = entry.value;
		}
		const config: CustomProviderConfig = {
			id: trimmedId,
			baseUrl: baseUrl.trim(),
			api,
			models: serializedModels,
		};
		const trimmedName = name.trim();
		if (trimmedName.length > 0) config.name = trimmedName;
		if (authHeader) config.authHeader = true;
		if (Object.keys(serializedHeaders).length > 0) config.headers = serializedHeaders;
		setValidationError(null);
		await onSave(config, apiKey.trim() || undefined);
	};

	const displayedError = validationError ?? error;

	return (
		<div className="modal-backdrop modal-backdrop-nested" data-testid="custom-provider-dialog">
			<div className="modal modal-nested modal-narrow-scroll modal-wide">
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Custom provider</span>
						<h3 className="modal-title">{editing ? (initial?.name ?? initial?.id ?? "Edit provider") : "Add provider"}</h3>
					</div>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog" disabled={busy}>
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<p className="settings-note">
						Writes an entry to <code>~/.pi/agent/models.json</code>. If you enter an API key it is stored
						through the credential API on save — never written into models.json.
					</p>
					<div className="custom-provider-form">
						<label className="settings-field">
							<span>Provider id</span>
							<input
								type="text"
								className="modal-input"
								placeholder="my-provider"
								value={id}
								autoComplete="off"
								spellCheck={false}
								disabled={busy || editing}
								onChange={(event) => setId(event.target.value)}
								data-testid="custom-provider-id"
							/>
						</label>
						<label className="settings-field">
							<span>Display name (optional)</span>
							<input
								type="text"
								className="modal-input"
								placeholder="My Provider"
								value={name}
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
								onChange={(event) => setName(event.target.value)}
								data-testid="custom-provider-name"
							/>
						</label>
						<label className="settings-field">
							<span>Base URL</span>
							<input
								type="text"
								className="modal-input"
								placeholder="http://localhost:11434/v1"
								value={baseUrl}
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
								onChange={(event) => setBaseUrl(event.target.value)}
								data-testid="custom-provider-base-url"
							/>
						</label>
						<label className="settings-field">
							<span>API</span>
							<select
								className="modal-input"
								value={api}
								disabled={busy}
								onChange={(event) => setApi(event.target.value as CustomProviderApi)}
								data-testid="custom-provider-api"
							>
								{API_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						<label className="settings-field">
							<span>API key (optional)</span>
							<input
								type="password"
								className="modal-input"
								placeholder="Used to fetch the model list; stored on save"
								value={apiKey}
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
								onChange={(event) => setApiKeyDraft(event.target.value)}
								data-testid="custom-provider-api-key"
							/>
						</label>
						<label className="settings-toggle">
							<input
								type="checkbox"
								checked={authHeader}
								disabled={busy}
								onChange={(event) => setAuthHeader(event.target.checked)}
								data-testid="custom-provider-auth-header"
							/>
							<span>
								<strong>Send Authorization: Bearer header</strong>
								<small>Enable for providers expecting a bearer token instead of a custom header.</small>
							</span>
						</label>

						<div className="custom-provider-subsection">
							<div className="custom-provider-subsection-header">
								<span>Custom headers (optional)</span>
								<button
									type="button"
									className="btn btn-small"
									disabled={busy}
									onClick={addHeader}
									data-testid="custom-provider-add-header"
								>
									Add header
								</button>
							</div>
							{headers.map((entry, index) => (
								<div className="custom-provider-kv-row" key={index}>
									<input
										type="text"
										className="modal-input"
										placeholder="header-name"
										value={entry.key}
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
										onChange={(event) => updateHeader(index, "key", event.target.value)}
										data-testid={`custom-provider-header-key-${index}`}
									/>
									<input
										type="text"
										className="modal-input"
										placeholder="value ($ENV_VAR or literal)"
										value={entry.value}
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
										onChange={(event) => updateHeader(index, "value", event.target.value)}
										data-testid={`custom-provider-header-value-${index}`}
									/>
									<button
										type="button"
										className="icon-button"
										onClick={() => removeHeader(index)}
										aria-label="Remove header"
										disabled={busy}
										data-testid={`custom-provider-remove-header-${index}`}
									>
										<Icon name="close" size={14} />
									</button>
								</div>
							))}
						</div>

						<div className="custom-provider-subsection">
							<div className="custom-provider-subsection-header">
								<span>Models</span>
								<div className="custom-provider-subsection-actions">
									{onFetchModels && (
										<button
											type="button"
											className="btn btn-small"
											disabled={busy || fetchPhase !== "idle" || baseUrl.trim().length === 0}
											onClick={() => void fetchModels()}
											data-testid="custom-provider-fetch"
										>
											{fetchPhase === "fetching"
												? "Fetching models…"
												: fetchPhase === "matching"
													? "Matching catalog metadata…"
													: "Fetch models"}
										</button>
									)}
									<button
										type="button"
										className="btn btn-small"
										disabled={busy}
										onClick={addModel}
										data-testid="custom-provider-add-model"
									>
										Add model
									</button>
								</div>
							</div>
							{fetchError && <p className="settings-error">{fetchError}</p>}
							{matchError && (
								<p className="settings-note settings-note-warning" data-testid="custom-provider-match-warning">
									Catalog metadata could not be loaded ({matchError}). Parameters can still be entered
									manually.
								</p>
							)}
							{fetchedModels.length > 0 && (
								<div className="custom-provider-fetched" data-testid="custom-provider-fetched">
									<div className="custom-provider-fetched-header">
										<span>{fetchedModels.length} models found — select which to add</span>
										<button
											type="button"
											className="btn btn-small"
											disabled={busy}
											onClick={toggleAllFetched}
											data-testid="custom-provider-toggle-all"
										>
											{allSelected ? "Select none" : "Select all"}
										</button>
									</div>
									<div className="custom-provider-fetched-list">
										{fetchedModels.map((model) => (
											<label className="custom-provider-fetched-row" key={model.id}>
												<input
													type="checkbox"
													checked={selectedFetched.has(model.id)}
													disabled={busy}
													onChange={() => toggleFetched(model.id)}
													data-testid={`fetched-model-check-${model.id}`}
												/>
												<span className="custom-provider-fetched-id">{model.id}</span>
												{model.name !== undefined && (
													<span className="custom-provider-fetched-meta">{model.name}</span>
												)}
												{model.contextWindow !== undefined && (
													<span className="custom-provider-fetched-meta">context {model.contextWindow}</span>
												)}
												{model.maxTokens !== undefined && (
													<span className="custom-provider-fetched-meta">max out {model.maxTokens}</span>
												)}
												{metaChips(model)}
											</label>
										))}
									</div>
									<button
										type="button"
										className="btn btn-small"
										disabled={busy || fetchPhase !== "idle" || selectedFetched.size === 0}
										onClick={addSelectedFetched}
										data-testid="custom-provider-add-selected"
									>
										Add selected ({selectedFetched.size})
									</button>
								</div>
							)}
							{models.map((draft, index) => (
								<div className="custom-provider-model-row" key={index} data-testid={`custom-provider-model-${index}`}>
									<div className="custom-provider-model-line">
										<input
											type="text"
											className="modal-input"
											placeholder="model id"
											value={draft.id}
											autoComplete="off"
											spellCheck={false}
											disabled={busy}
											onChange={(event) => updateModel(index, { id: event.target.value })}
											data-testid={`custom-provider-model-id-${index}`}
										/>
										<input
											type="text"
											className="modal-input"
											placeholder="display name (optional)"
											value={draft.name}
											autoComplete="off"
											spellCheck={false}
											disabled={busy}
											onChange={(event) => updateModel(index, { name: event.target.value })}
											data-testid={`custom-provider-model-name-${index}`}
										/>
										<button
											type="button"
											className="icon-button"
											onClick={() => removeModel(index)}
											aria-label="Remove model"
											disabled={busy || models.length <= 1}
											data-testid={`custom-provider-remove-model-${index}`}
										>
											<Icon name="close" size={14} />
										</button>
									</div>
									<div className="custom-provider-model-options">
										<label className="settings-toggle settings-toggle-inline">
											<input
												type="checkbox"
												checked={draft.reasoning}
												disabled={busy}
												onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
												data-testid={`custom-provider-model-reasoning-${index}`}
											/>
											<span>Reasoning</span>
										</label>
										<label className="settings-toggle settings-toggle-inline">
											<input
												type="checkbox"
												checked={draft.text}
												disabled={busy}
												onChange={(event) => updateModel(index, { text: event.target.checked })}
											/>
											<span>Text</span>
										</label>
										<label className="settings-toggle settings-toggle-inline">
											<input
												type="checkbox"
												checked={draft.image}
												disabled={busy}
												onChange={(event) => updateModel(index, { image: event.target.checked })}
											/>
											<span>Image</span>
										</label>
										<input
											type="number"
											className="modal-input modal-input-narrow"
											placeholder="context window"
											value={draft.contextWindow}
											autoComplete="off"
											disabled={busy}
											onChange={(event) => updateModel(index, { contextWindow: event.target.value })}
											data-testid={`custom-provider-model-context-${index}`}
										/>
										<input
											type="number"
											className="modal-input modal-input-narrow"
											placeholder="max tokens"
											value={draft.maxTokens}
											autoComplete="off"
											disabled={busy}
											onChange={(event) => updateModel(index, { maxTokens: event.target.value })}
											data-testid={`custom-provider-model-max-tokens-${index}`}
										/>
									</div>
									{draft.reasoning && (
										<div className="custom-provider-thinking" data-testid={`custom-provider-thinking-${index}`}>
											<span className="custom-provider-thinking-title">Thinking levels</span>
											<div className="custom-provider-thinking-grid">
												{THINKING_LEVELS.map((level) => {
													const current = draft.thinkingLevelMap?.[level];
													const mode = current === undefined ? "default" : current === null ? "hidden" : "custom";
													return (
														<div className="custom-provider-thinking-row" key={level}>
															<span className="custom-provider-thinking-level">{level}</span>
															<select
																className="modal-input"
																value={mode}
																disabled={busy}
																onChange={(event) => {
																	const next = event.target.value;
																	setThinkingLevel(index, level, next === "default" ? undefined : next === "hidden" ? null : "");
																}}
																data-testid={`custom-provider-thinking-mode-${index}-${level}`}
															>
																<option value="default">default</option>
																<option value="hidden">hide</option>
																<option value="custom">custom</option>
															</select>
															{mode === "custom" && (
																<input
																	type="text"
																	className="modal-input"
																	placeholder="provider value"
																	value={current ?? ""}
																	autoComplete="off"
																	spellCheck={false}
																	disabled={busy}
																	onChange={(event) => setThinkingLevel(index, level, event.target.value)}
																	data-testid={`custom-provider-thinking-value-${index}-${level}`}
																/>
															)}
														</div>
													);
												})}
											</div>
										</div>
									)}
								</div>
							))}
						</div>
					</div>
					{displayedError && <p className="settings-error">{displayedError}</p>}
				</div>
				<div className="modal-actions">
					<button type="button" className="btn btn-small" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-small btn-primary"
						disabled={busy}
						onClick={() => void save()}
						data-testid="custom-provider-save"
					>
						{busy ? "Saving…" : editing ? "Save changes" : "Add provider"}
					</button>
				</div>
			</div>
		</div>
	);
}
