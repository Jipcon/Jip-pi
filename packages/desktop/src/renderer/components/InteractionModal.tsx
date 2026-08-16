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

export function NotificationToasts({
	notifications,
	onDismiss,
}: {
	notifications: Array<{ id: string; message: string; type: "info" | "warning" | "error" }>;
	onDismiss: (id: string) => void;
}): React.JSX.Element {
	return (
		<div className="toast-container" data-testid="toast-container">
			{notifications.map((notification) => (
				<div key={notification.id} className={`toast toast-${notification.type}`}>
					<span>{notification.message}</span>
					<button type="button" className="toast-close" onClick={() => onDismiss(notification.id)}>
						×
					</button>
				</div>
			))}
		</div>
	);
}
