import { appendFile, copyFile, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson } from "./policy-bundle.ts";
import type { JsonlManifestStore } from "./runtime-manifest.ts";
import {
	ForegroundChangedError,
	PromotionConflictError,
	PromotionNeedsAttentionError,
	WorkspaceManagerFault,
} from "./workspace-errors.ts";
import { hashPathAt, isLockError, joinUnderRoot, type PathHash, rmWithRetry, writeFileAtomic } from "./workspace-fs.ts";
import type { PromotionReceipt, PromotionResult, WorkspaceLease, WorkspaceVerifier } from "./workspace-manager.ts";

/**
 * PromotionJournal: append-only JSONL authority for one promotion. Records are
 * line-durable (torn-tail tolerant, same rules as the runtime manifest); a
 * corrupt interior line faults the manager.
 */

export type PlannedPathOp = "tracked_patch" | "untracked_create" | "untracked_modify" | "untracked_delete";

export interface PlannedPathMutation {
	path: string;
	op: PlannedPathOp;
	targetHash: string | null;
	/** Lease-root source file for untracked create/modify (byte-exact source). */
	sourcePath?: string;
	/** One `diff --git` section for tracked paths (git backend). */
	patchSection?: string;
	/** Link materialization (when op creates/modifies a link). */
	target?: string;
	targetIsDirectory?: boolean;
	/**
	 * Tracked "new file" patch over a foreground path that exists as an
	 * untracked file at snapshot time: the untracked preimage must be removed
	 * before `git apply` can create the file.
	 */
	preExistingUntracked?: boolean;
}

export interface PromotionPlan {
	paths: PlannedPathMutation[];
	/** Git backend only: restore the index to this tree after apply/rollback. */
	capturedIndexTree?: string;
}

/** Backend-specific promotion hooks; both backends share the engine below. */
export interface PromotionAdapter {
	/** Snapshot fingerprint the foreground must still match. */
	snapshotFingerprint(): Promise<string>;
	/** Recompute the foreground capture fingerprint (read-only). */
	computeForegroundFingerprint(): Promise<string>;
	/** Build the ordered plan + expected per-path preimages. */
	buildPlan(): Promise<{
		plan: PromotionPlan;
		preimages: Map<string, PathHash>;
		foregroundRoot: string;
		leaseRoot: string;
	}>;
	/** Apply one path mutation to the foreground (git apply / byte copy / rm). */
	applyPath(entry: PlannedPathMutation, foregroundRoot: string): Promise<void>;
	/** Optional post-apply finalize (git: read-tree index restore). */
	finalizeApply?(plan: PromotionPlan, foregroundRoot: string): Promise<void>;
	/** lstat + hash of one foreground path (never follows links). */
	hashForegroundPath(root: string, path: string): Promise<PathHash>;
}

export interface PromotionJournalEvent {
	type: "open" | "prepared" | "applied" | "rolled_back" | "close" | "needs_attention";
	seq: number;
	promotionId: string;
	path?: string;
	op?: PlannedPathOp;
	preimageKind?: "file" | "link" | "absent";
	preimageHash?: string | null;
	preimageTarget?: string | null;
	targetHash?: string | null;
	recoveryCopy?: string | null;
	postKind?: "file" | "link" | "absent";
	postHash?: string | null;
	postTarget?: string | null;
	capturedIndexTree?: string | null;
	status?: "promoted" | "rolled_back" | "needs_attention";
	/** Stage 8 receipt fields on the close event: durable attempt result. */
	touchedPaths?: string[];
	postFingerprint?: string;
	/** Stage 8 promotion lineage: the baseline (origin) snapshot identity. */
	promotionOriginSnapshotId?: string;
	promotionOriginFingerprint?: string;
	reason?: string;
}

export interface FoldedPromotionJournal {
	events: PromotionJournalEvent[];
	open: boolean;
	closed: boolean;
	needsAttention: boolean;
	appliedPaths: string[];
	perPath: Map<string, PromotionJournalEvent>;
}

