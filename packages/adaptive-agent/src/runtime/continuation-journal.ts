import { appendFile, readFile } from "node:fs/promises";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";

/**
 * Append-only continuation journal: the correctness-critical coordination
 * authority for one continuation group. TrajectoryStore must never be
 * substituted for it because the journal must not skip torn lines.
 */

export type ContinuationJournalEvent =
	| {
			type: "group_planned";
			groupId: string;
			source: {
				sessionId: string;
				lane: string;
				cursor: { operationId: string; assistantEntryId: string; leafId: string };
				workspaceSnapshotId: string;
				contextFingerprint: string;
				requestFingerprint: string;
				policyStateFingerprint: string;
			};
			variants: Array<{ id: string; seed?: number }>;
	  }
	| {
			type: "child_session_forked";
			groupId: string;
			childId: string;
			sampleIndex: number;
			sessionId: string;
			lane: string;
	  }
	| {
			type: "child_workspace_ready";
			groupId: string;
			childId: string;
			sampleIndex: number;
			/** Durable workspace lease identity (Stage 7): reattach verifies it. */
			leaseId: string;
			snapshotId: string;
	  }
	| {
			type: "child_run_accepted";
			groupId: string;
			childId: string;
			sampleIndex: number;
			operationId: string;
			basisEntryId: string;
	  }
	| { type: "child_ready"; groupId: string; childId: string; sampleIndex: number }
	| { type: "group_ready"; groupId: string }
	| { type: "child_failed"; groupId: string; childId: string; sampleIndex: number; reason: string }
	| { type: "group_failed"; groupId: string; reason: string }
	/**
	 * Stage 8 group terminal/release receipts (S8.6): every child of the
	 * group reached a terminal state, and the group snapshot was released.
	 * Both are idempotent re-runs of the same cleanup.
	 */
	| { type: "group_terminal"; groupId: string; reason: string }
	| { type: "group_released"; groupId: string; snapshotId: string };

/** Storage/journal failure: faults the whole group, never a typed rejection. */
export class ContinuationJournalFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ContinuationJournalFault";
	}
}

/** Deterministic child identity from the group id and the ordered sample index. */
export function continuationChildId(groupId: string, sampleIndex: number): string {
	return sha256Hex(`${groupId}:child:${sampleIndex}`);
}

/** Deterministic group id: identical checkpoint plus identical variants reattach. */
export function continuationGroupId(input: {
	sourceSessionId: string;
	sourceLane: string;
	cursor: { operationId: string; assistantEntryId: string; leafId: string };
	workspaceSnapshotId: string;
	contextFingerprint: string;
	requestFingerprint: string;
	policyStateFingerprint: string;
	variants: Array<{ id: string; seed?: number }>;
}): string {
	return sha256Hex(canonicalJson(input as unknown as JsonValue));
}

function eventKey(event: ContinuationJournalEvent): string {
	const child = "childId" in event ? event.childId : "";
	return `${event.groupId}:${event.type}:${child}`;
}

function eventJson(event: ContinuationJournalEvent): string {
	return canonicalJson(event as unknown as JsonValue);
}

export interface ContinuationJournal {
	/** Idempotent append: repeating the same event is a no-op, conflicting content faults. */
	append(event: ContinuationJournalEvent): Promise<void>;
	/** All events of one group in append order. */
	events(groupId: string): Promise<ContinuationJournalEvent[]>;
	close(): Promise<void>;
}

function assertEvent(event: unknown): ContinuationJournalEvent {
	const value = event as { type?: unknown; groupId?: unknown; childId?: unknown };
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.type !== "string" ||
		typeof value.groupId !== "string"
	) {
		throw new ContinuationJournalFault("Journal line is not a continuation event");
	}
	return value as unknown as ContinuationJournalEvent;
}

export class MemoryContinuationJournal implements ContinuationJournal {
	private readonly lines: ContinuationJournalEvent[] = [];
	private closed = false;

	async append(event: ContinuationJournalEvent): Promise<void> {
		if (this.closed) throw new ContinuationJournalFault("Memory journal is closed");
		const key = eventKey(event);
		const existing = this.lines.find((line) => eventKey(line) === key);
		if (existing !== undefined) {
			if (eventJson(existing) !== eventJson(event)) {
				throw new ContinuationJournalFault(`Journal event ${key} was already recorded with different content`);
			}
			return;
		}
		this.lines.push(structuredClone(event));
	}

	async events(groupId: string): Promise<ContinuationJournalEvent[]> {
		return this.lines.filter((line) => line.groupId === groupId).map((line) => structuredClone(line));
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

/**
 * JSONL journal backend: one canonical JSON event per line, appended
 * atomically line-by-line. Recovery drops only an incomplete torn tail and
 * never silently skips a complete line; an unreadable file faults the group.
 */
export class JsonlContinuationJournal implements ContinuationJournal {
	private readonly filePath: string;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private sealed = false;

	constructor(options: { filePath: string }) {
		this.filePath = options.filePath;
	}

	async append(event: ContinuationJournalEvent): Promise<void> {
		if (this.closed) throw new ContinuationJournalFault(`Journal ${this.filePath} is closed`);
		const payload = `${eventJson(event)}\n`;
		const run = async (): Promise<void> => {
			if (this.closed) return;
			const recorded = await this.readRecorded();
			const key = eventKey(event);
			const existing = recorded.find((line) => eventKey(line) === key);
			if (existing !== undefined) {
				if (eventJson(existing) !== eventJson(event)) {
					throw new ContinuationJournalFault(`Journal event ${key} was already recorded with different content`);
				}
				return;
			}
			try {
				await appendFile(this.filePath, payload, "utf8");
			} catch (error) {
				throw new ContinuationJournalFault(
					`Failed to append to journal ${this.filePath}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		};
		const next = this.queue.then(run, run);
		// The stored queue swallows the rejection so a per-event fault never
		// becomes an unhandled rejection; callers still observe it via `next`.
		this.queue = next.catch(() => undefined);
		await next;
	}

	async events(groupId: string): Promise<ContinuationJournalEvent[]> {
		const recorded = await this.readRecorded();
		return recorded.filter((line) => line.groupId === groupId).map((line) => structuredClone(line));
	}

	private async readRecorded(): Promise<ContinuationJournalEvent[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw new ContinuationJournalFault(
				`Failed to read journal ${this.filePath}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		const events: ContinuationJournalEvent[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line.length === 0) continue;
			try {
				events.push(assertEvent(JSON.parse(line)));
			} catch (error) {
				// Torn tail: only an unterminated final line is recoverable; a
				// corrupt complete line (or a corrupt line before a later
				// complete line) faults the whole group.
				if (index === lines.length - 1 && !endsWithNewline) continue;
				throw new ContinuationJournalFault(
					`Journal ${this.filePath} contains a corrupt line`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return events;
	}

	async close(): Promise<void> {
		if (this.sealed) return;
		this.sealed = true;
		await this.queue;
		this.closed = true;
	}
}
