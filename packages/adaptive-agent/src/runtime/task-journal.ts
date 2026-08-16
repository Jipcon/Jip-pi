import { appendFile, readFile } from "node:fs/promises";
import type { AgentHarnessStreamOptions } from "@earendil-works/pi-agent-core";
import type { AdaptiveTaskBudget } from "./adaptive-task-budget.ts";
import type { BeliefState } from "./belief-state.ts";
import type { TurnEvidence } from "./evaluator.ts";
import { canonicalJsonLoose, type ExactRequestProfile } from "./exact-request.ts";
import type { CandidatePolicyStateRef, ExactSamplingVariant } from "./harness-v4-contract.ts";
import type { LeafTurnCursor } from "./leaf-turn-executor.ts";
import type { PolicyBundleRef } from "./policy-bundle.ts";
import type { ControllerDecision } from "./rule-based-controller.ts";

/**
 * Append-only AdaptiveTaskJournal: the CandidateGraph authority (Stage 8,
 * S8.1). It stores references, decision bases and task-level facts only;
 * assistant/tool history, effective args and mutable candidate state are
 * never copied. Canonical JSON, single writer, torn-tail recovery; a
 * complete corrupt line faults. Same-key replays are no-ops, conflicting
 * content faults.
 */

export type AdaptiveTaskOutcome =
	| { kind: "promoted"; winnerId: string; touchedPaths: string[] }
	| { kind: "no_verified_candidate"; reason: string }
	| { kind: "budget_exhausted"; budget: "calls" | "tokens" | "time" | "candidates" }
	| { kind: "suspended"; reason: string }
	| { kind: "foreground_changed"; message: string }
	| { kind: "promotion_needs_attention"; promotionId: string; recoveryCopies: string[] };

export type TaskJournalEventType =
	| "task_planned"
	| "root_session_ready"
	| "root_workspace_ready"
	| "root_run_accepted"
	| "candidate_turn_observed"
	| "controller_decided"
	| "branch_committed"
	| "candidate_provisioned"
	| "verifier_planned"
	| "verifier_settled"
	| "candidate_terminal"
	| "candidate_release_started"
	| "candidate_released"
	| "winner_selected"
	| "promotion_started"
	| "promotion_settled"
	| "snapshot_released"
	| "task_terminal";

export interface TaskJournalEventBase {
	type: TaskJournalEventType;
	taskId: string;
	/** Graph revision this event advances the graph to. */
	revision: number;
	/** Deterministic action identity; a same-id replay is a no-op. */
	actionId: string;
	at: number;
}

export type TaskJournalEvent = TaskJournalEventBase &
	(
		| {
				type: "task_planned";
				policyBundle: PolicyBundleRef;
				frozenModel: { provider: string; modelId: string };
				budget: AdaptiveTaskBudget;
				workspace: { sourceRoot: string; logicalRoot: string };
				systemPrompt: string;
				profile: ExactRequestProfile;
				streamOptions?: AgentHarnessStreamOptions;
				coverageThreshold: number;
				redundancyThreshold: number;
				deadlineMs: number;
				rootCandidateId: string;
				rootSessionId: string;
				rootPolicyStateRef: CandidatePolicyStateRef;
		  }
		| { type: "root_session_ready"; candidateId: string; sessionId: string; lane: string }
		| {
				type: "root_workspace_ready";
				candidateId: string;
				snapshotId: string;
				snapshotFingerprint: string;
				leaseId: string;
		  }
		| { type: "root_run_accepted"; candidateId: string; operationId: string; basisEntryId: string }
		| {
				type: "candidate_turn_observed";
				candidateId: string;
				operationId: string;
				cursor: LeafTurnCursor;
				policyStateRef: CandidatePolicyStateRef;
				belief: BeliefState;
				cost: { providerCalls: number; totalTokens: number };
				evidence: TurnEvidence;
				settlement?: "completed" | "failed" | "aborted";
		  }
		| {
				type: "controller_decided";
				candidateId: string;
				decision: ControllerDecision;
				basis: {
					policyStateFingerprint: string;
					beliefFingerprint: string;
					budgetFingerprint: string;
					policyBundle: PolicyBundleRef;
					/** The cursor the decision was made for (crash-resumption key). */
					cursor?: LeafTurnCursor;
				};
		  }
		| {
				type: "branch_committed";
				candidateId: string;
				groupId: string;
				snapshotId: string;
				snapshotFingerprint: string;
				logicalRoot: string;
				contentFingerprint: string;
				cursor: LeafTurnCursor;
				contextFingerprint: string;
				requestFingerprint: string;
				policyStateFingerprint: string;
				variants: ExactSamplingVariant[];
				childIds: string[];
		  }
		| {
				type: "candidate_provisioned";
				candidateId: string;
				parentId?: string;
				depth: number;
				continuationGroupId?: string;
				sessionId: string;
				lane: string;
				snapshotId: string;
				leaseId: string;
				operationId?: string;
				basisEntryId?: string;
				cursor?: LeafTurnCursor;
				policyStateRef: CandidatePolicyStateRef;
				belief: BeliefState;
		  }
		| {
				type: "verifier_planned";
				candidateId: string;
				attemptId: string;
				verifierId: string;
				verifierVersion: string;
				replay: "safe" | "never";
		  }
		| {
				type: "verifier_settled";
				candidateId: string;
				attemptId: string;
				status: "pass" | "fail" | "interrupted";
				coverage: number;
				durationMs: number;
				summary: { hash: string; length: number; prefix: string };
				workspaceFingerprint: string;
				workspaceMutation?: { kind: "tracked" | "untracked" | "both"; detail: string };
				belief: BeliefState;
		  }
		| {
				type: "candidate_terminal";
				candidateId: string;
				status: "verified" | "pruned" | "failed" | "winner";
				reason: string;
		  }
		| { type: "candidate_release_started"; candidateId: string }
		| { type: "candidate_released"; candidateId: string }
		| { type: "winner_selected"; winnerId: string; promotionAttemptId: string }
		| { type: "promotion_started"; winnerId: string; promotionAttemptId: string }
		| {
				type: "promotion_settled";
				winnerId: string;
				promotionAttemptId: string;
				status: "promoted" | "rolled_back" | "needs_attention";
				touchedPaths: string[];
				postFingerprint: string;
				reason?: string;
		  }
		| { type: "snapshot_released"; snapshotId: string }
		| { type: "task_terminal"; outcome: AdaptiveTaskOutcome }
	);

