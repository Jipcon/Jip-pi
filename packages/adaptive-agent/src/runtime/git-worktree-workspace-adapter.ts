import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { ContentStore } from "./content-store.ts";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";
import type { LeaseStatus, SnapshotRecord, UntrackedEntry } from "./runtime-manifest.ts";
import { JsonlManifestStore } from "./runtime-manifest.ts";
import {
	PromotionConflictError,
	SourceWorkspaceChangedError,
	UnsupportedRepositoryStateError,
	UnsupportedWorkspaceError,
	WorkspaceCaseCollisionError,
	WorkspaceLeaseConflictError,
	WorkspaceManagerFault,
	WorkspaceOrphanedError,
	WorkspacePathEscapeError,
	WorkspaceSnapshotMismatch,
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
	resolvedPolicyHash,
	resolveWorkspacePolicy,
	validateWorkspaceRelativePath,
	type WorkspacePolicy,
} from "./workspace-policy.ts";
import {
	type PlannedPathMutation,
	type PromotionAdapter,
	readPromotionReceipt,
	recoverPromotionJournal,
	runPromotion,
	settlePromotionManifestRecord,
} from "./workspace-promotion.ts";

const execFileP = promisify(execFile);

const PRIVATE_REF_PREFIX = "refs/pi-adaptive";
const SNAPSHOT_REF_PREFIX = "refs/pi-adaptive/snapshots";

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

interface GitMeta {
	repoRoot: string;
	commonDir: string;
	gitDir: string;
	isBare: boolean;
	insideWorkTree: boolean;
	superproject: string;
}

export interface GitWorktreeWorkspaceAdapterOptions {
	/** Manager-owned state directory (worktrees, manifest, content, journals). */
	stateRoot: string;
	policy?: WorkspacePolicy;
	retry?: { maxAttempts?: number; delayMs?: number };
	/** Extra environment for git subprocesses. */
	env?: NodeJS.ProcessEnv;
}

interface UntrackedPass {
	entries: UntrackedEntry[];
	excluded: Array<{ path: string; reason: string }>;
	manifestHash: string;
}

interface CaptureFacts {
	headOid: string;
	indexTree: string;
	commitOid: string;
	trackedTree: string;
	untracked: UntrackedPass;
	fingerprint: string;
	policyHash: string;
}

/**
 * Production Git worktree backend. See docs/workspace-manager.md. Never
 * touches the foreground branch or index outside promotion (where the index
 * is restored to the capture-time tree after applying the patch).
 */
export class GitWorktreeWorkspaceManager implements WorkspaceManagerBackend {
	readonly stateRoot: string;
	private readonly options: GitWorktreeWorkspaceAdapterOptions;
	private readonly policy: ResolvedWorkspacePolicy;
	private readonly manifest: JsonlManifestStore;
	private readonly content: ContentStore;
	private readonly worktreesRoot: string;
	private readonly patchesRoot: string;
	private readonly promotionsRoot: string;
	private readonly retryMaxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly leaseStatusCache = new Map<string, LeaseStatus>();

