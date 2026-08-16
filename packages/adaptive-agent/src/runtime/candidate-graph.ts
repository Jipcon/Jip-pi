import type { AgentHarnessStreamOptions } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import type { AdaptiveTaskBudget } from "./adaptive-task-budget.ts";
import { type BeliefState, initialBelief, isEligibleVerified } from "./belief-state.ts";
import type { ContinuationJournalEvent } from "./continuation-journal.ts";
import type { TurnEvidence } from "./evaluator.ts";
import { canonicalJsonLoose, type ExactRequestProfile } from "./exact-request.ts";
import type { CandidatePolicyStateRef, ExactSamplingVariant } from "./harness-v4-contract.ts";
import type { LeafTurnCursor } from "./leaf-turn-executor.ts";
import type { PolicyBundleRef } from "./policy-bundle.ts";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";
import type { ControllerDecision } from "./rule-based-controller.ts";
import {
	type AdaptiveTaskJournal,
	type AdaptiveTaskOutcome,
	type TaskJournalEvent,
	taskJournalEventKey,
} from "./task-journal.ts";

/**
 * CandidateGraph (Stage 8, S8.1): an append-only fold over the
 * AdaptiveTaskJournal. Nodes hold durable identity only (session/workspace
 * references, policy-state refs, belief, cost); no live objects. Every
 * transition carries a graph revision and a deterministic action id; a
 * replayed event is a no-op, a same-key conflicting event faults.
 */

export class TaskGraphFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TaskGraphFault";
	}
}

export interface CandidateCost {
	providerCalls: number;
	totalTokens: number;
}

export type CandidateStatus =
	| "provisioning"
	| "active"
	| "branching"
	| "branch_origin"
	| "verifying"
	| "verified"
	| "pruned"
	| "failed"
	| "winner"
	| "terminal";

export interface CandidateNode {
	id: string;
	parentId?: string;
	depth: number;

	conversation: {
		sessionId: string;
		lane: string;
		operationId?: string;
		basisEntryId?: string;
		cursor?: LeafTurnCursor;
		continuationGroupId?: string;
	};

	workspace: {
		snapshotId: string;
		leaseId?: string;
		snapshotFingerprint?: string;
	};

	policyState: CandidatePolicyStateRef;
	belief: BeliefState;
	cost: CandidateCost;

	status: CandidateStatus;
	settlement?: "completed" | "failed" | "aborted";
	terminalReason?: string;
	released: boolean;
	lastEvidence?: TurnEvidence;
	pendingVerifier?: { attemptId: string; replay: "safe" | "never" };
	verifierResult?: {
		status: "pass" | "fail" | "interrupted";
		coverage: number;
		workspaceFingerprint: string;
		mutation?: { kind: "tracked" | "untracked" | "both"; detail: string };
	};
}

export interface ContinuationGroupRecord {
	groupId: string;
	sourceId: string;
	snapshotId: string;
	cursor: LeafTurnCursor;
	contextFingerprint: string;
	requestFingerprint: string;
	policyStateFingerprint: string;
	variants: ExactSamplingVariant[];
	childIds: string[];
}

export interface FoldedTaskGraph {
	taskId: string;
	status: "planned" | "running" | "terminal";
	policyBundle?: PolicyBundleRef;
	frozenModel?: { provider: string; modelId: string };
	budget?: AdaptiveTaskBudget;
	deadlineMs?: number;
	coverageThreshold?: number;
	redundancyThreshold?: number;
	profile?: ExactRequestProfile;
	streamOptions?: AgentHarnessStreamOptions;
	systemPrompt?: string;
	workspace?: { sourceRoot: string; logicalRoot: string };
	rootCandidateId?: string;
	rootSessionId?: string;
	winnerId?: string;
	promotionAttemptId?: string;
	outcome?: AdaptiveTaskOutcome;
	revision: number;
	nodes: Map<string, CandidateNode>;
	groups: Map<string, ContinuationGroupRecord>;
	lastDecisions: Map<string, { decision: ControllerDecision; basis: { cursor?: LeafTurnCursor } }>;
	releasedSnapshots: Set<string>;
}

const EMPTY_NODE_PLACEHOLDER = "pending";

