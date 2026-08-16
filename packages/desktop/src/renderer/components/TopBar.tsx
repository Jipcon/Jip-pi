/**
 * TopBar: app title, runtime selectors and settings.
 *
 * The brand sits above the sidebar; the runtime selectors live in a center
 * container that mirrors the chat column geometry (same max width and
 * gutter), so the Provider select starts exactly above the message content.
 *
 * Model selection is split into a Provider selector and a Model selector so
 * OpenCode Go (subscription) and OpenCode Zen (balance) models are never
 * mixed into one flat list. Failed switches roll the selection back and
 * show an error.
 */

import type { ModelInfo } from "@earendil-works/pi-agent-protocol";
import { useState } from "react";
import { setModel, setThinkingLevel, store } from "../state/hooks.ts";
import { providerDisplay } from "../state/providers.ts";
import type { BackendPhase } from "../../shared/ipc.ts";
import { Icon } from "./Icon.tsx";
import { Select, type SelectOption } from "./Select.tsx";

/** Canonical thinking levels in strength order (mirrors ThinkingLevel in pi-agent). */
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Levels that fill the strength meter; "off" fills none. */
const METER_LEVELS = ALL_THINKING_LEVELS.filter((level) => level !== "off");

function notifyError(context: string, error: unknown): void {
	store.dispatch({
		type: "notify",
		notification: {
			message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
			type: "error",
		},
	});
}

function formatContextWindow(tokens: number | undefined): string | undefined {
	if (tokens === undefined) {
		return undefined;
	}
	if (tokens >= 1_000_000) {
		const mega = tokens / 1_000_000;
		return `${mega >= 10 ? Math.round(mega) : Number(mega.toFixed(1))}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}k`;
	}
	return String(tokens);
}

/** Five-to-six segment strength indicator for a thinking level. */
function ThinkingMeter({ level, enabled }: { level: string; enabled: boolean }): React.JSX.Element {
	const filled = METER_LEVELS.indexOf(level as (typeof METER_LEVELS)[number]) + 1;
	return (
		<span className="thinking-meter" aria-hidden="true">
			{METER_LEVELS.map((segment, index) => (
				<span
					key={segment}
					className={`thinking-meter-segment${enabled && index < filled ? " thinking-meter-segment-filled" : ""}`}
				/>
			))}
		</span>
	);
}