export class JsonlPromotionJournal {
	private readonly filePath: string;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: { filePath: string }) {
		this.filePath = options.filePath;
	}

	async append(input: Omit<PromotionJournalEvent, "seq">): Promise<void> {
		const run = async (): Promise<void> => {
			const events = await this.events();
			const nextSeq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
			const event = { ...structuredClone(input), seq: nextSeq } as PromotionJournalEvent;
			try {
				await mkdir(dirname(this.filePath), { recursive: true });
				await appendFile(this.filePath, `${canonicalJson(event as unknown as JsonValue)}\n`, "utf8");
			} catch (error) {
				throw new WorkspaceManagerFault(
					`Failed to append to promotion journal ${this.filePath}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		await next;
	}

	async events(): Promise<PromotionJournalEvent[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw new WorkspaceManagerFault(
				`Failed to read promotion journal ${this.filePath}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		const events: PromotionJournalEvent[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line.length === 0) continue;
			try {
				const parsed = JSON.parse(line) as { type?: unknown; promotionId?: unknown; seq?: unknown };
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					typeof parsed.type !== "string" ||
					typeof parsed.promotionId !== "string" ||
					typeof parsed.seq !== "number"
				) {
					throw new Error("not a promotion journal event");
				}
				events.push(parsed as unknown as PromotionJournalEvent);
			} catch {
				if (index === lines.length - 1 && !endsWithNewline) continue;
				throw new WorkspaceManagerFault(`Promotion journal ${this.filePath} contains a corrupt line`);
			}
		}
		return events;
	}

	async fold(): Promise<FoldedPromotionJournal> {
		const events = await this.events();
		const perPath = new Map<string, PromotionJournalEvent>();
		let open = false;
		let closed = false;
		let needsAttention = false;
		for (const event of events) {
			if (event.type === "open") open = true;
			if (event.type === "close") {
				closed = true;
				open = false;
			}
			if (event.type === "needs_attention") {
				needsAttention = true;
				open = false;
			}
			if (event.path !== undefined && event.type !== "open") perPath.set(event.path, event);
		}
		const appliedPaths = [...perPath.values()]
			.filter((event) => event.type === "applied")
			.map((event) => event.path!);
		return { events, open, closed, needsAttention, appliedPaths, perPath };
	}

	async exists(): Promise<boolean> {
		try {
			await readFile(this.filePath, "utf8");
			return true;
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return false;
			throw error;
		}
	}

	async delete(): Promise<void> {
		await rm(this.filePath, { force: true });
	}

	get path(): string {
		return this.filePath;
	}
}

export interface RunPromotionOptions {
	promotionId: string;
	/** Receipt identities: the durable lease/snapshot pair of this attempt. */
	leaseId: string;
	snapshotId: string;
	/**
	 * Stage 8 promotion lineage: the baseline snapshot the promotion diff and
	 * drift gate are computed against (the original foreground origin). It is
	 * durable on the close event and in the receipt.
	 */
	promotionOrigin: { snapshotId: string; fingerprint: string };
	journalPath: string;
	recoveryDir: string;
	adapter: PromotionAdapter;
	lease: WorkspaceLease;
	verifier?: WorkspaceVerifier;
	finalVerifier?: WorkspaceVerifier;
}

/**
 * Reads the durable receipt of a completed attempt. A closed journal with a
 * promoted/rolled_back close event is the receipt itself and is never
 * deleted; a missing/open/needs-attention journal has no receipt.
 */
export async function readPromotionReceipt(
	journalPath: string,
	identities: { promotionId: string; leaseId: string; snapshotId: string },
): Promise<PromotionReceipt | undefined> {
	const journal = new JsonlPromotionJournal({ filePath: journalPath });
	if (!(await journal.exists())) return undefined;
	const folded = await journal.fold();
	if (!folded.closed) return undefined;
	let close: PromotionJournalEvent | undefined;
	for (const event of folded.events) {
		if (event.type === "close") close = event;
	}
	if (close === undefined || (close.status !== "promoted" && close.status !== "rolled_back")) return undefined;
	return {
		promotionId: identities.promotionId,
		leaseId: identities.leaseId,
		snapshotId: identities.snapshotId,
		promotionOriginSnapshotId: close.promotionOriginSnapshotId ?? identities.snapshotId,
		promotionOriginFingerprint: close.promotionOriginFingerprint ?? "",
		status: close.status,
		touchedPaths: close.touchedPaths ?? [],
		postFingerprint: close.postFingerprint ?? "",
		...(close.reason === undefined ? {} : { reason: close.reason }),
	};
}

