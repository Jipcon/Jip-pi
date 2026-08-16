import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import type {
	BranchScan,
	CustomEntry,
	Entry,
	JsonValue,
	MessageEntry,
	Session,
	UsageRow,
} from "@earendil-works/pi-agent-core/harness-v4";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	type CandidatePolicyState,
	fingerprintState,
	summarizeWorkspace,
	validateCandidatePolicyState,
	type WorkspaceMetadata,
} from "./candidate-policy-state.ts";
import { reduceTurn, type ToolStepFacts, type TurnEvidence, type TurnFacts } from "./evaluator.ts";
import {
	ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
	ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE,
	type AdaptiveRunBasisData,
	type AdaptiveToolBatchData,
	type CandidatePolicyStateCapsule,
	type CandidatePolicyStateSnapshot,
	type DurableToolDecision,
	type ProjectionBasis,
} from "./harness-v4-contract.ts";
import { canonicalJson, type PolicyBundle, PROJECTOR_VERSION, TOOL_POLICY_FAULT_FINGERPRINT } from "./policy-bundle.ts";
import { type PolicyRegistry, PolicyRegistryError } from "./policy-registry.ts";

/** Deterministic reconstruction failure: same basis, different state. */
export class StateProjectionMismatch extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateProjectionMismatch";
	}
}

/** Fail-closed projection fault: missing/corrupt basis, bundle, capsule or branch. */
export class PolicyProjectionFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PolicyProjectionFault";
	}
}

export interface ProjectionFacts {
	session: Session;
	/** Required only for task_origin cursors. */
	originSnapshot?: CandidatePolicyState;
	/** Required for tool_batch_start cursors: the durable run-basis entry id. */
	basisEntryId?: string;
	/**
	 * Exact-continuation children: usage rows of the forked prefix live in
	 * the source session (forks never copy the usage ledger), so the
	 * one-level reconstruction of an inherited capsule reads its token ledger
	 * from this handle. Defaults to the projection session.
	 */
	inheritedUsageSource?: Session;
}

/** Non-authoritative, deletable projection cache. */
export interface ProjectionCache {
	get(key: string): CandidatePolicyStateCapsule | undefined;
	put(key: string, capsule: CandidatePolicyStateCapsule): void;
	clear(): void;
}

export class MemoryProjectionCache implements ProjectionCache {
	private readonly entries = new Map<string, CandidatePolicyStateCapsule>();

	get(key: string): CandidatePolicyStateCapsule | undefined {
		const capsule = this.entries.get(key);
		if (capsule === undefined) return undefined;
		// A corrupt or stale cached capsule is dropped, never trusted.
		const valid =
			validateCapsule(capsule) === undefined && fingerprintState(capsule.snapshot) === capsule.fingerprint;
		if (!valid) {
			this.entries.delete(key);
			return undefined;
		}
		return structuredClone(capsule);
	}

	put(key: string, capsule: CandidatePolicyStateCapsule): void {
		this.entries.set(key, structuredClone(capsule));
	}

	clear(): void {
		this.entries.clear();
	}
}

export interface CandidateStateProjectorOptions {
	registry: PolicyRegistry;
	cache?: ProjectionCache;
}

export const TASK_ORIGIN_OPERATION_ID = "task-origin";

/** Deterministic task-origin basis for a not-yet-accepted Run. */
export function taskOriginBasis(input: {
	taskId: string;
	candidateId: string;
	sessionId: string;
	lane: string;
	policyBundle: { version: string; fingerprint: string };
	workspaceMetadata?: WorkspaceMetadata;
}): ProjectionBasis {
	return {
		taskId: input.taskId,
		candidateId: input.candidateId,
		sessionId: input.sessionId,
		lane: input.lane,
		operationId: TASK_ORIGIN_OPERATION_ID,
		cursor: { kind: "task_origin" },
		policyBundle: input.policyBundle,
		projectorVersion: PROJECTOR_VERSION,
		inheritedStateFingerprint: "",
		...(input.workspaceMetadata === undefined ? {} : { workspaceMetadata: input.workspaceMetadata }),
	};
}

/**
 * Deterministic origin capsule: same inputs always produce the same basis,
 * snapshot and fingerprint, so a Run's task-origin capsule is repeatable.
 */