function eventTarget(event: TaskJournalEvent): string {
	switch (event.type) {
		case "task_planned":
		case "task_terminal":
			return event.taskId;
		case "root_session_ready":
		case "root_workspace_ready":
		case "root_run_accepted":
		case "candidate_turn_observed":
		case "controller_decided":
		case "candidate_provisioned":
		case "verifier_planned":
		case "verifier_settled":
		case "candidate_terminal":
		case "candidate_release_started":
		case "candidate_released":
			return `candidate:${event.candidateId}`;
		case "branch_committed":
			return `branch:${event.candidateId}:${event.groupId}`;
		case "winner_selected":
		case "promotion_started":
		case "promotion_settled":
			return `promotion:${event.promotionAttemptId}`;
		case "snapshot_released":
			return `snapshot:${event.snapshotId}`;
	}
}

/** Deterministic action identity: same task/revision/type/target always replays identically. */
export function deterministicActionId(input: {
	taskId: string;
	revision: number;
	type: TaskJournalEvent["type"];
	target: string;
}): string {
	return sha256Hex(
		canonicalJson({
			taskId: input.taskId,
			revision: input.revision,
			type: input.type,
			target: input.target,
		} as unknown as JsonValue),
	);
}

export function actionIdForEvent(event: TaskJournalEvent): string {
	return deterministicActionId({
		taskId: event.taskId,
		revision: event.revision,
		type: event.type,
		target: eventTarget(event),
	});
}

/** Event content identity without the wall-clock timestamp (loose canonical JSON for profile floats). */
function eventContentKey(event: TaskJournalEvent): string {
	const { at: _at, ...content } = event;
	void _at;
	return canonicalJsonLoose(content);
}

function fault(context: string, detail: string): never {
	throw new TaskGraphFault(`${context}: ${detail}`);
}

interface FoldState {
	graph: FoldedTaskGraph;
	rootFlags: { session: boolean; workspace: boolean; run: boolean };
	seenKeys: Map<string, string>;
	seenActions: Map<string, string>;
}

function nodeOf(state: FoldState, candidateId: string, context: string): CandidateNode {
	const node = state.graph.nodes.get(candidateId);
	if (node === undefined) fault(context, `candidate ${candidateId} is unknown`);
	return node;
}

function assertNotTerminal(node: CandidateNode, context: string): void {
	if (
		node.status === "pruned" ||
		node.status === "failed" ||
		node.status === "winner" ||
		node.status === "terminal" ||
		node.status === "branch_origin"
	) {
		fault(context, `candidate ${node.id} is ${node.status}`);
	}
}