export class TaskJournalFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TaskJournalFault";
	}
}

export function taskJournalEventKey(event: TaskJournalEvent): string {
	switch (event.type) {
		case "task_planned":
		case "task_terminal":
			return `${event.taskId}:${event.type}`;
		case "root_session_ready":
		case "root_workspace_ready":
		case "root_run_accepted":
		case "candidate_release_started":
		case "candidate_released":
		case "candidate_terminal":
			return `${event.taskId}:${event.type}:${event.candidateId}`;
		case "verifier_planned":
		case "verifier_settled":
			return `${event.taskId}:${event.type}:${event.candidateId}:${event.attemptId}`;
		case "branch_committed":
			return `${event.taskId}:${event.type}:${event.candidateId}`;
		case "candidate_provisioned":
			return `${event.taskId}:${event.type}:${event.candidateId}`;
		case "winner_selected":
		case "promotion_started":
		case "promotion_settled":
			return `${event.taskId}:${event.type}:${event.promotionAttemptId}`;
		case "snapshot_released":
			return `${event.taskId}:${event.type}:${event.snapshotId}`;
		case "candidate_turn_observed":
		case "controller_decided":
			// Multiple events per candidate are legal; the deterministic
			// actionId is their replay identity.
			return `${event.taskId}:${event.type}:${event.actionId}`;
	}
}

/**
 * Canonical serialization of one event. Loose canonical JSON (finite
 * non-integer numbers allowed) because task_planned carries the exact
 * request profile (temperature/top-p); object keys are still sorted
 * recursively and every other value stays fully deterministic.
 */
export function canonicalTaskJournalEvent(event: TaskJournalEvent): string {
	return canonicalJsonLoose(event);
}

export interface AdaptiveTaskJournal {
	/** Appends one canonical JSON event; replay-by-actionId is validated by the graph. */
	append(event: TaskJournalEvent): Promise<void>;
	events(): Promise<TaskJournalEvent[]>;
	close(): Promise<void>;
}

function assertEvent(value: unknown): TaskJournalEvent {
	const record = value as { type?: unknown; taskId?: unknown; revision?: unknown; actionId?: unknown; at?: unknown };
	if (
		typeof record !== "object" ||
		record === null ||
		typeof record.type !== "string" ||
		typeof record.taskId !== "string" ||
		typeof record.revision !== "number" ||
		!Number.isSafeInteger(record.revision) ||
		typeof record.actionId !== "string" ||
		typeof record.at !== "number"
	) {
		throw new TaskJournalFault("Task journal line is not a task journal event");
	}
	return value as unknown as TaskJournalEvent;
}

export class MemoryTaskJournal implements AdaptiveTaskJournal {
	private readonly lines: TaskJournalEvent[] = [];
	private closed = false;

	async append(event: TaskJournalEvent): Promise<void> {
		if (this.closed) throw new TaskJournalFault("Memory task journal is closed");
		this.lines.push(structuredClone(event));
	}

	async events(): Promise<TaskJournalEvent[]> {
		if (this.closed) throw new TaskJournalFault("Memory task journal is closed");
		return this.lines.map((line) => structuredClone(line));
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

/** JSONL backend: one canonical event per line, torn-tail tolerant. */
export class JsonlTaskJournal implements AdaptiveTaskJournal {
	private readonly filePath: string;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: { filePath: string }) {
		this.filePath = options.filePath;
	}

	async append(event: TaskJournalEvent): Promise<void> {
		if (this.closed) throw new TaskJournalFault(`Task journal ${this.filePath} is closed`);
		const payload = `${canonicalTaskJournalEvent(event)}
`;
		const run = async (): Promise<void> => {
			if (this.closed) return;
			try {
				await appendFile(this.filePath, payload, "utf8");
			} catch (error) {
				throw new TaskJournalFault(
					`Failed to append to task journal ${this.filePath}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		};
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		await next;
	}

	async events(): Promise<TaskJournalEvent[]> {
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw new TaskJournalFault(
				`Failed to read task journal ${this.filePath}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		const events: TaskJournalEvent[] = [];
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line.length === 0) continue;
			try {
				events.push(assertEvent(JSON.parse(line)));
			} catch (error) {
				// Only an unterminated final line is a recoverable torn tail; a
				// corrupt complete line faults the whole task.
				if (index === lines.length - 1 && !endsWithNewline) continue;
				if (error instanceof TaskJournalFault) throw error;
				throw new TaskJournalFault(
					`Task journal ${this.filePath} contains a corrupt line`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return events;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.queue;
		this.closed = true;
	}
}
