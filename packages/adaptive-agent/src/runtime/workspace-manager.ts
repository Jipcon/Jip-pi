import type { WorkspaceFileFact } from "./candidate-policy-state.ts";
import type {
	LogicalWorkspaceIdentity,
	WorkspaceLease as Stage6WorkspaceLease,
	WorkspaceContinuationPort,
	WorkspaceMetadata,
	WorkspaceSnapshot,
} from "./execution-environment.ts";
import { sha256Hex } from "./policy-bundle.ts";
import type { LeaseStatus } from "./runtime-manifest.ts";
import type { WorkspacePolicy } from "./workspace-policy.ts";

/**
 * Stage 7 WorkspaceManager contracts. See docs/workspace-manager.md for the
 * frozen implementation spec. Stage 8 (CandidateGraph, winner selection,
 * adaptive search) is out of scope.
 */

export interface WorkspaceSnapshotRef {
	/** sha256-shaped, stable across process reopens. */
	id: string;
	/** Canonical absolute path captured from. */
	sourceRoot: string;
	backend: "git-worktree" | "temp-copy";
	fingerprint: string;
	logicalWorkspace: LogicalWorkspaceIdentity;
	/** Stage 6 bridge projection: untracked file facts at capture time. */
	files: WorkspaceFileFact[];
}

/** Durable lease identity: deterministic for the same snapshot+candidate pair. */
export interface WorkspaceLease extends Stage6WorkspaceLease {
	readonly id: string;
	readonly snapshotId: string;
	readonly candidateId: string;
	readonly root: string;
}

export function workspaceLeaseId(snapshotId: string, candidateId: string): string {
	return sha256Hex(`${snapshotId}:${candidateId}`);
}

export interface WorkspaceCaptureInput {
	sourceRoot: string;
	logicalRoot: string;
	policy?: WorkspacePolicy;
	/**
	 * Stage 8 lease re-capture lineage (S8 promotion lineage): when capturing
	 * a candidate lease into a new snapshot, the record durably inherits the
	 * ORIGINAL foreground snapshot identity as its promotion baseline:
	 * - forkBase = this snapshot's own content (exact child creation);
	 * - promotionOrigin = the foreground snapshot named here (drift gate,
	 *   full origin-to-winner patch, original index restore).
	 * Foreground captures omit it and are their own origin.
	 */
	promotionOrigin?: {
		sourceRoot: string;
		repoRoot: string;
		repoId: string;
		snapshotId: string;
		fingerprint: string;
	};
}

export interface WorkspaceDiffSummary {
	tracked: { added: number; modified: number; deleted: number; binary: number };
	untracked: { created: number; modified: number; deleted: number; absorbedByTracked: string[] };
	touchedPaths: string[];
	/** sha256 of the tracked patch bytes ("" when there is no tracked diff). */
	trackedPatchHash: string;
	untrackedManifestHash: string;
}

export interface WorkspacePatch {
	snapshotId: string;
	leaseId: string;
	/** Manager-owned file path ("" when there is no tracked diff). */
	trackedPatchPath: string;
	/** Manager-owned JSON mutation plan. */
	untrackedManifestPath: string;
	summary: WorkspaceDiffSummary;
}

export interface UntrackedMutationPlan {
	snapshotId: string;
	leaseId: string;
	ops: Array<
		| {
				path: string;
				op: "create" | "modify";
				kind?: "file" | "link";
				size?: number;
				hash?: string;
				target?: string;
				targetIsDirectory?: boolean;
		  }
		| { path: string; op: "delete" }
	>;
	hash: string;
}

export type WorkspaceVerifier = (context: { cwd: string }) => Promise<void> | void;

export interface PromotionInput {
	lease: WorkspaceLease;
	/** Runs with cwd = lease root before any foreground write. */
	verifier?: WorkspaceVerifier;
	/** Runs with cwd = foreground after all paths are applied. */
	finalVerifier?: WorkspaceVerifier;
}

/**
 * Durable promotion receipt (Stage 8, S8.6): one per promotion attempt.
 * Retrying a completed attempt returns the original durable result instead
 * of re-executing; a successful closed journal is never deleted.
 */
