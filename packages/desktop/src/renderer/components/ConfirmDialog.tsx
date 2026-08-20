/**
 * ConfirmDialog: the shared in-app confirmation modal for destructive
 * actions (session delete, workspace remove, custom provider delete).
 *
 * The dialog owns the confirmation UX (busy state, Escape, close button,
 * inline error that keeps the dialog open on failure); the caller supplies
 * every piece of wording. Focus moves to the confirm button on open so the
 * dialog is fully keyboard-operable, and closing it returns keyboard input
 * to the underlying app.
 */

import { useEffect, useRef } from "react";
import { Icon } from "./Icon.tsx";

export interface ConfirmDialogProps {
	/** Small label above the title (e.g. "Conversation", "Workspace"). */
	eyebrow?: string;
	title: string;
	message: string;
	/** Tooltip for the message (full text behind a truncated message). */
	messageTitle?: string;
	/** Label of the destructive action button (e.g. "Move to Trash"). */
	confirmLabel: string;
	/** Label shown on the action button while the action runs. */
	busyLabel?: string;
	busy: boolean;
	/** Failure message; while set the dialog stays open. */
	error?: string | null;
	onConfirm: () => void;
	onClose: () => void;
	/** Base for data-testids: `<testId>` for the dialog, `<testId>-confirm` for the action. */
	testId: string;
	/** Override for the confirm button testid (defaults to `<testId>-confirm`). */
	confirmTestId?: string;
	/** aria-labelledby target and element id for the title. */
	titleId: string;
	/** aria-label for the close button. */
	closeLabel: string;
}

export function ConfirmDialog({
	eyebrow: _eyebrow,
	title,
	message,
	messageTitle,
	confirmLabel,
	busyLabel,
	busy,
	error = null,
	onConfirm,
	onClose,
	testId,
	confirmTestId,
	titleId,
	closeLabel,
}: ConfirmDialogProps): React.JSX.Element {
	const confirmRef = useRef<HTMLButtonElement>(null);

	// eyebrow is deprecated in B scheme (title-only header), kept for compat
	void _eyebrow;

	useEffect(() => {
		confirmRef.current?.focus();
	}, []);

	return (
		<div className="modal-backdrop">
			<div
				className="modal session-delete-modal"
				onKeyDown={(event) => {
					if (event.key === "Escape" && !busy) {
						onClose();
					}
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				data-testid={testId}
			>
				<div className="modal-header">
					<h3 className="modal-title" id={titleId}>
						{title}
					</h3>
					<button
						type="button"
						className="icon-button"
						disabled={busy}
						onClick={onClose}
						aria-label={closeLabel}
						data-testid={`${testId}-close`}
					>
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<p className="session-delete-warning" title={messageTitle}>
						{message}
					</p>
					{error !== null && (
						<p className="settings-error" data-testid={`${testId}-error`}>
							{error}
						</p>
					)}
				</div>
				<div className="modal-actions">
					<button type="button" className="btn" disabled={busy} onClick={onClose}>
						Cancel
					</button>
					<button
						ref={confirmRef}
						type="button"
						className="btn btn-danger"
						disabled={busy}
						onClick={onConfirm}
						data-testid={confirmTestId ?? `${testId}-confirm`}
					>
						{busy ? (busyLabel ?? confirmLabel) : confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