function applyEvent(state: FoldState, event: TaskJournalEvent): void {
	const { graph } = state;
	switch (event.type) {
		case "task_planned": {
			if (graph.status !== "planned") fault("task_planned", "task is already planned");
			graph.status = "running";
			graph.policyBundle = structuredClone(event.policyBundle);
			graph.frozenModel = structuredClone(event.frozenModel);
			graph.budget = structuredClone(event.budget);
			graph.deadlineMs = event.deadlineMs;
			graph.coverageThreshold = event.coverageThreshold;
			graph.redundancyThreshold = event.redundancyThreshold;
			graph.profile = structuredClone(event.profile);
			graph.streamOptions = event.streamOptions === undefined ? undefined : structuredClone(event.streamOptions);
			graph.systemPrompt = event.systemPrompt;
			graph.workspace = structuredClone(event.workspace);
			graph.rootCandidateId = event.rootCandidateId;
			graph.rootSessionId = event.rootSessionId;
			graph.nodes.set(event.rootCandidateId, {
				id: event.rootCandidateId,
				depth: 0,
				conversation: { sessionId: EMPTY_NODE_PLACEHOLDER, lane: "" },
				workspace: { snapshotId: EMPTY_NODE_PLACEHOLDER },
				policyState: structuredClone(event.rootPolicyStateRef),
				belief: initialBelief(),
				cost: { providerCalls: 0, totalTokens: 0 },
				status: "provisioning",
				released: false,
			});
			return;
		}
		case "root_session_ready": {
			const node = nodeOf(state, event.candidateId, "root_session_ready");
			node.conversation.sessionId = event.sessionId;
			node.conversation.lane = event.lane;
			state.rootFlags.session = true;
			break;
		}
		case "root_workspace_ready": {
			const node = nodeOf(state, event.candidateId, "root_workspace_ready");
			node.workspace.snapshotId = event.snapshotId;
			node.workspace.snapshotFingerprint = event.snapshotFingerprint;
			node.workspace.leaseId = event.leaseId;
			state.rootFlags.workspace = true;
			break;
		}
		case "root_run_accepted": {
			const node = nodeOf(state, event.candidateId, "root_run_accepted");
			node.conversation.operationId = event.operationId;
			node.conversation.basisEntryId = event.basisEntryId;
			state.rootFlags.run = true;
			break;
		}
		case "candidate_turn_observed": {
			const node = nodeOf(state, event.candidateId, "candidate_turn_observed");
			assertNotTerminal(node, "candidate_turn_observed");
			node.conversation.operationId = event.operationId;
			node.conversation.cursor = structuredClone(event.cursor);
			node.policyState = structuredClone(event.policyStateRef);
			node.belief = structuredClone(event.belief);
			node.cost.providerCalls += event.cost.providerCalls;
			node.cost.totalTokens += event.cost.totalTokens;
			node.lastEvidence = structuredClone(event.evidence);
			node.settlement = event.settlement;
			break;
		}
		case "controller_decided": {
			const node = nodeOf(state, event.candidateId, "controller_decided");
			assertNotTerminal(node, "controller_decided");
			graph.lastDecisions.set(event.candidateId, {
				decision: structuredClone(event.decision),
				basis: {
					...(event.basis.cursor === undefined ? {} : { cursor: structuredClone(event.basis.cursor) }),
				},
			});
			if (event.decision.kind === "branch") node.status = "branching";
			else if (event.decision.kind === "verify") node.status = "verifying";
			break;
		}
		case "branch_committed": {
			const node = nodeOf(state, event.candidateId, "branch_committed");
			if (node.status !== "branching")
				fault("branch_committed", `candidate ${node.id} is ${node.status}, not branching`);
			node.status = "branch_origin";
			graph.groups.set(event.groupId, {
				groupId: event.groupId,
				sourceId: event.candidateId,
				snapshotId: event.snapshotId,
				cursor: structuredClone(event.cursor),
				contextFingerprint: event.contextFingerprint,
				requestFingerprint: event.requestFingerprint,
				policyStateFingerprint: event.policyStateFingerprint,
				variants: event.variants.map((variant) => ({ ...variant })),
				childIds: [...event.childIds],
			});
			for (const childId of event.childIds) {
				graph.nodes.set(childId, {
					id: childId,
					parentId: event.candidateId,
					depth: node.depth + 1,
					conversation: {
						sessionId: EMPTY_NODE_PLACEHOLDER,
						lane: node.conversation.lane,
						continuationGroupId: event.groupId,
						cursor: structuredClone(event.cursor),
					},
					workspace: {
						snapshotId: event.snapshotId,
						snapshotFingerprint: event.snapshotFingerprint,
					},
					policyState: {
						basis: { ...structuredClone(node.policyState.basis), candidateId: childId },
						fingerprint: event.policyStateFingerprint,
					},
					belief: initialBelief(),
					cost: { providerCalls: 0, totalTokens: 0 },
					status: "provisioning",
					released: false,
				});
			}
			break;
		}
		case "candidate_provisioned": {
			const node = nodeOf(state, event.candidateId, "candidate_provisioned");
			if (node.status !== "provisioning") fault("candidate_provisioned", `candidate ${node.id} is ${node.status}`);
			node.conversation.sessionId = event.sessionId;
			node.conversation.lane = event.lane;
			node.conversation.operationId = event.operationId;
			node.conversation.basisEntryId = event.basisEntryId;
			if (event.cursor !== undefined) node.conversation.cursor = structuredClone(event.cursor);
			node.workspace.snapshotId = event.snapshotId;
			node.workspace.leaseId = event.leaseId;
			node.policyState = structuredClone(event.policyStateRef);
			node.belief = structuredClone(event.belief);
			node.status = "active";
			break;
		}
		case "verifier_planned": {
			const node = nodeOf(state, event.candidateId, "verifier_planned");
			node.pendingVerifier = { attemptId: event.attemptId, replay: event.replay };
			break;
		}
		case "verifier_settled": {
			const node = nodeOf(state, event.candidateId, "verifier_settled");
			node.belief = structuredClone(event.belief);
			node.verifierResult = {
				status: event.status,
				coverage: event.coverage,
				workspaceFingerprint: event.workspaceFingerprint,
				...(event.workspaceMutation === undefined ? {} : { mutation: { ...event.workspaceMutation } }),
			};
			node.pendingVerifier = undefined;
			const threshold = graph.coverageThreshold ?? 100;
			const eligible =
				event.status === "pass" &&
				event.workspaceMutation === undefined &&
				isEligibleVerified(event.belief, threshold);
			if (eligible && (node.status === "verifying" || node.status === "active")) {
				node.status = "verified";
			} else if (!eligible && node.settlement === "completed") {
				node.status = "failed";
				node.terminalReason =
					event.workspaceMutation !== undefined
						? "verifier mutated the workspace"
						: event.status === "pass"
							? "verifier pass below the coverage threshold"
							: `verifier ${event.status}`;
			}
			break;
		}
		case "candidate_terminal": {
			const node = nodeOf(state, event.candidateId, "candidate_terminal");
			if (node.status !== "winner") assertNotTerminal(node, "candidate_terminal");
			node.status = event.status;
			node.terminalReason = event.reason;
			// A demoted winner frees the winner slot for the next verified
			// candidate (promotion failed or rolled back).
			if (graph.winnerId === event.candidateId && event.status !== "winner") {
				graph.winnerId = undefined;
				graph.promotionAttemptId = undefined;
			}
			break;
		}
		case "candidate_release_started": {
			nodeOf(state, event.candidateId, "candidate_release_started");
			break;
		}
		case "candidate_released": {
			const node = nodeOf(state, event.candidateId, "candidate_released");
			node.released = true;
			break;
		}
		case "winner_selected": {
			if (graph.winnerId !== undefined) fault("winner_selected", "a winner is already selected");
			const node = nodeOf(state, event.winnerId, "winner_selected");
			node.status = "winner";
			graph.winnerId = event.winnerId;
			graph.promotionAttemptId = event.promotionAttemptId;
			break;
		}
		case "promotion_started": {
			if (graph.winnerId !== event.winnerId) fault("promotion_started", "winner does not match the selected winner");
			break;
		}
		case "promotion_settled": {
			if (graph.winnerId !== event.winnerId) fault("promotion_settled", "winner does not match the selected winner");
			break;
		}
		case "snapshot_released":
			graph.releasedSnapshots.add(event.snapshotId);
			break;
		case "task_terminal": {
			if (graph.status === "terminal") fault("task_terminal", "task is already terminal");
			graph.status = "terminal";
			graph.outcome = structuredClone(event.outcome);
			break;
		}
	}
	if (state.rootFlags.session && state.rootFlags.workspace && state.rootFlags.run) {
		const root = graph.nodes.get(graph.rootCandidateId ?? "");
		if (root !== undefined && root.status === "provisioning") root.status = "active";
	}
}