	constructor(options: GitWorktreeWorkspaceAdapterOptions) {
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

	// ------------------------------------------------------------------ git

	private async git(dir: string, args: string[]): Promise<GitResult> {
		try {
			const result = await execFileP("git", args, {
				cwd: dir,
				encoding: "utf8",
				windowsHide: true,
				maxBuffer: 64 * 1024 * 1024,
				env: {
					...process.env,
					...this.options.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
				},
			});
			return { ok: true, stdout: result.stdout, stderr: result.stderr, code: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; code?: number };
			return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
		}
	}

	private async gitBuffer(dir: string, args: string[]): Promise<Buffer> {
		return await new Promise<Buffer>((resolveBuffer, reject) => {
			execFile(
				"git",
				args,
				{
					cwd: dir,
					encoding: "buffer",
					windowsHide: true,
					maxBuffer: 64 * 1024 * 1024,
					env: {
						...process.env,
						...this.options.env,
						GIT_OPTIONAL_LOCKS: "0",
						GIT_TERMINAL_PROMPT: "0",
					},
				},
				(error: Error | null, stdout: string | Buffer) => {
					if (error !== null) {
						reject(new WorkspaceManagerFault(`git ${args.join(" ")} failed in ${dir}: ${String(error)}`, error));
						return;
					}
					resolveBuffer(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
				},
			);
		});
	}

	private async requireGit(dir: string, args: string[], failure: (detail: string) => Error): Promise<string> {
		const result = await this.git(dir, args);
		if (!result.ok) {
			throw failure(`${args.join(" ")} failed: ${result.stderr.trim()}`);
		}
		return result.stdout.trim();
	}

	private async gitMeta(sourceRoot: string): Promise<GitMeta> {
		const isBare = (await this.git(sourceRoot, ["rev-parse", "--is-bare-repository"])).stdout.trim();
		const inside = (await this.git(sourceRoot, ["rev-parse", "--is-inside-work-tree"])).stdout.trim();
		const superproject = (
			await this.git(sourceRoot, ["rev-parse", "--show-superproject-working-tree"])
		).stdout.trim();
		const repoRoot = (await this.git(sourceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
		const commonDir = (
			await this.git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
		).stdout.trim();
		const gitDir = (await this.git(sourceRoot, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
		return {
			repoRoot,
			commonDir,
			gitDir,
			isBare: isBare === "true",
			insideWorkTree: inside === "true",
			superproject,
		};
	}

	private async assertRepositorySupported(meta: GitMeta, dir: string): Promise<void> {
		if (meta.isBare || !meta.insideWorkTree) {
			throw new UnsupportedWorkspaceError(`${dir} is not a Git worktree`);
		}
		if (meta.superproject.length > 0) {
			throw new UnsupportedWorkspaceError(`${dir} is a submodule of ${meta.superproject}`);
		}
		const sparse = await this.git(dir, ["config", "--worktree", "--bool", "core.sparseCheckout"]);
		if (sparse.ok && sparse.stdout.trim() === "true") {
			throw new UnsupportedWorkspaceError(`${dir} uses a sparse checkout`);
		}
		const unmerged = await this.git(dir, ["ls-files", "--unmerged"]);
		if (unmerged.stdout.trim().length > 0) {
			throw new UnsupportedRepositoryStateError(`${dir} has an unmerged index`);
		}
		for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
			const markerPath = (await this.git(dir, ["rev-parse", "--git-path", marker])).stdout.trim();
			if (markerPath.length > 0 && (await pathExists(markerPath))) {
				throw new UnsupportedRepositoryStateError(`${dir} has an in-progress ${marker}`);
			}
		}
		for (const markerDir of ["rebase-merge", "rebase-apply", "sequencer"]) {
			const markerPath = (await this.git(dir, ["rev-parse", "--git-path", markerDir])).stdout.trim();
			if (markerPath.length > 0 && (await pathExists(markerPath))) {
				throw new UnsupportedRepositoryStateError(`${dir} has an in-progress ${markerDir} operation`);
			}
		}
		const head = await this.git(dir, ["rev-parse", "--verify", "HEAD"]);
		if (!head.ok) {
			throw new UnsupportedRepositoryStateError(`${dir} has no HEAD commit`);
		}
	}

	// ------------------------------------------------------------ untracked

	private async enumerateUntracked(repoRoot: string, policy: ResolvedWorkspacePolicy): Promise<UntrackedPass> {
		const raw = await this.gitBuffer(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
		const paths = raw
			.toString("utf8")
			.split("\0")
			.filter((path) => path.length > 0);
		// Seed the case-collision set with every tracked path.
		const trackedRaw = await this.gitBuffer(repoRoot, ["ls-files", "-z"]);
		const seen = new Set<string>();
		for (const tracked of trackedRaw.toString("utf8").split("\0")) {
			if (tracked.length > 0) seen.add(tracked.replaceAll("\\", "/").toLowerCase());
		}
		// Directory pass: git reports untracked directories (junctions
		// included) only with --directory; record in-root reparse points as
		// links and never capture files through them.
		const linkDirs = new Map<string, UntrackedEntry>();
		const dirRaw = await this.gitBuffer(repoRoot, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"--directory",
			"-z",
		]);
		for (const rawEntry of dirRaw.toString("utf8").split("\0")) {
			if (!rawEntry.endsWith("/")) continue;
			const dirPath = rawEntry.slice(0, -1).replaceAll("\\", "/");
			const physical = joinUnderRoot(repoRoot, dirPath);
			const kind = await lstatKind(physical);
			if (kind === "link") {
				linkDirs.set(dirPath, await this.captureLink(repoRoot, physical, dirPath, seen, policy));
			}
		}
		const underLink = (filePath: string): boolean => {
			const segments = filePath.split("/");
			for (let index = 1; index < segments.length; index++) {
				if (linkDirs.has(segments.slice(0, index).join("/"))) return true;
			}
			return false;
		};
		const entries: UntrackedEntry[] = [];
		const excluded: Array<{ path: string; reason: string }> = [];
		let totalBytes = 0;
		for (const path of paths) {
			const validated = validateWorkspaceRelativePath(path, policy);
			if (isDeniedPath(validated, policy)) {
				excluded.push({ path: validated, reason: "policy:deny" });
				continue;
			}
			if (underLink(validated)) {
				excluded.push({ path: validated, reason: "under-link" });
				continue;
			}
			const physical = joinUnderRoot(repoRoot, validated);
			const kind = await lstatKind(physical);
			if (kind === "link") {
				entries.push(await this.captureLink(repoRoot, physical, validated, seen, policy));
				continue;
			}
			if (kind !== "file") {
				excluded.push({ path: validated, reason: `unsupported file kind ${kind}` });
				continue;
			}
			const stats = await lstat(physical);
			if (stats.size > policy.maxUntrackedFileBytes) {
				excluded.push({ path: validated, reason: "policy:oversize" });
				continue;
			}
			totalBytes += stats.size;
			if (totalBytes > policy.maxTotalUntrackedBytes) {
				excluded.push({ path: validated, reason: "policy:total-size" });
				continue;
			}
			if (entries.length >= policy.maxUntrackedFiles) {
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
		for (const linkEntry of linkDirs.values()) {
			entries.push(linkEntry);
		}
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

	private async captureLink(
		repoRoot: string,
		physical: string,
		validated: string,
		seen: Set<string>,
		policy: ResolvedWorkspacePolicy,
	): Promise<UntrackedEntry> {
		if (!policy.allowLinks) {
			throw new UnsupportedWorkspaceError(`link ${validated} is not allowed by policy`);
		}
		assertNoCaseCollision(validated, seen);
		const target = await readlink(physical);
		const absoluteTarget = resolve(dirname(physical), target);
		const rootPrefix = resolve(repoRoot);
		if (
			absoluteTarget !== rootPrefix &&
			!absoluteTarget.startsWith(`${rootPrefix}\\`) &&
			!absoluteTarget.startsWith(`${rootPrefix}/`)
		) {
			throw new WorkspacePathEscapeError(`link ${validated} points outside the repository root`);
		}
		const targetIsDirectory = (await lstatKind(absoluteTarget)) === "directory";
		const stats = await lstat(physical);
		return {
			path: validated,
			kind: "link",
			mode: stats.mode,
			size: 0,
			mtimeMs: Math.trunc(stats.mtimeMs),
			hash: "",
			target: target.replaceAll("\\", "/"),
			targetIsDirectory,
		};
	}

	// ------------------------------------------------------------- capture

	private async captureFacts(repoRoot: string, policy: ResolvedWorkspacePolicy): Promise<CaptureFacts> {
		const headOid = await this.requireGit(
			repoRoot,
			["rev-parse", "HEAD"],
			(d) => new UnsupportedRepositoryStateError(d),
		);
		const indexTree = await this.requireGit(repoRoot, ["write-tree"], (d) => new UnsupportedRepositoryStateError(d));
		// A freshly rewritten index (git read-tree during promotion finalize)
		// carries no stat cache; with GIT_OPTIONAL_LOCKS=0, "git stash create"
		// then exits 1 with empty output. A best-effort refresh restores the
		// stat cache (staged content is never changed by a refresh).
		await this.git(repoRoot, ["update-index", "--refresh"]);
		const tracked = await this.requireGit(repoRoot, ["stash", "create"], (d) => new WorkspaceManagerFault(d));
		let commitOid: string;
		let trackedTree: string;
		if (tracked.length === 0) {
			commitOid = headOid;
			trackedTree = await this.requireGit(
				repoRoot,
				["rev-parse", `${headOid}^{tree}`],
				(d) => new WorkspaceManagerFault(d),
			);
		} else {
			commitOid = tracked;
			trackedTree = await this.requireGit(
				repoRoot,
				["rev-parse", `${tracked}^{tree}`],
				(d) => new WorkspaceManagerFault(d),
			);
		}
		const untracked = await this.enumerateUntracked(repoRoot, policy);
		const policyHash = resolvedPolicyHash(policy);
		const fingerprint = sha256Hex(
			canonicalJson({
				headOid,
				indexTree,
				trackedTree,
				untrackedManifestHash: untracked.manifestHash,
				policyHash,
			} as unknown as JsonValue),
		);
		return { headOid, indexTree, commitOid, trackedTree, untracked, fingerprint, policyHash };
	}

	async capture(input: WorkspaceCaptureInput): Promise<WorkspaceSnapshotRef> {
		let sourceRoot: string;
		try {
			sourceRoot = await realpath(resolve(input.sourceRoot));
		} catch (error) {
			throw new UnsupportedWorkspaceError(`${input.sourceRoot} cannot be resolved: ${(error as Error).message}`);
		}
		const policy = resolveWorkspacePolicy(input.policy ?? this.options.policy);
		const meta = await this.gitMeta(sourceRoot);
		await this.assertRepositorySupported(meta, sourceRoot);
		const repoId = sha256Hex(meta.repoRoot.replaceAll("\\", "/"));
		const first = await this.captureFacts(meta.repoRoot, policy);
		// Drift double-check: the tracked tree and untracked manifest must be
		// stable across two full passes before anything is published.
		const second = await this.captureFacts(meta.repoRoot, policy);
		if (
			first.headOid !== second.headOid ||
			first.indexTree !== second.indexTree ||
			first.trackedTree !== second.trackedTree ||
			first.untracked.manifestHash !== second.untracked.manifestHash
		) {
			throw new SourceWorkspaceChangedError(`${sourceRoot} changed while the snapshot was being captured`);
		}
		const snapshotId = sha256Hex(`${randomUUID()}:${repoId}`);
		const ref = `${SNAPSHOT_REF_PREFIX}/${repoId}/${snapshotId}`;
		const updateRef = await this.git(meta.repoRoot, [
			"update-ref",
			ref,
			first.commitOid,
			"0000000000000000000000000000000000000000",
		]);
		if (!updateRef.ok) {
			throw new WorkspaceManagerFault(`Failed to create snapshot ref ${ref}: ${updateRef.stderr.trim()}`);
		}
		const record = {
			type: "snapshot",
			snapshotId,
			repoId: input.promotionOrigin?.repoId ?? repoId,
			sourceRoot,
			// Stage 8 promotion lineage: a lease re-capture keeps the original
			// foreground roots as the apply target; the content basis stays the
			// capture root.
			repoRoot: input.promotionOrigin?.repoRoot ?? meta.repoRoot,
			commonDir: meta.commonDir,
			backend: "git-worktree" as const,
			ref,
			commitOid: first.commitOid,
			headOid: first.headOid,
			indexTree: first.indexTree,
			trackedTree: first.trackedTree,
			untrackedManifestHash: first.untracked.manifestHash,
			policyHash: first.policyHash,
			fingerprint: first.fingerprint,
			logicalRoot: input.logicalRoot,
			createdAt: Date.now(),
			untracked: first.untracked.entries,
			untrackedExcluded: first.untracked.excluded,
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
			backend: "git-worktree",
			fingerprint: first.fingerprint,
			logicalWorkspace: { root: input.logicalRoot, contentFingerprint: first.fingerprint },
			files: first.untracked.entries.map((entry) => ({
				path: entry.path,
				size: entry.size,
				mtimeMs: entry.mtimeMs,
				hash: entry.hash,
			})),
		};
	}

	// --------------------------------------------------------------- fork

	/** On this backend release deletes the ref, so a record whose ref is gone is released. */
	async snapshotReleased(snapshotId: string): Promise<boolean> {
		const record = (await this.manifest.fold()).snapshots.get(snapshotId);
		if (record === undefined) return false;
		const refCheck = await this.git(record.repoRoot, ["rev-parse", "--verify", record.ref]);
		return !refCheck.ok;
	}

	async findSnapshot(snapshotId: string): Promise<WorkspaceSnapshotRef> {
		const record = (await this.manifest.fold()).snapshots.get(snapshotId);
		if (record === undefined) {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshotId} has no manifest record`);
		}
		if (record.backend !== "git-worktree") {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshotId} belongs to another backend`);
		}
		const refCheck = await this.git(record.repoRoot, ["rev-parse", "--verify", record.ref]);
		if (!refCheck.ok) {
			throw new WorkspaceSnapshotNotFoundError(`snapshot ${snapshotId} ref ${record.ref} is gone`);
		}
		const actualCommit = refCheck.stdout.trim();
		if (actualCommit !== record.commitOid) {
			throw new WorkspaceSnapshotMismatch(
				`snapshot ${snapshotId} ref points at ${actualCommit}, not ${record.commitOid}`,
			);
		}
		return this.refFromRecord(record);
	}

	private refFromRecord(record: SnapshotRecord): WorkspaceSnapshotRef {
		return {
			id: record.snapshotId,
			sourceRoot: record.sourceRoot,
			backend: "git-worktree",
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

	async fork(snapshot: WorkspaceSnapshotRef, candidateId: string): Promise<WorkspaceLease> {
		if (snapshot.backend !== "git-worktree") {
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
			await this.attachExistingLease(existing, record, snapshot, candidateId);
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
			worktreeName: "",
			status: "creating",
			createdAt: Date.now(),
		});
		// On failure the creating record stays durable for recover(); the
		// worktree may be half-created but the record identity is deterministic.
		await this.completeWorktree(record, root, leaseId, candidateId);
		const ready = (await this.manifest.fold()).leases.get(leaseId)!;
		return this.leaseFromRecord(ready, record);
	}

	private async attachExistingLease(
		existing: {
			leaseId: string;
			snapshotId: string;
			candidateId: string;
			root: string;
			gitDir: string;
			worktreeName: string;
			status: LeaseStatus;
		},
		record: SnapshotRecord,
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
				const rootExists = await pathExists(existing.root);
				const commonDir = rootExists
					? (await this.git(existing.root, ["rev-parse", "--git-common-dir"])).stdout.trim()
					: "";
				if (!rootExists || commonDir !== record.commonDir) {
					throw new WorkspaceLeaseConflictError(
						`lease ${existing.leaseId} is recorded ready but its worktree is missing or mismatched`,
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

	private async completeWorktree(
		record: SnapshotRecord,
		root: string,
		leaseId: string,
		candidateId: string,
	): Promise<void> {
		await mkdir(dirname(root), { recursive: true });
		const add = await this.git(record.repoRoot, ["worktree", "add", "--detach", root, record.ref]);
		if (!add.ok) {
			throw new WorkspaceManagerFault(`Failed to create worktree ${root} from ${record.ref}: ${add.stderr.trim()}`);
		}
		const gitDir = (await this.git(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
		const worktreeName = basename(gitDir);
		await this.materializeUntracked(record, root);
		const folded = await this.manifest.fold();
		const existing = folded.leases.get(leaseId);
		await this.manifest.append({
			type: "lease",
			leaseId,
			snapshotId: record.snapshotId,
			candidateId,
			root,
			gitDir,
			worktreeName,
			status: "ready",
			createdAt: existing?.createdAt ?? Date.now(),
		});
	}

	private async materializeUntracked(record: SnapshotRecord, root: string): Promise<void> {
		const files = record.untracked.filter((entry) => entry.kind === "file");
		const links = record.untracked.filter((entry) => entry.kind === "link");
		for (const entry of files) {
			const destination = joinUnderRoot(root, entry.path);
			await mkdir(dirname(destination), { recursive: true });
			await this.content.copyTo(entry.hash, destination);
		}
		// Links last: their targets are already materialized by this point.
		for (const entry of links) {
			const destination = joinUnderRoot(root, entry.path);
			await mkdir(dirname(destination), { recursive: true });
			const target = entry.target ?? "";
			try {
				await symlink(target, destination, entry.targetIsDirectory ? "junction" : "file");
			} catch (error) {
				// Windows without Developer Mode cannot create file symlinks;
				// fall back to a byte copy of the in-root target.
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
		lease: {
			leaseId: string;
			snapshotId: string;
			candidateId: string;
			root: string;
			gitDir: string;
			worktreeName: string;
			status: LeaseStatus;
		},
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
		const tracked = await this.git(lease.root, [
			"diff",
			"--binary",
			"--full-index",
			"--no-renames",
			snapshot.ref,
			"--",
		]);
		if (!tracked.ok) {
			throw new WorkspaceManagerFault(`git diff failed in ${lease.root}: ${tracked.stderr.trim()}`);
		}
		const trackedNames = (await this.gitBuffer(lease.root, ["diff", "--name-only", "-z", snapshot.ref, "--"]))
			.toString("utf8")
			.split("\0")
			.filter((path) => path.length > 0);
		const sections = splitPatchSections(tracked.stdout);
		const sectionPaths = sections.map((section) => section.path);
		if (
			new Set(sectionPaths).size !== trackedNames.length ||
			sectionPaths.some((path) => !trackedNames.includes(path))
		) {
			throw new WorkspaceManagerFault("git diff path parsing mismatch; refusing to build a patch");
		}
		const trackedTouched = new Set(trackedNames.map((path) => path.replaceAll("\\", "/")));
		const trackedPatchPath =
			sections.length === 0
				? ""
				: join(this.patchesRoot, `${snapshot.snapshotId}-${sha256Hex(tracked.stdout)}.patch`);
		if (sections.length > 0) {
			await mkdir(this.patchesRoot, { recursive: true });
			await writeFile(trackedPatchPath, tracked.stdout);
		}
		const untrackedPlan = await this.buildUntrackedPlan(lease, snapshot, trackedTouched);
		const untrackedManifestPath = join(this.patchesRoot, `${snapshot.snapshotId}-${untrackedPlan.hash}.json`);
		await mkdir(this.patchesRoot, { recursive: true });
		await writeFile(untrackedManifestPath, canonicalJson(untrackedPlan as unknown as JsonValue));
		const summary: WorkspaceDiffSummary = {
			tracked: countTrackedSections(sections),
			untracked: {
				created: untrackedPlan.ops.filter((op) => op.op === "create").length,
				modified: untrackedPlan.ops.filter((op) => op.op === "modify").length,
				deleted: untrackedPlan.ops.filter((op) => op.op === "delete").length,
				absorbedByTracked: untrackedPlan.absorbedByTracked,
			},
			touchedPaths: [...new Set([...[...trackedTouched], ...untrackedPlan.ops.map((op) => op.path)])].sort(),
			trackedPatchHash: sections.length === 0 ? "" : sha256Hex(tracked.stdout),
			untrackedManifestHash: untrackedPlan.hash,
		};
		return {
			snapshotId: snapshot.snapshotId,
			leaseId: lease.id,
			trackedPatchPath,
			untrackedManifestPath,
			summary,
		};
	}

	private async buildUntrackedPlan(
		lease: WorkspaceLease,
		snapshot: SnapshotRecord,
		trackedTouched: Set<string>,
	): Promise<UntrackedMutationPlan & { absorbedByTracked: string[] }> {
		const current = await this.enumerateUntracked(lease.root, this.policy);
		const currentMap = new Map(current.entries.map((entry) => [entry.path, entry]));
		const snapshotMap = new Map(snapshot.untracked.map((entry) => [entry.path, entry]));
		const ops: UntrackedMutationPlan["ops"] = [];
		const absorbed: string[] = [];
		const absorb = (path: string): void => {
			const entry = currentMap.get(path);
			if (entry === undefined) return;
			if (trackedTouched.has(path)) {
				absorbed.push(path);
				return;
			}
			ops.push(untrackedOpEntry(entry, snapshotMap.has(path) ? "modify" : "create"));
		};
		for (const entry of current.entries) {
			const before = snapshotMap.get(entry.path);
			if (before === undefined) {
				absorb(entry.path);
			} else if (before.kind !== entry.kind || before.hash !== entry.hash || before.target !== entry.target) {
				absorb(entry.path);
			}
		}
		for (const [path] of snapshotMap) {
			if (!currentMap.has(path)) {
				if (trackedTouched.has(path)) {
					absorbed.push(path);
				} else {
					ops.push({ path, op: "delete" });
				}
			}
		}
		ops.sort((left, right) => (left.path < right.path ? -1 : 1));
		const plan: UntrackedMutationPlan = { snapshotId: snapshot.snapshotId, leaseId: lease.id, ops, hash: "" };
		plan.hash = sha256Hex(
			canonicalJson({ snapshotId: plan.snapshotId, leaseId: plan.leaseId, ops: plan.ops } as unknown as JsonValue),
		);
		return { ...plan, absorbedByTracked: absorbed.sort() };
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
		const meta = await this.gitMeta(foregroundRoot);
		if (meta.repoRoot.length === 0) {
			throw new PromotionConflictError(`foreground repository ${foregroundRoot} no longer exists`);
		}
		const repoId = sha256Hex(meta.repoRoot.replaceAll("\\", "/"));
		if (repoId !== origin.repoId) {
			throw new PromotionConflictError(`foreground repository identity changed from ${origin.repoId} to ${repoId}`);
		}
		return {
			snapshotFingerprint: async () => origin.fingerprint,
			computeForegroundFingerprint: async () => (await this.captureFacts(meta.repoRoot, this.policy)).fingerprint,
			buildPlan: async () => {
				const tracked = await this.git(lease.root, [
					"diff",
					"--binary",
					"--full-index",
					"--no-renames",
					origin.ref,
					"--",
				]);
				if (!tracked.ok) {
					throw new WorkspaceManagerFault(`git diff failed in ${lease.root}: ${tracked.stderr.trim()}`);
				}
				const sections = splitPatchSections(tracked.stdout);
				const trackedTouched = new Set(sections.map((section) => section.path.replaceAll("\\", "/")));
				const untrackedPlan = await this.buildUntrackedPlan(lease, origin, trackedTouched);
				const paths: PlannedPathMutation[] = [];
				const preimages = new Map<string, PathHash>();
				for (const section of sections) {
					const normalized = section.path.replaceAll("\\", "/");
					validateWorkspaceRelativePath(normalized, this.policy);
					const current = await hashPathAt(foregroundRoot, normalized);
					paths.push({
						path: normalized,
						op: "tracked_patch",
						targetHash: null,
						patchSection: section.text,
						preExistingUntracked: section.text.includes("new file mode") && current.kind === "file",
					});
					preimages.set(normalized, current);
				}
				for (const op of untrackedPlan.ops) {
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
				return {
					plan: { paths, capturedIndexTree: origin.indexTree },
					preimages,
					foregroundRoot,
					leaseRoot: lease.root,
				};
			},
			applyPath: async (entry, root) => {
				switch (entry.op) {
					case "tracked_patch": {
						if (entry.patchSection === undefined) {
							throw new WorkspaceManagerFault(`tracked patch section for ${entry.path} is missing`);
						}
						// A tracked "new file" over an untracked foreground file:
						// the untracked preimage is already journaled as the
						// recovery copy; remove it so git apply can create it.
						if (entry.preExistingUntracked === true) {
							const removed = await rmWithRetry(joinUnderRoot(root, entry.path), {
								maxAttempts: this.retryMaxAttempts,
								delayMs: this.retryDelayMs,
							});
							if (!removed) {
								throw new PromotionConflictError(`could not remove the untracked preimage of ${entry.path}`);
							}
						}
						const temporary = join(
							this.patchesRoot,
							`apply-${process.pid}-${Math.random().toString(36).slice(2)}.patch`,
						);
						await mkdir(this.patchesRoot, { recursive: true });
						await writeFile(temporary, entry.patchSection);
						try {
							const applied = await this.git(root, ["apply", "--binary", temporary]);
							if (!applied.ok) {
								throw new PromotionConflictError(
									`git apply failed for ${entry.path}: ${applied.stderr.trim()}`,
								);
							}
						} finally {
							await rm(temporary, { force: true }).catch(() => undefined);
						}
						return;
					}
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
							throw new WorkspaceManagerFault(`untracked source for ${entry.path} is missing`);
						}
						if (entry.targetHash !== null) {
							const verified = await sha256File(entry.sourcePath);
							if (verified !== entry.targetHash) {
								throw new WorkspaceManagerFault(
									`candidate source for ${entry.path} drifted (${verified} != ${entry.targetHash})`,
								);
							}
						}
						const bytes = await readFile(entry.sourcePath);
						await writeFileAtomic(joinUnderRoot(root, entry.path), bytes);
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
				}
			},
			finalizeApply: async (plan, root) => {
				if (plan.capturedIndexTree === undefined) return;
				const restored = await this.git(root, ["read-tree", plan.capturedIndexTree]);
				if (!restored.ok) {
					throw new WorkspaceManagerFault(`failed to restore the capture-time index: ${restored.stderr.trim()}`);
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
		const removed = await this.removeWorktree(record);
		if (!removed) {
			await this.markLease(record, "orphaned");
			throw new WorkspaceOrphanedError(
				`lease ${lease.id} worktree ${record.root} is locked; marked orphaned for recover()`,
			);
		}
		await this.markLease(record, "released");
		await this.releaseSnapshotIfUnreferenced(record.snapshotId);
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

	private async removeWorktree(record: { root: string }): Promise<boolean> {
		const root = record.root;
		if (!(await pathExists(root))) {
			await this.pruneWorktrees();
			return true;
		}
		if (!this.isManagerOwnedPath(root)) {
			throw new WorkspacePathEscapeError(`refusing to remove non-manager-owned path ${root}`);
		}
		const snapshotRecords = (await this.manifest.fold()).snapshots;
		for (const snapshot of snapshotRecords.values()) {
			if (snapshot.backend !== "git-worktree" || !(await pathExists(snapshot.repoRoot))) continue;
			const removed = await this.git(snapshot.repoRoot, ["worktree", "remove", "--force", root]);
			if (removed.ok || removed.stderr.includes("is not a working tree")) break;
		}
		// `git worktree remove` can fail after unregistering; directory removal
		// is the authority for the orphan decision.
		if (await pathExists(root)) {
			const removedDir = await rmWithRetry(root, {
				maxAttempts: this.retryMaxAttempts,
				delayMs: this.retryDelayMs,
			});
			if (!removedDir) return false;
		}
		await this.pruneWorktrees();
		return true;
	}

	private async pruneWorktrees(): Promise<void> {
		const snapshotRecords = (await this.manifest.fold()).snapshots;
		const repos = new Set<string>();
		for (const snapshot of snapshotRecords.values()) {
			if (snapshot.backend === "git-worktree") repos.add(snapshot.repoRoot);
		}
		for (const repoRoot of repos) {
			if (!(await pathExists(repoRoot))) continue;
			await this.git(repoRoot, ["worktree", "prune"]);
		}
	}

	private isManagerOwnedPath(path: string): boolean {
		const resolvedRoot = resolve(this.worktreesRoot);
		const resolvedPath = resolve(path);
		return (
			resolvedPath === resolvedRoot ||
			resolvedPath.startsWith(`${resolvedRoot}\\`) ||
			resolvedPath.startsWith(`${resolvedRoot}/`)
		);
	}

	/**
	 * True while a non-released derived snapshot names this snapshot as its
	 * promotion origin. On the git backend a snapshot is released by deleting
	 * its ref (no manifest released record), so the ref existence is the
	 * release marker here.
	 */
	private async referencedAsPromotionOrigin(snapshotId: string): Promise<boolean> {
		const folded = await this.manifest.fold();
		for (const record of folded.snapshots.values()) {
			if (record.promotionOriginSnapshotId !== snapshotId) continue;
			if (folded.releasedSnapshots.has(record.snapshotId)) continue;
			const refCheck = await this.git(record.repoRoot, ["rev-parse", "--verify", record.ref]);
			if (!refCheck.ok) continue;
			return true;
		}
		return false;
	}

	private async releaseSnapshotIfUnreferenced(snapshotId: string): Promise<void> {
		const folded = await this.manifest.fold();
		for (const lease of folded.leases.values()) {
			if (lease.snapshotId === snapshotId && lease.status !== "released") return;
		}
		// Stage 8 reference-aware retention: a snapshot that is still the
		// promotion origin of a live derived snapshot stays retained.
		if (await this.referencedAsPromotionOrigin(snapshotId)) return;
		const snapshot = folded.snapshots.get(snapshotId);
		if (snapshot === undefined) return;
		const deleted = await this.git(snapshot.repoRoot, ["update-ref", "-d", snapshot.ref, snapshot.commitOid]);
		if (!deleted.ok && !deleted.stderr.includes("reference already")) {
			throw new WorkspaceManagerFault(`Failed to delete snapshot ref ${snapshot.ref}: ${deleted.stderr.trim()}`);
		}
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
		const record = folded.snapshots.get(snapshot.id);
		if (record === undefined) return;
		// Stage 8 reference-aware retention: deferred while a live derived
		// snapshot still needs this snapshot as its promotion baseline.
		if (await this.referencedAsPromotionOrigin(snapshot.id)) return;
		const refCheck = await this.git(record.repoRoot, ["rev-parse", "--verify", record.ref]);
		if (!refCheck.ok) return;
		const deleted = await this.git(record.repoRoot, ["update-ref", "-d", record.ref, record.commitOid]);
		if (!deleted.ok) {
			throw new WorkspaceManagerFault(`Failed to delete snapshot ref ${record.ref}: ${deleted.stderr.trim()}`);
		}
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
		await this.reconcileUnmanifestedRefs(folded, report);
		const registered = await this.registeredWorktrees(folded);
		for (const lease of folded.leases.values()) {
			await this.recoverLease(lease, folded, registered, report);
		}
		const refolded = await this.manifest.fold();
		await this.recoverPromotionJournals(refolded, report);
		await this.recoverContentBlobs(refolded, report);
		await this.recoverStrayDirectories(refolded, registered, report);
		await this.recoverStaleMetadata(refolded, registered, report);
		const final = await this.manifest.fold();
		for (const lease of final.leases.values()) {
			if (lease.status === "orphaned" || lease.status === "releasing" || lease.status === "creating") {
				report.remainingOrphans.push(lease.leaseId);
			}
		}
		return report;
	}

	private async registeredWorktrees(folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>): Promise<Set<string>> {
		const registered = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend !== "git-worktree" || !(await pathExists(snapshot.repoRoot))) continue;
			const list = await this.git(snapshot.repoRoot, ["worktree", "list", "--porcelain"]);
			for (const line of list.stdout.split("\n")) {
				if (line.startsWith("worktree ")) {
					registered.add(resolve(line.slice("worktree ".length).trim()));
				}
			}
		}
		return registered;
	}

	private async reconcileUnmanifestedRefs(
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const known = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend === "git-worktree") known.add(snapshot.ref);
		}
		const repos = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend === "git-worktree" && (await pathExists(snapshot.repoRoot))) repos.add(snapshot.repoRoot);
		}
		for (const repoRoot of repos) {
			const refs = await this.git(repoRoot, ["for-each-ref", "--format=%(refname)", PRIVATE_REF_PREFIX]);
			if (!refs.ok) continue;
			for (const ref of refs.stdout.split("\n")) {
				if (ref.length === 0 || known.has(ref)) continue;
				const deleted = await this.git(repoRoot, ["update-ref", "-d", ref]);
				if (deleted.ok) report.unmanifestedRefsDeleted.push(ref);
			}
		}
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
		registered: Set<string>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const snapshot = folded.snapshots.get(lease.snapshotId);
		if (snapshot === undefined || snapshot.backend !== "git-worktree") {
			report.leases.conflicted.push(lease.leaseId);
			return;
		}
		switch (lease.status) {
			case "creating": {
				try {
					await this.completeWorktree(snapshot, lease.root, lease.leaseId, lease.candidateId);
					report.leases.completed += 1;
				} catch {
					report.leases.conflicted.push(lease.leaseId);
				}
				return;
			}
			case "ready": {
				const exists = await pathExists(lease.root);
				if (exists && registered.has(resolve(lease.root))) {
					report.leases.ready += 1;
				} else if (exists) {
					report.leases.conflicted.push(lease.leaseId);
				} else {
					await this.markLease(lease, "orphaned");
					report.leases.orphaned += 1;
				}
				return;
			}
			case "releasing":
			case "orphaned": {
				const removed = await this.removeWorktree(lease);
				if (removed) {
					await this.markLease(lease, "released");
					report.leases.released += 1;
					await this.releaseSnapshotIfUnreferenced(lease.snapshotId);
				} else {
					if (lease.status !== "orphaned") await this.markLease(lease, "orphaned");
					report.leases.orphaned += 1;
				}
				return;
			}
			case "released": {
				if (await pathExists(lease.root)) {
					const removed = await this.removeWorktree(lease);
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
			if (lease === undefined) {
				report.promotions.needsAttention.push(promotion.promotionId);
				continue;
			}
			const snapshot = folded.snapshots.get(lease.snapshotId);
			if (snapshot === undefined) {
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
		const liveSnapshots = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend !== "git-worktree" || !(await pathExists(snapshot.repoRoot))) continue;
			const check = await this.git(snapshot.repoRoot, ["rev-parse", "--verify", snapshot.ref]);
			if (check.ok) liveSnapshots.add(snapshot.snapshotId);
		}
		const referenced = new Set<string>();
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend !== "git-worktree" || !liveSnapshots.has(snapshot.snapshotId)) continue;
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
		registered: Set<string>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const knownRoots = new Set<string>();
		for (const lease of folded.leases.values()) {
			if (lease.status === "released") continue;
			knownRoots.add(resolve(lease.root));
		}
		// Two levels: <worktreesRoot>/<repoIdShort>/<candidateId>.
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
		for (const path of registered) {
			if (this.isManagerOwnedPath(path) && !knownRoots.has(resolve(path))) {
				const removed = await rmWithRetry(path, { maxAttempts: this.retryMaxAttempts, delayMs: this.retryDelayMs });
				if (removed) report.worktreesRemoved.push(path);
			}
		}
		await this.pruneWorktrees();
	}

	private async recoverStaleMetadata(
		folded: Awaited<ReturnType<JsonlManifestStore["fold"]>>,
		registered: Set<string>,
		report: WorkspaceRecoveryReport,
	): Promise<void> {
		const registeredNames = new Set([...registered].map((path) => basename(path)));
		for (const snapshot of folded.snapshots.values()) {
			if (snapshot.backend !== "git-worktree" || !(await pathExists(snapshot.commonDir))) continue;
			const metadataRoot = join(snapshot.commonDir, "worktrees");
			for (const name of await listDirEntries(metadataRoot)) {
				const leaseReferences = [...folded.leases.values()].some(
					(lease) => lease.worktreeName === name && lease.status !== "released",
				);
				if (registeredNames.has(name) || leaseReferences) continue;
				const metadataPath = join(metadataRoot, name);
				const removed = await rmWithRetry(metadataPath, {
					maxAttempts: this.retryMaxAttempts,
					delayMs: this.retryDelayMs,
				});
				if (removed) report.metadataDirsRemoved.push(metadataPath);
			}
		}
	}
}

// ----------------------------------------------------------- patch helpers

function splitPatchSections(patch: string): Array<{ path: string; text: string }> {
	const lines = patch.split("\n");
	const sections: Array<{ path: string; text: string }> = [];
	let current: { path: string; text: string } | undefined;
	const flush = (): void => {
		if (current !== undefined && current.text.length > 0) sections.push(current);
		current = undefined;
	};
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			const path = parseDiffGitPath(line);
			if (path !== null) current = { path, text: `${line}\n` };
			continue;
		}
		if (current !== undefined) current.text += `${line}\n`;
	}
	flush();
	return sections;
}

function parseDiffGitPath(line: string): string | null {
	const rest = line.slice("diff --git ".length);
	const bIndex = findBPrefix(rest);
	if (bIndex < 0) return null;
	const right = rest.slice(bIndex + 2);
	return gitUnquotePath(right);
}

function findBPrefix(rest: string): number {
	let quote = false;
	for (let index = 0; index < rest.length - 2; index++) {
		const char = rest[index];
		if (char === '"') {
			quote = !quote;
			continue;
		}
		if (!quote && char === " " && rest[index + 1] === "b" && rest[index + 2] === "/") {
			return index + 1;
		}
	}
	return -1;
}

function gitUnquotePath(value: string): string {
	if (!value.startsWith('"')) return value.split(" ")[0] ?? "";
	let result = "";
	for (let index = 1; index < value.length; index++) {
		const char = value[index]!;
		if (char === '"') break;
		if (char !== "\\") {
			result += char;
			continue;
		}
		const next = value[index + 1];
		if (next === undefined) break;
		if (next === "t") {
			result += "\t";
			index += 1;
		} else if (next === "n") {
			result += "\n";
			index += 1;
		} else if (next === "r") {
			result += "\r";
			index += 1;
		} else if (next === '"') {
			result += '"';
			index += 1;
		} else if (next === "\\") {
			result += "\\";
			index += 1;
		} else if (next >= "0" && next <= "7") {
			let octal = "";
			let cursor = index + 1;
			while (cursor < value.length && octal.length < 3 && value[cursor]! >= "0" && value[cursor]! <= "7") {
				octal += value[cursor]!;
				cursor += 1;
			}
			result += String.fromCharCode(Number.parseInt(octal, 8));
			index = cursor - 1;
		} else {
			result += next;
			index += 1;
		}
	}
	return result;
}

function countTrackedSections(sections: Array<{ path: string; text: string }>): {
	added: number;
	modified: number;
	deleted: number;
	binary: number;
} {
	const counts = { added: 0, modified: 0, deleted: 0, binary: 0 };
	for (const section of sections) {
		if (section.text.includes("GIT binary patch")) counts.binary += 1;
		if (section.text.includes("new file mode")) counts.added += 1;
		else if (section.text.includes("deleted file mode")) counts.deleted += 1;
		else counts.modified += 1;
	}
	return counts;
}

function assertNoCaseCollision(path: string, seen: Set<string>): void {
	const key = path.toLowerCase();
	if (seen.has(key)) {
		throw new WorkspaceCaseCollisionError(`path ${JSON.stringify(path)} collides case-insensitively`);
	}
	seen.add(key);
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