export function TopBar({
	workspaceId,
	sessionId,
	phase,
	models,
	currentModel,
	thinkingLevels,
	thinkingLevel,
	onOpenSettings,
	locked = false,
}: {
	/** Workspace/session the model controls apply to. */
	workspaceId: string;
	sessionId: string;
	phase: BackendPhase;
	models: ModelInfo[];
	currentModel: ModelInfo | null;
	thinkingLevels: string[];
	thinkingLevel: string | undefined;
	onOpenSettings: () => void;
	/** Model/thinking switching is disabled while streaming, compacting or retrying. */
	locked?: boolean;
}): React.JSX.Element {
	// Pending in-flight selection: keeps the selector showing the user's pick
	// while setModel is running and rolls back to the store value on failure.
	const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
	const [pendingLevel, setPendingLevel] = useState<string | null>(null);

	const providers = [...new Set(models.map((model) => model.provider))].sort();
	// An in-flight provider switch drives the visible provider/model lists:
	// building options from the stale currentModel would leave the pending
	// value unmatched, dropping the trigger to the "Select a model" fallback.
	const selectedProvider =
		(pendingModel?.provider && providers.includes(pendingModel.provider) ? pendingModel.provider : undefined) ??
		(currentModel?.provider && providers.includes(currentModel.provider) ? currentModel.provider : undefined) ??
		providers[0] ??
		"";
	const providerModels = selectedProvider ? models.filter((model) => model.provider === selectedProvider) : [];
	const currentModelValue = currentModel ? `${currentModel.provider}/${currentModel.id}` : "";
	const modelOptions =
		currentModel && !providerModels.some((model) => model.provider === currentModel.provider && model.id === currentModel.id)
			? [currentModel, ...providerModels]
			: providerModels;

	// The panel always shows the full level matrix; levels the current model
	// cannot reach stay visible but disabled, with the cap in the tooltip.
	const highestSupportedLevel = [...ALL_THINKING_LEVELS].reverse().find((level) => thinkingLevels.includes(level));
	const effectiveLevel = pendingLevel ?? thinkingLevel;
	const thinkingOptions: SelectOption[] = ALL_THINKING_LEVELS.map((level) => {
		const supported = thinkingLevels.includes(level);
		return {
			value: level,
			label: level,
			disabled: !supported,
			disabledReason: supported
				? undefined
				: highestSupportedLevel
					? `This model supports up to ${highestSupportedLevel}`
					: "Not supported by this model",
			meta: <ThinkingMeter level={level} enabled={supported} />,
		};
	});
	// Unknown levels reported by the backend still render as a selectable row.
	if (effectiveLevel && !(ALL_THINKING_LEVELS as readonly string[]).includes(effectiveLevel)) {
		thinkingOptions.unshift({ value: effectiveLevel, label: effectiveLevel });
	}

	const providerOptions: SelectOption[] = providers.map((provider) => {
		const display = providerDisplay(provider);
		return { value: provider, label: display.label, description: display.description };
	});
	const modelSelectOptions: SelectOption[] = modelOptions.map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: model.name,
		meta: formatContextWindow(model.contextWindow),
	}));

	const runtimeDisabled = phase !== "running" || models.length === 0 || locked;

	const applyModel = async (provider: string, modelId: string): Promise<void> => {
		setPendingModel({ provider, modelId });
		try {
			await setModel(workspaceId, sessionId, { provider, modelId });
		} catch (error) {
			// Roll back: the store still holds the previous model, so the
			// selector snaps back automatically once pending clears.
			notifyError("Failed to switch model", error);
		} finally {
			setPendingModel(null);
		}
	};

	const onProviderChange = (provider: string): void => {
		if (!provider) {
			return;
		}
		void switchProvider(provider);
	};

	const switchProvider = async (provider: string): Promise<void> => {
		const firstModel = models.find((model) => model.provider === provider);
		if (!firstModel) {
			notifyError("Failed to switch provider", new Error(`No models available for provider ${provider}`));
			return;
		}
		await applyModel(provider, firstModel.id);
	};

	const onModelChange = (value: string): void => {
		const [provider, ...rest] = value.split("/");
		const modelId = rest.join("/");
		if (provider && modelId) {
			void applyModel(provider, modelId);
		}
	};

	const onThinkingChange = (level: string): void => {
		if (!level) {
			return;
		}
		setPendingLevel(level);
		void setThinkingLevel(workspaceId, sessionId, level)
			.catch((error) => notifyError("Failed to change thinking level", error))
			.finally(() => setPendingLevel(null));
	};

	return (
		<header className="topbar" data-testid="topbar">
			<div className="topbar-left">
				<span className="brand-wordmark">
					<strong>Jip-pi</strong>
				</span>
			</div>
			<div className="topbar-center">
				<div className="topbar-controls">
					<div className="runtime-control provider-control">
						<span className="topbar-control-label">Provider</span>
						<Select
							value={selectedProvider}
							options={providerOptions}
							placeholder="No providers"
							disabled={runtimeDisabled}
							onChange={onProviderChange}
							ariaLabel="Provider"
							testId="provider-select"
							triggerClassName="provider-select"
						/>
					</div>
					<div className="runtime-control model-control">
						<span className="topbar-control-label">Model</span>
						<Select
							value={pendingModel ? `${pendingModel.provider}/${pendingModel.modelId}` : currentModelValue}
							options={modelSelectOptions}
							placeholder={modelSelectOptions.length === 0 ? "No models" : "Select a model"}
							disabled={runtimeDisabled || modelSelectOptions.length === 0 || pendingModel !== null}
							onChange={onModelChange}
							ariaLabel="Model"
							testId="model-select"
							triggerClassName="model-select"
						/>
					</div>
					<div className="runtime-control thinking-control">
						<span className="topbar-control-label">Thinking</span>
						{/* Amber dot: any level above "off" is a visible cost signal. */}
						{effectiveLevel !== undefined && effectiveLevel !== "off" && (
							<span className="thinking-active-dot" aria-hidden="true" />
						)}
						<Select
							value={effectiveLevel ?? ""}
							options={thinkingOptions}
							placeholder="Unavailable"
							disabled={runtimeDisabled || thinkingLevels.length === 0 || pendingLevel !== null}
							onChange={onThinkingChange}
							ariaLabel="Thinking level"
							testId="thinking-select"
							triggerClassName="thinking-select"
						/>
					</div>
				</div>
			</div>
			<div className="topbar-right">
				<button
					type="button"
					className="btn btn-ghost topbar-action"
					onClick={onOpenSettings}
					data-testid="settings-button"
					title="Open settings"
					aria-label="Open settings"
				>
					<Icon name="settings" size={30} />
				</button>
			</div>
		</header>
	);
}
