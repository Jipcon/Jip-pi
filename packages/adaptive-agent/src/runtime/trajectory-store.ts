import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";

export type TrajectoryRecordKind = "turn" | "step" | "task" | "policy" | "evaluator_evidence";

export interface TrajectoryRecord {
	/** Stable identity: at-least-once delivery is deduplicated on this. */
	id: string;
	kind: TrajectoryRecordKind;
	taskId: string;
	candidateId: string;
	sessionId: string;
	operationId: string;
	assistantEntryId?: string;
	toolIndex?: number;
	toolCallId?: string;
	resultEntryId?: string;
	policyBundleVersion: string;
	policyBundleFingerprint: string;
	stateFingerprint?: string;
	/** Structured metrics only: hashes, lengths and sanitized summaries. */
	metrics: Record<string, unknown>;
	recordedAt: number;
}

export interface TrajectoryAppendResult {
	appended: boolean;
}

/**
 * Non-authoritative research data. Writes are fire-and-forget: pausing,
 * failing, duplicating or losing records must never change Harness execution,
 * projection or policy decisions.
 */
export interface TrajectoryStore {
	append(record: TrajectoryRecord): Promise<TrajectoryAppendResult>;
	query(filter?: { kind?: TrajectoryRecordKind; taskId?: string; operationId?: string }): Promise<TrajectoryRecord[]>;
	setPaused(paused: boolean): void;
	close(): Promise<void>;
}

export const MAX_TRAJECTORY_SUMMARY_LENGTH = 200;

/**
 * Redacts free-form content down to structured metrics: long strings are
 * replaced by their length and sha256, keeping only a bounded sanitized prefix.
 * Full shell output and raw file content never enter the store.
 */
export function sanitizeTrajectoryMetrics(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_TRAJECTORY_SUMMARY_LENGTH) return value;
		return {
			length: value.length,
			hash: sha256Hex(value),
			prefix: collapseWhitespace(value.slice(0, MAX_TRAJECTORY_SUMMARY_LENGTH)),
		};
	}
	if (Array.isArray(value)) return value.map((item) => sanitizeTrajectoryMetrics(item));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = sanitizeTrajectoryMetrics(item);
		return out;
	}
	if (typeof value === "number" && !Number.isFinite(value)) return null;
	return value;
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export class InMemoryTrajectoryStore implements TrajectoryStore {
	private readonly records = new Map<string, TrajectoryRecord>();
	private paused = false;
	private closed = false;

	async append(record: TrajectoryRecord): Promise<TrajectoryAppendResult> {
		if (this.closed || this.paused) return { appended: false };
		// Idempotent by stable identity: duplicates are dropped, the first
		// write wins and is never overwritten.
		if (this.records.has(record.id)) return { appended: false };
		const sanitized = structuredClone(record);
		sanitized.metrics = sanitizeTrajectoryMetrics(record.metrics) as Record<string, unknown>;
		this.records.set(record.id, sanitized);
		return { appended: true };
	}

	async query(
		filter: { kind?: TrajectoryRecordKind; taskId?: string; operationId?: string } = {},
	): Promise<TrajectoryRecord[]> {
		return [...this.records.values()]
			.filter(
				(record) =>
					(filter.kind === undefined || record.kind === filter.kind) &&
					(filter.taskId === undefined || record.taskId === filter.taskId) &&
					(filter.operationId === undefined || record.operationId === filter.operationId),
			)
			.map((record) => structuredClone(record))
			.sort((left, right) => left.recordedAt - right.recordedAt);
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.records.clear();
	}
}

/**
 * Append-only JSONL research store. Every write is best-effort: failures are
 * swallowed (optionally reported) and never propagate to callers.
 */
export class JsonlTrajectoryStore implements TrajectoryStore {
	private readonly directory: string;
	private readonly path: string;
	private readonly onError?: (error: Error) => void;
	private paused = false;
	private closed = false;

	constructor(options: { directory: string; file?: string; onError?: (error: Error) => void }) {
		this.directory = options.directory;
		this.path = join(options.directory, options.file ?? "trajectory.jsonl");
		this.onError = options.onError;
	}

	async append(record: TrajectoryRecord): Promise<TrajectoryAppendResult> {
		if (this.closed || this.paused) return { appended: false };
		const sanitized = structuredClone(record);
		sanitized.metrics = sanitizeTrajectoryMetrics(record.metrics) as Record<string, unknown>;
		try {
			await mkdir(this.directory, { recursive: true });
			await appendFile(this.path, `${canonicalJson(sanitized as unknown as JsonValue)}\n`, "utf8");
			return { appended: true };
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
			return { appended: false };
		}
	}

	async query(
		filter: { kind?: TrajectoryRecordKind; taskId?: string; operationId?: string } = {},
	): Promise<TrajectoryRecord[]> {
		let lines: string[];
		try {
			lines = (await readFile(this.path, "utf8")).split("\n");
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT") return [];
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
			return [];
		}
		const seen = new Set<string>();
		const records: TrajectoryRecord[] = [];
		for (const line of lines) {
			if (line.trim().length === 0) continue;
			try {
				const record = JSON.parse(line) as TrajectoryRecord;
				if (record.id === undefined || seen.has(record.id)) continue;
				if (
					(filter.kind === undefined || record.kind === filter.kind) &&
					(filter.taskId === undefined || record.taskId === filter.taskId) &&
					(filter.operationId === undefined || record.operationId === filter.operationId)
				) {
					seen.add(record.id);
					records.push(record);
				}
			} catch {
				// A torn or foreign line is research data: skip it, never fail.
			}
		}
		return records.sort((left, right) => left.recordedAt - right.recordedAt);
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async remove(): Promise<void> {
		await rm(this.path, { force: true }).catch(() => undefined);
	}
}
