import type {
	AdaptiveAgentLane,
	ExactContinuationDispatchFacts,
	ExactContinuationDispatchGate,
	JsonValue,
	Session,
	SessionMetadata,
	SessionRepo,
} from "@earendil-works/pi-agent-core/harness-v4";
import { SessionError } from "@earendil-works/pi-agent-core/harness-v4";
import type { BranchOriginRegistry } from "./branch-origin.ts";
import {
	type ContinuationCheckpoint,
	NotBranchableCheckpointError,
	SourceCheckpointChangedError,
	validateContinuationCheckpoint,
} from "./continuation-checkpoint.ts";
import {
	type ContinuationJournal,
	type ContinuationJournalEvent,
	continuationChildId,
	continuationGroupId,
} from "./continuation-journal.ts";
import {
	buildCanonicalInferenceRequest,
	MissingIdentitiesError,
	NonDeterministicRequestPolicyError,
	RequestFingerprintMismatchError,
	UnsupportedSamplingControlError,
	verifyExactRequest,
	WorkspaceSnapshotMismatchError,
} from "./exact-request.ts";
import type { ExecutionEnvironment, WorkspaceContinuationPort, WorkspaceLease } from "./execution-environment.ts";
import { HarnessV4LeafTurnAdapter, type HarnessV4LeafTurnBasis } from "./harness-leaf-turn-adapter.ts";
import {
	ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
	type CandidatePolicyStateCapsule,
	type ExactSamplingVariant,
} from "./harness-v4-contract.ts";
import type { LeafTurnCursor, LeafTurnExecutionResult, LeafTurnExecutor } from "./leaf-turn-executor.ts";
import { sha256Hex } from "./policy-bundle.ts";
import { StateProjectionMismatch } from "./state-projector.ts";

/** Storage/session/workspace conflict or failure: faults the whole group. */
export class ContinuationGroupFault extends Error {
	constructor(message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ContinuationGroupFault";
	}
}

export type ContinuationRejected =
	| NotBranchableCheckpointError
	| SourceCheckpointChangedError
	| WorkspaceSnapshotMismatchError
	| MissingIdentitiesError
	| NonDeterministicRequestPolicyError
	| StateProjectionMismatch
	| RequestFingerprintMismatchError
	| UnsupportedSamplingControlError;

export interface ContinuationCandidate {
	groupId: string;
	childId: string;
	sampleIndex: number;
	variant: ExactSamplingVariant;
	sessionId: string;
	session: Session;
	lane: string;
	/** The live child lane handle; never exposed through the runtime's guarded surfaces. */
	laneHandle: AdaptiveAgentLane;
	/** Checkpoint cursor identity shared by the whole group. */
	cursor: LeafTurnCursor;
	workspaceLease: WorkspaceLease;
	environment: ExecutionEnvironment;
	checkpoint: ContinuationCheckpoint;
	policyCapsule: CandidatePolicyStateCapsule;
	acceptedRun: { operationId: string; basisEntryId: string };
	executor: LeafTurnExecutor;
	/** Closes the child harness; never dispatches or mutates the child Run. */
	close(): Promise<void>;
}

/** Caller-supplied child harness factory; the gate is assembled by BranchContinuation. */
export interface CreateChildHarnessInput {
	session: Session;
	variant: ExactSamplingVariant;
	checkpoint: ContinuationCheckpoint;
	environment: ExecutionEnvironment;
	gate: ExactContinuationDispatchGate;
}

export type CreateChildHarness = (
	input: CreateChildHarnessInput,
) => Promise<{ lane: AdaptiveAgentLane; close(): Promise<void> }>;

