/**
 * Sidebar: workspace info + sessions list.
 * Sessions are listed newest-first and can be restored without exposing Jip-pi's
 * session file layout to the renderer.
 */

import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Icon } from "./Icon.tsx";

const SIDEBAR_WIDTH_STORAGE_KEY = "pi-desktop.sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const SIDEBAR_MIN_WIDTH_FALLBACK = 200;
const SIDEBAR_MAX_WIDTH_FALLBACK = 480;
const SIDEBAR_MIN_CONTENT_WIDTH = 320;

function getSidebarBounds(): { minWidth: number; maxWidth: number } {
	const styles = getComputedStyle(document.documentElement);
	const minWidth = Number.parseFloat(styles.getPropertyValue("--sidebar-min-width")) || SIDEBAR_MIN_WIDTH_FALLBACK;
	const maxWidth = Number.parseFloat(styles.getPropertyValue("--sidebar-max-width")) || SIDEBAR_MAX_WIDTH_FALLBACK;
	const viewportMax = window.innerWidth - SIDEBAR_MIN_CONTENT_WIDTH;
	return {
		minWidth,
		maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMax)),
	};
}

function clampSidebarWidth(width: number): number {
	const { minWidth, maxWidth } = getSidebarBounds();
	return Math.max(minWidth, Math.min(maxWidth, width));
}

function applySidebarWidth(width: number): void {
	document.documentElement.style.setProperty("--sidebar-width", `${Math.round(clampSidebarWidth(width))}px`);
}