/**
 * Closes a stale open promotion manifest record once the journal receipt is
 * durable (crash window between the run and the manifest close append).
 */
export async function settlePromotionManifestRecord(
	manifest: JsonlManifestStore,
	promotionId: string,
	leaseId: string,
): Promise<void> {
	const folded = await manifest.fold();
	const record = folded.promotions.get(promotionId);
	if (record !== undefined && record.status === "open") {
		await manifest.append({ type: "promotion", promotionId, leaseId, status: "closed" });
	}
}

function receiptFor(
	options: RunPromotionOptions,
	status: "promoted" | "rolled_back",
	event: Pick<
		PromotionJournalEvent,
		"touchedPaths" | "postFingerprint" | "reason" | "promotionOriginSnapshotId" | "promotionOriginFingerprint"
	>,
): PromotionReceipt {
	return {
		promotionId: options.promotionId,
		leaseId: options.leaseId,
		snapshotId: options.snapshotId,
		promotionOriginSnapshotId: event.promotionOriginSnapshotId ?? options.promotionOrigin.snapshotId,
		promotionOriginFingerprint: event.promotionOriginFingerprint ?? options.promotionOrigin.fingerprint,
		status,
		touchedPaths: event.touchedPaths ?? [],
		postFingerprint: event.postFingerprint ?? "",
		...(event.reason === undefined ? {} : { reason: event.reason }),
	};
}

/** Durable result of an already-closed attempt: replay never re-executes. */
function durableResult(options: RunPromotionOptions, folded: FoldedPromotionJournal): PromotionResult {
	let close: PromotionJournalEvent | undefined;
	for (const event of folded.events) {
		if (event.type === "close") close = event;
	}
	if (close?.status === "promoted") {
		return {
			status: "promoted",
			touchedPaths: close.touchedPaths ?? folded.appliedPaths,
			receipt: receiptFor(options, "promoted", close),
		};
	}
	return {
		status: "rolled_back",
		reason: close?.reason ?? "the previous promotion attempt rolled back",
		touchedPaths: close?.touchedPaths ?? [],
		receipt: receiptFor(options, "rolled_back", close ?? {}),
	};
}

function pathHashMatches(actual: PathHash, expected: PathHash): boolean {
	if (actual.kind !== expected.kind) return false;
	if (actual.kind === "file" && expected.kind === "file") return actual.hash === expected.hash;
	if (actual.kind === "link" && expected.kind === "link") return actual.target === expected.target;
	return true;
}

function pathHashMatchesEvent(
	actual: PathHash,
	event: Omit<PromotionJournalEvent, "seq">,
	field: "preimage" | "post",
): boolean {
	const kind = field === "preimage" ? event.preimageKind : event.postKind;
	if (kind === "absent") return actual.kind === "absent";
	if (kind === "file")
		return actual.kind === "file" && actual.hash === (field === "preimage" ? event.preimageHash : event.postHash);
	if (kind === "link") {
		return (
			actual.kind === "link" && actual.target === (field === "preimage" ? event.preimageTarget : event.postTarget)
		);
	}
	return false;
}

function pathHashFields(value: PathHash): {
	preimageKind: "file" | "link" | "absent";
	preimageHash: string | null;
	preimageTarget: string | null;
} {
	switch (value.kind) {
		case "file":
			return { preimageKind: "file", preimageHash: value.hash, preimageTarget: null };
		case "link":
			return { preimageKind: "link", preimageHash: null, preimageTarget: value.target };
		case "absent":
			return { preimageKind: "absent", preimageHash: null, preimageTarget: null };
	}
}