export interface BranchContinuationOptions {
	journal: ContinuationJournal;
	workspacePort: WorkspaceContinuationPort;
	sessionRepo: SessionRepo<SessionMetadata, { id?: string; parentSessionId?: string }, { cwd?: string }>;
	createChildHarness: CreateChildHarness;
	/**
	 * Stage 7 durable branch-origin freeze. When present, forkExact freezes
	 * the source lane before any child is forked, keeps the freeze after
	 * group_ready, and releases it when the group fails before any dispatch.
	 */
	originRegistry?: BranchOriginRegistry;
	/**
	 * The open source session handle (the source harness's durable session)
	 * used to write the freeze marker. Required together with originRegistry.
	 */
	sourceSession?: Session;
	/**
	 * Stage 8: shared session-handle resolver. Repositories enforce a single
	 * writer per session, so a runtime that already holds the child session
	 * must hand it over instead of opening a second writer.
	 */
	openSession?: (sessionId: string) => Promise<Session>;
}

function isTypedRejection(error: unknown): error is ContinuationRejected {
	return (
		error instanceof NotBranchableCheckpointError ||
		error instanceof SourceCheckpointChangedError ||
		error instanceof WorkspaceSnapshotMismatchError ||
		error instanceof MissingIdentitiesError ||
		error instanceof NonDeterministicRequestPolicyError ||
		error instanceof StateProjectionMismatch ||
		error instanceof RequestFingerprintMismatchError ||
		error instanceof UnsupportedSamplingControlError
	);
}

function reconstructRejection(reason: string): ContinuationRejected {
	const [name, ...rest] = reason.split(": ");
	const message = rest.join(": ");
	switch (name) {
		case "NotBranchableCheckpoint":
			return new NotBranchableCheckpointError(message);
		case "SourceCheckpointChanged":
			return new SourceCheckpointChangedError(message);
		case "WorkspaceSnapshotMismatch":
			return new WorkspaceSnapshotMismatchError(message);
		case "MissingIdentities":
			return new MissingIdentitiesError(message);
		case "NonDeterministicRequestPolicy":
			return new NonDeterministicRequestPolicyError(message);
		case "StateProjectionMismatch":
			return new StateProjectionMismatch(message);
		case "RequestFingerprintMismatch":
			return new RequestFingerprintMismatchError(message);
		case "UnsupportedSamplingControl":
			return new UnsupportedSamplingControlError(message);
		default:
			return new NotBranchableCheckpointError(reason);
	}
}

function rejectionReason(error: ContinuationRejected): string {
	return `${error.name}: ${error.message}`;
}

/** Deterministic child session id: retries reattach instead of creating twins. */
export function continuationChildSessionId(groupId: string, sampleIndex: number): string {
	return sha256Hex(`${groupId}:session:${sampleIndex}`);
}

/** Deterministic group id shared by capture-time and admission-time builders. */
export function exactContinuationGroupId(source: ContinuationCheckpoint, variants: ExactSamplingVariant[]): string {
	return continuationGroupId({
		sourceSessionId: source.sourceSessionId,
		sourceLane: source.sourceLane,
		cursor: source.cursor,
		workspaceSnapshotId: source.workspaceSnapshotId,
		contextFingerprint: source.contextFingerprint,
		requestFingerprint: source.requestFingerprint,
		policyStateFingerprint: source.policyState.fingerprint,
		variants: variants.map((variant) => ({ ...variant })),
	});
}

function cursorEquals(left: unknown, right: LeafTurnCursor): boolean {
	if (typeof left !== "object" || left === null) return false;
	const value = left as Record<string, unknown>;
	return (
		value.operationId === right.operationId &&
		value.assistantEntryId === right.assistantEntryId &&
		value.leafId === right.leafId
	);
}

/**
 * The pre-dispatch second gate of one child: recomputes both fingerprints
 * through the same canonical builder used at capture, compares them with the
 * checkpoint AND the durable `adaptive.run_basis`, applies the sampling
 * variant, and only then lets the provider intent commit.
 */