function loadSidebarWidth(): number | null {
	try {
		const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (raw === null) return null;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

function saveSidebarWidth(width: number): void {
	try {
		window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
	} catch {
		// Ignore storage failures.
	}
}

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
					<h3 className="modal-title" id="rename-session-title">
						Rename session
					</h3>
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
						<input
							type="text"
							className="modal-input"
							value={name}
							disabled={saving}
							maxLength={160}
							autoFocus
							placeholder="Enter session name"
							aria-label="Session name"
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
	const [error, setError] = useState<string | null>(null);

	const confirmDelete = async (): Promise<void> => {
		setDeleting(true);
		setError(null);
		try {
			await deleteSessionEntry(session);
			onClose();
		} catch (err) {
			// The dialog stays open and shows the failure.
			setError(
				`Failed to delete "${displaySessionTitle(session)}": ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setDeleting(false);
		}
	};

	return (
		<ConfirmDialog
			eyebrow="Conversation"
			title="Delete session?"
			message={`Move "${displaySessionTitle(session)}" to the system Trash? This cannot be undone.`}
			messageTitle={sessionTitle(session)}
			confirmLabel="Move to Trash"
			busyLabel="Deleting…"
			busy={deleting}
			error={error}
			onConfirm={() => void confirmDelete()}
			onClose={onClose}
			testId="delete-session-dialog"
			confirmTestId="delete-session-confirm"
			titleId="delete-session-title"
			closeLabel="Close delete dialog"
		/>
	);
}

function RemoveWorkspaceDialog({
	workspacePath,
	sessionCount,
	onClose,
}: {
	workspacePath: string;
	sessionCount: number;
	onClose: () => void;
}): React.JSX.Element {
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const confirmRemove = async (): Promise<void> => {
		setDeleting(true);
		setError(null);
		try {
			await removeWorkspaceEntry(workspacePath);
			onClose();
		} catch (err) {
			// The dialog stays open and shows the failure.
			setError(
				`Failed to remove "${workspaceName(workspacePath)}": ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setDeleting(false);
		}
	};

	return (
		<ConfirmDialog
			eyebrow="Workspace"
			title="Remove workspace?"
			message={
				sessionCount > 0
					? `Remove "${workspaceName(workspacePath)}" and move the folder and its ${sessionCount} session${sessionCount === 1 ? "" : "s"} to the system Trash? This cannot be undone.`
					: `Remove "${workspaceName(workspacePath)}" and move the folder to the system Trash? This cannot be undone.`
			}
			messageTitle={workspacePath}
			confirmLabel="Move to Trash"
			busyLabel="Removing…"
			busy={deleting}
			error={error}
			onConfirm={() => void confirmRemove()}
			onClose={onClose}
			testId="remove-workspace-dialog"
			confirmTestId="remove-workspace-confirm"
			titleId="remove-workspace-title"
			closeLabel="Close remove workspace dialog"
		/>
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
	const [removeWorkspaceTarget, setRemoveWorkspaceTarget] = useState<string | null>(null);
	const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
	const sidebarRef = useRef<HTMLElement>(null);
	const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

	useLayoutEffect(() => {
		const saved = loadSidebarWidth();
		if (saved !== null) {
			applySidebarWidth(saved);
		}
	}, []);

	useEffect(() => {
		const onWindowResize = () => {
			const current = sidebarRef.current?.getBoundingClientRect().width;
			if (current !== undefined) {
				applySidebarWidth(current);
			}
		};
		window.addEventListener("resize", onWindowResize);
		return () => window.removeEventListener("resize", onWindowResize);
	}, []);

	const handleResizerPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		if (window.matchMedia("(max-width: 900px)").matches) return;
		event.preventDefault();
		const sidebar = sidebarRef.current;
		if (!sidebar) return;
		const startX = event.clientX;
		const startWidth = sidebar.getBoundingClientRect().width;
		dragStateRef.current = { startX, startWidth };
		document.body.classList.add("sidebar-resizing");
		const target = event.currentTarget;
		target.setPointerCapture?.(event.pointerId);

		const onPointerMove = (e: PointerEvent) => {
			const state = dragStateRef.current;
			if (!state) return;
			applySidebarWidth(state.startWidth + (e.clientX - state.startX));
		};

		const cleanup = (pointerId: number) => {
			dragStateRef.current = null;
			document.body.classList.remove("sidebar-resizing");
			try {
				target.releasePointerCapture?.(pointerId);
			} catch {
				// Ignore release failures.
			}
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerCancel);
			const current = sidebar.getBoundingClientRect().width;
			saveSidebarWidth(current);
		};

		const onPointerUp = (e: PointerEvent) => cleanup(e.pointerId);
		const onPointerCancel = (e: PointerEvent) => cleanup(e.pointerId);

		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", onPointerUp);
		window.addEventListener("pointercancel", onPointerCancel);
	}, []);

	const handleResizerDoubleClick = useCallback(() => {
		if (window.matchMedia("(max-width: 900px)").matches) return;
		applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
		saveSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
	}, []);

	const handleResizerKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			const delta = event.key === "ArrowLeft" ? -12 : 12;
			const current = sidebarRef.current?.getBoundingClientRect().width ?? DEFAULT_SIDEBAR_WIDTH;
			const next = clampSidebarWidth(current + delta);
			applySidebarWidth(next);
			saveSidebarWidth(next);
		} else if (event.key === "Home") {
			event.preventDefault();
			const { minWidth } = getSidebarBounds();
			applySidebarWidth(minWidth);
			saveSidebarWidth(minWidth);
		} else if (event.key === "End") {
			event.preventDefault();
			const { maxWidth } = getSidebarBounds();
			applySidebarWidth(maxWidth);
			saveSidebarWidth(maxWidth);
		} else if (event.key === "Escape") {
			(event.currentTarget as HTMLElement).blur();
		}
	}, []);

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
		<aside ref={sidebarRef} className="sidebar" data-testid="sidebar">
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
						New chat
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
							disabled={busy}
							autoFocus
							onClick={() => {
								const target = workspaceContextMenu.workspacePath;
								setWorkspaceContextMenu(null);
								setRemoveWorkspaceTarget(target);
							}}
						>
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
							Move to Trash
						</button>
					</div>
				</>
			)}
			{renameTarget && <RenameSessionDialog session={renameTarget} onClose={() => setRenameTarget(null)} />}
			{deleteTarget && <DeleteSessionDialog session={deleteTarget} onClose={() => setDeleteTarget(null)} />}
			{removeWorkspaceTarget && (
				<RemoveWorkspaceDialog
					workspacePath={removeWorkspaceTarget}
					sessionCount={
						catalogSessions.filter(
							(session) =>
								session.workspacePath &&
								workspacePathsEqual(session.workspacePath, removeWorkspaceTarget),
						).length
					}
					onClose={() => setRemoveWorkspaceTarget(null)}
				/>
			)}
			<button
				type="button"
				className="sidebar-resizer"
				title="Drag to resize, double-click to reset"
				aria-label="Resize sidebar"
				aria-orientation="vertical"
				role="separator"
				tabIndex={0}
				onPointerDown={handleResizerPointerDown}
				onDoubleClick={handleResizerDoubleClick}
				onKeyDown={handleResizerKeyDown}
				data-testid="sidebar-resizer"
			/>
		</aside>
	);
}
