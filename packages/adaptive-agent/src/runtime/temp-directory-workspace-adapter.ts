import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { ContentStore } from "./content-store.ts";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";
import type { LeaseStatus, SnapshotRecord, UntrackedEntry } from "./runtime-manifest.ts";
import { JsonlManifestStore } from "./runtime-manifest.ts";
import {
	PromotionConflictError,
	SourceWorkspaceChangedError,
	UnsupportedWorkspaceError,
	WorkspaceCaseCollisionError,
	WorkspaceLeaseConflictError,
	WorkspaceManagerFault,
	WorkspaceOrphanedError,
	WorkspacePathEscapeError,
	WorkspaceSnapshotNotFoundError,
} from "./workspace-errors.ts";
import {
	hashPathAt,
	joinUnderRoot,
	listDirEntries,
	lstatKind,
	type PathHash,
	pathExists,
	rmWithRetry,
	sha256File,
	writeFileAtomic,
} from "./workspace-fs.ts";
import {
	type PromotionResult,
	type UntrackedMutationPlan,
	type WorkspaceCaptureInput,
	type WorkspaceDiffSummary,
	type WorkspaceLease,
	type WorkspaceManagerBackend,
	type WorkspacePatch,
	type WorkspaceRecoveryReport,
	type WorkspaceSnapshotRef,
	type WorkspaceVerifier,
	workspaceLeaseId,
} from "./workspace-manager.ts";
import {
	isDeniedPath,
	type ResolvedWorkspacePolicy,
	resolveWorkspacePolicy,
	validateWorkspaceRelativePath,
	type WorkspacePolicy,
	workspacePolicyHash,
} from "./workspace-policy.ts";
import {
	type PlannedPathMutation,
	type PromotionAdapter,
	readPromotionReceipt,
	recoverPromotionJournal,
	runPromotion,
	settlePromotionManifestRecord,
} from "./workspace-promotion.ts";

/**
 * Test-only full-copy backend (no Git). Shares the runtime manifest, content
 * store, promotion journal, and recovery machinery with the Git backend so
 * the same conformance suite exercises both. Uses real byte copies; never
 * hardlinks.
 */

export interface TempDirectoryWorkspaceAdapterOptions {
	stateRoot: string;
	policy?: WorkspacePolicy;
	retry?: { maxAttempts?: number; delayMs?: number };
}

interface WalkedTree {
	entries: UntrackedEntry[];
	excluded: Array<{ path: string; reason: string }>;
	manifestHash: string;
}

export class TempDirectoryWorkspaceManager implements WorkspaceManagerBackend {
	readonly stateRoot: string;
	private readonly options: TempDirectoryWorkspaceAdapterOptions;
	private readonly policy: ResolvedWorkspacePolicy;
	private readonly manifest: JsonlManifestStore;
	private readonly content: ContentStore;
	private readonly worktreesRoot: string;
	private readonly patchesRoot: string;
	private readonly promotionsRoot: string;
	private readonly retryMaxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly leaseStatusCache = new Map<string, LeaseStatus>();

	constructor(options: TempDirectoryWorkspaceAdapterOptions) {
		this.options = options;
		this.stateRoot = options.stateRoot;
		this.policy = resolveWorkspacePolicy(options.policy);
		this.manifest = new JsonlManifestStore({ filePath: join(options.stateRoot, "manifest.jsonl") });
		this.content = new ContentStore({ root: join(options.stateRoot, "content") });
		this.worktreesRoot = join(options.stateRoot, "worktrees");
		this.patchesRoot = join(options.stateRoot, "patches");
		this.promotionsRoot = join(options.stateRoot, "promotions");
		this.retryMaxAttempts = options.retry?.maxAttempts ?? 5;
		this.retryDelayMs = options.retry?.delayMs ?? 250;
	}

	leaseStatuses(): Map<string, LeaseStatus> {
		return new Map(this.leaseStatusCache);
	}

	// ---------------------------------------------------------------- walk