export function buildExactContinuationDispatchGate(input: {
	checkpoint: ContinuationCheckpoint;
	environment: ExecutionEnvironment;
	variant: ExactSamplingVariant;
}): ExactContinuationDispatchGate {
	return {
		verifyFirstDispatch: async (
			facts: ExactContinuationDispatchFacts,
		): Promise<{ metadataPatch?: Record<string, unknown> } | undefined> => {
			const { checkpoint, environment, variant } = input;
			if (
				facts.hooksRegistered.transformContext ||
				facts.hooksRegistered.beforeRequest ||
				facts.hooksRegistered.beforePayload
			) {
				throw new NonDeterministicRequestPolicyError(
					"transform_context, before_request, or before_payload hooks are registered",
				);
			}
			if (facts.customMessageTransform) {
				throw new NonDeterministicRequestPolicyError("a custom provider message transform is configured");
			}
			const basis = facts.basisData as unknown as {
				schemaVersion?: unknown;
				start?: {
					kind?: unknown;
					source?: { parentSessionId?: unknown; sourceCursor?: unknown };
					contextFingerprint?: unknown;
					requestFingerprint?: unknown;
					fixedToolCatalogFingerprint?: unknown;
					sampling?: { id?: unknown; seed?: unknown };
				};
				inheritedPolicyState?: { fingerprint?: unknown };
			};
			const basisMismatch = (detail: string): RequestFingerprintMismatchError =>
				new RequestFingerprintMismatchError(`durable adaptive.run_basis ${detail}`);
			if (basis.schemaVersion !== 1) throw basisMismatch("has an unsupported schemaVersion");
			if (basis.start?.kind !== "exact_continuation") throw basisMismatch("is not an exact_continuation start");
			if (basis.start.source?.parentSessionId !== checkpoint.sourceSessionId) {
				throw basisMismatch("names a different source session");
			}
			if (!cursorEquals(basis.start.source?.sourceCursor, checkpoint.cursor)) {
				throw basisMismatch("names a different source cursor");
			}
			if (basis.start.contextFingerprint !== checkpoint.contextFingerprint) {
				throw basisMismatch("pins a different context fingerprint");
			}
			if (basis.start.requestFingerprint !== checkpoint.requestFingerprint) {
				throw basisMismatch("pins a different request fingerprint");
			}
			if (basis.start.fixedToolCatalogFingerprint !== checkpoint.fixedToolCatalogFingerprint) {
				throw basisMismatch("pins a different fixed tool catalog fingerprint");
			}
			if (basis.start.sampling?.id !== variant.id || basis.start.sampling?.seed !== variant.seed) {
				throw basisMismatch(
					`pins sampling ${JSON.stringify(basis.start.sampling)}, not the ordered variant ${variant.id}`,
				);
			}
			if (basis.inheritedPolicyState?.fingerprint !== checkpoint.policyState.fingerprint) {
				throw basisMismatch("persists a different inherited policy capsule");
			}
			if (
				facts.configuration.model.provider !== checkpoint.model.provider ||
				facts.configuration.model.modelId !== checkpoint.model.modelId
			) {
				throw new RequestFingerprintMismatchError(
					`model drifted from ${checkpoint.model.provider}/${checkpoint.model.modelId} to ${facts.configuration.model.provider}/${facts.configuration.model.modelId}`,
				);
			}
			if (
				environment.logicalWorkspace.root !== checkpoint.logicalWorkspace.root ||
				environment.logicalWorkspace.contentFingerprint !== checkpoint.logicalWorkspace.contentFingerprint
			) {
				throw new WorkspaceSnapshotMismatchError(
					"the child workspace does not project the checkpoint's logical workspace identity",
				);
			}
			const canonical = buildCanonicalInferenceRequest({
				model: { ...facts.configuration.model },
				thinkingLevel: facts.configuration.thinkingLevel,
				systemPrompt: facts.systemPrompt,
				providerMessages: facts.providerMessages,
				tools: facts.tools,
				sampling: { ...checkpoint.profile.sampling, ...(variant.seed === undefined ? {} : { seed: variant.seed }) },
				streamOptions: facts.streamOptions,
				profile: checkpoint.profile,
				policyBundleFingerprint: checkpoint.policyState.basis.policyBundle.fingerprint,
				projectorVersion: checkpoint.policyState.basis.projectorVersion,
				policyStateFingerprint: checkpoint.policyState.fingerprint,
				fixedToolCatalogFingerprint: checkpoint.fixedToolCatalogFingerprint,
				logicalWorkspace: checkpoint.logicalWorkspace,
			});
			verifyExactRequest(canonical, {
				contextFingerprint: checkpoint.contextFingerprint,
				requestFingerprint: checkpoint.requestFingerprint,
				fixedToolCatalogFingerprint: checkpoint.fixedToolCatalogFingerprint,
				sampling: variant,
				seedCapable: checkpoint.profile.seedCapable,
			});
			return {
				metadataPatch: {
					"pi.exact_continuation.sampling": {
						id: variant.id,
						...(variant.seed === undefined ? {} : { seed: variant.seed }),
					},
				},
			};
		},
	};
}