/** Pure fold of a journal event list into a task graph; replay-safe, fail-closed. */
export function foldTaskGraph(events: TaskJournalEvent[]): FoldedTaskGraph {
	const state: FoldState = {
		graph: {
			taskId: "",
			status: "planned",
			revision: 0,
			nodes: new Map(),
			groups: new Map(),
			lastDecisions: new Map(),
			releasedSnapshots: new Set(),
		},
		rootFlags: { session: false, workspace: false, run: false },
		seenKeys: new Map(),
		seenActions: new Map(),
	};
	let lastTaskId: string | undefined;
	for (const event of events) {
		if (state.graph.taskId === "") state.graph.taskId = event.taskId;
		if (event.taskId !== state.graph.taskId) fault("fold", "journal mixes multiple tasks");
		if (lastTaskId === undefined) {
			lastTaskId = event.taskId;
			if (event.type !== "task_planned") fault("fold", "the first journal event must be task_planned");
		}
		const key = taskJournalEventKey(event);
		const seenContent = state.seenKeys.get(key);
		if (seenContent !== undefined) {
			const content = eventContentKey(event);
			if (seenContent !== content) fault("fold", `event ${key} was already recorded with different content`);
			continue;
		}
		const expectedActionId = actionIdForEvent(event);
		if (event.actionId !== expectedActionId) {
			fault("fold", `event ${key} actionId ${event.actionId} is not the deterministic ${expectedActionId}`);
		}
		const seenAction = state.seenActions.get(event.actionId);
		if (seenAction !== undefined) {
			if (seenAction !== eventContentKey(event))
				fault("fold", `action ${event.actionId} replays with different content`);
			continue;
		}
		if (event.revision !== state.graph.revision + 1) {
			fault("fold", `event ${key} revision ${event.revision} is not ${state.graph.revision + 1}`);
		}
		applyEvent(state, event);
		state.graph.revision = event.revision;
		state.seenKeys.set(key, eventContentKey(event));
		state.seenActions.set(event.actionId, eventContentKey(event));
	}
	return state.graph;
}