	private async walkTree(root: string): Promise<WalkedTree> {
		const entries: UntrackedEntry[] = [];
		const excluded: Array<{ path: string; reason: string }> = [];
		const seen = new Set<string>();
		let totalBytes = 0;
		const walk = async (directory: string, prefix: string): Promise<void> => {
			for (const name of await readdir(directory)) {
				const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
				const physical = join(directory, name);
				let kind: "file" | "directory" | "link" | "other" | "absent";
				try {
					kind = await lstatKind(physical);
				} catch {
					throw new SourceWorkspaceChangedError(`${relative} disappeared while walking ${root}`);
				}
				if (kind === "directory") {
					await walk(physical, relative);
					continue;
				}
				let validated: string;
				try {
					validated = validateWorkspaceRelativePath(relative, this.policy);
				} catch {
					throw new UnsupportedWorkspaceError(`path ${JSON.stringify(relative)} in ${root} is not capturable`);
				}
				if (isDeniedPath(validated, this.policy)) {
					excluded.push({ path: validated, reason: "policy:deny" });
					continue;
				}
				if (kind === "link") {
					if (!this.policy.allowLinks) {
						throw new UnsupportedWorkspaceError(`link ${validated} is not allowed by policy`);
					}
					assertNoCaseCollision(validated, seen);
					const target = await readlink(physical);
					const absoluteTarget = resolve(dirname(physical), target);
					const rootPrefix = resolve(root);
					if (
						absoluteTarget !== rootPrefix &&
						!absoluteTarget.startsWith(`${rootPrefix}\\`) &&
						!absoluteTarget.startsWith(`${rootPrefix}/`)
					) {
						throw new WorkspacePathEscapeError(`link ${validated} points outside the source root`);
					}
					const stats = await lstat(physical);
					entries.push({
						path: validated,
						kind: "link",
						mode: stats.mode,
						size: 0,
						mtimeMs: Math.trunc(stats.mtimeMs),
						hash: "",
						target: target.replaceAll("\\", "/"),
						targetIsDirectory: (await lstatKind(absoluteTarget)) === "directory",
					});
					continue;
				}
				if (kind !== "file") {
					excluded.push({ path: validated, reason: `unsupported file kind ${kind}` });
					continue;
				}
				const stats = await lstat(physical);
				if (stats.size > this.policy.maxUntrackedFileBytes) {
					excluded.push({ path: validated, reason: "policy:oversize" });
					continue;
				}
				totalBytes += stats.size;
				if (totalBytes > this.policy.maxTotalUntrackedBytes) {
					excluded.push({ path: validated, reason: "policy:total-size" });
					continue;
				}
				if (entries.length >= this.policy.maxUntrackedFiles) {
					excluded.push({ path: validated, reason: "policy:file-count" });
					continue;
				}
				assertNoCaseCollision(validated, seen);
				const hash = await sha256File(physical);
				await this.content.putFile(physical, hash);
				entries.push({
					path: validated,
					kind: "file",
					mode: stats.mode,
					size: stats.size,
					mtimeMs: Math.trunc(stats.mtimeMs),
					hash,
				});
			}
		};
		await walk(root, "");
		entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		const manifestHash = sha256Hex(
			canonicalJson(
				entries.map((entry) => ({
					path: entry.path,
					kind: entry.kind,
					mode: entry.mode,
					size: entry.size,
					hash: entry.hash,
					target: entry.target ?? null,
				})) as unknown as JsonValue,
			),
		);
		return { entries, excluded, manifestHash };
	}

	private async fingerprint(root: string): Promise<{ fingerprint: string; policyHash: string; manifestHash: string }> {
		const walked = await this.walkTree(root);
		const policyHash = workspacePolicyHash(this.options.policy);
		const fingerprint = sha256Hex(
			canonicalJson({
				entries: walked.entries.map((entry) => fingerprintEntry(entry)),
				policyHash,
			} as unknown as JsonValue),
		);
		return { fingerprint, policyHash, manifestHash: walked.manifestHash };
	}

	// ------------------------------------------------------------- capture

	async capture(input: WorkspaceCaptureInput): Promise<WorkspaceSnapshotRef> {
		let sourceRoot: string;
		try {
			sourceRoot = await realpath(resolve(input.sourceRoot));
		} catch (error) {
			throw new UnsupportedWorkspaceError(`${input.sourceRoot} cannot be resolved: ${(error as Error).message}`);
		}
		const kind = await lstatKind(sourceRoot);
		if (kind !== "directory") {
			throw new UnsupportedWorkspaceError(`${sourceRoot} is not a directory`);
		}
		const first = await this.walkTree(sourceRoot);
		const firstFingerprint = sha256Hex(
			canonicalJson({
				entries: first.entries.map((entry) => fingerprintEntry(entry)),
				policyHash: workspacePolicyHash(this.options.policy),
			} as unknown as JsonValue),
		);
		const second = await this.walkTree(sourceRoot);
		const secondFingerprint = sha256Hex(
			canonicalJson({
				entries: second.entries.map((entry) => fingerprintEntry(entry)),
				policyHash: workspacePolicyHash(this.options.policy),
			} as unknown as JsonValue),
		);
		if (firstFingerprint !== secondFingerprint) {
			throw new SourceWorkspaceChangedError(`${sourceRoot} changed while the snapshot was being captured`);
		}
		const snapshotId = sha256Hex(`${randomUUID()}:${firstFingerprint}`);
		const policyHash = workspacePolicyHash(this.options.policy);
		const promotionRepoId = input.promotionOrigin?.repoId ?? sha256Hex(sourceRoot.replaceAll("\\", "/"));
		const record = {
			type: "snapshot",
			snapshotId,
			repoId: promotionRepoId,
			sourceRoot,
			repoRoot: input.promotionOrigin?.repoRoot ?? sourceRoot,
			commonDir: "",
			backend: "temp-copy" as const,
			ref: `temp-copy://${snapshotId}`,
			commitOid: "",
			headOid: "",
			indexTree: "",
			trackedTree: "",
			untrackedManifestHash: first.manifestHash,
			policyHash,
			fingerprint: firstFingerprint,
			logicalRoot: input.logicalRoot,
			createdAt: Date.now(),
			untracked: first.entries,
			untrackedExcluded: first.excluded,
			...(input.promotionOrigin === undefined
				? {}
				: {
						promotionOriginSnapshotId: input.promotionOrigin.snapshotId,
						promotionOriginFingerprint: input.promotionOrigin.fingerprint,
					}),
		} satisfies Omit<SnapshotRecord, "seq">;
		await this.manifest.append(record);
		return {
			id: snapshotId,
			sourceRoot,
			backend: "temp-copy",
			fingerprint: firstFingerprint,
			logicalWorkspace: { root: input.logicalRoot, contentFingerprint: firstFingerprint },
			files: first.entries.map((entry) => ({
				path: entry.path,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
				hash: entry.hash,
			})),
		};
	}