export function createOriginCapsule(input: {
	taskId: string;
	candidateId: string;
	sessionId: string;
	lane: string;
	policyBundle: { version: string; fingerprint: string };
	snapshot: CandidatePolicyState;
	workspaceMetadata?: WorkspaceMetadata;
}): CandidatePolicyStateCapsule {
	const fingerprint = fingerprintState(input.snapshot);
	const basis = taskOriginBasis(input);
	const snapshot = structuredClone(input.snapshot);
	if (input.workspaceMetadata !== undefined) snapshot.workspace = summarizeWorkspace(input.workspaceMetadata);
	return {
		basis: { ...basis, inheritedStateFingerprint: fingerprint },
		fingerprint,
		snapshot,
	};
}

/** Shape + internal-consistency validation of any capsule. */
export function validateCapsule(capsule: CandidatePolicyStateCapsule): string | undefined {
	const basis = capsule.basis;
	if (basis === undefined || typeof basis !== "object") return "capsule basis must be an object";
	const basisInvalid = validateProjectionBasisShape(basis);
	if (basisInvalid !== undefined) return basisInvalid;
	if (typeof capsule.fingerprint !== "string" || capsule.fingerprint.length !== 64)
		return "capsule fingerprint must be a sha256";
	const snapshotInvalid = validateCandidatePolicyState(capsule.snapshot);
	if (snapshotInvalid !== undefined) return `capsule snapshot is invalid: ${snapshotInvalid}`;
	if (fingerprintState(capsule.snapshot) !== capsule.fingerprint)
		return "capsule fingerprint does not match its snapshot";
	// A task_origin basis names the origin state itself; a post_turn basis
	// references the seed of the run it was projected from.
	if (basis.cursor.kind === "task_origin" && basis.inheritedStateFingerprint !== capsule.fingerprint) {
		return "origin capsule basis inheritedStateFingerprint does not match the capsule";
	}
	return undefined;
}

function validateProjectionBasisShape(basis: ProjectionBasis): string | undefined {
	if (typeof basis.taskId !== "string" || basis.taskId.length === 0) return "basis taskId must be a non-empty string";
	if (typeof basis.candidateId !== "string" || basis.candidateId.length === 0)
		return "basis candidateId must be a non-empty string";
	if (typeof basis.sessionId !== "string" || basis.sessionId.length === 0)
		return "basis sessionId must be a non-empty string";
	if (typeof basis.lane !== "string" || basis.lane.length === 0) return "basis lane must be a non-empty string";
	if (typeof basis.operationId !== "string" || basis.operationId.length === 0)
		return "basis operationId must be a non-empty string";
	const cursor = basis.cursor;
	if (cursor === undefined || typeof cursor !== "object") return "basis cursor must be an object";
	if (cursor.kind === "task_origin") {
		if (basis.operationId !== TASK_ORIGIN_OPERATION_ID)
			return "task_origin basis must use the task-origin operation id";
	} else if (cursor.kind === "tool_batch_start") {
		if (typeof cursor.assistantEntryId !== "string" || cursor.assistantEntryId.length === 0) {
			return "tool_batch_start cursor must name the assistant entry";
		}
	} else if (cursor.kind === "post_turn") {
		if (typeof cursor.cursor?.assistantEntryId !== "string" || cursor.cursor.assistantEntryId.length === 0) {
			return "post_turn cursor must name the assistant entry";
		}
		if (typeof cursor.cursor.leafId !== "string" || cursor.cursor.leafId.length === 0)
			return "post_turn cursor must name the leaf";
		if (cursor.cursor.operationId !== basis.operationId) return "post_turn cursor operation does not match the basis";
		if (
			cursor.terminalOutcome !== undefined &&
			cursor.terminalOutcome !== "completed" &&
			cursor.terminalOutcome !== "failed" &&
			cursor.terminalOutcome !== "aborted"
		) {
			return "post_turn terminalOutcome is invalid";
		}
	} else {
		return "basis cursor kind is invalid";
	}
	if (typeof basis.policyBundle?.version !== "string" || basis.policyBundle.version.length === 0) {
		return "basis policyBundle version must be a non-empty string";
	}
	if (typeof basis.policyBundle.fingerprint !== "string" || basis.policyBundle.fingerprint.length !== 64) {
		return "basis policyBundle fingerprint must be a sha256";
	}
	if (basis.projectorVersion !== PROJECTOR_VERSION) {
		return `basis projectorVersion ${basis.projectorVersion} is not ${PROJECTOR_VERSION}`;
	}
	if (typeof basis.inheritedStateFingerprint !== "string" || basis.inheritedStateFingerprint.length !== 64) {
		return "basis inheritedStateFingerprint must be a sha256";
	}
	if (basis.workspaceMetadata !== undefined && !isWorkspaceMetadata(basis.workspaceMetadata)) {
		return "basis workspaceMetadata is invalid";
	}
	return undefined;
}