export class CandidateGraph {
	private folded: FoldedTaskGraph;
	private readonly journal: AdaptiveTaskJournal;

	private constructor(journal: AdaptiveTaskJournal, folded: FoldedTaskGraph) {
		this.journal = journal;
		this.folded = folded;
	}

	static async open(journal: AdaptiveTaskJournal): Promise<CandidateGraph> {
		const events = await journal.events();
		return new CandidateGraph(journal, foldTaskGraph(events));
	}

	revision(): number {
		return this.folded.revision;
	}

	status(): FoldedTaskGraph["status"] {
		return this.folded.status;
	}

	outcome(): AdaptiveTaskOutcome | undefined {
		return this.folded.outcome === undefined ? undefined : structuredClone(this.folded.outcome);
	}

	/** Snapshot of the folded task graph; callers never touch live state. */
	snapshot(): FoldedTaskGraph {
		const clone: FoldedTaskGraph = {
			taskId: this.folded.taskId,
			status: this.folded.status,
			revision: this.folded.revision,
			nodes: new Map(),
			groups: new Map(),
			lastDecisions: new Map(),
			releasedSnapshots: new Set(this.folded.releasedSnapshots),
		};
		for (const [key, value] of this.folded.nodes) clone.nodes.set(key, structuredClone(value));
		for (const [key, value] of this.folded.groups) clone.groups.set(key, structuredClone(value));
		for (const [key, value] of this.folded.lastDecisions) clone.lastDecisions.set(key, structuredClone(value));
		if (this.folded.policyBundle !== undefined) clone.policyBundle = structuredClone(this.folded.policyBundle);
		if (this.folded.frozenModel !== undefined) clone.frozenModel = structuredClone(this.folded.frozenModel);
		if (this.folded.budget !== undefined) clone.budget = structuredClone(this.folded.budget);
		if (this.folded.deadlineMs !== undefined) clone.deadlineMs = this.folded.deadlineMs;
		if (this.folded.coverageThreshold !== undefined) clone.coverageThreshold = this.folded.coverageThreshold;
		if (this.folded.redundancyThreshold !== undefined) clone.redundancyThreshold = this.folded.redundancyThreshold;
		if (this.folded.profile !== undefined) clone.profile = structuredClone(this.folded.profile);
		if (this.folded.streamOptions !== undefined) clone.streamOptions = structuredClone(this.folded.streamOptions);
		if (this.folded.systemPrompt !== undefined) clone.systemPrompt = this.folded.systemPrompt;
		if (this.folded.workspace !== undefined) clone.workspace = structuredClone(this.folded.workspace);
		if (this.folded.rootCandidateId !== undefined) clone.rootCandidateId = this.folded.rootCandidateId;
		if (this.folded.rootSessionId !== undefined) clone.rootSessionId = this.folded.rootSessionId;
		if (this.folded.winnerId !== undefined) clone.winnerId = this.folded.winnerId;
		if (this.folded.promotionAttemptId !== undefined) clone.promotionAttemptId = this.folded.promotionAttemptId;
		if (this.folded.outcome !== undefined) clone.outcome = structuredClone(this.folded.outcome);
		return clone;
	}