export class BranchContinuation {
	private readonly options: BranchContinuationOptions;

	constructor(options: BranchContinuationOptions) {
		this.options = options;
	}

	/**
	 * Creates one accepted-but-undispatched continuation Run per ordered
	 * variant from an immutable checkpoint. Same-group retries reattach via
	 * the journal and deterministic child identities; partial groups never
	 * return candidates, so no sibling can dispatch before the whole group is
	 * ready. Storage conflicts fault the group instead of degrading.
	 */
	async forkExact(
		source: ContinuationCheckpoint,
		variants: ExactSamplingVariant[],
	): Promise<LeafTurnExecutionResult<ContinuationCandidate[], ContinuationRejected>> {
		const invalid = validateForkExactInput(source, variants);
		if (invalid !== undefined) return { ok: false, error: invalid };
		const groupId = exactContinuationGroupId(source, variants);
		await this.options.journal.append({
			type: "group_planned",
			groupId,
			source: {
				sessionId: source.sourceSessionId,
				lane: source.sourceLane,
				cursor: structuredClone(source.cursor),
				workspaceSnapshotId: source.workspaceSnapshotId,
				contextFingerprint: source.contextFingerprint,
				requestFingerprint: source.requestFingerprint,
				policyStateFingerprint: source.policyState.fingerprint,
			},
			variants: variants.map((variant) => ({ ...variant })),
		});
		// Durable branch-origin freeze (Stage 7): the source lane becomes a
		// read-only origin before any child can be forked.
		let sourceSession: Session | undefined;
		let frozen = false;
		if (this.options.originRegistry !== undefined) {
			sourceSession = this.options.sourceSession;
			if (sourceSession === undefined) {
				throw new ContinuationGroupFault(
					"an originRegistry is configured but no sourceSession handle is available for the freeze marker",
				);
			}
			await this.options.originRegistry.freeze({
				session: sourceSession,
				lane: source.sourceLane,
				operationId: source.cursor.operationId,
				groupId,
			});
			frozen = true;
		}
		const recorded = await this.options.journal.events(groupId);
		const failed = recorded.find((event) => event.type === "group_failed");
		if (failed !== undefined) {
			return { ok: false, error: reconstructRejection(failed.reason) };
		}

		const candidates: ContinuationCandidate[] = [];
		for (let sampleIndex = 0; sampleIndex < variants.length; sampleIndex++) {
			const variant = variants[sampleIndex]!;
			const childId = continuationChildId(groupId, sampleIndex);
			try {
				candidates.push(await this.forkChild(groupId, childId, sampleIndex, variant, source));
			} catch (error) {
				// A fault or typed rejection mid-group must never leak the
				// already-ready siblings: their harnesses (and session writers)
				// close and their workspace leases release before the group
				// outcome is decided.
				await Promise.all(candidates.map((candidate) => candidate.close().catch(() => undefined)));
				await Promise.all(candidates.map((candidate) => candidate.workspaceLease.release().catch(() => undefined)));
				if (!isTypedRejection(error)) throw error;
				const reason = rejectionReason(error);
				await this.options.journal.append({ type: "child_failed", groupId, childId, sampleIndex, reason });
				await this.options.journal.append({ type: "group_failed", groupId, reason });
				// No child was ever dispatched: the freeze may be safely undone.
				if (frozen && this.options.originRegistry !== undefined && sourceSession !== undefined) {
					await this.options.originRegistry
						.unfreeze({ session: sourceSession, lane: source.sourceLane })
						.catch(() => undefined);
				}
				return { ok: false, error };
			}
		}
		try {
			await this.options.journal.append({ type: "group_ready", groupId });
		} catch (error) {
			await Promise.all(candidates.map((candidate) => candidate.close().catch(() => undefined)));
			await Promise.all(candidates.map((candidate) => candidate.workspaceLease.release().catch(() => undefined)));
			throw error;
		}
		// group_ready: the source stays a permanently frozen branch origin.
		// The caller owns the sourceSession handle; it is never closed here.
		return { ok: true, value: candidates };
	}