function isWorkspaceMetadata(value: unknown): value is WorkspaceMetadata {
	if (typeof value !== "object" || value === null) return false;
	const files = (value as { files?: unknown }).files;
	return Array.isArray(files) && files.every((file) => typeof (file as { path?: unknown }).path === "string");
}

/**
 * Deterministic view of one candidate: reconstructs the bounded policy state
 * from `adaptive.run_basis`, the target branch prefix and usage rows only.
 */
export class CandidateStateProjector {
	private readonly registry: PolicyRegistry;
	private readonly cache: ProjectionCache | undefined;

	constructor(options: CandidateStateProjectorOptions) {
		this.registry = options.registry;
		this.cache = options.cache;
	}

	clearCache(): void {
		this.cache?.clear();
	}

	async project(
		basis: ProjectionBasis,
		facts: ProjectionFacts,
		observeTurn?: (evidence: TurnEvidence) => void,
	): Promise<CandidatePolicyStateCapsule> {
		const shapeInvalid = validateProjectionBasisShape(basis);
		if (shapeInvalid !== undefined) throw new PolicyProjectionFault(`Invalid ProjectionBasis: ${shapeInvalid}`);
		const cacheKey = canonicalJson(basis as unknown as JsonValue);
		const cached = this.cache?.get(cacheKey);
		if (cached !== undefined) return cached;

		const capsule =
			basis.cursor.kind === "task_origin"
				? this.projectTaskOrigin(basis, facts)
				: await this.projectFromRun(basis, facts, observeTurn);
		this.cache?.put(cacheKey, capsule);
		return capsule;
	}

	private projectTaskOrigin(basis: ProjectionBasis, facts: ProjectionFacts): CandidatePolicyStateCapsule {
		const snapshot = facts.originSnapshot;
		if (snapshot === undefined)
			throw new PolicyProjectionFault("task_origin projection requires the origin snapshot");
		const snapshotInvalid = validateCandidatePolicyState(snapshot);
		if (snapshotInvalid !== undefined)
			throw new PolicyProjectionFault(`Origin snapshot is invalid: ${snapshotInvalid}`);
		const fingerprint = fingerprintState(snapshot);
		if (basis.inheritedStateFingerprint !== fingerprint) {
			throw new StateProjectionMismatch(
				`Origin snapshot fingerprint ${fingerprint} does not match the basis fingerprint ${basis.inheritedStateFingerprint}`,
			);
		}
		const next = structuredClone(snapshot);
		if (basis.workspaceMetadata !== undefined) next.workspace = summarizeWorkspace(basis.workspaceMetadata);
		return { basis, fingerprint, snapshot: next };
	}

	private async projectFromRun(
		basis: ProjectionBasis,
		facts: ProjectionFacts,
		observeTurn?: (evidence: TurnEvidence) => void,
	): Promise<CandidatePolicyStateCapsule> {
		const session = facts.session;
		const bundle = await this.resolveBundle(basis);
		let runBasisEntry: CustomEntry;
		let positionId: string;
		let range: Entry[];
		if (basis.cursor.kind === "tool_batch_start") {
			if (facts.basisEntryId === undefined)
				throw new PolicyProjectionFault("tool_batch_start projection requires basisEntryId");
			runBasisEntry = await this.locateBasisEntry(session, facts.basisEntryId);
			positionId = basis.cursor.assistantEntryId;
			await this.verifyAncestry(session, positionId, runBasisEntry.id);
			const chain = await this.branchRange(session, positionId, runBasisEntry.id);
			range = chain.slice(1, -1);
		} else if (basis.cursor.kind === "post_turn") {
			runBasisEntry = await this.nearestRunBasis(session, basis.cursor.cursor.leafId);
			positionId = basis.cursor.cursor.leafId;
			const chain = await this.branchRange(session, positionId, runBasisEntry.id);
			range = chain.slice(1);
		} else {
			throw new PolicyProjectionFault("projectFromRun requires a tool_batch_start or post_turn cursor");
		}
		const runBasis = this.parseRunBasis(runBasisEntry);
		this.validateRunBasisAgainstBasis(runBasis, runBasisEntry.id, basis);
		const sourceSessionId =
			runBasis.start?.kind === "exact_continuation" ? runBasis.start.source.parentSessionId : undefined;
		await this.validateInheritedCapsule(
			runBasis.inheritedPolicyState,
			session,
			basis,
			sourceSessionId,
			runBasis,
			facts.inheritedUsageSource ?? session,
		);

		const replay = await this.replayRange(
			session,
			range,
			runBasis.inheritedPolicyState.snapshot,
			bundle,
			observeTurn,
		);
		const snapshot = structuredClone(replay.state);
		if (
			basis.cursor.kind === "post_turn" &&
			(basis.cursor.terminalOutcome === "failed" || basis.cursor.terminalOutcome === "aborted")
		) {
			snapshot.phase = "terminal";
		}
		if (basis.workspaceMetadata !== undefined) snapshot.workspace = summarizeWorkspace(basis.workspaceMetadata);
		const fingerprint = fingerprintState(snapshot);
		return { basis, fingerprint, snapshot };
	}