	node(candidateId: string): CandidateNode | undefined {
		const node = this.folded.nodes.get(candidateId);
		return node === undefined ? undefined : structuredClone(node);
	}

	nodes(): CandidateNode[] {
		return [...this.folded.nodes.values()].map((node) => structuredClone(node));
	}

	lastDecision(candidateId: string): { decision: ControllerDecision; basis: { cursor?: LeafTurnCursor } } | undefined {
		const decision = this.folded.lastDecisions.get(candidateId);
		return decision === undefined ? undefined : structuredClone(decision);
	}

	/**
	 * Appends one transition. Validates revision/action id against the fold
	 * BEFORE the durable append so a conflicting event never enters the
	 * journal, then re-folds.
	 */
	async append(event: TaskJournalEvent): Promise<number> {
		const key = taskJournalEventKey(event);
		const events = await this.journal.events();
		// Pre-validate by folding the projected event list without appending:
		// a conflicting or mis-revisioned event never enters the journal. A
		// key-replay that leaves the fold unchanged is accepted as a no-op.
		const projectedFold = foldTaskGraph([...events, event]);
		if (projectedFold.revision !== event.revision && projectedFold.revision !== this.folded.revision) {
			throw new TaskGraphFault(`event ${key} did not advance the fold to its own revision ${event.revision}`);
		}
		await this.journal.append(event);
		const recorded = await this.journal.events();
		this.folded = foldTaskGraph(recorded);
		return this.folded.revision;
	}

	/** Eligible candidates in the deterministic winner tie-break order. */
	eligibleCandidates(requiredCoverage: number): CandidateNode[] {
		return [...this.folded.nodes.values()]
			.filter(
				(node) =>
					node.status === "verified" &&
					isEligibleVerified(node.belief, requiredCoverage) &&
					node.verifierResult?.mutation === undefined,
			)
			.sort(compareEligibleCandidates);
	}
}

/**
 * Deterministic winner tie-break (S8.4): verified, higher evidence coverage,
 * lower verification debt, fewer failures/redundant calls, lower token/call
 * cost, then the lexicographically smaller candidateId.
 */
