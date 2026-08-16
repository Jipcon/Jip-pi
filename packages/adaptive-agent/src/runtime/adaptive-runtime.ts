import type { AgentHarnessStreamOptions, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AdaptiveAgentLane,
	LaneLastResult,
	Session,
	SessionMetadata,
	SessionRepo,
} from "@earendil-works/pi-agent-core/harness-v4";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
	type AdaptiveTaskBudget,
	budgetExhaustion,
	scanCandidateUsage,
	type TaskBudgetFacts,
	taskBudgetFingerprint,
	validateAdaptiveTaskBudget,
	zeroBudgetFacts,
} from "./adaptive-task-budget.ts";
import { fingerprintBelief, fuseBelief, initialBelief } from "./belief-state.ts";
import {
	BranchContinuation,
	type ContinuationCandidate,
	type CreateChildHarness,
	exactContinuationGroupId,
} from "./branch-continuation.ts";
import { type BranchOriginRegistry, SessionRegisterBranchOriginRegistry } from "./branch-origin.ts";
import { BranchOriginBarrier } from "./branch-origin-barrier.ts";
import {
	CandidateGraph,
	type CandidateNode,
	deterministicActionId,
	type FoldedTaskGraph,
	reconcileTaskGraph,
	TaskGraphFault,
} from "./candidate-graph.ts";
import { initialCandidateState } from "./candidate-policy-state.ts";
import { CandidateTurnRunner, type CandidateTurnStep } from "./candidate-turn-runner.ts";
import { type ContinuationCheckpoint, captureContinuationCheckpoint } from "./continuation-checkpoint.ts";
import { type ContinuationJournal, continuationChildId } from "./continuation-journal.ts";
import { canonicalJsonLoose, type ExactRequestProfile } from "./exact-request.ts";
import type { ExecutionEnvironment, WorkspaceContinuationPort, WorkspaceSnapshot } from "./execution-environment.ts";
import {
	detectWorkspaceMutation,
	type HardVerifier,
	runHardVerifier,
	workspaceDiffFingerprint,
} from "./hard-verifier.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "./harness-leaf-turn-adapter.ts";
import type { CandidatePolicyStateRef, ExactSamplingVariant, ProjectionBasis } from "./harness-v4-contract.ts";
import type { LeafTurnCursor, LeafTurnResult, LeafTurnRunSettlement } from "./leaf-turn-executor.ts";
import { computeToolCatalogFingerprint, PROJECTOR_VERSION, sha256Hex } from "./policy-bundle.ts";
import type { PolicyRegistry } from "./policy-registry.ts";
import { type ControllerDecision, decideController } from "./rule-based-controller.ts";
import {
	type CandidateStateProjector,
	createOriginCapsule,
	CandidateStateProjector as ProjectorClass,
} from "./state-projector.ts";
import {
	type AdaptiveTaskJournal,
	type AdaptiveTaskOutcome,
	type TaskJournalEvent,
	taskJournalEventKey,
} from "./task-journal.ts";
import type { TrajectoryRecord, TrajectoryStore } from "./trajectory-store.ts";
import { sanitizeTrajectoryMetrics } from "./trajectory-store.ts";
import { ForegroundChangedError, PromotionConflictError } from "./workspace-errors.ts";
import type { WorkspaceLease, WorkspaceManager, WorkspaceSnapshotRef, WorkspaceVerifier } from "./workspace-manager.ts";

/**
 * Minimal Adaptive Runtime (Stage 8): foreground snapshot -> root candidate
 * -> turn-level control -> exact branch -> verifier/belief -> winner ->
 * strict promotion -> cleanup. Process-crash-safe: every transition is a
 * TaskJournal event with a graph revision and a deterministic action id, and
 * reopening folds + reconciles the graph against Harness, ContinuationJournal
 * and WorkspaceManager before any new effect.
 */

export class AdaptiveRuntimeFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AdaptiveRuntimeFault";
	}
}

/** Thrown after a journaled event when the crash-injection hook fires. */
export class SimulatedProcessCrash extends Error {
	readonly eventType: TaskJournalEvent["type"];

	constructor(eventType: TaskJournalEvent["type"]) {
		super(`simulated process crash after ${eventType}`);
		this.name = "SimulatedProcessCrash";
		this.eventType = eventType;
	}
}

export const DEFAULT_ADAPTIVE_PROFILE: ExactRequestProfile = {
	hookProfileVersion: "hooks-v1",
	resourceProfileVersion: "resources-v1",
	sampling: { temperature: 0.7, topP: 0.9, maxTokens: 4096 },
	seedCapable: false,
	contextPolicy: { version: "context-v1", projectionPolicy: "no-custom-projectors", compactionState: "none" },
};

export interface AdmitAdaptiveTaskInput {
	taskId: string;
	prompt: AgentMessage | AgentMessage[];
	policyBundle: { version: string; fingerprint: string };
	frozenModel: { provider: string; modelId: string };
	budget: AdaptiveTaskBudget;
	verifier: HardVerifier;
	systemPrompt: string;
	logicalRoot: string;
	profile?: ExactRequestProfile;
	streamOptions?: AgentHarnessStreamOptions;
	/** Required evidence coverage percent for winner eligibility (default 100). */
	coverageThreshold?: number;
	/** Redundant calls per turn that trigger the exact-branch rule (default 1). */
	redundancyThreshold?: number;
}

export interface CreateRootHarnessInput {
	session: Session;
	lease: WorkspaceLease;
	environment: ExecutionEnvironment;
}

export type CreateRootHarness = (
	input: CreateRootHarnessInput,
) => Promise<{ lane: AdaptiveAgentLane; close(): Promise<void> }>;

export interface MinimalAdaptiveRuntimeOptions {
	input: AdmitAdaptiveTaskInput;
	registry: PolicyRegistry;
	tools: AgentTool[];
	sessionRepo: SessionRepo<SessionMetadata, { id?: string; parentSessionId?: string }, { cwd?: string }>;
	workspaceManager: WorkspaceManager;
	workspaceSourceRoot: string;
	taskJournal: AdaptiveTaskJournal;
	continuationJournal: (groupId: string) => ContinuationJournal;
	createRootHarness: CreateRootHarness;
	createChildHarness: CreateChildHarness;
	projector?: CandidateStateProjector;
	trajectory?: TrajectoryStore;
	originRegistry?: BranchOriginRegistry;
	/** Foreground final verifier; defaults to the task hard verifier. */
	finalVerifier?: WorkspaceVerifier;
	now?: () => number;
	/** Crash injection: returning "crash" throws SimulatedProcessCrash after the append. */
	afterEvent?: (event: TaskJournalEvent) => "crash" | undefined;
}

interface CandidateWorker {
	candidateId: string;
	session: Session;
	lease: WorkspaceLease;
	/** Present only while the candidate run can still be driven. */
	lane?: AdaptiveAgentLane;
	runner?: CandidateTurnRunner;
	close: () => Promise<void>;
	/** Exact-continuation children: the source session owning the inherited usage rows. */
	parentSession?: Session;
}

/** Projects a lease snapshot onto the Stage 6 continuation port (never re-captures the foreground). */
export class LeaseWorkspaceContinuationPort implements WorkspaceContinuationPort {
	private readonly manager: WorkspaceManager;
	private readonly snapshotRef: WorkspaceSnapshotRef;

	constructor(options: { manager: WorkspaceManager; snapshot: WorkspaceSnapshotRef }) {
		this.manager = options.manager;
		this.snapshotRef = options.snapshot;
	}

	async snapshot(_source: unknown, _logicalRoot: string): Promise<WorkspaceSnapshot> {
		return {
			id: this.snapshotRef.id,
			logical: structuredClone(this.snapshotRef.logicalWorkspace),
			files: this.snapshotRef.files.map((file) => ({ ...file })),
		};
	}