export interface PromotionReceipt {
	promotionId: string;
	leaseId: string;
	snapshotId: string;
	/** Stage 8 lineage: the promotion baseline snapshot (foreground origin). */
	promotionOriginSnapshotId: string;
	promotionOriginFingerprint: string;
	status: "promoted" | "rolled_back";
	touchedPaths: string[];
	postFingerprint: string;
	reason?: string;
}

export type PromotionResult =
	| { status: "promoted"; touchedPaths: string[]; receipt: PromotionReceipt }
	| { status: "verifier_failed"; message: string }
	| { status: "rolled_back"; reason: string; touchedPaths: string[]; receipt: PromotionReceipt }
	| { status: "needs_attention"; reason: string; promotionId: string; recoveryCopies: string[] };

export interface WorkspaceRecoveryReport {
	leases: {
		ready: number;
		completed: number;
		released: number;
		orphaned: number;
		conflicted: string[];
	};
	worktreesRemoved: string[];
	refsDeleted: string[];
	unmanifestedRefsDeleted: string[];
	blobsDeleted: number;
	metadataDirsRemoved: string[];
	promotions: { recovered: string[]; rolledBack: string[]; needsAttention: string[]; discarded: string[] };
	remainingOrphans: string[];
}

export interface WorkspaceManager {
	capture(input: WorkspaceCaptureInput): Promise<WorkspaceSnapshotRef>;
	fork(snapshot: WorkspaceSnapshotRef, candidateId: string): Promise<WorkspaceLease>;
	/** Re-captures the current state of a lease root into a new snapshot. */
	snapshot(lease: WorkspaceLease): Promise<WorkspaceSnapshotRef>;
	diff(lease: WorkspaceLease): Promise<WorkspacePatch>;
	promote(input: PromotionInput): Promise<PromotionResult>;
	release(lease: WorkspaceLease): Promise<void>;
	/** Loads a snapshot ref by id after reopen. */
	findSnapshot(snapshotId: string): Promise<WorkspaceSnapshotRef>;
	/** True when the manager's durable record shows the snapshot already released. */
	snapshotReleased(snapshotId: string): Promise<boolean>;
	/** Drops a snapshot (ref + unique blobs). Faults while leases reference it. */
	releaseSnapshot(snapshot: WorkspaceSnapshotRef): Promise<void>;
	recover(): Promise<WorkspaceRecoveryReport>;
}

/** Internal adapter surface shared by the two backends. */
export interface WorkspaceManagerBackend extends WorkspaceManager {
	readonly stateRoot: string;
	readonly leaseStatuses: () => Map<string, LeaseStatus>;
}

/**
 * Stage 6 bridge: adapts a real WorkspaceManager onto WorkspaceContinuationPort.
 * The caller-supplied WorkspaceMetadata is never trusted for production
 * backends; everything is re-derived from a real capture.
 */
export interface WorkspaceManagerContinuationAdapterOptions {
	manager: WorkspaceManager;
	sourceRoot: string;
	policy?: WorkspacePolicy;
}

export class WorkspaceManagerContinuationAdapter implements WorkspaceContinuationPort {
	private readonly options: WorkspaceManagerContinuationAdapterOptions;

	constructor(options: WorkspaceManagerContinuationAdapterOptions) {
		this.options = options;
	}

	async snapshot(_untrusted: WorkspaceMetadata, logicalRoot: string): Promise<WorkspaceSnapshot> {
		const ref = await this.options.manager.capture({
			sourceRoot: this.options.sourceRoot,
			logicalRoot,
			policy: this.options.policy,
		});
		return {
			id: ref.id,
			logical: structuredClone(ref.logicalWorkspace),
			files: ref.files.map((file) => ({ ...file })),
		};
	}

	async fork(snapshotId: string, childId: string): Promise<WorkspaceLease> {
		const snapshot = await this.options.manager.findSnapshot(snapshotId);
		return this.options.manager.fork(snapshot, childId);
	}
}