	private async resolveBundle(basis: ProjectionBasis): Promise<PolicyBundle> {
		try {
			return await this.registry.resolve(basis.policyBundle);
		} catch (error) {
			if (error instanceof PolicyRegistryError) {
				throw new PolicyProjectionFault(
					`PolicyBundle ${basis.policyBundle.version} is unavailable: ${error.message}`,
					error,
				);
			}
			throw error;
		}
	}

	private async locateBasisEntry(session: Session, basisEntryId: string): Promise<CustomEntry> {
		let entries: ReadonlyMap<string, Entry>;
		try {
			entries = await session.getEntries([basisEntryId]);
		} catch (error) {
			throw new PolicyProjectionFault(`Failed to read run basis entry ${basisEntryId}`, toCause(error));
		}
		const entry = entries.get(basisEntryId);
		if (entry === undefined) throw new PolicyProjectionFault(`Run basis entry ${basisEntryId} does not exist`);
		if (entry.type !== "custom" || entry.customType !== ADAPTIVE_RUN_BASIS_CUSTOM_TYPE) {
			throw new PolicyProjectionFault(`Entry ${basisEntryId} is not a ${ADAPTIVE_RUN_BASIS_CUSTOM_TYPE} entry`);
		}
		return entry;
	}

	private async nearestRunBasis(session: Session, positionId: string): Promise<CustomEntry> {
		const matches = await this.branch(session, {
			start: positionId,
			customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
			limit: 1,
		});
		const entry = matches[0];
		if (entry === undefined || entry.type !== "custom") {
			throw new PolicyProjectionFault(`No ${ADAPTIVE_RUN_BASIS_CUSTOM_TYPE} entry on the branch of ${positionId}`);
		}
		return entry;
	}

	private async verifyAncestry(session: Session, positionId: string, basisEntryId: string): Promise<void> {
		const chain = await this.branch(session, { start: positionId, order: "oldestFirst" });
		// The nearest run-basis ancestor is the last one on the root-first chain.
		const bases = chain.filter(
			(entry) => entry.type === "custom" && entry.customType === ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
		);
		if (bases.length === 0 || bases.at(-1)?.id !== basisEntryId) {
			throw new PolicyProjectionFault(`Run basis entry ${basisEntryId} is not the nearest basis of ${positionId}`);
		}
	}

	private async branch(session: Session, query: BranchScan & { start: string }): Promise<Entry[]> {
		try {
			return await session.findEntriesOnBranch(query);
		} catch (error) {
			throw new PolicyProjectionFault(`Failed to read the branch of ${query.start}`, toCause(error));
		}
	}

	private async branchRange(session: Session, positionId: string, runBasisEntryId: string): Promise<Entry[]> {
		const chain = await this.branch(session, {
			start: positionId,
			stopAtId: runBasisEntryId,
			order: "oldestFirst",
		});
		if (chain[0]?.id !== runBasisEntryId) {
			throw new PolicyProjectionFault(
				`Branch of ${positionId} does not include the run basis entry ${runBasisEntryId}`,
			);
		}
		return chain;
	}

