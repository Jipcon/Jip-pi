/**
 * Typed workspace errors. Git/filesystem/manifest/journal write failures are
 * manager faults (`WorkspaceManagerFault`) and must never be masked as one of
 * these business rejections.
 */

export class UnsupportedWorkspaceError extends Error {
	constructor(detail: string) {
		super(`Unsupported workspace: ${detail}`);
		this.name = "UnsupportedWorkspace";
	}
}

export class UnsupportedRepositoryStateError extends Error {
	constructor(detail: string) {
		super(`Unsupported repository state: ${detail}`);
		this.name = "UnsupportedRepositoryState";
	}
}

export class SourceWorkspaceChangedError extends Error {
	constructor(detail: string) {
		super(`Source workspace changed: ${detail}`);
		this.name = "SourceWorkspaceChanged";
	}
}

export class WorkspaceSnapshotNotFoundError extends Error {
	constructor(detail: string) {
		super(`Workspace snapshot not found: ${detail}`);
		this.name = "WorkspaceSnapshotNotFound";
	}
}

/** The manifest record and the on-disk ref disagree; only recover() may repair.
 * Class name deliberately differs from exact-request.ts's WorkspaceSnapshotMismatchError. */
export class WorkspaceSnapshotMismatch extends Error {
	constructor(detail: string) {
		super(`Workspace snapshot mismatch: ${detail}`);
		this.name = "WorkspaceSnapshotMismatch";
	}
}

export class WorkspaceLeaseConflictError extends Error {
	constructor(detail: string) {
		super(`Workspace lease conflict: ${detail}`);
		this.name = "WorkspaceLeaseConflict";
	}
}

export class WorkspacePathEscapeError extends Error {
	constructor(detail: string) {
		super(`Workspace path escape: ${detail}`);
		this.name = "WorkspacePathEscape";
	}
}

export class WorkspaceCaseCollisionError extends Error {
	constructor(detail: string) {
		super(`Workspace case collision: ${detail}`);
		this.name = "WorkspaceCaseCollision";
	}
}

export class ForegroundChangedError extends Error {
	constructor(detail: string) {
		super(`Foreground changed: ${detail}`);
		this.name = "ForegroundChanged";
	}
}

export class PromotionConflictError extends Error {
	constructor(detail: string) {
		super(`Promotion conflict: ${detail}`);
		this.name = "PromotionConflict";
	}
}

export class PromotionNeedsAttentionError extends Error {
	constructor(detail: string) {
		super(`Promotion needs attention: ${detail}`);
		this.name = "PromotionNeedsAttention";
	}
}

export class WorkspaceOrphanedError extends Error {
	constructor(detail: string) {
		super(`Workspace orphaned: ${detail}`);
		this.name = "WorkspaceOrphaned";
	}
}

export class BranchOriginFrozenError extends Error {
	constructor(detail: string) {
		super(`Branch origin frozen: ${detail}`);
		this.name = "BranchOriginFrozen";
	}
}

export class BranchOriginConflictError extends Error {
	constructor(detail: string) {
		super(`Branch origin conflict: ${detail}`);
		this.name = "BranchOriginConflict";
	}
}

/** Unrecoverable storage/git/file system write failure inside the manager. */
export class WorkspaceManagerFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkspaceManagerFault";
	}
}
