/**
 * Sidebar: workspace info + sessions list.
 * Sessions are listed newest-first and can be restored without exposing Jip-pi's
 * session file layout to the renderer.
 */

import { type FormEvent, useState } from "react";
import type { SessionInfo } from "@earendil-works/pi-agent-protocol";
import { workspacePathKey, workspacePathsEqual } from "../../shared/workspace-path.ts";
import {
	deleteSessionEntry,
	newSession,
	openSession,
	removeWorkspaceEntry,
	renameSessionEntry,
	store,
} from "../state/hooks.ts";
import type { SessionStatusIndicator } from "../state/store.ts";
import { Icon } from "./Icon.tsx";

interface SessionContextMenuState {
	session: SessionInfo;
	x: number;
	y: number;
}

interface WorkspaceContextMenuState {
	workspacePath: string;
	x: number;
	y: number;
}
function sessionTitle(session: SessionInfo): string {
	const label = session.name?.trim() || session.preview?.replace(/\s+/g, " ").trim();
	return label || `Session ${session.id.slice(0, 8)}`;
}

/** Longest session title shown in compact surfaces (delete dialog, toasts, list rows). */
export const MAX_SESSION_TITLE_LENGTH = 60;

const sessionTitleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Truncate by user-perceived characters so emoji sequences stay intact. */
export function truncateSessionTitle(title: string): string {
	if (title.length <= MAX_SESSION_TITLE_LENGTH) {
		return title;
	}
	const graphemes = [...sessionTitleSegmenter.segment(title)].map((part) => part.segment);
	if (graphemes.length <= MAX_SESSION_TITLE_LENGTH) {
		return title;
	}
	return `${graphemes.slice(0, MAX_SESSION_TITLE_LENGTH).join("").trimEnd()}…`;
}

/** Title for compact surfaces: content-derived and truncated. */
function displaySessionTitle(session: SessionInfo): string {
	return truncateSessionTitle(sessionTitle(session));
}

interface SessionGroup {
	workspacePath: string | null;
	name: string;
	sessions: SessionInfo[];
}

