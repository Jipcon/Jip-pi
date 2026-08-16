/**
 * WorkspacePicker: shown when no workspace is open.
 */

import { Icon } from "./Icon.tsx";

export function WorkspacePicker({
	busy,
	error,
	onPick,
}: {
	busy: boolean;
	error: string | null;
	onPick: () => void;
}): React.JSX.Element {
	return (
		<div className="workspace-picker" data-testid="workspace-picker">
			<div className="workspace-picker-titlebar" aria-hidden="true">
				<span className="brand-wordmark">
					<strong>Jip-pi</strong>
				</span>
			</div>
			<div className="workspace-picker-card">
				<span className="workspace-picker-eyebrow">Jip-pi</span>
				<h1 className="workspace-picker-title">Your workspace, in focus.</h1>
				<p className="workspace-picker-subtitle">Choose a project folder to start a focused agent session.</p>
				<button
					type="button"
					className="btn btn-primary btn-large workspace-picker-button"
					disabled={busy}
					onClick={onPick}
					data-testid="pick-workspace-button"
				>
					<Icon name="folder" size={17} />
					{busy ? "Starting…" : "Open workspace"}
				</button>
				<p className="workspace-picker-note">The selected folder becomes the agent's working directory.</p>
				{error && <div className="workspace-picker-error">{error}</div>}
			</div>
		</div>
	);
}