	async fork(snapshotId: string, childId: string): Promise<WorkspaceLease> {
		const snapshot = await this.manager.findSnapshot(snapshotId);
		return this.manager.fork(snapshot, childId);
	}
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function addUsage(total: Usage, addition: Usage): void {
	total.input += addition.input;
	total.output += addition.output;
	total.cacheRead += addition.cacheRead;
	total.cacheWrite += addition.cacheWrite;
	total.totalTokens += addition.totalTokens;
	total.cost.input += addition.cost.input;
	total.cost.output += addition.cost.output;
	total.cost.cacheRead += addition.cost.cacheRead;
	total.cost.cacheWrite += addition.cost.cacheWrite;
	total.cost.total += addition.cost.total;
}

function aggregateUsageRows(rows: Array<{ usage: Usage }>): Usage {
	const total = structuredClone(ZERO_USAGE);
	for (const row of rows) addUsage(total, row.usage);
	return total;
}

function rootCandidateIdOf(taskId: string): string {
	return sha256Hex(`${taskId}:candidate:root`);
}

function rootSessionIdOf(taskId: string): string {
	return sha256Hex(`${taskId}:session:root`);
}

function promotionAttemptIdOf(lease: WorkspaceLease, snapshotId: string): string {
	return sha256Hex(`${lease.id}:${snapshotId}`);
}

function verifierAttemptIdOf(taskId: string, candidateId: string, index: number): string {
	return sha256Hex(`${taskId}:${candidateId}:verify:${index}`);
}

function branchVariantsOf(candidateId: string, seedCapable: boolean): ExactSamplingVariant[] {
	const first: ExactSamplingVariant = { id: `${candidateId}:v1` };
	const second: ExactSamplingVariant = { id: `${candidateId}:v2` };
	if (seedCapable) {
		first.seed = 1;
		second.seed = 2;
	}
	return [first, second];
}

async function reconstructLeafTurn(
	session: Session,
	operationId: string,
	assistantEntryId: string,
	leafId: string,
): Promise<LeafTurnResult> {
	const commit = await session.getTurnCommit({ assistantEntryId, leafId });
	if (commit === undefined) {
		throw new AdaptiveRuntimeFault(`turn commit ${assistantEntryId}/${leafId} is missing`);
	}
	const message = commit.assistantEntry.message;
	if (message.role !== "assistant") {
		throw new AdaptiveRuntimeFault(`turn ${assistantEntryId} has no assistant message`);
	}
	const toolResults = commit.toolResultEntries.map((entry) => entry.message);
	return {
		operationId,
		cursor: { operationId, assistantEntryId, leafId },
		beforeLeafId: null,
		afterLeafId: leafId,
		assistantEntryId,
		toolResultEntryIds: commit.toolResultEntries.map((entry) => entry.id),
		usageRowIds: commit.usageRows.map((row) => row.id),
		message: structuredClone(message as AssistantMessage),
		toolResults: structuredClone(toolResults as ToolResultMessage[]),
		usage: aggregateUsageRows(commit.usageRows),
	};
}

function settlementFromLastResult(
	last: LaneLastResult,
	finalMessage: AssistantMessage,
): LeafTurnRunSettlement | undefined {
	if (last.kind !== "run" || last.leafId === null || last.finalAssistantEntryId === undefined) return undefined;
	switch (last.outcome) {
		case "completed":
			return {
				kind: "completed",
				leafId: last.leafId,
				finalEntryId: last.finalAssistantEntryId,
				finalMessage: structuredClone(finalMessage),
			};
		case "aborted":
			return {
				kind: "aborted",
				leafId: last.leafId,
				finalEntryId: last.finalAssistantEntryId,
				finalMessage: structuredClone(finalMessage),
			};
		case "failed":
			return {
				kind: "failed",
				leafId: last.leafId,
				error: { code: "run_failed", message: last.error.message },
				finalEntryId: last.finalAssistantEntryId,
				finalMessage: structuredClone(finalMessage),
			};
		case "declined":
			return {
				kind: "failed",
				leafId: last.leafId,
				error: { code: "declined", message: "the run was declined before the crash" },
				finalEntryId: last.finalAssistantEntryId,
				finalMessage: structuredClone(finalMessage),
			};
	}
}

export class MinimalAdaptiveRuntime {
	private readonly options: MinimalAdaptiveRuntimeOptions;
	private readonly input: AdmitAdaptiveTaskInput;
	private readonly registry: PolicyRegistry;
	private readonly projector: CandidateStateProjector;
	private readonly originRegistry: BranchOriginRegistry;
	private readonly now: () => number;
	private graph: CandidateGraph | undefined;
	private readonly workers = new Map<string, CandidateWorker>();
	private readonly sessions = new Map<string, Session>();
	private trajectorySeq = 0;

	private constructor(options: MinimalAdaptiveRuntimeOptions) {
		this.options = options;
		this.input = options.input;
		this.registry = options.registry;
		this.projector = options.projector ?? new ProjectorClass({ registry: options.registry });
		this.originRegistry = options.originRegistry ?? new SessionRegisterBranchOriginRegistry();
		this.now = options.now ?? Date.now;
	}

	static async reopen(options: MinimalAdaptiveRuntimeOptions): Promise<MinimalAdaptiveRuntime> {
		const runtime = new MinimalAdaptiveRuntime(options);
		await runtime.initialize(true);
		return runtime;
	}

	private graphNow(): CandidateGraph {
		if (this.graph === undefined) throw new AdaptiveRuntimeFault("runtime is not initialized");
		return this.graph;
	}

	private async initialize(reconcile: boolean): Promise<void> {
		this.graph = await CandidateGraph.open(this.options.taskJournal);
		if (this.graph.status() === "planned") return;
		const snap = this.graph.snapshot();
		if (reconcile) await this.reconcile(snap);
		await this.rebuildWorkers(snap);
	}

	private async reconcile(snap: FoldedTaskGraph): Promise<void> {
		await reconcileTaskGraph(snap, {
			sessionExists: async (sessionId: string) =>
				(await this.options.sessionRepo.list()).some((metadata) => metadata.id === sessionId),
			workspaceSnapshot: async (snapshotId: string) => {
				try {
					const ref = await this.options.workspaceManager.findSnapshot(snapshotId);
					return { fingerprint: ref.fingerprint };
				} catch {
					return undefined;
				}
			},
			snapshotReleased: async (snapshotId: string) => this.options.workspaceManager.snapshotReleased(snapshotId),
			leaseStatus: async (leaseId: string) => {
				const backend = this.options.workspaceManager as WorkspaceManager & {
					leaseStatuses?: () => Map<string, { status: string }>;
				};
				return backend.leaseStatuses?.().get(leaseId)?.status;
			},
			continuationEvents: async (groupId: string) => this.options.continuationJournal(groupId).events(groupId),
		});
	}

	// ------------------------------------------------------------ lifecycle

	async run(): Promise<AdaptiveTaskOutcome> {
		if (this.graph === undefined) await this.initialize(false);
		while (true) {
			const snap = this.graphNow().snapshot();
			if (snap.status === "terminal") {
				await this.finalizeCleanup(snap);
				return snap.outcome ?? { kind: "no_verified_candidate", reason: "task terminal without outcome" };
			}
			if (snap.status === "planned") {
				await this.planTask();
				continue;
			}
			const candidate = this.nextCandidate(snap);
			if (candidate === undefined) {
				await this.settleWithoutWinner(snap);
				continue;
			}
			await this.driveCandidate(candidate);
		}
	}

	private async planTask(): Promise<void> {
		const input = this.input;
		const budgetInvalid = validateAdaptiveTaskBudget(input.budget);
		if (budgetInvalid !== undefined) throw new AdaptiveRuntimeFault(`invalid task budget: ${budgetInvalid}`);
		if (
			input.coverageThreshold !== undefined &&
			(!Number.isSafeInteger(input.coverageThreshold) ||
				input.coverageThreshold < 0 ||
				input.coverageThreshold > 100)
		) {
			throw new AdaptiveRuntimeFault("coverageThreshold must be an integer percent 0..100");
		}
		const bundle = await this.registry.resolve(input.policyBundle);
		const rootCandidateId = rootCandidateIdOf(input.taskId);
		const rootSessionId = rootSessionIdOf(input.taskId);
		const capsule = createOriginCapsule({
			taskId: input.taskId,
			candidateId: rootCandidateId,
			sessionId: rootSessionId,
			lane: "main",
			policyBundle: input.policyBundle,
			snapshot: initialCandidateState(
				bundle.rules.budgets.maxTurns,
				bundle.rules.budgets.maxToolCalls,
				bundle.rules.budgets.maxTokens,
			),
		});
		const rootPolicyStateRef: CandidatePolicyStateRef = { basis: capsule.basis, fingerprint: capsule.fingerprint };
		const at = this.now();
		const event: TaskJournalEvent = {
			type: "task_planned",
			taskId: input.taskId,
			revision: 1,
			actionId: deterministicActionId({
				taskId: input.taskId,
				revision: 1,
				type: "task_planned",
				target: input.taskId,
			}),
			at,
			policyBundle: { ...input.policyBundle },
			frozenModel: { ...input.frozenModel },
			budget: structuredClone(input.budget),
			workspace: { sourceRoot: this.options.workspaceSourceRoot, logicalRoot: input.logicalRoot },
			systemPrompt: input.systemPrompt,
			profile: structuredClone(input.profile ?? DEFAULT_ADAPTIVE_PROFILE),
			...(input.streamOptions === undefined ? {} : { streamOptions: structuredClone(input.streamOptions) }),
			coverageThreshold: input.coverageThreshold ?? 100,
			redundancyThreshold: input.redundancyThreshold ?? 1,
			deadlineMs: at + input.budget.maxWallClockMs,
			rootCandidateId,
			rootSessionId,
			rootPolicyStateRef,
		};
		await this.appendEvent(event);
	}

