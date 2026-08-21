/**
 * InteractionModal: renders extension UI requests (select / confirm / input /
 * editor) and answers them through the backend. Notifications are toasts and
 * never require a response.
 */

import { useState } from "react";
import type { UserInteractionRequest } from "@earendil-works/pi-agent-protocol";
import type { InteractionResponse } from "@earendil-works/pi-agent-protocol";

export function InteractionDialog({
	workspaceId,
	sessionId,
	request,
	onClose,
}: {
	/** Session the interaction belongs to (response routing). */
	workspaceId: string;
	sessionId: string;
	request: UserInteractionRequest;
	onClose: () => void;
}): React.JSX.Element {
	const [value, setValue] = useState(request.kind === "editor" ? (request.prefill ?? "") : "");
	const [cancelled, setCancelled] = useState(false);

	if (cancelled) {
		return <div />;
	}

	const respond = async (id: string, response: InteractionResponse): Promise<void> => {
		await window.agent.respondInteraction(workspaceId, sessionId, id, response);
	};

	const cancel = () => {
		setCancelled(true);
		onClose();
		void respond(request.id, { kind: "cancelled" });
	};

	return (
		<div className="modal-backdrop" data-testid="interaction-modal">
			<div className="modal">
				<div className="modal-header">
					<h3 className="modal-title">{request.title ?? "Request"}</h3>
				</div>
				<div className="modal-body">
					{request.message && <p className="modal-message">{request.message}</p>}
					{request.kind === "select" && (
						<div className="modal-options">
							{(request.options ?? []).map((option) => (
								<button
									type="button"
									key={option}
									className="btn btn-block"
									onClick={() => {
										onClose();
										void respond(request.id, { kind: "value", value: option });
									}}
								>
									{option}
								</button>
							))}
						</div>
					)}
					{request.kind === "confirm" && (
						<div className="modal-actions">
							<button type="button" className="btn" onClick={cancel}>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => {
									onClose();
									void respond(request.id, { kind: "confirmed", confirmed: true });
								}}
							>
								Confirm
							</button>
						</div>
					)}
					{(request.kind === "input" || request.kind === "editor") && (
						<div className="modal-form">
							{request.kind === "input" ? (
								<input
									type="text"
									className="modal-input"
									placeholder={request.placeholder ?? ""}
									value={value}
									onChange={(event) => setValue(event.target.value)}
									data-testid="interaction-input"
								/>
							) : (
								<textarea
									className="modal-textarea"
									value={value}
									onChange={(event) => setValue(event.target.value)}
									rows={10}
									data-testid="interaction-editor"
								/>
							)}
							<div className="modal-actions">
								<button type="button" className="btn" onClick={cancel}>
									Cancel
								</button>
								<button
									type="button"
									className="btn btn-primary"
									disabled={value.length === 0 && request.kind === "input"}
									onClick={() => {
										onClose();
										void respond(request.id, { kind: "value", value });
									}}
								>
									OK
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function formatToM(raw: string): string {
	const numeric = raw.replace(/,/g, "").trim();
	const value = Number(numeric);
	if (!Number.isFinite(value)) return raw;
	const millions = value / 1_000_000;
	if (millions === 0) return "0M";
	if (millions < 0.01) return `${millions.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}M`;
	return `${millions.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
}

function parseTurnStats(message: string): Record<string, string> | null {
	const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines[0] !== "Turn Stats" && lines[0] !== "Turn Statistics") return null;
	const data: Record<string, string> = {};
	for (const line of lines.slice(1)) {
		const match = line.match(/^(\w+)\s+(.+)$/);
		if (match) data[match[1].toLowerCase()] = match[2];
	}
	if (data.input) data.input = formatToM(data.input);
	if (data.output) data.output = formatToM(data.output);
	if (data.total) data.total = formatToM(data.total);
	if (data.cache) {
		const cacheMatch = data.cache.match(/r\s*([\d,]+)\s*\/\s*w\s*([\d,]+)/i);
		if (cacheMatch) {
			data["cache read"] = formatToM(cacheMatch[1]);
			data["cache write"] = formatToM(cacheMatch[2]);
			delete data.cache;
		}
	}
	return data;
}

export function NotificationToasts({
	notifications,
	onDismiss,
}: {
	notifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>; 
	onDismiss: (id: string) => void;
}): React.JSX.Element {
	return (
		<div className="toast-container" data-testid="toast-container">
			{notifications.map((notification) => {
				const turnStats = parseTurnStats(notification.message);
				if (turnStats) {
					return (
						<div key={notification.id} className="toast toast-turn-stats" data-testid="toast-turn-stats">
							<div className="toast-turn-top">
								<span className="toast-turn-title">Turn Statistics</span>
								<button type="button" className="toast-close" onClick={() => onDismiss(notification.id)}>
									×
								</button>
							</div>
							{(turnStats.speed || turnStats.time) && (
								<div className="toast-turn-meta">
									<span>
										{[turnStats.speed?.replace(/ /g, "\u00A0"), turnStats.time].filter(Boolean).join(" \u00B7 ")}
									</span>
								</div>
							)}
							<div className="toast-turn-grid">
								{turnStats.input && (
									<div className="toast-turn-metric">
										<span className="toast-turn-label">Input</span>
										<span className="toast-turn-value">{turnStats.input}</span>
									</div>
								)}
								{turnStats.output && (
									<div className="toast-turn-metric">
										<span className="toast-turn-label">Output</span>
										<span className="toast-turn-value">{turnStats.output}</span>
									</div>
								)}
								{turnStats["cache read"] && (
									<div className="toast-turn-metric">
										<span className="toast-turn-label">Cache Read</span>
										<span className="toast-turn-value">{turnStats["cache read"]}</span>
									</div>
								)}
								{turnStats["cache write"] && (
									<div className="toast-turn-metric">
										<span className="toast-turn-label">Cache Write</span>
										<span className="toast-turn-value">{turnStats["cache write"]}</span>
									</div>
								)}
								{turnStats.total && (
									<div className="toast-turn-metric toast-turn-total">
										<span className="toast-turn-label">Total</span>
										<span className="toast-turn-value">{turnStats.total}</span>
									</div>
								)}
							</div>
						</div>
					);
				}
				return (
					<div key={notification.id} className={`toast toast-${notification.type}`}>
						<span>{notification.message}</span>
						<button type="button" className="toast-close" onClick={() => onDismiss(notification.id)}>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}
