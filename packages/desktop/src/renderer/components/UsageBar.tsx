import type { SessionUsage } from "@earendil-works/pi-agent-protocol";

function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		const scaled = value / 1_000_000;
		return `${scaled.toFixed(scaled >= 10 || Number.isInteger(scaled) ? 0 : 1)}m`;
	}
	if (value >= 1_000) {
		const scaled = value / 1_000;
		return `${scaled.toFixed(scaled >= 100 || Number.isInteger(scaled) ? 0 : 1)}k`;
	}
	return Math.round(value).toLocaleString();
}

/** Static USD→CNY rate for the local cost estimate (display-only, not live FX). */
const CNY_PER_USD = 7.2;

function formatCost(valueUsd: number): string {
	if (valueUsd <= 0) {
		return "—";
	}
	const value = valueUsd * CNY_PER_USD;
	if (value < 0.01) {
		return `¥${value.toFixed(4)}`;
	}
	return `¥${value.toFixed(2)}`;
}

export function UsageBar({
	usage,
}: {
	usage: SessionUsage | null;
}): React.JSX.Element | null {
	if (!usage) {
		return null;
	}
	const context = usage.contextUsage;
	const usedPercent = context?.percent === null || context?.percent === undefined
		? null
		: Math.min(Math.max(context.percent, 0), 100);
	const tone = usedPercent !== null && usedPercent >= 90 ? "danger" : usedPercent !== null && usedPercent >= 70 ? "warning" : "normal";
	const remaining = context?.tokens === null || context?.tokens === undefined
		? null
		: Math.max(context.contextWindow - context.tokens, 0);

	return (
		<div className={`usage-bar usage-bar-${tone}`} data-testid="usage-bar">
			<div
				className="usage-total"
				title={`Input ${usage.tokens.input.toLocaleString()} · Output ${usage.tokens.output.toLocaleString()} · Cache read ${usage.tokens.cacheRead.toLocaleString()} · Cache write ${usage.tokens.cacheWrite.toLocaleString()}`}
			>
				<span>Session</span>
				<strong>{formatTokens(usage.tokens.total)} tokens</strong>
			</div>
			{usage.cost > 0 && (
			<div
				className="usage-cost"
				title={`Local estimate in CNY at a static ¥${CNY_PER_USD}/$ rate, computed from the model price metadata; not the official Go quota.`}
				data-testid="usage-cost"
			>
					<span>Est. cost</span>
					<strong>{formatCost(usage.cost)}</strong>
				</div>
			)}
			{context && (
				<div className="usage-context">
					<div className="usage-context-copy">
						<span>Context left</span>
						<strong>
							{remaining === null
								? `Recalculating · ${formatTokens(context.contextWindow)} window`
								: `${formatTokens(remaining)} / ${formatTokens(context.contextWindow)}`}
						</strong>
						{usedPercent !== null && (
							<span
								className={`usage-context-chip${tone === "normal" ? "" : ` usage-context-chip-${tone}`}`}
								data-testid="usage-context-chip"
							>
								{Math.round(100 - usedPercent)}% left
							</span>
						)}
					</div>
					<div className="usage-context-track" aria-hidden="true">
						<div className="usage-context-fill" style={{ width: `${usedPercent ?? 0}%` }} />
					</div>
				</div>
			)}
		</div>
	);
}