	private async forkChild(
		groupId: string,
		childId: string,
		sampleIndex: number,
		variant: ExactSamplingVariant,
		source: ContinuationCheckpoint,
	): Promise<ContinuationCandidate> {
		const journal = this.options.journal;
		const recorded = await journal.events(groupId);
		const byType = (type: ContinuationJournalEvent["type"]): ContinuationJournalEvent | undefined =>
			recorded.find((event) => event.type === type && "childId" in event && event.childId === childId);

		let session: Session | undefined;
		let workspaceLease: WorkspaceLease | undefined;
		let created: Awaited<ReturnType<CreateChildHarness>> | undefined;
		try {
			const sessionId = continuationChildSessionId(groupId, sampleIndex);
			session = await this.forkChildSession(groupId, childId, sampleIndex, sessionId, source, byType);
			workspaceLease = await this.forkChildWorkspace(groupId, childId, sampleIndex, source, byType);
			const environment = workspaceLease.environment;

			const basis: HarnessV4LeafTurnBasis = {
				schemaVersion: 1,
				taskId: source.policyState.basis.taskId,
				// Stage 8 (S8.2): the child run basis names the child candidate
				// id; the inherited capsule stays the unchanged source capsule.
				// Model-invisible: sibling request fingerprints do not change.
				candidateId: childId,
				policyBundle: structuredClone(source.policyState.basis.policyBundle),
				projectorVersion: source.policyState.basis.projectorVersion,
				inheritedPolicyState: structuredClone(source.policyState),
				start: {
					kind: "exact_continuation",
					source: {
						parentSessionId: source.sourceSessionId,
						sourceCursor: structuredClone(source.cursor),
					},
					contextFingerprint: source.contextFingerprint,
					requestFingerprint: source.requestFingerprint,
					fixedToolCatalogFingerprint: source.fixedToolCatalogFingerprint,
					sampling: structuredClone(variant),
				},
			};

			const gate = buildExactContinuationDispatchGate({ checkpoint: source, environment, variant });
			created = await this.options.createChildHarness({ session, variant, checkpoint: source, environment, gate });
			const acceptedEvent = byType("child_run_accepted");
			let acceptedRun: { operationId: string; basisEntryId: string };
			if (acceptedEvent !== undefined && acceptedEvent.type === "child_run_accepted") {
				acceptedRun = await this.verifyAcceptedRun(session, source, {
					operationId: acceptedEvent.operationId,
					basisEntryId: acceptedEvent.basisEntryId,
				});
			} else {
				const attached = await this.attachExistingRun(session, source);
				acceptedRun = attached ?? (await this.acceptChildRun(created.lane, source, basis));
				await journal.append({
					type: "child_run_accepted",
					groupId,
					childId,
					sampleIndex,
					operationId: acceptedRun.operationId,
					basisEntryId: acceptedRun.basisEntryId,
				});
			}
			await journal.append({ type: "child_ready", groupId, childId, sampleIndex });
			const executor = new HarnessV4LeafTurnAdapter({ lane: created.lane, basis: structuredClone(basis) });
			return {
				groupId,
				childId,
				sampleIndex,
				variant: structuredClone(variant),
				sessionId,
				session,
				lane: source.sourceLane,
				laneHandle: created.lane,
				cursor: structuredClone(source.cursor),
				workspaceLease,
				environment,
				checkpoint: structuredClone(source),
				policyCapsule: structuredClone(source.policyState),
				acceptedRun,
				executor,
				close: created.close,
			};
		} catch (error) {
			await created?.close().catch(() => undefined);
			// The harness owns the session handle; without a harness the forked
			// handle must not leak an active writer into a later reattach.
			await session?.close().catch(() => undefined);
			await workspaceLease?.release().catch(() => undefined);
			throw error;
		}
	}