	private nextCandidate(snap: FoldedTaskGraph): CandidateNode | undefined {
		const rootCandidateId = snap.rootCandidateId;
		const nodes = [...snap.nodes.values()].filter((node) => {
			if (node.released) return false;
			if (node.pendingVerifier !== undefined) return true;
			if (node.status === "verifying") return true;
			if (node.status === "branching") return true;
			if (node.status === "branch_origin") {
				return [...snap.nodes.values()].some(
					(other) => other.parentId === node.id && other.status === "provisioning",
				);
			}
			if (node.status === "verified" || node.status === "winner") return true;
			if (node.status === "active") return true;
			if (node.status === "provisioning" && node.id === rootCandidateId) return true;
			return false;
		});
		nodes.sort((left, right) => {
			const priority = (node: CandidateNode): number => {
				if (node.pendingVerifier !== undefined) return 0;
				if (node.status === "verifying") return 1;
				if (node.status === "branching") return 2;
				if (node.status === "branch_origin") return 3;
				if (node.status === "provisioning") return 4;
				if (node.status === "verified" || node.status === "winner") return 5;
				return 6;
			};
			const delta = priority(left) - priority(right);
			if (delta !== 0) return delta;
			if (left.depth !== right.depth) return left.depth - right.depth;
			// Deterministic sibling order: the group's ordered variants
			// (v1 before v2), independent of the random child id ordering.
			const siblingIndex = (node: CandidateNode): number => {
				const group = [...snap.groups.values()].find((candidate) => candidate.childIds.includes(node.id));
				return group === undefined ? -1 : group.childIds.indexOf(node.id);
			};
			const leftSibling = siblingIndex(left);
			const rightSibling = siblingIndex(right);
			if (leftSibling !== rightSibling) return leftSibling - rightSibling;
			return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
		});
		return nodes[0];
	}

	private async driveCandidate(node: CandidateNode): Promise<void> {
		if (node.pendingVerifier !== undefined) {
			await this.resumeVerification(node);
			return;
		}
		if (node.status === "verifying") {
			await this.verifyFlow(node);
			return;
		}
		if (node.status === "branching" || node.status === "branch_origin") {
			await this.executeBranch(node);
			return;
		}
		if (node.status === "provisioning") {
			await this.provisionRoot();
			// The node stays "provisioning" until root_run_accepted: continue
			// straight into the first turn once the worker exists.
			if (this.workers.has(node.id)) {
				await this.driveTurn(node);
				return;
			}
			return;
		}
		if (node.status === "verified" || node.status === "winner") {
			await this.selectWinnerAndPromote();
			return;
		}
		const last = this.graphNow().lastDecision(node.id);
		if (last !== undefined && last.decision.kind !== "continue") {
			await this.resumeDecision(node, last.decision);
			return;
		}
		await this.driveTurn(node);
	}

	private async resumeDecision(node: CandidateNode, decision: ControllerDecision): Promise<void> {
		const worker = await this.buildWorker(node);
		switch (decision.kind) {
			case "branch":
				await this.executeBranch(node);
				return;
			case "verify":
				await this.verifyFlow(node);
				return;
			case "stop":
				await this.selectWinnerAndPromote();
				return;
			case "suspend":
				await this.appendCandidateTerminal(node.id, "failed", decision.reason);
				await this.finishTask({ kind: "suspended", reason: decision.reason });
				return;
			case "prune":
				await this.pruneCandidate(node, worker, decision.reason);
				return;
			case "fault":
				throw new AdaptiveRuntimeFault(`controller faulted candidate ${node.id}: ${decision.reason}`);
			case "continue":
				return;
		}
	}

	// ------------------------------------------------------------ workers

	private async provisionRoot(): Promise<void> {
		const snap = this.graphNow().snapshot();
		const rootCandidateId = snap.rootCandidateId;
		if (rootCandidateId === undefined) throw new AdaptiveRuntimeFault("task has no root candidate");
		const rootNode = snap.nodes.get(rootCandidateId);
		if (rootNode === undefined) throw new AdaptiveRuntimeFault("root candidate node is missing");
		// Idempotent within one process: the node stays "provisioning" until
		// root_run_accepted, and every drive of a provisioning root must not
		// reopen the already-open session or fork a second lease.
		if (this.workers.has(rootCandidateId)) return;
		const rootSessionId = snap.rootSessionId ?? rootSessionIdOf(snap.taskId);

		let session: Session;
		if (rootNode.conversation.sessionId !== "" && rootNode.conversation.sessionId !== "pending") {
			session = await this.openSession(rootNode.conversation.sessionId);
		} else {
			try {
				session = await this.options.sessionRepo.create({ id: rootSessionId });
			} catch (error) {
				if ((error as { code?: string }).code === "already_exists") {
					session = await this.openSession(rootSessionId);
				} else {
					throw error;
				}
			}
			await this.appendEvent({
				type: "root_session_ready",
				taskId: snap.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: snap.taskId,
					revision: this.graphNow().revision() + 1,
					type: "root_session_ready",
					target: `candidate:${rootCandidateId}`,
				}),
				at: this.now(),
				candidateId: rootCandidateId,
				sessionId: session.metadata.id,
				lane: "main",
			});
		}

