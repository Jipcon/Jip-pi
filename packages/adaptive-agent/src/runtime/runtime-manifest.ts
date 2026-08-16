import { appendFile, readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson } from "./policy-bundle.ts";
import { WorkspaceManagerFault } from "./workspace-errors.ts";

/**
 * Append-only runtime manifest: the durable authority for snapshot refs,
 * leases, and promotion journal locations. One canonical JSON record per
 * line; a torn final line is dropped, a corrupt interior line faults.
 * Single active writer process (same boundary as the Harness JSONL backend).
 */

export interface UntrackedEntry {
	path: string;
	kind: "file" | "link";
	mode: number;
	size: number;
	mtimeMs: number;
	hash: string;
	target?: string;
	targetIsDirectory?: boolean;
}

export interface UntrackedExclusion {
	path: string;
	reason: string;
}

export type LeaseStatus = "creating" | "ready" | "releasing" | "released" | "orphaned";

export interface SnapshotRecord {
	type: "snapshot";
	seq: number;
	snapshotId: string;
	repoId: string;
	sourceRoot: string;
	repoRoot: string;
	commonDir: string;
	backend: "git-worktree" | "temp-copy";
	ref: string;
	commitOid: string;
	headOid: string;
	indexTree: string;
	trackedTree: string;
	untrackedManifestHash: string;
	policyHash: string;
	fingerprint: string;
	logicalRoot: string;
	createdAt: number;
	untracked: UntrackedEntry[];
	untrackedExcluded: UntrackedExclusion[];
	/**
	 * Stage 8 promotion lineage: for a lease-derived snapshot this names the
	 * ORIGINAL foreground snapshot whose content is the promotion baseline
	 * (drift gate, full patch basis, index restore). Absent on foreground
	 * captures, which are their own promotion origin. Fork materialization
	 * always uses this snapshot's own content.
	 */
	promotionOriginSnapshotId?: string;
	promotionOriginFingerprint?: string;
}

export interface LeaseRecord {
	type: "lease";
	seq: number;
	leaseId: string;
	snapshotId: string;
	candidateId: string;
	root: string;
	gitDir: string;
	worktreeName: string;
	status: LeaseStatus;
	createdAt: number;
}

export interface PromotionRecord {
	type: "promotion";
	seq: number;
	promotionId: string;
	leaseId: string;
	status: "open" | "closed";
}

export type ManifestRecord =
	| SnapshotRecord
	| { type: "snapshot.released"; seq: number; snapshotId: string }
	| LeaseRecord
	| PromotionRecord;

export interface FoldedManifest {
	snapshots: Map<string, SnapshotRecord>;
	releasedSnapshots: Set<string>;
	leases: Map<string, LeaseRecord>;
	promotions: Map<string, PromotionRecord>;
}

function recordKey(record: ManifestRecord): string {
	switch (record.type) {
		case "snapshot":
			return `snapshot:${record.snapshotId}`;
		case "snapshot.released":
			return `snapshot:${record.snapshotId}`;
		case "lease":
			return `lease:${record.leaseId}`;
		case "promotion":
			return `promotion:${record.promotionId}`;
	}
}

export function foldManifest(records: ManifestRecord[]): FoldedManifest {
	const folded: FoldedManifest = {
		snapshots: new Map(),
		releasedSnapshots: new Set(),
		leases: new Map(),
		promotions: new Map(),
	};
	for (const record of records) {
		switch (record.type) {
			case "snapshot":
				folded.snapshots.set(record.snapshotId, record);
				break;
			case "snapshot.released":
				folded.releasedSnapshots.add(record.snapshotId);
				break;
			case "lease":
				folded.leases.set(record.leaseId, record);
				break;
			case "promotion":
				folded.promotions.set(record.promotionId, record);
				break;
		}
	}
	return folded;
}

function assertManifestRecord(value: unknown): ManifestRecord {
	const record = value as { type?: unknown; snapshotId?: unknown; leaseId?: unknown; promotionId?: unknown };
	if (
		typeof record !== "object" ||
		record === null ||
		(record.type !== "snapshot" &&
			record.type !== "snapshot.released" &&
			record.type !== "lease" &&
			record.type !== "promotion")
	) {
		throw new WorkspaceManagerFault("Manifest line is not a recognized record");
	}
	if ((record.type === "snapshot" || record.type === "snapshot.released") && typeof record.snapshotId !== "string") {
		throw new WorkspaceManagerFault("Manifest snapshot record has no snapshotId");
	}
	if (record.type === "lease" && typeof record.leaseId !== "string") {
		throw new WorkspaceManagerFault("Manifest lease record has no leaseId");
	}
	if (record.type === "promotion" && typeof record.promotionId !== "string") {
		throw new WorkspaceManagerFault("Manifest promotion record has no promotionId");
	}
	return value as unknown as ManifestRecord;
}

export type ManifestRecordInput =
	| Omit<SnapshotRecord, "seq">
	| Omit<{ type: "snapshot.released"; seq: number; snapshotId: string }, "seq">
	| Omit<LeaseRecord, "seq">
	| Omit<PromotionRecord, "seq">;

export class JsonlManifestStore {
	private readonly filePath: string;
	private queue: Promise<void> = Promise.resolve();
	private nextSeq = 1;
	private closed = false;
	private loaded = false;

	constructor(options: { filePath: string }) {
		this.filePath = options.filePath;
	}

	async append(input: ManifestRecordInput): Promise<ManifestRecord> {
		if (this.closed) throw new WorkspaceManagerFault(`Manifest ${this.filePath} is closed`);
		const run = async (): Promise<ManifestRecord> => {
			if (!this.loaded) {
				this.nextSeq = (await this.records()).reduce((max, record) => Math.max(max, record.seq), 0) + 1;
				this.loaded = true;
			}
			const record = { ...structuredClone(input), seq: this.nextSeq } as ManifestRecord;
			record.seq = this.nextSeq;
			this.nextSeq += 1;
			try {
				await appendFile(this.filePath, `${canonicalJson(record as unknown as JsonValue)}\n`, "utf8");
			} catch (error) {
				throw new WorkspaceManagerFault(
					`Failed to append to manifest ${this.filePath}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			return record;
		};
		const next = this.queue.then(run, run);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async records(): Promise<ManifestRecord[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw new WorkspaceManagerFault(
				`Failed to read manifest ${this.filePath}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		const records: ManifestRecord[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line.length === 0) continue;
			try {
				records.push(assertManifestRecord(JSON.parse(line)));
			} catch (error) {
				if (index === lines.length - 1 && !endsWithNewline) continue;
				if (error instanceof WorkspaceManagerFault) throw error;
				throw new WorkspaceManagerFault(
					`Manifest ${this.filePath} contains a corrupt line`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return records;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.queue;
		this.closed = true;
	}

	/** Reopen-tolerant read of the folded manifest. */
	async fold(): Promise<FoldedManifest> {
		return foldManifest(await this.records());
	}

	get path(): string {
		return this.filePath;
	}

	// Exposed for the deterministic record key folding used by recovery.
	static recordKey(record: ManifestRecord): string {
		return recordKey(record);
	}
}