	private async forkChildSession(
		groupId: string,
		childId: string,
		sampleIndex: number,
		sessionId: string,
		source: ContinuationCheckpoint,
		byType: (type: ContinuationJournalEvent["type"]) => ContinuationJournalEvent | undefined,
	): Promise<Session> {
		const journal = this.options.journal;
		const forkedEvent = byType("child_session_forked");
		if (forkedEvent !== undefined && forkedEvent.type === "child_session_forked") {
			if (forkedEvent.sessionId !== sessionId || forkedEvent.lane !== source.sourceLane) {
				throw new ContinuationGroupFault(
					`Journal child session ${childId} does not match its deterministic identity`,
				);
			}
			const session = await this.openChildSession(sessionId);
			await this.verifyForkedPrefix(session, source);
			return session;
		}
		const metadata = await this.findSessionMetadata(source.sourceSessionId);
		let session: Session;
		try {
			session = await this.options.sessionRepo.fork(metadata, {
				scope: "branch",
				lane: source.sourceLane,
				entryId: source.cursor.leafId,
				position: "at",
				id: sessionId,
			});
		} catch (error) {
			// Crash window: the fork committed but the journal append did not.
			// The deterministic id makes the existing child reattachable.
			if (error instanceof SessionError && error.code === "already_exists") {
				const existing = await this.openChildSession(sessionId);
				await this.verifyForkedPrefix(existing, source);
				session = existing;
			} else {
				throw error;
			}
		}
		try {
			await journal.append({
				type: "child_session_forked",
				groupId,
				childId,
				sampleIndex,
				sessionId,
				lane: source.sourceLane,
			});
		} catch (error) {
			// The journal is the authority; without the event a retry would
			// fork a twin, so the unjournaled child must not stay open.
			await session.close().catch(() => undefined);
			throw error;
		}
		return session;
	}

	private async forkChildWorkspace(
		groupId: string,
		childId: string,
		sampleIndex: number,
		source: ContinuationCheckpoint,
		byType: (type: ContinuationJournalEvent["type"]) => ContinuationJournalEvent | undefined,
	): Promise<WorkspaceLease> {
		const journal = this.options.journal;
		const lease = await this.options.workspacePort.fork(source.workspaceSnapshotId, childId);
		if (
			lease.environment.logicalWorkspace.root !== source.logicalWorkspace.root ||
			lease.environment.logicalWorkspace.contentFingerprint !== source.logicalWorkspace.contentFingerprint
		) {
			throw new WorkspaceSnapshotMismatchError(
				`child ${childId} workspace projects ${JSON.stringify(lease.environment.logicalWorkspace)}, not the checkpoint identity`,
			);
		}
		const recorded = byType("child_workspace_ready");
		if (recorded !== undefined && recorded.type === "child_workspace_ready") {
			// Durable lease identity: same snapshotId + childId must reattach,
			// and a different lease id or snapshot is a content conflict.
			if (recorded.leaseId !== lease.id || recorded.snapshotId !== source.workspaceSnapshotId) {
				throw new ContinuationGroupFault(
					`Journal workspace ${childId} records lease ${recorded.leaseId}/${recorded.snapshotId}, but the reattached lease is ${lease.id}/${source.workspaceSnapshotId}`,
				);
			}
		} else {
			try {
				await journal.append({
					type: "child_workspace_ready",
					groupId,
					childId,
					sampleIndex,
					leaseId: lease.id,
					snapshotId: source.workspaceSnapshotId,
				});
			} catch (error) {
				await lease.release().catch(() => undefined);
				throw error;
			}
		}
		return lease;
	}