		const afterSession = this.graphNow().snapshot().nodes.get(rootCandidateId)!;
		let snapshot: WorkspaceSnapshotRef;
		let lease: WorkspaceLease;
		if (afterSession.workspace.snapshotId !== "" && afterSession.workspace.snapshotId !== "pending") {
			snapshot = await this.options.workspaceManager.findSnapshot(afterSession.workspace.snapshotId);
			lease = await this.options.workspaceManager.fork(snapshot, rootCandidateId);
		} else {
			snapshot = await this.options.workspaceManager.capture({
				sourceRoot: this.options.workspaceSourceRoot,
				logicalRoot: this.input.logicalRoot,
			});
			lease = await this.options.workspaceManager.fork(snapshot, rootCandidateId);
			await this.appendEvent({
				type: "root_workspace_ready",
				taskId: snap.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: snap.taskId,
					revision: this.graphNow().revision() + 1,
					type: "root_workspace_ready",
					target: `candidate:${rootCandidateId}`,
				}),
				at: this.now(),
				candidateId: rootCandidateId,
				snapshotId: snapshot.id,
				snapshotFingerprint: snapshot.fingerprint,
				leaseId: lease.id,
			});
		}

		this.sessions.set(rootCandidateId, session);
		this.sessions.set(session.metadata.id, session);
		const created = await this.options.createRootHarness({ session, lease, environment: lease.environment });
		const runner = new CandidateTurnRunner({
			session,
			lane: created.lane,
			registry: this.registry,
			projector: this.projector,
			executorFactory: (basis: HarnessV4LeafTurnBasis) =>
				new HarnessV4LeafTurnAdapter({ lane: created.lane, basis }),
			tools: this.options.tools,
			workspaceRoot: lease.root,
			task: {
				taskId: snap.taskId,
				candidateId: rootCandidateId,
				policyBundle: snap.policyBundle ?? this.input.policyBundle,
				frozenModel: snap.frozenModel ?? this.input.frozenModel,
			},
			originGuard: async () => {
				await new BranchOriginBarrier({
					session,
					lane: "main",
					registry: this.originRegistry,
				}).assertAvailable();
			},
		});
		this.workers.set(rootCandidateId, {
			candidateId: rootCandidateId,
			session,
			lane: created.lane,
			lease,
			runner,
			close: created.close,
		});
	}

	private async buildWorker(node: CandidateNode): Promise<CandidateWorker> {
		const existing = this.workers.get(node.id);
		if (existing !== undefined) return existing;
		const snap = this.graphNow().snapshot();
		if (node.id === snap.rootCandidateId) {
			await this.provisionRoot();
			const worker = this.workers.get(node.id);
			if (worker === undefined) throw new AdaptiveRuntimeFault("root worker did not build");
			return worker;
		}
		// A settled child run can no longer be driven: the lane is idle and
		// BranchContinuation cannot reattach it. Verification re-runs, winner
		// consistency checks and promotion only need the lease and session.
		if (node.settlement !== undefined) {
			const session = await this.openSession(node.conversation.sessionId);
			const lease = await this.options.workspaceManager.fork(
				await this.options.workspaceManager.findSnapshot(node.workspace.snapshotId),
				node.id,
			);
			const parentSession =
				node.parentId === undefined
					? undefined
					: await this.openSession(snap.nodes.get(node.parentId)!.conversation.sessionId);
			const worker: CandidateWorker = {
				candidateId: node.id,
				session,
				lease,
				close: async () => undefined,
				parentSession,
			};
			this.workers.set(node.id, worker);
			return worker;
		}
		// Continuation child: reattach through BranchContinuation.
		const parentId = node.parentId;
		if (parentId === undefined) throw new AdaptiveRuntimeFault(`candidate ${node.id} has no parent`);
		const parent = snap.nodes.get(parentId);
		if (parent === undefined) throw new AdaptiveRuntimeFault(`candidate ${node.id} parent ${parentId} is missing`);
		const { checkpoint, group } = await this.rebuildCheckpoint(snap, parent);
		const candidates = await this.forkGroup(checkpoint, group.groupId);
		const candidate = candidates.find((item) => item.childId === node.id);
		if (candidate === undefined) {
			throw new AdaptiveRuntimeFault(`group ${group.groupId} does not contain child ${node.id}`);
		}
		return this.attachChildWorker(candidate);
	}

	private async rebuildWorkers(snap: FoldedTaskGraph): Promise<void> {
		for (const node of snap.nodes.values()) {
			if (node.released) continue;
			if (node.conversation.sessionId === "" || node.conversation.sessionId === "pending") continue;
			const session = await this.openSession(node.conversation.sessionId);
			this.sessions.set(node.id, session);
		}
	}

	private async openSession(sessionId: string): Promise<Session> {
		const existing = this.sessions.get(sessionId);
		if (existing !== undefined) return existing;
		const metadata = (await this.options.sessionRepo.list()).find((item) => item.id === sessionId);
		if (metadata === undefined) throw new AdaptiveRuntimeFault(`session ${sessionId} is missing`);
		const session = await this.options.sessionRepo.open(metadata);
		this.sessions.set(sessionId, session);
		return session;
	}

	// ------------------------------------------------------------ turns

	private async driveTurn(node: CandidateNode): Promise<void> {
		const worker = await this.buildWorker(node);
		const facts = await this.budgetFacts();
		if (budgetExhaustion(facts) !== undefined) {
			const exhaustion = budgetExhaustion(facts)!;
			await this.resumeDecision(node, {
				kind: "prune",
				reason: `task budget ${exhaustion.budget} exhausted`,
				budget: exhaustion.budget,
			});
			return;
		}
		const { step, firstRootStart } = await this.nextTurnStep(node, worker);
		if (firstRootStart && step.kind === "turn") {
			const basisEntry = await this.latestRunBasisEntry(worker.session);
			await this.appendEvent({
				type: "root_run_accepted",
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					type: "root_run_accepted",
					target: `candidate:${node.id}`,
				}),
				at: this.now(),
				candidateId: node.id,
				operationId: step.observation.turn.operationId,
				basisEntryId: basisEntry,
			});
		}
		await this.handleTurnStep(node, worker, step);
	}

	private async nextTurnStep(
		node: CandidateNode,
		worker: CandidateWorker,
	): Promise<{ step: CandidateTurnStep; firstRootStart: boolean }> {
		const open = await worker.lane!.getOpenOperation();
		if (open !== null && open.kind === "run" && open.turnCursor !== null) {
			const observed = node.conversation.cursor;
			if (
				observed !== undefined &&
				observed.operationId === open.operationId &&
				observed.assistantEntryId === open.turnCursor.assistantEntryId &&
				this.decisionCoversCursor(node.id, observed)
			) {
				return { step: (await worker.runner!.advance(observed)).step, firstRootStart: false };
			}
			const turn = await reconstructLeafTurn(
				worker.session,
				open.operationId,
				open.turnCursor.assistantEntryId,
				open.turnCursor.leafId,
			);
			return { step: await worker.runner!.observeTurn({ turn }), firstRootStart: false };
		}
		if (open === null) {
			const last = await worker.lane!.getLastResult();
			if (last !== undefined) {
				const turn = await reconstructLeafTurn(
					worker.session,
					last.operationId,
					last.finalAssistantEntryId!,
					last.leafId!,
				);
				const settlement = settlementFromLastResult(last, turn.message);
				if (settlement !== undefined) {
					return { step: await worker.runner!.observeTurn({ turn, settlement }), firstRootStart: false };
				}
			}
			if (node.conversation.operationId === undefined && node.id === this.graphNow().snapshot().rootCandidateId) {
				return { step: (await worker.runner!.start(this.input.prompt)).step, firstRootStart: true };
			}
		}
		return { step: (await worker.runner!.advance()).step, firstRootStart: false };
	}

	/**
	 * A parked turn may only be advanced past when its controller decision is
	 * already durable; after a crash between the observation and the decision
	 * the turn is re-observed and re-decided without a new provider request.
	 */
	private decisionCoversCursor(candidateId: string, cursor: LeafTurnCursor): boolean {
		const decision = this.graphNow().lastDecision(candidateId);
		const basisCursor = decision?.basis?.cursor;
		return (
			decision !== undefined &&
			basisCursor !== undefined &&
			basisCursor.operationId === cursor.operationId &&
			basisCursor.assistantEntryId === cursor.assistantEntryId
		);
	}

	private async latestRunBasisEntry(session: Session): Promise<string> {
		const matches = await session.findEntries({ customType: "adaptive.run_basis", order: "desc", limit: 1 });
		const entry = matches[0];
		if (entry === undefined || entry.type !== "custom") {
			throw new AdaptiveRuntimeFault("no adaptive.run_basis entry after the root run start");
		}
		return entry.id;
	}

	private async handleTurnStep(node: CandidateNode, worker: CandidateWorker, step: CandidateTurnStep): Promise<void> {
		switch (step.kind) {
			case "turn": {
				const observation = step.observation;
				const fresh = this.graphNow().snapshot().nodes.get(node.id);
				const belief = fuseBelief(fresh?.belief ?? node.belief, {
					turn: {
						redundantCalls: observation.evidence.redundantCalls,
						failureFingerprints: [...observation.evidence.failureFingerprints],
						verificationAttempts: observation.evidence.verificationAttempts,
						verificationSuccesses: observation.evidence.verificationSuccesses,
					},
					verificationDebt: observation.capsule.snapshot.verification.debt,
				});
				await this.appendEvent({
					type: "candidate_turn_observed",
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					actionId: deterministicActionId({
						taskId: this.input.taskId,
						revision: this.graphNow().revision() + 1,
						type: "candidate_turn_observed",
						target: `candidate:${node.id}`,
					}),
					at: this.now(),
					candidateId: node.id,
					operationId: observation.turn.operationId,
					cursor: structuredClone(observation.turn.cursor),
					policyStateRef: {
						basis: structuredClone(observation.capsule.basis),
						fingerprint: observation.capsule.fingerprint,
					},
					belief,
					cost: { providerCalls: 1, totalTokens: observation.turn.usage.totalTokens },
					evidence: structuredClone(observation.evidence),
					...(observation.settlement === undefined ? {} : { settlement: observation.settlement.kind }),
				});
				this.appendTrajectory({
					kind: "task",
					taskId: this.input.taskId,
					candidateId: node.id,
					sessionId: worker.session.metadata.id,
					operationId: observation.turn.operationId,
					metrics: { turn: true, stateFingerprint: observation.capsule.fingerprint },
				});
				const freshNode = this.graphNow().snapshot().nodes.get(node.id)!;
				await this.decideAndApply(freshNode, {
					settled: observation.settlement?.kind,
					lastTurnFailures: observation.evidence.failureFingerprints.length,
					lastTurnRedundancy: observation.evidence.redundantCalls,
				});
				return;
			}
			case "suspended": {
				await this.appendCandidateTerminal(node.id, "failed", `run suspended: ${step.operation.reason}`);
				await this.finishTask({ kind: "suspended", reason: step.operation.reason });
				return;
			}
			case "policy_fault":
			case "projection_fault":
				throw new AdaptiveRuntimeFault(`candidate ${node.id} ${step.kind}: ${step.message}`);
			case "model_drift":
				throw new AdaptiveRuntimeFault(`candidate ${node.id} model drifted: ${step.message}`);
			case "budget_exhausted": {
				await this.resumeDecision(node, {
					kind: "prune",
					reason: `candidate bundle budget ${step.budget} exhausted`,
				});
				return;
			}
			case "rejected": {
				await this.resumeDecision(node, { kind: "prune", reason: `drive rejected: ${step.message}` });
				return;
			}
		}
	}

	// ------------------------------------------------------------ controller

	private async decideAndApply(
		node: CandidateNode,
		extra: { settled?: "completed" | "failed" | "aborted"; lastTurnFailures: number; lastTurnRedundancy: number },
	): Promise<void> {
		const snap = this.graphNow().snapshot();
		const facts = await this.budgetFacts();
		const eligible = this.graphNow().eligibleCandidates(snap.coverageThreshold ?? 100);
		const decision = decideController({
			graphRevision: snap.revision,
			candidateId: node.id,
			cursor: node.conversation.cursor,
			policyStateFingerprint: node.policyState.fingerprint,
			beliefFingerprint: fingerprintBelief(node.belief),
			budgetFingerprint: taskBudgetFingerprint(facts),
			policyBundle: snap.policyBundle ?? this.input.policyBundle,
			settled: extra.settled,
			belief: node.belief,
			lastTurnFailures: extra.lastTurnFailures,
			lastTurnRedundancy: extra.lastTurnRedundancy,
			branchVariants: branchVariantsOf(node.id, (snap.profile ?? DEFAULT_ADAPTIVE_PROFILE).seedCapable),
			canBranch: this.canBranch(node),
			eligibleVerifiedExists: eligible.length > 0,
			continueValueBps:
				node.settlement !== undefined ||
				(eligible.length > 0 && !eligible.some((candidate) => candidate.id === node.id))
					? 0
					: node.belief.pathValue.high,
			redundancyThreshold: snap.redundancyThreshold ?? 1,
			budget: facts,
			exhaustion: budgetExhaustion(facts),
		});
		await this.applyDecision(node, decision);
	}

	private canBranch(node: CandidateNode): boolean {
		const snap = this.graphNow().snapshot();
		const budget = snap.budget;
		if (budget === undefined) return false;
		const total = snap.nodes.size;
		const active = [...snap.nodes.values()].filter((candidate) => !isTerminalStatus(candidate.status)).length;
		return (
			total + 2 <= budget.maxTotalCandidates &&
			active + 2 <= budget.maxActiveCandidates &&
			node.depth + 1 <= budget.maxBranchDepth
		);
	}

	private async applyDecision(node: CandidateNode, decision: ControllerDecision): Promise<void> {
		await this.appendEvent({
			type: "controller_decided",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "controller_decided",
				target: `candidate:${node.id}`,
			}),
			at: this.now(),
			candidateId: node.id,
			decision: structuredClone(decision) as ControllerDecision,
			basis: {
				policyStateFingerprint: node.policyState.fingerprint,
				beliefFingerprint: fingerprintBelief(node.belief),
				budgetFingerprint: taskBudgetFingerprint(await this.budgetFacts()),
				policyBundle: this.graphNow().snapshot().policyBundle ?? this.input.policyBundle,
				...(node.conversation.cursor === undefined ? {} : { cursor: structuredClone(node.conversation.cursor) }),
			},
		});
		await this.resumeDecision(node, decision);
	}

	private async pruneCandidate(node: CandidateNode, worker: CandidateWorker, reason: string): Promise<void> {
		await this.appendCandidateTerminal(node.id, "pruned", reason);
		await this.releaseWorker(worker);
	}

	// ------------------------------------------------------------ branching

	private async executeBranch(node: CandidateNode): Promise<void> {
		const snap = this.graphNow().snapshot();
		const groupRecord = [...snap.groups.values()].find((group) => group.sourceId === node.id);
		let checkpoint: ContinuationCheckpoint;
		let groupId: string;
		if (groupRecord !== undefined) {
			checkpoint = (await this.rebuildCheckpoint(snap, node)).checkpoint;
			groupId = groupRecord.groupId;
		} else {
			const worker = await this.buildWorker(node);
			const leaseSnapshot = await this.options.workspaceManager.snapshot(worker.lease);
			const port = new LeaseWorkspaceContinuationPort({
				manager: this.options.workspaceManager,
				snapshot: leaseSnapshot,
			});
			const captured = await captureContinuationCheckpoint({
				lane: worker.lane!,
				session: worker.session,
				projector: this.projector,
				workspacePort: port,
				workspaceMetadata: { files: [] },
				logicalRoot: this.input.logicalRoot,
				tools: this.options.tools,
				systemPrompt: this.input.systemPrompt,
				streamOptions: this.input.streamOptions ?? {},
				profile: snap.profile ?? DEFAULT_ADAPTIVE_PROFILE,
				entryProjectors: {},
			});
			if (!captured.ok) {
				throw new AdaptiveRuntimeFault(
					`checkpoint capture failed for candidate ${node.id}: ${captured.error.message}`,
				);
			}
			checkpoint = captured.value;
			const profile = snap.profile ?? DEFAULT_ADAPTIVE_PROFILE;
			const variants = branchVariantsOf(node.id, profile.seedCapable);
			groupId = exactContinuationGroupId(checkpoint, variants);
			const childIds = variants.map((_variant, index) => continuationChildId(groupId, index));
			await this.appendEvent({
				type: "branch_committed",
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					type: "branch_committed",
					target: `branch:${node.id}:${groupId}`,
				}),
				at: this.now(),
				candidateId: node.id,
				groupId,
				snapshotId: checkpoint.workspaceSnapshotId,
				snapshotFingerprint: checkpoint.workspaceFingerprint,
				logicalRoot: checkpoint.logicalWorkspace.root,
				contentFingerprint: checkpoint.logicalWorkspace.contentFingerprint,
				cursor: structuredClone(checkpoint.cursor),
				contextFingerprint: checkpoint.contextFingerprint,
				requestFingerprint: checkpoint.requestFingerprint,
				policyStateFingerprint: checkpoint.policyState.fingerprint,
				variants: variants.map((variant) => ({ ...variant })),
				childIds,
			});
		}
		const candidates = await this.forkGroup(checkpoint, groupId);
		await this.provisionChildren(node, candidates);
	}

	private async forkGroup(checkpoint: ContinuationCheckpoint, groupId: string): Promise<ContinuationCandidate[]> {
		const snap = this.graphNow().snapshot();
		const group = snap.groups.get(groupId);
		if (group === undefined) throw new AdaptiveRuntimeFault(`group ${groupId} is not in the graph`);
		const port = new LeaseWorkspaceContinuationPort({
			manager: this.options.workspaceManager,
			snapshot: await this.options.workspaceManager.findSnapshot(group.snapshotId),
		});
		const sourceSession = await this.openSession(checkpoint.sourceSessionId);
		const branch = new BranchContinuation({
			journal: this.options.continuationJournal(groupId),
			workspacePort: port,
			sessionRepo: this.options.sessionRepo,
			createChildHarness: this.options.createChildHarness,
			originRegistry: this.originRegistry,
			sourceSession,
			openSession: (sessionId) => this.openSession(sessionId),
		});
		const forked = await branch.forkExact(
			checkpoint,
			group.variants.map((variant) => ({ ...variant })),
		);
		if (!forked.ok) {
			throw new AdaptiveRuntimeFault(
				`exact branch of group ${groupId} failed: ${forked.error.name}: ${forked.error.message}`,
			);
		}
		return forked.value;
	}

	private async provisionChildren(source: CandidateNode, candidates: ContinuationCandidate[]): Promise<void> {
		for (const candidate of candidates) {
			const fresh = this.graphNow().snapshot().nodes.get(candidate.childId);
			if (fresh !== undefined && fresh.status !== "provisioning") continue;
			const checkpoint = candidate.checkpoint;
			const policyBasis: ProjectionBasis = {
				...structuredClone(checkpoint.policyState.basis),
				candidateId: candidate.childId,
			};
			const policyStateRef: CandidatePolicyStateRef = {
				basis: policyBasis,
				fingerprint: checkpoint.policyState.fingerprint,
			};
			await this.attachChildWorker(candidate);
			const lease = candidate.workspaceLease as unknown as WorkspaceLease;
			await this.appendEvent({
				type: "candidate_provisioned",
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					type: "candidate_provisioned",
					target: `candidate:${candidate.childId}`,
				}),
				at: this.now(),
				candidateId: candidate.childId,
				parentId: source.id,
				depth: source.depth + 1,
				continuationGroupId: candidate.groupId,
				sessionId: candidate.session.metadata.id,
				lane: candidate.lane,
				snapshotId: lease.snapshotId,
				leaseId: lease.id,
				operationId: candidate.acceptedRun.operationId,
				basisEntryId: candidate.acceptedRun.basisEntryId,
				cursor: structuredClone(candidate.cursor),
				policyStateRef,
				belief: initialBelief(),
			});
		}
	}

	private async attachChildWorker(candidate: ContinuationCandidate): Promise<CandidateWorker> {
		const childBasis: HarnessV4LeafTurnBasis = {
			schemaVersion: 1,
			taskId: candidate.checkpoint.policyState.basis.taskId,
			candidateId: candidate.childId,
			policyBundle: structuredClone(candidate.checkpoint.policyState.basis.policyBundle),
			projectorVersion: candidate.checkpoint.policyState.basis.projectorVersion,
			inheritedPolicyState: structuredClone(candidate.checkpoint.policyState),
			start: {
				kind: "exact_continuation",
				source: {
					parentSessionId: candidate.checkpoint.sourceSessionId,
					sourceCursor: structuredClone(candidate.checkpoint.cursor),
				},
				contextFingerprint: candidate.checkpoint.contextFingerprint,
				requestFingerprint: candidate.checkpoint.requestFingerprint,
				fixedToolCatalogFingerprint: candidate.checkpoint.fixedToolCatalogFingerprint,
				sampling: structuredClone(candidate.variant),
			},
		};
		const snap = this.graphNow().snapshot();
		const lease = candidate.workspaceLease as unknown as WorkspaceLease;
		const parentSession = await this.openSession(candidate.checkpoint.sourceSessionId);
		const runner = new CandidateTurnRunner({
			session: candidate.session,
			lane: candidate.laneHandle,
			registry: this.registry,
			projector: this.projector,
			executor: candidate.executor,
			tools: this.options.tools,
			workspaceRoot: lease.root,
			task: {
				taskId: snap.taskId,
				candidateId: candidate.childId,
				policyBundle: snap.policyBundle ?? this.input.policyBundle,
				frozenModel: snap.frozenModel ?? this.input.frozenModel,
			},
			inheritedBasis: childBasis,
			inheritedUsageSource: parentSession,
		});
		const worker: CandidateWorker = {
			candidateId: candidate.childId,
			session: candidate.session,
			lane: candidate.laneHandle,
			lease,
			runner,
			close: candidate.close,
			parentSession,
		};
		this.workers.set(candidate.childId, worker);
		this.sessions.set(candidate.childId, candidate.session);
		this.sessions.set(candidate.session.metadata.id, candidate.session);
		return worker;
	}

	private async rebuildCheckpoint(
		snap: FoldedTaskGraph,
		source: CandidateNode,
	): Promise<{
		checkpoint: ContinuationCheckpoint;
		group: FoldedTaskGraph["groups"] extends Map<string, infer T> ? T : never;
	}> {
		const group = [...snap.groups.values()].find((candidate) => candidate.sourceId === source.id);
		if (group === undefined) throw new AdaptiveRuntimeFault(`candidate ${source.id} has no continuation group`);
		const sourceSession = await this.openSession(source.conversation.sessionId);
		const basis: ProjectionBasis = {
			taskId: snap.taskId,
			candidateId: source.id,
			sessionId: source.conversation.sessionId,
			lane: source.conversation.lane,
			operationId: group.cursor.operationId,
			cursor: { kind: "post_turn", cursor: structuredClone(group.cursor) },
			policyBundle: snap.policyBundle ?? this.input.policyBundle,
			projectorVersion: PROJECTOR_VERSION,
			inheritedStateFingerprint: source.policyState.basis.inheritedStateFingerprint,
		};
		const capsule = await this.projector.project(basis, { session: sourceSession });
		if (capsule.fingerprint !== group.policyStateFingerprint) {
			throw new AdaptiveRuntimeFault(
				`group ${group.groupId} policy state reconstructs to ${capsule.fingerprint}, not the recorded ${group.policyStateFingerprint}`,
			);
		}
		const snapshotRef = await this.options.workspaceManager.findSnapshot(group.snapshotId);
		const checkpoint: ContinuationCheckpoint = {
			sourceSessionId: source.conversation.sessionId,
			sourceLane: source.conversation.lane,
			cursor: structuredClone(group.cursor),
			workspaceSnapshotId: group.snapshotId,
			workspaceFingerprint: snapshotRef.fingerprint,
			logicalWorkspace: structuredClone(snapshotRef.logicalWorkspace),
			contextFingerprint: group.contextFingerprint,
			requestFingerprint: group.requestFingerprint,
			policyState: structuredClone(capsule),
			fixedToolCatalogFingerprint: computeToolCatalogFingerprint(this.options.tools),
			resolvedSystemPrompt: this.input.systemPrompt,
			model: snap.frozenModel ?? this.input.frozenModel,
			profile: structuredClone(snap.profile ?? DEFAULT_ADAPTIVE_PROFILE),
		};
		return { checkpoint, group };
	}

	// ------------------------------------------------------------ verification

	private async verifyFlow(node: CandidateNode): Promise<void> {
		const attemptIndex = node.belief.requestedEvidence;
		const attemptId = verifierAttemptIdOf(this.input.taskId, node.id, attemptIndex);
		const verifier = this.input.verifier;
		await this.appendEvent({
			type: "verifier_planned",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "verifier_planned",
				target: `candidate:${node.id}`,
			}),
			at: this.now(),
			candidateId: node.id,
			attemptId,
			verifierId: verifier.id,
			verifierVersion: verifier.version,
			replay: verifier.replay,
		});
		await this.runVerification(node, attemptId);
	}

	private async resumeVerification(node: CandidateNode): Promise<void> {
		const pending = node.pendingVerifier;
		if (pending === undefined) return;
		if (pending.replay === "safe") {
			await this.runVerification(node, pending.attemptId);
		} else {
			await this.settleVerification(node, pending.attemptId, "interrupted", 0, 0, {
				hash: sha256Hex(""),
				length: 0,
				prefix: "interrupted",
			});
		}
	}

	private async runVerification(node: CandidateNode, attemptId: string): Promise<void> {
		const worker = await this.buildWorker(node);
		const before = await this.options.workspaceManager.diff(worker.lease);
		const controller = new AbortController();
		const result = await runHardVerifier({
			verifier: this.input.verifier,
			taskId: this.input.taskId,
			candidateId: node.id,
			cwd: worker.lease.root,
			signal: controller.signal,
		});
		const after = await this.options.workspaceManager.diff(worker.lease);
		const mutation = detectWorkspaceMutation(before, after);
		this.appendTrajectory({
			kind: "evaluator_evidence",
			taskId: this.input.taskId,
			candidateId: node.id,
			sessionId: worker.session.metadata.id,
			operationId: "",
			metrics: { verifierId: this.input.verifier.id, status: result.status, coverage: result.coverage },
		});
		await this.settleVerification(
			node,
			attemptId,
			result.status,
			result.coverage,
			result.durationMs,
			result.summary,
			{
				workspaceFingerprint: workspaceDiffFingerprint(after),
				...(mutation === undefined ? {} : { workspaceMutation: mutation }),
			},
		);
	}

	private async settleVerification(
		node: CandidateNode,
		attemptId: string,
		status: "pass" | "fail" | "interrupted",
		coverage: number,
		durationMs: number,
		summary: { hash: string; length: number; prefix: string },
		extra: {
			workspaceFingerprint?: string;
			workspaceMutation?: { kind: "tracked" | "untracked" | "both"; detail: string };
		} = {},
	): Promise<void> {
		const fresh = this.graphNow().snapshot().nodes.get(node.id) ?? node;
		const effectiveStatus: "pass" | "fail" | "interrupted" =
			extra.workspaceMutation !== undefined && status === "pass" ? "fail" : status;
		// A hard-verifier pass verifies the whole candidate workspace, so it
		// clears the accumulated verification debt; a fail/interruption keeps
		// the debt in place.
		const belief = fuseBelief(fresh.belief, {
			verifier: { effectiveStatus, coverage },
			verificationDebt: effectiveStatus === "pass" ? 0 : fresh.belief.verificationDebt,
			requestedEvidence: true,
		});
		await this.appendEvent({
			type: "verifier_settled",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "verifier_settled",
				target: `candidate:${node.id}`,
			}),
			at: this.now(),
			candidateId: node.id,
			attemptId,
			status,
			coverage,
			durationMs,
			summary: { ...summary },
			workspaceFingerprint: extra.workspaceFingerprint ?? "",
			...(extra.workspaceMutation === undefined ? {} : { workspaceMutation: { ...extra.workspaceMutation } }),
			belief,
		});
	}

	// ------------------------------------------------------------ winner + promotion

	private async selectWinnerAndPromote(): Promise<void> {
		while (true) {
			const snap = this.graphNow().snapshot();
			let target: CandidateNode | undefined;
			if (snap.winnerId !== undefined) {
				// A selected-but-not-yet-promoted winner keeps status "winner";
				// a demoted winner was failed/pruned by a failed promotion.
				const winner = snap.nodes.get(snap.winnerId);
				if (winner !== undefined && winner.status === "winner") target = winner;
			}
			if (target === undefined) {
				target = this.graphNow().eligibleCandidates(snap.coverageThreshold ?? 100)[0];
			}
			if (target === undefined) {
				await this.settleWithoutWinner(snap);
				return;
			}
			const outcome = await this.tryPromote(target);
			if (outcome === "terminal") return;
			// retry: the failed winner was demoted; loop over the next eligible.
		}
	}

	private async tryPromote(candidate: CandidateNode): Promise<"terminal" | "retry"> {
		const worker = await this.buildWorker(candidate);
		await this.recheckWinnerEligibility(candidate, worker);
		const attemptId = promotionAttemptIdOf(worker.lease, candidate.workspace.snapshotId);
		await this.appendEvent({
			type: "winner_selected",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "winner_selected",
				target: `promotion:${attemptId}`,
			}),
			at: this.now(),
			winnerId: candidate.id,
			promotionAttemptId: attemptId,
		});
		await this.appendEvent({
			type: "promotion_started",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "promotion_started",
				target: `promotion:${attemptId}`,
			}),
			at: this.now(),
			winnerId: candidate.id,
			promotionAttemptId: attemptId,
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await this.promoteOnce(candidate, worker, attemptId);
			switch (result.kind) {
				case "terminal":
					return "terminal";
				case "retry":
					return "retry";
				case "recovered":
					continue;
			}
		}
		throw new AdaptiveRuntimeFault(`promotion ${attemptId} could not be settled after recovery`);
	}

	private async promoteOnce(
		candidate: CandidateNode,
		worker: CandidateWorker,
		attemptId: string,
	): Promise<{ kind: "terminal" | "retry" | "recovered" }> {
		let result: Awaited<ReturnType<WorkspaceManager["promote"]>>;
		try {
			result = await this.options.workspaceManager.promote({
				lease: worker.lease,
				verifier: async ({ cwd }) => {
					const controller = new AbortController();
					const verified = await runHardVerifier({
						verifier: this.input.verifier,
						taskId: this.input.taskId,
						candidateId: candidate.id,
						cwd,
						signal: controller.signal,
					});
					if (verified.status !== "pass") {
						throw new Error(`winner verifier re-run failed with coverage ${verified.coverage}`);
					}
				},
				finalVerifier:
					this.options.finalVerifier ??
					(async ({ cwd }) => {
						const controller = new AbortController();
						const verified = await runHardVerifier({
							verifier: this.input.verifier,
							taskId: this.input.taskId,
							candidateId: candidate.id,
							cwd,
							signal: controller.signal,
						});
						if (verified.status !== "pass") {
							throw new Error(`foreground final verifier failed with coverage ${verified.coverage}`);
						}
					}),
			});
		} catch (error) {
			if (error instanceof ForegroundChangedError) {
				await this.finishTask({ kind: "foreground_changed", message: error.message });
				return { kind: "terminal" };
			}
			if (error instanceof PromotionConflictError) {
				// An open promotion journal from a crashed attempt: recover()
				// settles it (rollback or discard), then retry once.
				const report = await this.options.workspaceManager.recover();
				if (report.promotions.needsAttention.includes(attemptId)) {
					await this.finishTask({
						kind: "promotion_needs_attention",
						promotionId: attemptId,
						recoveryCopies: [],
					});
					return { kind: "terminal" };
				}
				return { kind: "recovered" };
			}
			throw error;
		}
		switch (result.status) {
			case "promoted": {
				await this.appendEvent({
					type: "promotion_settled",
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					actionId: deterministicActionId({
						taskId: this.input.taskId,
						revision: this.graphNow().revision() + 1,
						type: "promotion_settled",
						target: `promotion:${attemptId}`,
					}),
					at: this.now(),
					winnerId: candidate.id,
					promotionAttemptId: attemptId,
					status: "promoted",
					touchedPaths: [...result.touchedPaths],
					postFingerprint: result.receipt.postFingerprint,
				});
				await this.finishTask({
					kind: "promoted",
					winnerId: candidate.id,
					touchedPaths: [...result.touchedPaths],
				});
				return { kind: "terminal" };
			}
			case "verifier_failed": {
				await this.appendCandidateTerminal(candidate.id, "failed", `winner verifier failed: ${result.message}`);
				return { kind: "retry" };
			}
			case "rolled_back": {
				await this.appendEvent({
					type: "promotion_settled",
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					actionId: deterministicActionId({
						taskId: this.input.taskId,
						revision: this.graphNow().revision() + 1,
						type: "promotion_settled",
						target: `promotion:${attemptId}`,
					}),
					at: this.now(),
					winnerId: candidate.id,
					promotionAttemptId: attemptId,
					status: "rolled_back",
					touchedPaths: [...result.touchedPaths],
					postFingerprint: result.receipt.postFingerprint,
					reason: result.reason,
				});
				await this.appendCandidateTerminal(candidate.id, "failed", `promotion rolled back: ${result.reason}`);
				return { kind: "retry" };
			}
			case "needs_attention": {
				await this.appendEvent({
					type: "promotion_settled",
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					actionId: deterministicActionId({
						taskId: this.input.taskId,
						revision: this.graphNow().revision() + 1,
						type: "promotion_settled",
						target: `promotion:${attemptId}`,
					}),
					at: this.now(),
					winnerId: candidate.id,
					promotionAttemptId: attemptId,
					status: "needs_attention",
					touchedPaths: [],
					postFingerprint: "",
					reason: result.reason,
				});
				await this.finishTask({
					kind: "promotion_needs_attention",
					promotionId: result.promotionId,
					recoveryCopies: [...result.recoveryCopies],
				});
				return { kind: "terminal" };
			}
		}
	}

	private async recheckWinnerEligibility(candidate: CandidateNode, worker: CandidateWorker): Promise<void> {
		const snap = this.graphNow().snapshot();
		const threshold = snap.coverageThreshold ?? 100;
		if (candidate.belief.verifierStatus !== "pass" || candidate.belief.verificationDebt !== 0) {
			throw new AdaptiveRuntimeFault(`candidate ${candidate.id} is not verifier-eligible`);
		}
		if (candidate.belief.evidenceCoverage < threshold) {
			throw new AdaptiveRuntimeFault(
				`candidate ${candidate.id} coverage ${candidate.belief.evidenceCoverage} is below ${threshold}`,
			);
		}
		if (candidate.verifierResult?.mutation !== undefined) {
			throw new AdaptiveRuntimeFault(`candidate ${candidate.id} verifier mutated the workspace`);
		}
		// Consistency re-check (S8.6): the stored policy-state ref must still
		// be the deterministic projection of the durable prefix.
		const capsule = await this.projector.project(candidate.policyState.basis, {
			session: worker.session,
			...(worker.parentSession === undefined ? {} : { inheritedUsageSource: worker.parentSession }),
		});
		if (capsule.fingerprint !== candidate.policyState.fingerprint) {
			throw new AdaptiveRuntimeFault(
				`candidate ${candidate.id} policy state reconstructs to ${capsule.fingerprint}, not ${candidate.policyState.fingerprint}`,
			);
		}
		// Verifier evidence must be bound to the current workspace fingerprint.
		const diff = await this.options.workspaceManager.diff(worker.lease);
		if (workspaceDiffFingerprint(diff) !== candidate.verifierResult?.workspaceFingerprint) {
			throw new AdaptiveRuntimeFault(`candidate ${candidate.id} workspace changed after verification`);
		}
	}

	// ------------------------------------------------------------ terminal + cleanup

	private async settleWithoutWinner(snap: FoldedTaskGraph): Promise<void> {
		for (const { decision } of snap.lastDecisions.values()) {
			if (decision.kind === "prune" && decision.budget !== undefined) {
				await this.finishTask({ kind: "budget_exhausted", budget: decision.budget });
				return;
			}
		}
		const pending = [...snap.nodes.values()].filter(
			(node) => !node.released && !isTerminalStatus(node.status) && node.status !== "branch_origin",
		);
		await this.finishTask({
			kind: "no_verified_candidate",
			reason:
				pending.length === 0
					? "all candidates reached a terminal state without verification"
					: `no verified candidate (${pending.length} candidate(s) pending)`,
		});
	}

	private async appendCandidateTerminal(
		candidateId: string,
		status: "verified" | "pruned" | "failed" | "winner",
		reason: string,
	): Promise<void> {
		await this.appendEvent({
			type: "candidate_terminal",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "candidate_terminal",
				target: `candidate:${candidateId}`,
			}),
			at: this.now(),
			candidateId,
			status,
			reason,
		});
	}

	private async finishTask(outcome: AdaptiveTaskOutcome): Promise<void> {
		if (this.graphNow().status() === "terminal") return;
		await this.appendEvent({
			type: "task_terminal",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "task_terminal",
				target: this.input.taskId,
			}),
			at: this.now(),
			outcome: structuredClone(outcome),
		});
	}

	private async releaseWorker(worker: CandidateWorker): Promise<void> {
		const snap = this.graphNow().snapshot();
		const node = snap.nodes.get(worker.candidateId);
		if (node?.released === true) return;
		await this.appendEvent({
			type: "candidate_release_started",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "candidate_release_started",
				target: `candidate:${worker.candidateId}`,
			}),
			at: this.now(),
			candidateId: worker.candidateId,
		});
		await worker.runner?.abort().catch(() => undefined);
		await worker.close().catch(() => undefined);
		await worker.lease.release().catch(() => undefined);
		await this.appendEvent({
			type: "candidate_released",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "candidate_released",
				target: `candidate:${worker.candidateId}`,
			}),
			at: this.now(),
			candidateId: worker.candidateId,
		});
	}

	private async finalizeCleanup(snap: FoldedTaskGraph): Promise<void> {
		for (const node of snap.nodes.values()) {
			if (node.released) continue;
			const worker = this.workers.get(node.id);
			if (worker !== undefined) {
				await this.releaseWorker(worker);
				continue;
			}
			if (node.workspace.snapshotId === "" || node.workspace.snapshotId === "pending") continue;
			const lease = await this.options.workspaceManager
				.fork(await this.options.workspaceManager.findSnapshot(node.workspace.snapshotId), node.id)
				.catch(() => undefined);
			if (lease === undefined) continue;
			await this.appendEvent({
				type: "candidate_release_started",
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					type: "candidate_release_started",
					target: `candidate:${node.id}`,
				}),
				at: this.now(),
				candidateId: node.id,
			});
			await lease.release().catch(() => undefined);
			await this.appendEvent({
				type: "candidate_released",
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				actionId: deterministicActionId({
					taskId: this.input.taskId,
					revision: this.graphNow().revision() + 1,
					type: "candidate_released",
					target: `candidate:${node.id}`,
				}),
				at: this.now(),
				candidateId: node.id,
			});
		}
		for (const group of snap.groups.values()) {
			const journal = this.options.continuationJournal(group.groupId);
			await journal.append({ type: "group_terminal", groupId: group.groupId, reason: "task terminal" });
			await this.releaseSnapshot(group.snapshotId);
			await journal.append({ type: "group_released", groupId: group.groupId, snapshotId: group.snapshotId });
		}
		const rootCandidateId = snap.rootCandidateId;
		const root = rootCandidateId === undefined ? undefined : snap.nodes.get(rootCandidateId);
		if (root !== undefined && root.workspace.snapshotId !== "" && root.workspace.snapshotId !== "pending") {
			await this.releaseSnapshot(root.workspace.snapshotId);
		}
	}

	private async releaseSnapshot(snapshotId: string): Promise<void> {
		const fresh = this.graphNow().snapshot();
		if (fresh.releasedSnapshots.has(snapshotId)) return;
		const snapshot = await this.options.workspaceManager.findSnapshot(snapshotId).catch(() => undefined);
		if (snapshot === undefined) return;
		await this.options.workspaceManager.releaseSnapshot(snapshot).catch((error: unknown) => {
			throw new AdaptiveRuntimeFault(
				`failed to release snapshot ${snapshotId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		});
		await this.appendEvent({
			type: "snapshot_released",
			taskId: this.input.taskId,
			revision: this.graphNow().revision() + 1,
			actionId: deterministicActionId({
				taskId: this.input.taskId,
				revision: this.graphNow().revision() + 1,
				type: "snapshot_released",
				target: `snapshot:${snapshotId}`,
			}),
			at: this.now(),
			snapshotId,
		});
	}

	private async appendEvent(event: TaskJournalEvent): Promise<void> {
		const key = taskJournalEventKey(event);
		const existing = (await this.options.taskJournal.events()).find(
			(candidate) => taskJournalEventKey(candidate) === key,
		);
		if (existing !== undefined) {
			// Deterministic replay: the same durable event is already recorded.
			// The semantic payload must be identical; the revision/action id
			// (and the wall-clock timestamp) are recomputed per attempt and
			// differ legitimately on a replay.
			const content = (value: TaskJournalEvent): string => {
				const { at: _at, revision: _revision, actionId: _actionId, ...rest } = value;
				void _at;
				void _revision;
				void _actionId;
				return canonicalJsonLoose(rest);
			};
			if (content(existing) !== content(event)) {
				throw new TaskGraphFault(`event ${key} replays with different content`);
			}
			if (this.options.afterEvent?.(event) === "crash") {
				throw new SimulatedProcessCrash(event.type);
			}
			return;
		}
		await this.graphNow().append(event);
		if (this.options.afterEvent?.(event) === "crash") {
			throw new SimulatedProcessCrash(event.type);
		}
	}

	private async budgetFacts(): Promise<TaskBudgetFacts> {
		const snap = this.graphNow().snapshot();
		const limits = snap.budget ?? this.input.budget;
		const facts = zeroBudgetFacts(limits, snap.deadlineMs ?? this.now() + limits.maxWallClockMs);
		let providerCalls = 0;
		let totalTokens = 0;
		for (const node of snap.nodes.values()) {
			if (node.released) continue;
			if (node.conversation.sessionId === "" || node.conversation.sessionId === "pending") continue;
			const session = await this.openSession(node.conversation.sessionId);
			const ledger = await scanCandidateUsage(session);
			providerCalls += ledger.providerCalls;
			totalTokens += ledger.totalTokens;
		}
		facts.providerCalls = providerCalls;
		facts.totalTokens = totalTokens;
		facts.wallClockUsedMs = Math.max(0, this.now() - (facts.deadlineMs - limits.maxWallClockMs));
		facts.activeCandidates = [...snap.nodes.values()].filter((node) => !isTerminalStatus(node.status)).length;
		facts.totalCandidates = snap.nodes.size;
		return facts;
	}

	private appendTrajectory(record: {
		kind: "task" | "evaluator_evidence";
		taskId: string;
		candidateId: string;
		sessionId: string;
		operationId: string;
		metrics: Record<string, unknown>;
	}): void {
		const trajectory = this.options.trajectory;
		if (trajectory === undefined) return;
		const trajectoryRecord: TrajectoryRecord = {
			id: `${record.kind}:${record.taskId}:${record.candidateId}:${this.trajectorySeq++}`,
			kind: record.kind,
			taskId: record.taskId,
			candidateId: record.candidateId,
			sessionId: record.sessionId,
			operationId: record.operationId,
			policyBundleVersion: this.input.policyBundle.version,
			policyBundleFingerprint: this.input.policyBundle.fingerprint,
			metrics: sanitizeTrajectoryMetrics(record.metrics) as Record<string, unknown>,
			recordedAt: Date.now(),
		};
		trajectory.append(trajectoryRecord).catch(() => undefined);
	}
}

function isTerminalStatus(status: CandidateNode["status"]): boolean {
	return status === "pruned" || status === "failed" || status === "winner" || status === "terminal";
}