	async findSnapshot(snapshotId: string): Promise<WorkspaceSnapshotRef> {
		const folded = await this.manifest.fold();
		const record = folded.snapshots.get(snapshotId);
		if (record === undefined || record.backend !== "temp-copy") {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshotId} has no temp-copy manifest record`);
		}
		if (folded.releasedSnapshots.has(snapshotId)) {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshotId} was released`);
		}
		return this.refFromRecord(record);
	}

	async snapshotReleased(snapshotId: string): Promise<boolean> {
		return (await this.manifest.fold()).releasedSnapshots.has(snapshotId);
	}

	private refFromRecord(record: SnapshotRecord): WorkspaceSnapshotRef {
		return {
			id: record.snapshotId,
			sourceRoot: record.sourceRoot,
			backend: "temp-copy",
			fingerprint: record.fingerprint,
			logicalWorkspace: { root: record.logicalRoot, contentFingerprint: record.fingerprint },
			files: record.untracked.map((entry) => ({
				path: entry.path,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
				hash: entry.hash,
			})),
		};
	}

	// ---------------------------------------------------------------- fork

	async fork(snapshot: WorkspaceSnapshotRef, candidateId: string): Promise<WorkspaceLease> {
		if (snapshot.backend !== "temp-copy") {
			throw new WorkspaceLeaseConflictError(`snapshot ${snapshot.id} belongs to another backend`);
		}
		const folded = await this.manifest.fold();
		const record = folded.snapshots.get(snapshot.id);
		if (record === undefined) {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshot.id} has no manifest record`);
		}
		const leaseId = workspaceLeaseId(snapshot.id, candidateId);
		const existing = folded.leases.get(leaseId);
		if (existing !== undefined) {
			await this.attachExistingLease(existing, snapshot, candidateId);
			const attached = (await this.manifest.fold()).leases.get(leaseId)!;
			return this.leaseFromRecord(attached, record);
		}
		const root = join(this.worktreesRoot, record.repoId.slice(0, 16), candidateId);
		await this.manifest.append({
			type: "lease",
			leaseId,
			snapshotId: snapshot.id,
			candidateId,
			root,
			gitDir: "",
			worktreeName: candidateId,
			status: "creating",
			createdAt: Date.now(),
		});
		// On failure the creating record stays durable for recover().
		await this.materialize(record, root);
		const foldedAfter = await this.manifest.fold();
		const existingAfter = foldedAfter.leases.get(leaseId);
		await this.manifest.append({
			type: "lease",
			leaseId,
			snapshotId: snapshot.id,
			candidateId,
			root,
			gitDir: "",
			worktreeName: candidateId,
			status: "ready",
			createdAt: existingAfter?.createdAt ?? Date.now(),
		});
		const ready = (await this.manifest.fold()).leases.get(leaseId)!;
		return this.leaseFromRecord(ready, record);
	}

	private async attachExistingLease(
		existing: { leaseId: string; snapshotId: string; candidateId: string; root: string; status: LeaseStatus },
		snapshot: WorkspaceSnapshotRef,
		candidateId: string,
	): Promise<void> {
		if (existing.snapshotId !== snapshot.id || existing.candidateId !== candidateId) {
			throw new WorkspaceLeaseConflictError(
				`lease ${existing.leaseId} exists for ${existing.snapshotId}/${existing.candidateId}, not ${snapshot.id}/${candidateId}`,
			);
		}
		switch (existing.status) {
			case "ready": {
				if (!(await pathExists(existing.root))) {
					throw new WorkspaceLeaseConflictError(
						`lease ${existing.leaseId} is recorded ready but its worktree is missing`,
					);
				}
				return;
			}
			case "creating":
				throw new WorkspaceLeaseConflictError(
					`lease ${existing.leaseId} is still creating; run recover() to finish it`,
				);
			case "releasing":
			case "orphaned":
				throw new WorkspaceLeaseConflictError(
					`lease ${existing.leaseId} is ${existing.status}; run recover() to settle it`,
				);
			case "released":
				throw new WorkspaceLeaseConflictError(`lease ${existing.leaseId} was released; its snapshot may be gone`);
		}
	}

	private async materialize(record: SnapshotRecord, root: string): Promise<void> {
		await mkdir(root, { recursive: true });
		const files = record.untracked.filter((entry) => entry.kind === "file");
		const links = record.untracked.filter((entry) => entry.kind === "link");
		for (const entry of files) {
			const destination = joinUnderRoot(root, entry.path);
			await mkdir(dirname(destination), { recursive: true });
			await this.content.copyTo(entry.hash, destination);
		}
		for (const entry of links) {
			const destination = joinUnderRoot(root, entry.path);
			await mkdir(dirname(destination), { recursive: true });
			const target = entry.target ?? "";
			try {
				await symlink(target, destination, entry.targetIsDirectory ? "junction" : "file");
			} catch (error) {
				const targetPath = resolve(dirname(destination), target);
				const rootPrefix = resolve(root);
				const inside =
					targetPath === rootPrefix ||
					targetPath.startsWith(`${rootPrefix}\\`) ||
					targetPath.startsWith(`${rootPrefix}/`);
				if (entry.targetIsDirectory || !inside || !(await pathExists(targetPath))) {
					throw new WorkspaceManagerFault(
						`Failed to materialize link ${entry.path} and no byte-copy fallback exists`,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				await writeFileAtomic(destination, await readFile(targetPath));
			}
		}
	}

	private leaseFromRecord(
		lease: { leaseId: string; snapshotId: string; candidateId: string; root: string; status: LeaseStatus },
		record: SnapshotRecord,
	): WorkspaceLease {
		const snapshotRef = this.refFromRecord(record);
		const logical = snapshotRef.logicalWorkspace;
		const leaseObject: WorkspaceLease = {
			id: lease.leaseId,
			snapshotId: lease.snapshotId,
			candidateId: lease.candidateId,
			root: lease.root,
			environment: {
				physicalRoot: lease.root,
				logicalWorkspace: structuredClone(logical),
				toPhysicalPath: (logicalPath: string): string => {
					if (logicalPath === logical.root) return lease.root;
					if (!logicalPath.startsWith(`${logical.root}/`)) return logicalPath;
					return join(lease.root, ...logicalPath.slice(logical.root.length + 1).split("/"));
				},
			},
			release: async (): Promise<void> => {
				await this.release(leaseObject);
			},
		};
		this.leaseStatusCache.set(lease.leaseId, lease.status);
		return leaseObject;
	}

	// ------------------------------------------------------------- snapshot

	async snapshot(lease: WorkspaceLease): Promise<WorkspaceSnapshotRef> {
		const record = await this.requireReadyLeaseSnapshot(lease);
		return this.capture({
			sourceRoot: lease.root,
			logicalRoot: record.logicalRoot,
			policy: this.options.policy,
			// Stage 8 promotion lineage: the new snapshot's content is the
			// fork base (this lease's state), while the promotion baseline
			// chains to the ORIGINAL foreground snapshot.
			promotionOrigin: {
				sourceRoot: record.sourceRoot,
				repoRoot: record.repoRoot,
				repoId: record.repoId,
				snapshotId: record.promotionOriginSnapshotId ?? record.snapshotId,
				fingerprint: record.promotionOriginFingerprint ?? record.fingerprint,
			},
		});
	}

	// ---------------------------------------------------------------- diff

	async diff(lease: WorkspaceLease): Promise<WorkspacePatch> {
		const snapshot = await this.requireReadyLeaseSnapshot(lease);
		const plan = await this.buildPlan(lease, snapshot, new Set());
		const untrackedManifestPath = join(this.patchesRoot, `${snapshot.snapshotId}-${plan.hash}.json`);
		await mkdir(this.patchesRoot, { recursive: true });
		await writeFileAtomic(untrackedManifestPath, Buffer.from(canonicalJson(plan as unknown as JsonValue), "utf8"));
		const summary: WorkspaceDiffSummary = {
			tracked: { added: 0, modified: 0, deleted: 0, binary: 0 },
			untracked: {
				created: plan.ops.filter((op) => op.op === "create").length,
				modified: plan.ops.filter((op) => op.op === "modify").length,
				deleted: plan.ops.filter((op) => op.op === "delete").length,
				absorbedByTracked: [],
			},
			touchedPaths: plan.ops.map((op) => op.path).sort(),
			trackedPatchHash: "",
			untrackedManifestHash: plan.hash,
		};
		return {
			snapshotId: snapshot.snapshotId,
			leaseId: lease.id,
			trackedPatchPath: "",
			untrackedManifestPath,
			summary,
		};
	}

	private async buildPlan(
		lease: WorkspaceLease,
		snapshot: SnapshotRecord,
		_trackedTouched: Set<string>,
	): Promise<UntrackedMutationPlan> {
		const current = await this.walkTree(lease.root);
		const currentMap = new Map(current.entries.map((entry) => [entry.path, entry]));
		const snapshotMap = new Map(snapshot.untracked.map((entry) => [entry.path, entry]));
		const ops: UntrackedMutationPlan["ops"] = [];
		for (const entry of current.entries) {
			const before = snapshotMap.get(entry.path);
			if (before === undefined) {
				ops.push(untrackedOpEntry(entry, "create"));
			} else if (before.kind !== entry.kind || before.hash !== entry.hash || before.target !== entry.target) {
				ops.push(untrackedOpEntry(entry, "modify"));
			}
		}
		for (const [path] of snapshotMap) {
			if (!currentMap.has(path)) ops.push({ path, op: "delete" });
		}
		ops.sort((left, right) => (left.path < right.path ? -1 : 1));
		const plan: UntrackedMutationPlan = { snapshotId: snapshot.snapshotId, leaseId: lease.id, ops, hash: "" };
		plan.hash = sha256Hex(
			canonicalJson({ snapshotId: plan.snapshotId, leaseId: plan.leaseId, ops: plan.ops } as unknown as JsonValue),
		);
		return plan;
	}

	// ------------------------------------------------------------- promote

	private async requireReadyLeaseSnapshot(lease: WorkspaceLease): Promise<SnapshotRecord> {
		const folded = await this.manifest.fold();
		const leaseRecord = folded.leases.get(lease.id);
		if (leaseRecord === undefined) {
			throw new WorkspaceLeaseConflictError(`lease ${lease.id} has no manifest record`);
		}
		if (leaseRecord.snapshotId !== lease.snapshotId || leaseRecord.root !== lease.root) {
			throw new WorkspaceLeaseConflictError(`lease ${lease.id} identity does not match its manifest record`);
		}
		if (leaseRecord.status === "orphaned") {
			throw new WorkspaceOrphanedError(`lease ${lease.id} is orphaned; run recover() first`);
		}
		if (leaseRecord.status !== "ready") {
			throw new WorkspaceLeaseConflictError(`lease ${lease.id} is ${leaseRecord.status}, not ready`);
		}
		const snapshot = (await this.manifest.fold()).snapshots.get(lease.snapshotId);
		if (snapshot === undefined) {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${lease.snapshotId} has no manifest record`);
		}
		return snapshot;
	}

	async promote(input: {
		lease: WorkspaceLease;
		verifier?: WorkspaceVerifier;
		finalVerifier?: WorkspaceVerifier;
	}): Promise<PromotionResult> {
		const snapshot = await this.requireReadyLeaseSnapshot(input.lease);
		const origin = await this.promotionOriginOf(snapshot);
		const adapter = await this.promotionAdapter(input.lease, origin);
		const promotionId = sha256Hex(`${input.lease.id}:${snapshot.snapshotId}`);
		// Stage 8 receipt (S8.6): a completed attempt replays its durable
		// result; the successful closed journal is never deleted or re-run.
		const receipt = await readPromotionReceipt(join(this.promotionsRoot, `${promotionId}.jsonl`), {
			promotionId,
			leaseId: input.lease.id,
			snapshotId: snapshot.snapshotId,
		});
		if (receipt !== undefined) {
			await settlePromotionManifestRecord(this.manifest, promotionId, input.lease.id);
			return receipt.status === "promoted"
				? { status: "promoted", touchedPaths: receipt.touchedPaths, receipt }
				: {
						status: "rolled_back",
						reason: receipt.reason ?? "the previous promotion attempt rolled back",
						touchedPaths: receipt.touchedPaths,
						receipt,
					};
		}
		await this.manifest.append({
			type: "promotion",
			promotionId,
			leaseId: input.lease.id,
			status: "open",
		});
		const result = await runPromotion({
			promotionId,
			leaseId: input.lease.id,
			snapshotId: snapshot.snapshotId,
			promotionOrigin: { snapshotId: origin.snapshotId, fingerprint: origin.fingerprint },
			journalPath: join(this.promotionsRoot, `${promotionId}.jsonl`),
			recoveryDir: join(this.promotionsRoot, promotionId, "recovery"),
			adapter,
			lease: input.lease,
			verifier: input.verifier,
			finalVerifier: input.finalVerifier,
		});
		if (result.status !== "needs_attention") {
			await this.manifest.append({
				type: "promotion",
				promotionId,
				leaseId: input.lease.id,
				status: "closed",
			});
		}
		return result;
	}

	/**
	 * Resolves the promotion baseline of a lease-derived snapshot: the
	 * ORIGINAL foreground snapshot (chain of promotionOriginSnapshotId). A
	 * foreground capture is its own origin.
	 */
	private async promotionOriginOf(snapshot: SnapshotRecord): Promise<SnapshotRecord> {
		const originId = snapshot.promotionOriginSnapshotId ?? snapshot.snapshotId;
		const origin = (await this.manifest.fold()).snapshots.get(originId);
		if (origin === undefined) {
			throw new WorkspaceSnapshotNotFoundError(
				`promotion origin ${originId} of snapshot ${snapshot.snapshotId} has no manifest record`,
			);
		}
		return origin;
	}

	private async promotionAdapter(lease: WorkspaceLease, origin: SnapshotRecord): Promise<PromotionAdapter> {
		const foregroundRoot = origin.repoRoot;
		if (!(await pathExists(foregroundRoot))) {
			throw new PromotionConflictError(`foreground directory ${foregroundRoot} no longer exists`);
		}
		return {
			snapshotFingerprint: async () => origin.fingerprint,
			computeForegroundFingerprint: async () => (await this.fingerprint(foregroundRoot)).fingerprint,
			buildPlan: async () => {
				// Full origin -> winner plan: the lease diff is computed against
				// the promotion origin, so the source's own mutations are part
				// of the applied patch.
				const plan = await this.buildPlan(lease, origin, new Set());
				const paths: PlannedPathMutation[] = [];
				const preimages = new Map<string, PathHash>();
				for (const op of plan.ops) {
					const current = await hashPathAt(foregroundRoot, op.path);
					switch (op.op) {
						case "create":
						case "modify":
							paths.push({
								path: op.path,
								op: op.op === "create" ? "untracked_create" : "untracked_modify",
								targetHash: op.hash ?? null,
								sourcePath: joinUnderRoot(lease.root, op.path),
								target: op.target,
								targetIsDirectory: op.targetIsDirectory,
							});
							break;
						case "delete":
							paths.push({ path: op.path, op: "untracked_delete", targetHash: null });
							break;
					}
					preimages.set(op.path, current);
				}
				return { plan: { paths }, preimages, foregroundRoot, leaseRoot: lease.root };
			},
			applyPath: async (entry, root) => {
				switch (entry.op) {
					case "untracked_create":
					case "untracked_modify": {
						if (entry.target !== undefined && entry.targetHash === null) {
							const destination = joinUnderRoot(root, entry.path);
							await mkdir(dirname(destination), { recursive: true });
							try {
								await symlink(entry.target, destination, entry.targetIsDirectory ? "junction" : "file");
							} catch (error) {
								const source = entry.sourcePath;
								if (source === undefined) throw error;
								await writeFileAtomic(destination, await readFile(source));
							}
							return;
						}
						if (entry.sourcePath === undefined) {
							throw new WorkspaceManagerFault(`source for ${entry.path} is missing`);
						}
						if (entry.targetHash !== null) {
							const verified = await sha256File(entry.sourcePath);
							if (verified !== entry.targetHash) {
								throw new WorkspaceManagerFault(
									`candidate source for ${entry.path} drifted (${verified} != ${entry.targetHash})`,
								);
							}
						}
						await writeFileAtomic(joinUnderRoot(root, entry.path), await readFile(entry.sourcePath));
						return;
					}
					case "untracked_delete": {
						const removed = await rmWithRetry(joinUnderRoot(root, entry.path), {
							maxAttempts: this.retryMaxAttempts,
							delayMs: this.retryDelayMs,
						});
						if (!removed) {
							throw new PromotionConflictError(`could not remove ${entry.path} from the foreground`);
						}
						return;
					}
					case "tracked_patch":
						throw new WorkspaceManagerFault(`temp-copy backend received a tracked patch for ${entry.path}`);
				}
			},
			hashForegroundPath: async (root, path) => hashPathAt(root, path),
		};
	}

	// ------------------------------------------------------------- release

	async release(lease: WorkspaceLease): Promise<void> {
		const folded = await this.manifest.fold();
		const record = folded.leases.get(lease.id);
		if (record === undefined) {
			throw new WorkspaceLeaseConflictError(`lease ${lease.id} has no manifest record`);
		}
		if (record.snapshotId !== lease.snapshotId) {
			throw new WorkspaceLeaseConflictError(`lease ${lease.id} does not reference snapshot ${lease.snapshotId}`);
		}
		if (record.status === "released") return;
		await this.markLease(record, "releasing");
		const removed = await this.removeWorktree(record.root);
		if (!removed) {
			await this.markLease(record, "orphaned");
			throw new WorkspaceOrphanedError(
				`lease ${lease.id} worktree ${record.root} is locked; marked orphaned for recover()`,
			);
		}
		await this.markLease(record, "released");
		await this.releaseSnapshotIfUnreferenced(record.snapshotId);
	}

	/** True while a non-released derived snapshot names this snapshot as its promotion origin. */
	private async referencedAsPromotionOrigin(snapshotId: string): Promise<boolean> {
		const folded = await this.manifest.fold();
		return [...folded.snapshots.values()].some(
			(record) =>
				record.promotionOriginSnapshotId === snapshotId && !folded.releasedSnapshots.has(record.snapshotId),
		);
	}

	private async releaseSnapshotIfUnreferenced(snapshotId: string): Promise<void> {
		const folded = await this.manifest.fold();
		for (const lease of folded.leases.values()) {
			if (lease.snapshotId === snapshotId && lease.status !== "released") return;
		}
		// Stage 8 reference-aware retention: a snapshot that is still the
		// promotion origin of a live derived snapshot stays retained.
		if (await this.referencedAsPromotionOrigin(snapshotId)) return;
		if (folded.releasedSnapshots.has(snapshotId)) return;
		await this.manifest.append({ type: "snapshot.released", snapshotId });
	}

	private async markLease(
		record: {
			leaseId: string;
			snapshotId: string;
			candidateId: string;
			root: string;
			gitDir: string;
			worktreeName: string;
			createdAt: number;
		},
		status: LeaseStatus,
	): Promise<void> {
		this.leaseStatusCache.set(record.leaseId, status);
		await this.manifest.append({
			type: "lease",
			leaseId: record.leaseId,
			snapshotId: record.snapshotId,
			candidateId: record.candidateId,
			root: record.root,
			gitDir: record.gitDir,
			worktreeName: record.worktreeName,
			status,
			createdAt: record.createdAt,
		});
	}

	private async removeWorktree(root: string): Promise<boolean> {
		if (!(await pathExists(root))) return true;
		const removed = await rmWithRetry(root, {
			maxAttempts: this.retryMaxAttempts,
			delayMs: this.retryDelayMs,
		});
		return removed;
	}

	async releaseSnapshot(snapshot: WorkspaceSnapshotRef): Promise<void> {
		const folded = await this.manifest.fold();
		for (const lease of folded.leases.values()) {
			if (lease.snapshotId === snapshot.id && lease.status !== "released") {
				throw new WorkspaceLeaseConflictError(
					`snapshot ${snapshot.id} is still referenced by lease ${lease.leaseId}`,
				);
			}
		}
		if (folded.releasedSnapshots.has(snapshot.id)) return;
		// Stage 8 reference-aware retention: deferred while a live derived
		// snapshot still needs this snapshot as its promotion baseline.
		if (await this.referencedAsPromotionOrigin(snapshot.id)) return;
		await this.manifest.append({ type: "snapshot.released", snapshotId: snapshot.id });
	}

	// ------------------------------------------------------------- recover

	async recover(): Promise<WorkspaceRecoveryReport> {
		const report: WorkspaceRecoveryReport = {
			leases: { ready: 0, completed: 0, released: 0, orphaned: 0, conflicted: [] },
			worktreesRemoved: [],
			refsDeleted: [],
			unmanifestedRefsDeleted: [],
			blobsDeleted: 0,
			metadataDirsRemoved: [],
			promotions: { recovered: [], rolledBack: [], needsAttention: [], discarded: [] },
			remainingOrphans: [],
		};
		const folded = await this.manifest.fold();
		for (const lease of folded.leases.values()) {
			await this.recoverLease(lease, folded, report);
		}
		const refolded = await this.manifest.fold();
		await this.recoverPromotionJournals(refolded, report);
		await this.recoverContentBlobs(refolded, report);
		await this.recoverStrayDirectories(refolded, report);
		const final = await this.manifest.fold();
		for (const lease of final.leases.values()) {
			if (lease.status === "orphaned" || lease.status === "releasing" || lease.status === "creating") {
				report.remainingOrphans.push(lease.leaseId);
			}
		}
		return report;
	}

	private async recoverLease(
		lease: {
			leaseId: string;
			snapshotId: string;
			candidateId: string;
			root: string;
			gitDir: string;
			worktreeName: string;
			status: LeaseStatus;
			createdAt: number;
		},
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const snapshot = folded.snapshots.get(lease.snapshotId);
		if (snapshot === undefined || snapshot.backend !== "temp-copy") {
			report.leases.conflicted.push(lease.leaseId);
			return;
		}
		switch (lease.status) {
			case "creating": {
				try {
					await this.materialize(snapshot, lease.root);
					await this.markLease(lease, "ready");
					report.leases.completed += 1;
				} catch {
					report.leases.conflicted.push(lease.leaseId);
				}
				return;
			}
			case "ready": {
				if (await pathExists(lease.root)) {
					report.leases.ready += 1;
				} else {
					await this.markLease(lease, "orphaned");
					report.leases.orphaned += 1;
				}
				return;
			}
			case "releasing":
			case "orphaned": {
				const removed = await this.removeWorktree(lease.root);
				if (removed) {
					await this.markLease(lease, "released");
					report.leases.released += 1;
				} else {
					if (lease.status !== "orphaned") await this.markLease(lease, "orphaned");
					report.leases.orphaned += 1;
				}
				return;
			}
			case "released": {
				if (await pathExists(lease.root)) {
					const removed = await this.removeWorktree(lease.root);
					if (!removed) report.leases.orphaned += 1;
					else report.worktreesRemoved.push(lease.root);
				}
				report.leases.released += 1;
				return;
			}
		}
	}

	private async recoverPromotionJournals(
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		for (const promotion of folded.promotions.values()) {
			if (promotion.status !== "open") continue;
			const journalPath = join(this.promotionsRoot, `${promotion.promotionId}.jsonl`);
			if (!(await pathExists(journalPath))) {
				await this.manifest.append({
					type: "promotion",
					promotionId: promotion.promotionId,
					leaseId: promotion.leaseId,
					status: "closed",
				});
				report.promotions.discarded.push(promotion.promotionId);
				continue;
			}
			const lease = folded.leases.get(promotion.leaseId);
			const snapshot = lease === undefined ? undefined : folded.snapshots.get(lease.snapshotId);
			if (lease === undefined || snapshot === undefined) {
				report.promotions.needsAttention.push(promotion.promotionId);
				continue;
			}
			const originId = snapshot.promotionOriginSnapshotId ?? snapshot.snapshotId;
			const origin = folded.snapshots.get(originId) ?? snapshot;
			const outcome = await recoverPromotionJournal({
				journalPath,
				recoveryDir: join(this.promotionsRoot, promotion.promotionId, "recovery"),
				foregroundRoot: origin.repoRoot,
				leaseId: promotion.leaseId,
				snapshotId: lease.snapshotId,
				promotionOriginSnapshotId: origin.snapshotId,
				promotionOriginFingerprint: origin.fingerprint,
			});
			switch (outcome.action) {
				case "discarded":
					report.promotions.discarded.push(outcome.promotionId);
					await this.manifest.append({
						type: "promotion",
						promotionId: promotion.promotionId,
						leaseId: promotion.leaseId,
						status: "closed",
					});
					break;
				case "rolled_back":
					report.promotions.rolledBack.push(outcome.promotionId);
					await this.manifest.append({
						type: "promotion",
						promotionId: promotion.promotionId,
						leaseId: promotion.leaseId,
						status: "closed",
					});
					break;
				case "needs_attention":
					report.promotions.needsAttention.push(outcome.promotionId);
					break;
				case "unchanged":
					break;
			}
		}
	}

	private async recoverContentBlobs(
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const referenced = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend !== "temp-copy" || folded.releasedSnapshots.has(snapshot.snapshotId)) continue;
			for (const entry of snapshot.untracked) {
				if (entry.kind === "file") referenced.add(entry.hash);
			}
		}
		for (const blob of await listDirEntries(this.content.rootPath)) {
			if (blob.includes(".tmp-")) continue;
			if (!referenced.has(blob)) {
				await this.content.remove(blob);
				report.blobsDeleted += 1;
			}
		}
	}

	private async recoverStrayDirectories(
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const knownRoots = new Set<string>();
		for (const lease of folded.leases.values()) {
			if (lease.status === "released") continue;
			knownRoots.add(resolve(lease.root));
		}
		for (const repoDir of await listDirEntries(this.worktreesRoot)) {
			const repoPath = join(this.worktreesRoot, repoDir);
			const repoLive = [...knownRoots].some((known) => resolve(dirname(known)) === resolve(repoPath));
			if (!repoLive) {
				const removed = await rmWithRetry(repoPath, {
					maxAttempts: this.retryMaxAttempts,
					delayMs: this.retryDelayMs,
				});
				if (removed) report.worktreesRemoved.push(repoPath);
				else report.remainingOrphans.push(repoPath);
				continue;
			}
			for (const candidateDir of await listDirEntries(repoPath)) {
				const candidatePath = join(repoPath, candidateDir);
				if (knownRoots.has(resolve(candidatePath))) continue;
				const removed = await rmWithRetry(candidatePath, {
					maxAttempts: this.retryMaxAttempts,
					delayMs: this.retryDelayMs,
				});
				if (removed) report.worktreesRemoved.push(candidatePath);
				else report.remainingOrphans.push(candidatePath);
			}
		}
	}
}

function assertNoCaseCollision(path: string, seen: Set<string>): void {
	const key = path.toLowerCase();
	if (seen.has(key)) {
		throw new WorkspaceCaseCollisionError(`path ${JSON.stringify(path)} collides case-insensitively`);
	}
	seen.add(key);
}

/** Integer-safe fingerprint projection of one tree entry (mtime never enters). */
function fingerprintEntry(entry: UntrackedEntry): {
	path: string;
	kind: string;
	mode: number;
	size: number;
	hash: string;
	target: string | null;
} {
	return {
		path: entry.path,
		kind: entry.kind,
		mode: entry.mode,
		size: entry.size,
		hash: entry.hash,
		target: entry.target ?? null,
	};
}

/** Canonical-JSON-safe mutation op for one entry (no undefined fields). */
function untrackedOpEntry(entry: UntrackedEntry, op: "create" | "modify"): UntrackedMutationPlan["ops"][number] {
	const base = { path: entry.path, op, kind: entry.kind, size: entry.size };
	if (entry.kind === "file") {
		return { ...base, hash: entry.hash };
	}
	return {
		...base,
		target: entry.target ?? "",
		...(entry.targetIsDirectory === undefined ? {} : { targetIsDirectory: entry.targetIsDirectory }),
	};
}