	private async acceptChildRun(
		lane: AdaptiveAgentLane,
		source: ContinuationCheckpoint,
		basis: HarnessV4LeafTurnBasis,
	): Promise<{ operationId: string; basisEntryId: string }> {
		const admitted = await lane.acceptAdaptiveContinuation(basis as unknown as { [key: string]: JsonValue }, {
			systemPromptOverride: source.resolvedSystemPrompt,
		});
		if (!admitted.ok) {
			switch (admitted.error._tag) {
				case "MissingIdentities":
					throw new MissingIdentitiesError(
						`child admission is missing ${[...admitted.error.tools, ...admitted.error.models].join(", ")}`,
					);
				case "InvalidMessage":
					throw new NotBranchableCheckpointError(admitted.error.reason);
				case "LaneBusy":
				case "Closed":
					throw new ContinuationGroupFault(`Child admission failed with ${admitted.error._tag}`);
			}
		}
		return { operationId: admitted.value.operationId, basisEntryId: admitted.value.basisEntryId };
	}

	/** Reattach an already-admitted Run that the journal has not recorded yet. */
	private async attachExistingRun(
		session: Session,
		source: ContinuationCheckpoint,
	): Promise<{ operationId: string; basisEntryId: string } | undefined> {
		const laneState = await session.getRegister("lane.state", source.sourceLane);
		if (laneState === undefined) {
			throw new ContinuationGroupFault(`Child lane ${source.sourceLane} has no state register`);
		}
		const operationId = laneState.value.currentOperationId;
		if (operationId === null) return undefined;
		const operation = await session.getRegister("op.meta", operationId);
		if (operation === undefined) throw new ContinuationGroupFault(`Child operation ${operationId} has no metadata`);
		if (operation.value.intent.kind !== "run" || operation.value.intent.adaptive === undefined) {
			throw new ContinuationGroupFault(`Child operation ${operationId} is not an adaptive continuation Run`);
		}
		const basisEntryId = operation.value.intent.adaptive.basisEntryId;
		const basisEntry = (await session.getEntries([basisEntryId])).get(basisEntryId);
		if (
			basisEntry === undefined ||
			basisEntry.type !== "custom" ||
			basisEntry.customType !== ADAPTIVE_RUN_BASIS_CUSTOM_TYPE
		) {
			throw new ContinuationGroupFault(`Child operation ${operationId} has no run basis entry`);
		}
		const data = basisEntry.data as unknown as {
			start?: { kind?: unknown; source?: { parentSessionId?: unknown; sourceCursor?: unknown } };
		};
		if (data.start?.kind !== "exact_continuation") return undefined;
		if (data.start.source?.parentSessionId !== source.sourceSessionId) return undefined;
		if (!cursorEquals(data.start.source?.sourceCursor, source.cursor)) return undefined;
		return { operationId, basisEntryId };
	}