function postHashFields(value: PathHash): {
	postKind: "file" | "link" | "absent";
	postHash: string | null;
	postTarget: string | null;
} {
	switch (value.kind) {
		case "file":
			return { postKind: "file", postHash: value.hash, postTarget: null };
		case "link":
			return { postKind: "link", postHash: null, postTarget: value.target };
		case "absent":
			return { postKind: "absent", postHash: null, postTarget: null };
	}
}

async function restorePath(
	recoveryDir: string,
	entry: PlannedPathMutation,
	event: Omit<PromotionJournalEvent, "seq">,
	root: string,
): Promise<void> {
	const target = joinUnderRoot(root, entry.path);
	if (event.preimageKind === "absent") {
		await rmWithRetry(target, { maxAttempts: 3, delayMs: 50 });
		return;
	}
	if (event.preimageKind === "link") {
		await rmWithRetry(target, { maxAttempts: 3, delayMs: 50 }).catch(() => undefined);
		await mkdir(dirname(target), { recursive: true });
		const linkTarget = event.preimageTarget ?? entry.target ?? "";
		try {
			await symlink(linkTarget, target, entry.targetIsDirectory ? "junction" : "file");
		} catch {
			// Privilege-less Windows cannot recreate file symlinks; leave the
			// rollback to report needs-attention instead of guessing bytes.
			throw new PromotionNeedsAttentionError(`cannot recreate link ${entry.path} during rollback`);
		}
		return;
	}
	if (event.recoveryCopy === undefined || event.recoveryCopy === null) {
		throw new PromotionNeedsAttentionError(`no recovery copy recorded for ${entry.path}`);
	}
	const copy = join(recoveryDir, event.recoveryCopy);
	await writeFileAtomic(target, await readFile(copy));
}

