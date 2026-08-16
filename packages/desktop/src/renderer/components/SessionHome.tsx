import { Icon } from "./Icon.tsx";

export function SessionHome({
	busy,
	loading,
	onPickWorkspace,
}: {
	busy: boolean;
	loading: boolean;
	onPickWorkspace: () => void;
}): React.JSX.Element {
	return (
		<main className="session-home" data-testid="session-home">
			<div className="session-home-card">
				<span className="session-home-mark" aria-hidden="true" />
				<h1>{loading ? "Loading conversations…" : "Resume a conversation"}</h1>
				<p>
					{loading
						? "Reading Jip-pi session history from your configured storage."
						: "Choose a conversation from the project list, or open another workspace."}
				</p>
				<button type="button" className="btn btn-primary" disabled={busy} onClick={onPickWorkspace}>
					<Icon name="folder" size={16} />
					{busy ? "Starting…" : "Open workspace"}
				</button>
			</div>
		</main>
	);
}