function workspaceName(path: string | null): string {
	if (!path) return "Other sessions";
	return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function combinedSessions(
	sessions: SessionInfo[],
	catalogSessions: SessionInfo[],
	currentWorkspace: string | null,
): SessionInfo[] {
	const combined = new Map<string, SessionInfo>();
	for (const candidate of [...catalogSessions, ...sessions]) {
		if (!candidate.id) continue;
		const existing = combined.get(candidate.id);
		combined.set(candidate.id, {
			...existing,
			...candidate,
			file: candidate.file ?? existing?.file,
			workspacePath: candidate.workspacePath ?? existing?.workspacePath ?? currentWorkspace ?? undefined,
			name: candidate.name ?? existing?.name,
			createdAt: candidate.createdAt ?? existing?.createdAt,
			updatedAt: candidate.updatedAt ?? existing?.updatedAt,
			messageCount: candidate.messageCount ?? existing?.messageCount,
			preview: candidate.preview ?? existing?.preview,
		});
	}
	return [...combined.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function groupSessions(
	sessions: SessionInfo[],
	workspaces: string[],
	currentWorkspace: string | null,
): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	for (const workspacePath of [...workspaces, currentWorkspace]) {
		const trimmedPath = workspacePath?.trim();
		if (!trimmedPath) continue;
		const key = workspacePathKey(trimmedPath);
		if (!groups.has(key)) {
			groups.set(key, {
				workspacePath: trimmedPath,
				name: workspaceName(trimmedPath),
				sessions: [],
			});
		}
	}
	for (const session of sessions) {
		const workspacePath = session.workspacePath?.trim() || null;
		const key = workspacePath ? workspacePathKey(workspacePath) : "__other_sessions__";
		const group = groups.get(key) ?? {
			workspacePath,
			name: workspaceName(workspacePath),
			sessions: [],
		};
		group.sessions.push(session);
		groups.set(key, group);
	}
	return [...groups.values()];
}

function RenameSessionDialog({
	session,
	onClose,
}: {
	session: SessionInfo;
	onClose: () => void;
}): React.JSX.Element {
	const [name, setName] = useState(session.name?.trim() || sessionTitle(session));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		const trimmedName = name.trim();
		if (!trimmedName) {
			setError("Session name cannot be empty.");
			return;
		}

		setSaving(true);
		setError(null);
		try {
			await renameSessionEntry(session, trimmedName);
			onClose();
		} catch (renameError) {
			setError(renameError instanceof Error ? renameError.message : String(renameError));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<form
				className="modal session-rename-modal"
				onSubmit={(event) => void submit(event)}
				onKeyDown={(event) => {
					if (event.key === "Escape" && !saving) {
						onClose();
					}
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="rename-session-title"
				data-testid="rename-session-dialog"
			>
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Conversation</span>
						<h3 className="modal-title" id="rename-session-title">
							Rename session
						</h3>
					</div>
					<button
						type="button"
						className="icon-button"
						disabled={saving}
						onClick={onClose}
						aria-label="Close rename dialog"
					>
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<label className="session-rename-field">
						<span>Session name</span>
						<input
							type="text"
							className="modal-input"
							value={name}
							disabled={saving}
							maxLength={160}
							autoFocus
							onChange={(event) => setName(event.target.value)}
							data-testid="rename-session-input"
						/>
					</label>
					{error && <p className="settings-error session-rename-error">{error}</p>}
				</div>
				<div className="modal-actions">
					<button type="button" className="btn" disabled={saving} onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn-primary" disabled={saving || name.trim().length === 0}>
						{saving ? "Renaming…" : "Rename"}
					</button>
				</div>
			</form>
		</div>
	);
}

function DeleteSessionDialog({
	session,
	onClose,
}: {
	session: SessionInfo;
	onClose: () => void;
}): React.JSX.Element {
	const [deleting, setDeleting] = useState(false);

	const confirmDelete = async (): Promise<void> => {
		setDeleting(true);
		try {
			await deleteSessionEntry(session);
			onClose();
		} catch (error) {
			store.dispatch({
				type: "notify",
				notification: {
					message: `Failed to delete "${displaySessionTitle(session)}": ${error instanceof Error ? error.message : String(error)}`,
					type: "error",
				},
			});
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div className="modal-backdrop">
			<div
				className="modal session-delete-modal"
				onKeyDown={(event) => {
					if (event.key === "Escape" && !deleting) {
						onClose();
					}
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="delete-session-title"
				data-testid="delete-session-dialog"
			>
				<div className="modal-header">
					<div>
						<span className="modal-eyebrow">Conversation</span>
						<h3 className="modal-title" id="delete-session-title">
							Delete session?
						</h3>
					</div>
					<button
						type="button"
						className="icon-button"
						disabled={deleting}
						onClick={onClose}
						aria-label="Close delete dialog"
					>
						<Icon name="close" />
					</button>
				</div>
				<div className="modal-body">
					<p className="session-delete-warning" title={sessionTitle(session)}>
						Move "{displaySessionTitle(session)}" to the system Trash? This cannot be undone.
					</p>
				</div>
				<div className="modal-actions">
					<button type="button" className="btn" disabled={deleting} onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="btn btn-danger"
						disabled={deleting}
						onClick={() => void confirmDelete()}
						data-testid="delete-session-confirm"
					>
						{deleting ? "Deleting…" : "Move to Trash"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function Sidebar({
	workspace,
	workspaces,
	sessions,
	catalogSessions = [],
	catalogLoading = false,
	currentSessionId,
	indicators = {},
	busy,
	running,
	switchingWorkspace = null,
	onAddWorkspace,
	onOpenWorkspace,
}: {
	workspace: string | null;
	workspaces: string[];
	sessions: SessionInfo[];
	catalogSessions?: SessionInfo[];
	catalogLoading?: boolean;
	currentSessionId: string | null;
	/** Per-session sidebar indicators (running / needs-attention). */
	indicators?: Record<string, SessionStatusIndicator | null>;
	busy: boolean;
	running?: boolean;
	/** Workspace whose backend is being started in the background. */
	switchingWorkspace?: string | null;
	onAddWorkspace: () => void;
	onOpenWorkspace: (workspace: string) => void;
}): React.JSX.Element {
	const backendRunning = running ?? workspace !== null;
	const displayedSessions = combinedSessions(sessions, catalogSessions, workspace);
	const groups = groupSessions(displayedSessions, workspaces, workspace);
	const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);
	const [workspaceContextMenu, setWorkspaceContextMenu] = useState<WorkspaceContextMenuState | null>(null);
	const [renameTarget, setRenameTarget] = useState<SessionInfo | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
	const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());

	const handleNewSession = (): void => {
		if (backendRunning && workspace) {
			void newSession(workspace).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				store.dispatch({
					type: "notify",
					notification: { message: `Failed to create session: ${message}`, type: "error" },
				});
			});
			return;
		}
		onAddWorkspace();
	};

	return (
		<aside className="sidebar" data-testid="sidebar">
			<section className="sidebar-section sidebar-workspace-section">
				<div className="sidebar-actions">
					<button
						type="button"
						className="btn sidebar-new-session"
						disabled={busy}
						onClick={handleNewSession}
						data-testid="new-session-button"
					>
						<Icon name="plus" />
						New conversation
					</button>
					<button
						type="button"
						className="btn sidebar-add-workspace"
						disabled={busy}
						onClick={onAddWorkspace}
						data-testid="add-workspace-button"
					>
						<Icon name="folder-plus" />
						Add workspace
					</button>
				</div>
			</section>

			<section className="sidebar-section sidebar-section-grow">
				<div className="sidebar-section-header">
					<h2 className="sidebar-heading">Conversations</h2>
					<span className="sidebar-count">{displayedSessions.length}</span>
				</div>
				<ul className="session-list session-project-list">
					{groups.length === 0 && (
						<li className="session-empty">
							<Icon name="message" size={18} />
							<span>{catalogLoading ? "Loading conversations…" : "Your conversations will appear here."}</span>
						</li>
					)}
					{groups.map((group) => {
						const groupKey = group.workspacePath ? workspacePathKey(group.workspacePath) : "__other_sessions__";
						const expanded = !collapsedProjects.has(groupKey);
						const emptyWorkspace = group.workspacePath !== null && group.sessions.length === 0;
						const switching =
							switchingWorkspace !== null &&
							group.workspacePath !== null &&
							workspacePathsEqual(switchingWorkspace, group.workspacePath);
						return (
							<li key={groupKey} className="session-project-group">
								<button
									type="button"
									className="session-project-header"
									title={group.workspacePath ?? undefined}
									aria-expanded={emptyWorkspace ? undefined : expanded}
									data-testid="session-project-toggle"
									onContextMenu={(event) => {
										event.preventDefault();
										if (busy || !group.workspacePath) return;
										setContextMenu(null);
										setWorkspaceContextMenu({
											workspacePath: group.workspacePath,
											x: Math.max(8, Math.min(event.clientX, window.innerWidth - 196)),
											y: Math.max(8, Math.min(event.clientY, window.innerHeight - 56)),
										});
									}}
									onClick={() => {
										if (emptyWorkspace && group.workspacePath) {
											onOpenWorkspace(group.workspacePath);
											return;
										}
										setCollapsedProjects((current) => {
											const next = new Set(current);
											if (next.has(groupKey)) {
												next.delete(groupKey);
											} else {
												next.add(groupKey);
											}
											return next;
										});
									}}
								>
									<Icon name="folder" size={16} className="session-project-folder" />
									<h3>{group.name}</h3>
									{switching && (
										<span className="session-project-switching" aria-label={`Opening ${group.name}…`}>
											<span className="session-project-switching-dot" aria-hidden="true" />
											Opening…
										</span>
									)}
								</button>
								{expanded && group.sessions.length > 0 && (
									<ul className="session-project-sessions">
										{group.sessions.map((session) => {
											const active = session.id === currentSessionId;
											const indicator = indicators[session.id] ?? null;
											return (
												<li key={session.id} className="session-row">
													<button
														type="button"
														className={`session-item ${active ? "session-item-active" : ""}`}
														disabled={busy}
														onClick={() => {
															if (!active) {
																const targetWorkspace = session.workspacePath ?? workspace ?? "";
																void openSession(targetWorkspace, session.id).catch((error) => {
																	const message =
																		error instanceof Error ? error.message : String(error);
																	store.dispatch({
																		type: "notify",
																		notification: {
																			message: `Failed to open "${displaySessionTitle(session)}": ${message}`,
																			type: "error",
																		},
																	});
																});
															}
														}}
												onPointerDown={(event) => {
													if (active) {
														event.preventDefault();
													}
												}}
													onContextMenu={(event) => {
														event.preventDefault();
														if (busy) return;
														setWorkspaceContextMenu(null);
														setContextMenu({
																session,
																x: Math.max(8, Math.min(event.clientX, window.innerWidth - 196)),
																y: Math.max(8, Math.min(event.clientY, window.innerHeight - 96)),
															});
														}}
														data-testid="session-item"
														aria-current={active ? "page" : undefined}
														title={session.file}
													>
													<span className="session-item-copy">
														<strong>{displaySessionTitle(session)}</strong>
													</span>
														{indicator === "running" && (
															<span
																className="session-indicator session-indicator-running"
																role="status"
																aria-label="Jip-pi is working"
																data-testid="session-indicator-running"
															/>
														)}
														{indicator === "needs-attention" && (
															<span
																className="session-indicator session-indicator-attention"
																aria-label="Needs interaction"
																data-testid="session-indicator-attention"
															>
																!
															</span>
														)}
													</button>
												</li>
											);
										})}
									</ul>
								)}
							</li>
						);
					})}
				</ul>
			</section>
			{workspaceContextMenu && (
				<>
					<button
						type="button"
						className="session-context-menu-backdrop"
						onClick={() => setWorkspaceContextMenu(null)}
						onContextMenu={(event) => {
							event.preventDefault();
							setWorkspaceContextMenu(null);
						}}
						aria-label="Close workspace menu"
					/>
					<div
						className="session-context-menu"
						style={{ left: workspaceContextMenu.x, top: workspaceContextMenu.y }}
						role="menu"
						aria-label={`Actions for ${workspaceName(workspaceContextMenu.workspacePath)}`}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setWorkspaceContextMenu(null);
							}
						}}
						data-testid="workspace-context-menu"
					>
						<div className="session-context-menu-surface" aria-hidden="true" />
						<button
							type="button"
							className="session-context-menu-danger"
							role="menuitem"
							disabled={
								busy ||
								(backendRunning &&
									workspace !== null &&
									workspacePathsEqual(workspaceContextMenu.workspacePath, workspace))
							}
							autoFocus
							onClick={() => {
								const target = workspaceContextMenu.workspacePath;
								setWorkspaceContextMenu(null);
								void removeWorkspaceEntry(target).catch((error) => {
									const message = error instanceof Error ? error.message : String(error);
									store.dispatch({
										type: "notify",
										notification: {
											message: `Failed to remove "${workspaceName(target)}": ${message}`,
											type: "error",
										},
									});
								});
							}}
							title={
								backendRunning &&
								workspace !== null &&
								workspacePathsEqual(workspaceContextMenu.workspacePath, workspace)
									? "Switch to another workspace first"
									: undefined
							}
						>
							<Icon name="trash" size={14} />
							Remove workspace
						</button>
					</div>
				</>
			)}
			{contextMenu && (
				<>
					<button
						type="button"
						className="session-context-menu-backdrop"
						onClick={() => setContextMenu(null)}
						onContextMenu={(event) => {
							event.preventDefault();
							setContextMenu(null);
						}}
						aria-label="Close session menu"
					/>
					<div
						className="session-context-menu"
						style={{ left: contextMenu.x, top: contextMenu.y }}
						role="menu"
						aria-label={`Actions for ${sessionTitle(contextMenu.session)}`}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								setContextMenu(null);
							}
						}}
						data-testid="session-context-menu"
					>
						<div className="session-context-menu-surface" aria-hidden="true" />
						<button
							type="button"
							role="menuitem"
							disabled={busy}
							autoFocus
							onClick={() => {
								setRenameTarget(contextMenu.session);
								setContextMenu(null);
							}}
						>
							<Icon name="edit" size={14} />
							Rename
						</button>
						<button
							type="button"
							className="session-context-menu-danger"
							role="menuitem"
							// §14.3/§14.4: the active idle session may be deleted
							// (the app falls back to another session); only a
							// running session is protected.
							disabled={busy || indicators[contextMenu.session.id] === "running"}
							onClick={() => {
								const target = contextMenu.session;
								setContextMenu(null);
								setDeleteTarget(target);
							}}
							title={
								indicators[contextMenu.session.id] === "running"
									? "Cannot delete a running session"
									: undefined
							}
						>
							<Icon name="trash" size={14} />
							Move to Trash
						</button>
					</div>
				</>
			)}
			{renameTarget && <RenameSessionDialog session={renameTarget} onClose={() => setRenameTarget(null)} />}
			{deleteTarget && <DeleteSessionDialog session={deleteTarget} onClose={() => setDeleteTarget(null)} />}
		</aside>
	);
}