export async function runPromotion(options: RunPromotionOptions): Promise<PromotionResult> {
	const { adapter, lease } = options;
	const journal = new JsonlPromotionJournal({ filePath: options.journalPath });
	// An open or needs-attention journal for this lease wins over everything
	// else: the previous promotion is still reconciling and its recovery
	// copies must be settled by recover() before a retry. A closed journal
	// is the durable receipt of a completed attempt (Stage 8, S8.6): the
	// original result is returned and the promotion is never re-executed.
	if (await journal.exists()) {
		const folded = await journal.fold();
		if (folded.open) {
			throw new PromotionConflictError(
				`promotion journal ${options.promotionId} is open; run recover() before retrying`,
			);
		}
		if (folded.needsAttention) {
			throw new PromotionConflictError(
				`promotion ${options.promotionId} needs attention; recover() must settle it before retrying`,
			);
		}
		return durableResult(options, folded);
	}

	const snapshotFingerprint = await adapter.snapshotFingerprint();
	if (options.verifier !== undefined) {
		try {
			await options.verifier({ cwd: lease.root });
		} catch (error) {
			return {
				status: "verifier_failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	// First foreground fingerprint gate: drift stops the promotion with zero
	// writes. Transient Windows locks are caller-environment conflicts.
	let fingerprintBefore: string;
	try {
		fingerprintBefore = await adapter.computeForegroundFingerprint();
	} catch (error) {
		if (isLockError((error as { code?: string }).code)) {
			throw new PromotionConflictError(
				`foreground is locked while recomputing its fingerprint: ${(error as Error).message}`,
			);
		}
		throw error;
	}
	if (fingerprintBefore !== snapshotFingerprint) {
		throw new ForegroundChangedError(
			`foreground fingerprint ${fingerprintBefore} differs from the capture fingerprint ${snapshotFingerprint}`,
		);
	}

	// Plan build and preimage verification read the foreground; transient
	// Windows locks there are caller-environment conflicts, not manager faults.
	let built: Awaited<ReturnType<PromotionAdapter["buildPlan"]>>;
	try {
		built = await adapter.buildPlan();
	} catch (error) {
		if (isLockError((error as { code?: string }).code)) {
			throw new PromotionConflictError(
				`foreground is locked while building the promotion plan: ${(error as Error).message}`,
			);
		}
		throw error;
	}
	const { plan, preimages, foregroundRoot } = built;
	if (plan.paths.length === 0) {
		const postFingerprint = await adapter.computeForegroundFingerprint();
		await journal.append({ type: "open", promotionId: options.promotionId });
		await journal.append({
			type: "close",
			promotionId: options.promotionId,
			status: "promoted",
			touchedPaths: [],
			postFingerprint,
			promotionOriginSnapshotId: options.promotionOrigin.snapshotId,
			promotionOriginFingerprint: options.promotionOrigin.fingerprint,
		});
		return {
			status: "promoted",
			touchedPaths: [],
			receipt: receiptFor(options, "promoted", { touchedPaths: [], postFingerprint }),
		};
	}

	// Re-verify the fingerprint and every touched path preimage before writing.
	let fingerprintAgain: string;
	try {
		fingerprintAgain = await adapter.computeForegroundFingerprint();
	} catch (error) {
		if (isLockError((error as { code?: string }).code)) {
			throw new PromotionConflictError(
				`foreground is locked while re-verifying its fingerprint: ${(error as Error).message}`,
			);
		}
		throw error;
	}
	if (fingerprintAgain !== snapshotFingerprint) {
		throw new ForegroundChangedError("foreground drifted between plan build and preimage verification");
	}
	for (const entry of plan.paths) {
		const expected = preimages.get(entry.path);
		if (expected === undefined) throw new WorkspaceManagerFault(`no expected preimage recorded for ${entry.path}`);
		const actual = await hashPathAt(foregroundRoot, entry.path);
		if (!pathHashMatches(actual, expected)) {
			throw new PromotionConflictError(
				`foreground path ${entry.path} changed between plan build and preimage verification`,
			);
		}
	}

	await journal.append({
		type: "open",
		promotionId: options.promotionId,
		capturedIndexTree: plan.capturedIndexTree ?? null,
	});

	const applied: Array<{ entry: PlannedPathMutation; event: Omit<PromotionJournalEvent, "seq"> }> = [];
	try {
		for (let index = 0; index < plan.paths.length; index++) {
			const entry = plan.paths[index]!;
			const preimage = preimages.get(entry.path)!;
			let recoveryCopy: string | null = null;
			if (preimage.kind === "file") {
				await mkdir(options.recoveryDir, { recursive: true });
				recoveryCopy = `${index}-${preimage.hash}`;
				await copyFile(joinUnderRoot(foregroundRoot, entry.path), join(options.recoveryDir, recoveryCopy));
			}
			await journal.append({
				type: "prepared",
				promotionId: options.promotionId,
				path: entry.path,
				op: entry.op,
				...pathHashFields(preimage),
				targetHash: entry.targetHash,
				recoveryCopy,
			});
			await adapter.applyPath(entry, foregroundRoot);
			const postHash = await hashPathAt(foregroundRoot, entry.path);
			const event = {
				type: "applied",
				promotionId: options.promotionId,
				path: entry.path,
				op: entry.op,
				...pathHashFields(preimage),
				targetHash: entry.targetHash,
				recoveryCopy,
				...postHashFields(postHash),
			} satisfies Omit<PromotionJournalEvent, "seq">;
			await journal.append(event);
			applied.push({ entry, event });
		}
		if (adapter.finalizeApply !== undefined) {
			await adapter.finalizeApply(plan, foregroundRoot);
		}
		if (options.finalVerifier !== undefined) {
			await options.finalVerifier({ cwd: foregroundRoot });
		}
		// The durable post-fingerprint seals the receipt; a failure here
		// rolls the apply back like any other apply-phase failure.
		const postFingerprint = await adapter.computeForegroundFingerprint();
		await journal.append({
			type: "close",
			promotionId: options.promotionId,
			status: "promoted",
			touchedPaths: plan.paths.map((entry) => entry.path),
			postFingerprint,
			promotionOriginSnapshotId: options.promotionOrigin.snapshotId,
			promotionOriginFingerprint: options.promotionOrigin.fingerprint,
		});
		await rm(options.recoveryDir, { recursive: true, force: true }).catch(() => undefined);
		return {
			status: "promoted",
			touchedPaths: plan.paths.map((entry) => entry.path),
			receipt: receiptFor(options, "promoted", {
				touchedPaths: plan.paths.map((entry) => entry.path),
				postFingerprint,
			}),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return rollbackApplied({
			journal,
			foregroundRoot,
			recoveryDir: options.recoveryDir,
			applied,
			reason,
			computePostFingerprint: () => adapter.computeForegroundFingerprint(),
			receiptIdentities: {
				promotionId: options.promotionId,
				leaseId: options.leaseId,
				snapshotId: options.snapshotId,
				promotionOriginSnapshotId: options.promotionOrigin.snapshotId,
				promotionOriginFingerprint: options.promotionOrigin.fingerprint,
			},
		});
	}
}

async function rollbackApplied(input: {
	journal: JsonlPromotionJournal;
	foregroundRoot: string;
	recoveryDir: string;
	applied: Array<{ entry: PlannedPathMutation; event: Omit<PromotionJournalEvent, "seq"> }>;
	reason: string;
	computePostFingerprint?: () => Promise<string>;
	receiptIdentities?: {
		promotionId: string;
		leaseId: string;
		snapshotId: string;
		promotionOriginSnapshotId: string;
		promotionOriginFingerprint: string;
	};
}): Promise<PromotionResult> {
	const { journal, foregroundRoot, recoveryDir, applied, reason } = input;
	const restored: string[] = [];
	for (const { entry, event } of [...applied].reverse()) {
		const current = await hashPathAt(foregroundRoot, entry.path);
		const matchesPre = pathHashMatchesEvent(current, event, "preimage");
		if (matchesPre) {
			await journal.append({
				type: "rolled_back",
				promotionId: event.promotionId,
				path: entry.path,
				op: entry.op,
				preimageKind: event.preimageKind,
				preimageHash: event.preimageHash,
				...(event.preimageTarget === undefined || event.preimageTarget === null
					? {}
					: { preimageTarget: event.preimageTarget }),
				targetHash: event.targetHash,
				recoveryCopy: event.recoveryCopy,
			});
			restored.push(entry.path);
			continue;
		}
		const matchesPost = pathHashMatchesEvent(current, event, "post");
		if (!matchesPost) {
			const needsAttention = new PromotionNeedsAttentionError(
				`promotion of ${entry.path} was interrupted and the path drifted (${reason})`,
			);
			await journal.append({
				type: "needs_attention",
				promotionId: event.promotionId,
				reason: needsAttention.message,
			});
			return needsAttentionResult(applied, recoveryDir, needsAttention, event.promotionId);
		}
		try {
			await restorePath(recoveryDir, entry, event, foregroundRoot);
			const after = await hashPathAt(foregroundRoot, entry.path);
			const matchesPreAfter = pathHashMatchesEvent(after, event, "preimage");
			if (!matchesPreAfter) {
				const needsAttention = new PromotionNeedsAttentionError(
					`restoring ${entry.path} raced with a concurrent edit; stopped automatic recovery`,
				);
				await journal.append({
					type: "needs_attention",
					promotionId: event.promotionId,
					reason: needsAttention.message,
				});
				return needsAttentionResult(applied, recoveryDir, needsAttention, event.promotionId);
			}
			await journal.append({
				type: "rolled_back",
				promotionId: event.promotionId,
				path: entry.path,
				op: entry.op,
				preimageKind: event.preimageKind,
				preimageHash: event.preimageHash,
				...(event.preimageTarget === undefined || event.preimageTarget === null
					? {}
					: { preimageTarget: event.preimageTarget }),
				targetHash: event.targetHash,
				recoveryCopy: event.recoveryCopy,
			});
			restored.push(entry.path);
		} catch (restoreError) {
			const needsAttention = new PromotionNeedsAttentionError(
				`restoring ${entry.path} failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
			);
			await journal.append({
				type: "needs_attention",
				promotionId: event.promotionId,
				reason: needsAttention.message,
			});
			return needsAttentionResult(applied, recoveryDir, needsAttention, event.promotionId);
		}
	}
	const promotionId = applied[0]?.event.promotionId ?? "";
	let postFingerprint = "";
	try {
		postFingerprint = (await input.computePostFingerprint?.()) ?? "";
	} catch {
		postFingerprint = "";
	}
	await journal.append({
		type: "close",
		promotionId,
		status: "rolled_back",
		touchedPaths: restored,
		postFingerprint,
		promotionOriginSnapshotId: input.receiptIdentities?.promotionOriginSnapshotId ?? "",
		promotionOriginFingerprint: input.receiptIdentities?.promotionOriginFingerprint ?? "",
		reason,
	});
	await rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
	const receipt: PromotionReceipt = {
		promotionId: input.receiptIdentities?.promotionId ?? promotionId,
		leaseId: input.receiptIdentities?.leaseId ?? "",
		snapshotId: input.receiptIdentities?.snapshotId ?? "",
		promotionOriginSnapshotId: input.receiptIdentities?.promotionOriginSnapshotId ?? "",
		promotionOriginFingerprint: input.receiptIdentities?.promotionOriginFingerprint ?? "",
		status: "rolled_back",
		touchedPaths: restored,
		postFingerprint,
		reason,
	};
	return { status: "rolled_back", reason, touchedPaths: restored, receipt };
}

function needsAttentionResult(
	applied: Array<{ entry: PlannedPathMutation; event: Omit<PromotionJournalEvent, "seq"> }>,
	recoveryDir: string,
	error: PromotionNeedsAttentionError,
	promotionId: string,
): PromotionResult {
	return {
		status: "needs_attention",
		reason: error.message,
		promotionId,
		recoveryCopies: applied
			.filter(({ event }) => event.recoveryCopy !== null && event.recoveryCopy !== undefined)
			.map(({ event }) => join(recoveryDir, event.recoveryCopy!)),
	};
}

/** Recovery of one promotion journal: conservative CAS; never guesses over user files. */
export async function recoverPromotionJournal(input: {
	journalPath: string;
	foregroundRoot: string;
	recoveryDir: string;
	leaseId?: string;
	snapshotId?: string;
	promotionOriginSnapshotId?: string;
	promotionOriginFingerprint?: string;
}): Promise<{ action: "discarded" | "rolled_back" | "needs_attention" | "unchanged"; promotionId: string }> {
	const { journalPath, foregroundRoot, recoveryDir } = input;
	const journal = new JsonlPromotionJournal({ filePath: journalPath });
	if (!(await journal.exists())) return { action: "unchanged", promotionId: "" };
	const folded = await journal.fold();
	if (!folded.open) {
		if (folded.closed) {
			await rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
		}
		return { action: "unchanged", promotionId: folded.events[0]?.promotionId ?? "" };
	}
	const promotionId = folded.events[0]?.promotionId ?? "";
	if (folded.appliedPaths.length === 0) {
		await journal.delete();
		await rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
		return { action: "discarded", promotionId };
	}
	// Conservative rule: only exact post-apply hashes may be rolled back.
	const appliedEvents = folded.appliedPaths.map((path) => folded.perPath.get(path)!);
	const entries = appliedEvents.map((event) => ({
		entry: {
			path: event.path!,
			op: event.op ?? "tracked_patch",
			targetHash: event.targetHash ?? null,
		} satisfies PlannedPathMutation,
		event,
	}));
	const result = await rollbackApplied({
		journal,
		foregroundRoot,
		recoveryDir,
		applied: entries,
		reason: "recovered promotion journal",
		computePostFingerprint: async () => "",
		receiptIdentities: {
			promotionId,
			leaseId: input.leaseId ?? "",
			snapshotId: input.snapshotId ?? "",
			promotionOriginSnapshotId: input.promotionOriginSnapshotId ?? "",
			promotionOriginFingerprint: input.promotionOriginFingerprint ?? "",
		},
	});
	return result.status === "rolled_back"
		? { action: "rolled_back", promotionId }
		: { action: "needs_attention", promotionId };
}