	private parseRunBasis(entry: CustomEntry): AdaptiveRunBasisData {
		const data = entry.data;
		if (typeof data !== "object" || data === null)
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has no data`);
		const basis = data as unknown as AdaptiveRunBasisData;
		if (basis.schemaVersion !== 1)
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has an unsupported schemaVersion`);
		if (typeof basis.operationId !== "string" || basis.operationId.length === 0) {
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has no operationId`);
		}
		if (
			typeof basis.taskId !== "string" ||
			basis.taskId.length === 0 ||
			typeof basis.candidateId !== "string" ||
			basis.candidateId.length === 0
		) {
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has invalid task or candidate identity`);
		}
		if (typeof basis.policyBundle?.version !== "string" || typeof basis.policyBundle?.fingerprint !== "string") {
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has no PolicyBundle ref`);
		}
		if (typeof basis.projectorVersion !== "string")
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} has no projectorVersion`);
		if (basis.start?.kind !== "prompt" && basis.start?.kind !== "exact_continuation") {
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} uses an unsupported run start`);
		}
		const capsuleInvalid = validateCapsule(basis.inheritedPolicyState);
		if (capsuleInvalid !== undefined) {
			throw new PolicyProjectionFault(`Run basis entry ${entry.id} inherited capsule is invalid: ${capsuleInvalid}`);
		}
		return basis;
	}

	private validateRunBasisAgainstBasis(
		runBasis: AdaptiveRunBasisData,
		basisEntryId: string,
		basis: ProjectionBasis,
	): void {
		if (runBasis.operationId !== basis.operationId) {
			throw new PolicyProjectionFault(
				`Run basis ${basisEntryId} belongs to operation ${runBasis.operationId}, not ${basis.operationId}`,
			);
		}
		if (runBasis.taskId !== basis.taskId || runBasis.candidateId !== basis.candidateId) {
			throw new PolicyProjectionFault(`Run basis ${basisEntryId} task/candidate identity does not match the basis`);
		}
		if (
			runBasis.policyBundle.version !== basis.policyBundle.version ||
			runBasis.policyBundle.fingerprint !== basis.policyBundle.fingerprint
		) {
			throw new PolicyProjectionFault(`Run basis ${basisEntryId} pins a different PolicyBundle than the basis`);
		}
		if (runBasis.projectorVersion !== basis.projectorVersion) {
			throw new PolicyProjectionFault(
				`Run basis ${basisEntryId} pins projector ${runBasis.projectorVersion}, not ${basis.projectorVersion}`,
			);
		}
		if (runBasis.inheritedPolicyState.fingerprint !== basis.inheritedStateFingerprint) {
			throw new PolicyProjectionFault(`Run basis ${basisEntryId} inherited fingerprint does not match the basis`);
		}
	}

	private async validateInheritedCapsule(
		capsule: CandidatePolicyStateCapsule,
		session: Session,
		basis: ProjectionBasis,
		sourceSessionId: string | undefined,
		currentRunBasis: AdaptiveRunBasisData,
		usageSession: Session = session,
	): Promise<void> {
		const cursor = capsule.basis.cursor;
		if (cursor.kind === "task_origin") {
			if (capsule.basis.sessionId !== basis.sessionId || capsule.basis.lane !== basis.lane) {
				throw new PolicyProjectionFault("Origin capsule session/lane does not match the current run");
			}
			return;
		}
		if (cursor.kind === "post_turn") {
			// Exact continuation children carry the source session's post-turn
			// capsule; the run's exact_continuation start names that source.
			const sessionMatches =
				capsule.basis.sessionId === basis.sessionId || capsule.basis.sessionId === sourceSessionId;
			if (!sessionMatches || capsule.basis.lane !== basis.lane) {
				throw new PolicyProjectionFault("Inherited capsule session/lane does not match the current run");
			}
			if (capsule.basis.sessionId !== basis.sessionId) {
				// Cross-session inheritance (exact-continuation child): the fork
				// renumbers entry seqs and never copies the usage ledger, so the
				// seq-derived capsule content cannot be replayed from the child
				// session. The capsule was already reconstructed against its own
				// session at checkpoint capture; here only the durable
				// provenance is verified: the capsule cursor equals the current
				// run's exact_continuation source, and the run basis pins the
				// capsule as its inherited seed (already checked against the
				// basis fingerprint by validateRunBasisAgainstBasis).
				const source = currentRunBasis.start;
				if (source?.kind !== "exact_continuation") {
					throw new PolicyProjectionFault(
						"Cross-session inherited capsule references a run without an exact_continuation source",
					);
				}
				if (
					cursor.cursor.operationId !== source.source.sourceCursor.operationId ||
					cursor.cursor.assistantEntryId !== source.source.sourceCursor.assistantEntryId ||
					cursor.cursor.leafId !== source.source.sourceCursor.leafId
				) {
					throw new PolicyProjectionFault(
						"Inherited capsule cursor does not match the run's exact_continuation source",
					);
				}
				if (source.source.parentSessionId !== capsule.basis.sessionId) {
					throw new PolicyProjectionFault(
						"Inherited capsule session does not match the run's exact_continuation source",
					);
				}
				return;
			}
			// One-level reconstruction check: the inherited post-turn capsule must
			// be the deterministic replay of the previous run's branch.
			const runBasisEntry = await this.nearestRunBasis(session, cursor.cursor.leafId);
			const runBasis = this.parseRunBasis(runBasisEntry);
			if (runBasis.operationId !== cursor.cursor.operationId) {
				throw new PolicyProjectionFault("Inherited capsule references an operation without a matching run basis");
			}
			if (runBasis.inheritedPolicyState.fingerprint !== capsule.basis.inheritedStateFingerprint) {
				throw new PolicyProjectionFault(
					"Inherited capsule references a seed that does not match the referenced run",
				);
			}
			const bundle = await this.resolveBundle(capsule.basis);
			const chain = await this.branchRange(session, cursor.cursor.leafId, runBasisEntry.id);
			const replay = await this.replayRange(
				session,
				chain.slice(1),
				runBasis.inheritedPolicyState.snapshot,
				bundle,
				undefined,
				usageSession,
			);
			const snapshot = structuredClone(replay.state);
			if (cursor.terminalOutcome === "failed" || cursor.terminalOutcome === "aborted") snapshot.phase = "terminal";
			if (capsule.basis.workspaceMetadata !== undefined)
				snapshot.workspace = summarizeWorkspace(capsule.basis.workspaceMetadata);
			const fingerprint = fingerprintState(snapshot);
			if (fingerprint !== capsule.fingerprint) {
				throw new StateProjectionMismatch(
					`Inherited capsule ${cursor.cursor.operationId}:${cursor.cursor.assistantEntryId} reconstructs to ${fingerprint}, not ${capsule.fingerprint}`,
				);
			}
			return;
		}
		throw new PolicyProjectionFault("Inherited capsule must reference task_origin or post_turn");
	}

	private async replayRange(
		session: Session,
		range: Entry[],
		seed: CandidatePolicyStateSnapshot,
		bundle: PolicyBundle,
		observeTurn?: (evidence: TurnEvidence) => void,
		usageSession: Session = session,
	): Promise<{ state: CandidatePolicyState }> {
		let state = structuredClone(seed);
		// Token ledger: every assistant/toolResult entry of the replayed
		// prefix may own usage rows. Rows are accumulated per entry in walk
		// order so that a mid-walk batch-start check sees exactly the usage of
		// the finalized prefix (the same basis the live batch clearance
		// projected from), while the final state carries the full prefix total.
		const usageEntryIds: string[] = [];
		for (const entry of range) {
			if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
				usageEntryIds.push(entry.id);
			}
		}
		const usageByEntry = new Map<string, number>();
		if (usageEntryIds.length > 0) {
			let usageRows: UsageRow[];
			try {
				usageRows = await usageSession.scanUsage({ entryIds: usageEntryIds, order: "asc" });
			} catch (error) {
				throw new PolicyProjectionFault("Failed to read usage rows for the branch prefix", toCause(error));
			}
			for (const row of usageRows) {
				if (row.entryId === undefined) continue;
				usageByEntry.set(row.entryId, (usageByEntry.get(row.entryId) ?? 0) + row.usage.totalTokens);
			}
		}
		let pendingAssistantUsage = 0;
		let currentAssistant: MessageEntry | undefined;
		let currentCalls: AgentToolCall[] = [];
		let currentDecisions: DurableToolDecision[] = [];
		let currentResults: Array<{ entry: MessageEntry; message: ToolResultMessage }> = [];

		const finalizeTurn = (): void => {
			if (currentAssistant === undefined) return;
			const steps = currentCalls.map((call, index): ToolStepFacts => {
				const decision = currentDecisions[index];
				const result = currentResults[index];
				if (decision === undefined) {
					throw new PolicyProjectionFault(`Turn ${currentAssistant!.id} has no decision for tool call ${call.id}`);
				}
				if (result === undefined) {
					throw new PolicyProjectionFault(
						`Turn ${currentAssistant!.id} is missing the result of tool call ${call.id}`,
					);
				}
				if (result.message.toolCallId !== call.id) {
					throw new PolicyProjectionFault(`Turn ${currentAssistant!.id} tool results are not source-ordered`);
				}
				return {
					toolName: call.name,
					decision: decision.kind === "block" ? "block" : decision.kind === "argument_guard" ? "guard" : "allow",
					args: decision.kind === "block" ? undefined : structuredClone(decision.effectiveArgs),
					isError: result.message.isError,
					seq: result.entry.seq,
					timestamp: result.entry.timestamp,
				};
			});
			const turn: TurnFacts = {
				assistantEntryId: currentAssistant.id,
				seq: currentAssistant.seq,
				timestamp: currentAssistant.timestamp,
				steps,
				usageTokens: 0,
			};
			const reduced = reduceTurn(state, turn, { commandPatterns: bundle.rules.verification.commandPatterns });
			state = reduced.state;
			observeTurn?.(reduced.evidence);
			currentAssistant = undefined;
			currentCalls = [];
			currentDecisions = [];
			currentResults = [];
		};

		for (const entry of range) {
			if (entry.type === "custom" && entry.customType === ADAPTIVE_RUN_BASIS_CUSTOM_TYPE) {
				throw new PolicyProjectionFault(`Nested run basis entry ${entry.id} inside a run branch`);
			}
			if (entry.type === "custom" && entry.customType === ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE) {
				const data = entry.data as unknown as AdaptiveToolBatchData | undefined;
				if (currentAssistant === undefined) {
					throw new PolicyProjectionFault(`Tool batch entry ${entry.id} has no preceding assistant entry`);
				}
				if (data?.schemaVersion !== 1 || !Array.isArray(data.decisions)) {
					throw new PolicyProjectionFault(`Tool batch entry ${entry.id} is invalid`);
				}
				if (data.decisions.length !== currentCalls.length) {
					throw new PolicyProjectionFault(
						`Tool batch entry ${entry.id} does not cover every tool call of the turn`,
					);
				}
				for (let index = 0; index < data.decisions.length; index++) {
					const decision = data.decisions[index]!;
					if (
						decision.sourceIndex !== index ||
						decision.toolCallId !== currentCalls[index]?.id ||
						decision.toolName !== currentCalls[index]?.name
					) {
						throw new PolicyProjectionFault(
							`Tool batch entry ${entry.id} decisions do not match the proposed calls`,
						);
					}
				}
				// The stored batch-start fingerprint must equal the deterministic
				// replay of the durable prefix; a fault sentinel is skipped.
				if (data.policyStateFingerprint !== TOOL_POLICY_FAULT_FINGERPRINT) {
					const batchStartFingerprint = fingerprintState(state);
					if (batchStartFingerprint !== data.policyStateFingerprint) {
						throw new StateProjectionMismatch(
							`Tool batch ${entry.id} recorded ${data.policyStateFingerprint} but the branch reconstructs ${batchStartFingerprint}`,
						);
					}
				}
				currentDecisions = structuredClone(data.decisions);
				continue;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				finalizeTurn();
				// The finalized turn's own usage enters the ledger now; the
				// next assistant's usage stays pending until its turn is
				// finalized (or the walk ends), so the batch-start check below
				// never sees the in-flight turn's usage.
				state.budgets.tokens.used += pendingAssistantUsage;
				currentAssistant = entry;
				currentCalls = entry.message.content.filter((part) => part.type === "toolCall");
				currentResults = [];
				pendingAssistantUsage = usageByEntry.get(entry.id) ?? 0;
				continue;
			}
			if (entry.type === "message" && entry.message.role === "toolResult") {
				if (currentAssistant === undefined) {
					throw new PolicyProjectionFault(`Tool result ${entry.id} has no preceding assistant entry`);
				}
				currentResults.push({ entry, message: entry.message });
				state.budgets.tokens.used += usageByEntry.get(entry.id) ?? 0;
			}
		}
		finalizeTurn();
		state.budgets.tokens.used += pendingAssistantUsage;
		return { state };
	}
}

function toCause(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
