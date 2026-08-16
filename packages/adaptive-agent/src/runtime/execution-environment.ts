import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import type { WorkspaceFileFact, WorkspaceMetadata } from "./candidate-policy-state.ts";
import { canonicalJson, fingerprintOfJson, sha256Hex } from "./policy-bundle.ts";
import { UnsupportedWorkspaceError } from "./workspace-errors.ts";

export { UnsupportedWorkspaceError } from "./workspace-errors.ts";

/**
 * Model/tool-visible logical workspace identity. Every exact sibling projects
 * the same `root` and `contentFingerprint`; physical roots never enter any
 * fingerprint or provider-visible path.
 */
export interface LogicalWorkspaceIdentity {
	root: string;
	contentFingerprint: string;
}

/**
 * Stage 6 narrow workspace continuation port. Physical roots may differ per
 * child; the logical root and content fingerprint must be identical across
 * the group. Stage 7 replaces the in-memory adapter with real Git worktree
 * backends; production without isolation capability must fail closed.
 */
export interface ExecutionEnvironment {
	/** Physical root of this child lease. Never model-visible. */
	readonly physicalRoot: string;
	readonly logicalWorkspace: LogicalWorkspaceIdentity;
	/** Projects a logical, model-visible path onto this child's physical root. */
	toPhysicalPath(logicalPath: string): string;
}

/** Immutable captured workspace snapshot; content is fixed at capture time. */
export interface WorkspaceSnapshot {
	readonly id: string;
	readonly logical: LogicalWorkspaceIdentity;
	readonly files: WorkspaceFileFact[];
}

export interface WorkspaceLease {
	/** Durable deterministic lease id (sha256 of snapshotId + candidate id). */
	readonly id: string;
	readonly snapshotId: string;
	readonly environment: ExecutionEnvironment;
	release(): Promise<void>;
}

/**
 * Immutable-snapshot workspace continuation port. `snapshot` runs under the
 * source driver lease; `fork` materializes one child lease from the pinned
 * snapshot id and must be deterministic and idempotent for the same child id.
 */
export interface WorkspaceContinuationPort {
	snapshot(source: WorkspaceMetadata, logicalRoot: string): Promise<WorkspaceSnapshot>;
	fork(snapshotId: string, childId: string): Promise<WorkspaceLease>;
}

/** Deterministic snapshot id: same logical root and content always fork alike. */
export function workspaceSnapshotId(logicalRoot: string, metadata: WorkspaceMetadata): string {
	return fingerprintOfJson({ logicalRoot, files: metadata.files } as unknown as JsonValue);
}

function logicalPathOf(physicalPath: string, environment: ExecutionEnvironment): string {
	const prefix = environment.physicalRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalized = physicalPath.replaceAll("\\", "/");
	if (normalized === prefix) return environment.logicalWorkspace.root;
	if (!normalized.startsWith(`${prefix}/`)) return normalized;
	return `${environment.logicalWorkspace.root}/${normalized.slice(prefix.length + 1)}`;
}

/**
 * Stage 6 fake workspace adapter: snapshots and child leases live in memory,
 * physical roots are distinct per child, and the logical projection is a pure
 * path mapping. Real filesystem backends belong to Stage 7.
 */
export class MemoryWorkspaceAdapter implements WorkspaceContinuationPort {
	private readonly snapshots = new Map<string, WorkspaceSnapshot>();
	private readonly leases = new Map<string, WorkspaceLease>();

	async snapshot(source: WorkspaceMetadata, logicalRoot: string): Promise<WorkspaceSnapshot> {
		const id = workspaceSnapshotId(logicalRoot, source);
		const existing = this.snapshots.get(id);
		if (existing !== undefined) return structuredClone(existing);
		const snapshot: WorkspaceSnapshot = {
			id,
			logical: {
				root: logicalRoot,
				contentFingerprint: fingerprintOfJson({ files: source.files } as unknown as JsonValue),
			},
			files: source.files.map((file) => ({ ...file })),
		};
		this.snapshots.set(id, structuredClone(snapshot));
		return structuredClone(snapshot);
	}

	async fork(snapshotId: string, childId: string): Promise<WorkspaceLease> {
		const leaseId = sha256Hex(`${snapshotId}:${childId}`);
		const existing = this.leases.get(leaseId);
		if (existing !== undefined) return existing;
		const snapshot = this.snapshots.get(snapshotId);
		if (snapshot === undefined) {
			throw new UnsupportedWorkspaceError(`Workspace snapshot ${snapshotId} is not available`);
		}
		const environment: ExecutionEnvironment = {
			physicalRoot: `memory://workspaces/${childId}`,
			logicalWorkspace: structuredClone(snapshot.logical),
			toPhysicalPath: (logicalPath: string): string => {
				if (logicalPath === snapshot.logical.root) return environment.physicalRoot;
				if (!logicalPath.startsWith(`${snapshot.logical.root}/`)) return logicalPath;
				return `${environment.physicalRoot}/${logicalPath.slice(snapshot.logical.root.length + 1)}`;
			},
		};
		const lease: WorkspaceLease = {
			id: leaseId,
			snapshotId,
			environment,
			release: async () => {
				this.leases.delete(leaseId);
			},
		};
		this.leases.set(leaseId, lease);
		return lease;
	}

	logicalPathOf(physicalPath: string, environment: ExecutionEnvironment): string {
		return logicalPathOf(physicalPath, environment);
	}
}

/** Stable logical-path projection helper shared by environment adapters. */
export function projectLogicalPath(physicalPath: string, environment: ExecutionEnvironment): string {
	return logicalPathOf(physicalPath, environment);
}

/** Canonical JSON serialization used when a snapshot is journaled or compared. */
export function canonicalWorkspaceSnapshot(snapshot: WorkspaceSnapshot): string {
	return canonicalJson({
		id: snapshot.id,
		logical: snapshot.logical,
		files: snapshot.files,
	} as unknown as JsonValue);
}

export type { WorkspaceFileFact, WorkspaceMetadata } from "./candidate-policy-state.ts";