export function compareEligibleCandidates(left: CandidateNode, right: CandidateNode): number {
	if (left.status !== right.status) return left.status === "verified" ? -1 : 1;
	if (left.belief.evidenceCoverage !== right.belief.evidenceCoverage) {
		return right.belief.evidenceCoverage - left.belief.evidenceCoverage;
	}
	if (left.belief.verificationDebt !== right.belief.verificationDebt) {
		return left.belief.verificationDebt - right.belief.verificationDebt;
	}
	const leftFailures = left.belief.failurePosterior + (left.lastEvidence?.redundantCalls ?? 0);
	const rightFailures = right.belief.failurePosterior + (right.lastEvidence?.redundantCalls ?? 0);
	if (leftFailures !== rightFailures) return leftFailures - rightFailures;
	if (left.cost.totalTokens !== right.cost.totalTokens) return left.cost.totalTokens - right.cost.totalTokens;
	if (left.cost.providerCalls !== right.cost.providerCalls) return left.cost.providerCalls - right.cost.providerCalls;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export interface GraphReconciliationFacts {
	sessionExists(sessionId: string): Promise<boolean>;
	workspaceSnapshot(snapshotId: string): Promise<{ fingerprint: string } | undefined>;
	/** True when the manager's own durable record shows the snapshot released. */
	snapshotReleased(snapshotId: string): Promise<boolean>;
	leaseStatus(leaseId: string): Promise<string | undefined>;
	continuationEvents(groupId: string): Promise<ContinuationJournalEvent[]>;
}

/**
 * Fail-closed reconciliation (S8.1): every durable identity referenced by the
 * graph must match Harness, ContinuationJournal and WorkspaceManager facts
 * before any new effect may be produced.
 */
export async function reconcileTaskGraph(graph: FoldedTaskGraph, facts: GraphReconciliationFacts): Promise<void> {
	for (const node of graph.nodes.values()) {
		const context = `candidate ${node.id}`;
		if (node.conversation.sessionId !== EMPTY_NODE_PLACEHOLDER && node.conversation.sessionId !== "") {
			if (!(await facts.sessionExists(node.conversation.sessionId))) {
				fault("reconcile", `${context} session ${node.conversation.sessionId} is missing from the repository`);
			}
		}
		if (node.workspace.snapshotId !== EMPTY_NODE_PLACEHOLDER && node.workspace.snapshotId !== "") {
			// A snapshot already recorded as released by either durable authority
			// (the task journal's snapshot_released, or the manager's own release
			// record, e.g. an auto-release during lease release) is legitimately
			// gone from the manager; the release record is itself the authority
			// alignment.
			const releasedByJournal = graph.releasedSnapshots.has(node.workspace.snapshotId);
			const releasedByManager = releasedByJournal || (await facts.snapshotReleased(node.workspace.snapshotId));
			if (!releasedByManager) {
				const snapshot = await facts.workspaceSnapshot(node.workspace.snapshotId);
				if (snapshot === undefined) {
					fault("reconcile", `${context} snapshot ${node.workspace.snapshotId} is missing from the manager`);
				}
				if (
					node.workspace.snapshotFingerprint !== undefined &&
					snapshot.fingerprint !== node.workspace.snapshotFingerprint
				) {
					fault("reconcile", `${context} snapshot fingerprint does not match the graph record`);
				}
			}
		}
		if (node.workspace.leaseId !== undefined && !node.released) {
			const status = await facts.leaseStatus(node.workspace.leaseId);
			if (status === "released" || status === "orphaned") {
				fault(
					"reconcile",
					`${context} lease ${node.workspace.leaseId} is ${status} but the candidate is not released`,
				);
			}
		}
		if (node.conversation.continuationGroupId !== undefined) {
			const group = graph.groups.get(node.conversation.continuationGroupId);
			if (group === undefined) fault("reconcile", `${context} group is not in the graph`);
			const events = await facts.continuationEvents(group.groupId);
			if (events.length === 0) {
				// The branch committed in the task journal but the fork has not
				// started yet (crash between branch_committed and forkExact):
				// every group child must still be provisioning.
				const siblings = [...graph.nodes.values()].filter(
					(candidate) => candidate.conversation.continuationGroupId === group.groupId,
				);
				if (!siblings.every((candidate) => candidate.status === "provisioning")) {
					fault("reconcile", `group ${group.groupId} has no continuation journal but is not fully provisioning`);
				}
				continue;
			}
			const byType = <T extends ContinuationJournalEvent["type"]>(
				type: T,
			): Extract<ContinuationJournalEvent, { type: T }>[] =>
				events.filter((event) => event.type === type) as Extract<ContinuationJournalEvent, { type: T }>[];
			if (byType("group_ready").length === 0) {
				fault("reconcile", `group ${group.groupId} has no group_ready in the continuation journal`);
			}
			// A still-provisioning child has no durable graph identity yet; its
			// journal records are verified once it is provisioned.
			if (node.status === "provisioning" && node.conversation.sessionId === EMPTY_NODE_PLACEHOLDER) continue;
			const forked = byType("child_session_forked").find((event) => event.childId === node.id);
			if (forked === undefined || forked.sessionId !== node.conversation.sessionId) {
				fault("reconcile", `${context} session identity does not match the continuation journal`);
			}
			const workspace = byType("child_workspace_ready").find((event) => event.childId === node.id);
			if (
				workspace === undefined ||
				workspace.leaseId !== node.workspace.leaseId ||
				workspace.snapshotId !== node.workspace.snapshotId
			) {
				fault("reconcile", `${context} workspace identity does not match the continuation journal`);
			}
			const run = byType("child_run_accepted").find((event) => event.childId === node.id);
			if (
				run === undefined ||
				run.operationId !== node.conversation.operationId ||
				run.basisEntryId !== node.conversation.basisEntryId
			) {
				fault("reconcile", `${context} run identity does not match the continuation journal`);
			}
		}
	}
}