	private async verifyAcceptedRun(
		session: Session,
		source: ContinuationCheckpoint,
		accepted: { operationId: string; basisEntryId: string },
	): Promise<{ operationId: string; basisEntryId: string }> {
		const laneState = await session.getRegister("lane.state", source.sourceLane);
		if (laneState === undefined) {
			throw new ContinuationGroupFault(`Child lane ${source.sourceLane} has no state register`);
		}
		if (laneState.value.currentOperationId !== accepted.operationId) {
			// A Run that already settled: the lane is idle and the terminal
			// transaction deleted the op.* registers. The durable provenance
			// is lane.lastResult plus the retained run basis entry.
			const lastResult = await session.getRegister("lane.lastResult", source.sourceLane);
			if (lastResult === undefined || lastResult.value.operationId !== accepted.operationId) {
				throw new ContinuationGroupFault(
					`Journal records an accepted Run ${accepted.operationId} that is not the child lane's current operation`,
				);
			}
		} else {
			const operation = await session.getRegister("op.meta", accepted.operationId);
			if (
				operation === undefined ||
				operation.value.intent.kind !== "run" ||
				operation.value.intent.adaptive?.basisEntryId !== accepted.basisEntryId
			) {
				throw new ContinuationGroupFault(
					`Journal records an accepted Run ${accepted.operationId} without a matching basis intent`,
				);
			}
		}
		const basisEntry = (await session.getEntries([accepted.basisEntryId])).get(accepted.basisEntryId);
		if (
			basisEntry === undefined ||
			basisEntry.type !== "custom" ||
			basisEntry.customType !== ADAPTIVE_RUN_BASIS_CUSTOM_TYPE
		) {
			throw new ContinuationGroupFault(`Journal records a missing run basis entry ${accepted.basisEntryId}`);
		}
		return { operationId: accepted.operationId, basisEntryId: accepted.basisEntryId };
	}

	private async openChildSession(sessionId: string): Promise<Session> {
		if (this.options.openSession !== undefined) return this.options.openSession(sessionId);
		const metadata = await this.findSessionMetadata(sessionId);
		return this.options.sessionRepo.open(metadata);
	}

	private async findSessionMetadata(sessionId: string): Promise<Session["metadata"]> {
		const listed = await this.options.sessionRepo.list();
		const metadata = listed.find((candidate) => candidate.id === sessionId);
		if (metadata === undefined) {
			throw new ContinuationGroupFault(`Session ${sessionId} is missing from the session repository`);
		}
		return metadata;
	}

	private async verifyForkedPrefix(session: Session, source: ContinuationCheckpoint): Promise<void> {
		const leafEntry = (await session.getEntries([source.cursor.leafId])).get(source.cursor.leafId);
		if (leafEntry === undefined) {
			throw new ContinuationGroupFault(`Child session is missing the checkpoint leaf entry ${source.cursor.leafId}`);
		}
	}
}

function validateForkExactInput(
	source: ContinuationCheckpoint,
	variants: ExactSamplingVariant[],
): ContinuationRejected | undefined {
	const checkpointInvalid = validateContinuationCheckpoint(source);
	if (checkpointInvalid !== undefined) return checkpointInvalid;
	if (variants.length === 0) return new NotBranchableCheckpointError("at least one sampling variant is required");
	const seen = new Set<string>();
	for (const variant of variants) {
		if (typeof variant.id !== "string" || variant.id.length === 0) {
			return new NotBranchableCheckpointError("sampling variant ids must be non-empty strings");
		}
		if (seen.has(variant.id)) return new NotBranchableCheckpointError(`duplicate sampling variant id ${variant.id}`);
		seen.add(variant.id);
		if (variant.seed !== undefined && !Number.isSafeInteger(variant.seed)) {
			return new NotBranchableCheckpointError(`sampling variant ${variant.id} seed must be a safe integer`);
		}
		if (variant.seed !== undefined && !source.profile.seedCapable) {
			return new UnsupportedSamplingControlError(
				`sampling variant ${variant.id} requests seed ${variant.seed} but the provider does not support seeds`,
			);
		}
	}
	return undefined;
}
