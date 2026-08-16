import { type AgentHarnessStreamOptions, type AgentTool, convertToLlm } from "@earendil-works/pi-agent-core";
import {
	type AdaptiveAgentLane,
	buildContextMessages,
	type CustomEntry,
	type Session,
} from "@earendil-works/pi-agent-core/harness-v4";
import {
	buildCanonicalInferenceRequest,
	canonicalContextFingerprint,
	canonicalRequestFingerprint,
	type ExactRequestProfile,
	MissingIdentitiesError,
	NonDeterministicRequestPolicyError,
	type WorkspaceSnapshotMismatchError,
} from "./exact-request.ts";
import {
	type LogicalWorkspaceIdentity,
	UnsupportedWorkspaceError,
	type WorkspaceContinuationPort,
	type WorkspaceMetadata,
} from "./execution-environment.ts";
import {
	ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
	type AdaptiveRunBasisData,
	type CandidatePolicyStateCapsule,
	type ProjectionBasis,
} from "./harness-v4-contract.ts";
import type { LeafTurnCursor, LeafTurnExecutionResult } from "./leaf-turn-executor.ts";
import { computeToolCatalogFingerprint, isSha256Fingerprint } from "./policy-bundle.ts";
import {
	type CandidateStateProjector,
	PolicyProjectionFault,
	StateProjectionMismatch,
	validateCapsule,
} from "./state-projector.ts";

/** The source lane is not at a branchable post-turn continuation checkpoint. */
export class NotBranchableCheckpointError extends Error {
	constructor(detail: string) {
		super(`Not branchable checkpoint: ${detail}`);
		this.name = "NotBranchableCheckpoint";
	}
}

/** The source cursor/leaf changed during the leased capture window. */
export class SourceCheckpointChangedError extends Error {
	constructor(detail: string) {
		super(`Source checkpoint changed: ${detail}`);
		this.name = "SourceCheckpointChanged";
	}
}

export type CheckpointCaptureRejected =
	| NotBranchableCheckpointError
	| SourceCheckpointChangedError
	| WorkspaceSnapshotMismatchError
	| MissingIdentitiesError
	| NonDeterministicRequestPolicyError
	| StateProjectionMismatch
	| { kind: "closed"; message: string };

/**
 * Immutable branchable checkpoint: the frozen committed conversation plus the
 * workspace snapshot, canonical request fingerprints, and the projected
 * policy-state capsule. Every exact sibling is admitted from this value.
 */
export interface ContinuationCheckpoint {
	sourceSessionId: string;
	sourceLane: string;
	cursor: LeafTurnCursor;
	workspaceSnapshotId: string;
	/** Real capture fingerprint (equals logicalWorkspace.contentFingerprint). */
	workspaceFingerprint: string;
	logicalWorkspace: LogicalWorkspaceIdentity;
	contextFingerprint: string;
	requestFingerprint: string;
	policyState: CandidatePolicyStateCapsule;
	fixedToolCatalogFingerprint: string;
	/** Resolved system prompt pinned into each child's continuation intent. */
	resolvedSystemPrompt: string;
	model: { provider: string; modelId: string };
	profile: ExactRequestProfile;
}

export interface CaptureCheckpointInput {
	/** Adaptive lane of the source harness (owns the capture seam). */
	lane: AdaptiveAgentLane;
	/** Durable source session handle; reads happen under the capture lease. */
	session: Session;
	projector: CandidateStateProjector;
	workspacePort: WorkspaceContinuationPort;
	workspaceMetadata: WorkspaceMetadata;
	logicalRoot: string;
	tools: AgentTool[];
	/** Resolved system prompt of the source run's next request. */
	systemPrompt: string;
	streamOptions: AgentHarnessStreamOptions;
	profile: ExactRequestProfile;
	/** Fail-closed: a custom provider-message transform cannot be proven stable. */
	customMessageTransform?: boolean;
	/** Fail-closed: registered custom entry projectors cannot be proven stable. */
	entryProjectors?: Record<string, unknown>;
}

export async function captureContinuationCheckpoint(
	input: CaptureCheckpointInput,
): Promise<LeafTurnExecutionResult<ContinuationCheckpoint, CheckpointCaptureRejected>> {
	try {
		return await captureContinuationCheckpointWithin(input);
	} catch (error) {
		const rejected = toCaptureRejected(error);
		if (rejected !== undefined) return { ok: false, error: rejected };
		throw error;
	}
}

/** Typed business rejections raised inside the leased capture callback. */
function toCaptureRejected(error: unknown): CheckpointCaptureRejected | undefined {
	if (error instanceof NotBranchableCheckpointError) return error;
	if (error instanceof SourceCheckpointChangedError) return error;
	if (error instanceof NonDeterministicRequestPolicyError) return error;
	if (error instanceof MissingIdentitiesError) return error;
	if (error instanceof StateProjectionMismatch) return error;
	return undefined;
}

async function captureContinuationCheckpointWithin(
	input: CaptureCheckpointInput,
): Promise<LeafTurnExecutionResult<ContinuationCheckpoint, CheckpointCaptureRejected>> {
	const captured = await input.lane.capturePostTurnCheckpoint(async (info) => {
		if (input.customMessageTransform === true) {
			throw new NonDeterministicRequestPolicyError("custom provider message transforms are not exact-compatible");
		}
		if (input.entryProjectors !== undefined && Object.keys(input.entryProjectors).length > 0) {
			throw new NonDeterministicRequestPolicyError("custom entry projectors are not exact-compatible");
		}
		let workspaceSnapshot: Awaited<ReturnType<WorkspaceContinuationPort["snapshot"]>>;
		try {
			workspaceSnapshot = await input.workspacePort.snapshot(input.workspaceMetadata, input.logicalRoot);
		} catch (error) {
			if (error instanceof UnsupportedWorkspaceError) {
				throw new NotBranchableCheckpointError(`workspace isolation is unavailable: ${error.message}`);
			}
			throw error;
		}
		const entries = await input.session
			.view(info.lane)
			.findEntriesOnBranch({ start: info.turnCursor.leafId, order: "oldestFirst" });
		const messages = await buildContextMessages(entries);
		const providerMessages = convertToLlm(messages);

		const sourceBasisEntry = await nearestRunBasisEntry(input.session, info.lane, info.turnCursor.leafId);
		const sourceBasis = parseRunBasisData(sourceBasisEntry);

		const cursor: LeafTurnCursor = {
			operationId: info.operationId,
			assistantEntryId: info.turnCursor.assistantEntryId,
			leafId: info.turnCursor.leafId,
		};
		const basis: ProjectionBasis = {
			taskId: sourceBasis.taskId,
			candidateId: sourceBasis.candidateId,
			sessionId: input.session.metadata.id,
			lane: info.lane,
			operationId: info.operationId,
			cursor: { kind: "post_turn", cursor: structuredClone(cursor) },
			policyBundle: structuredClone(sourceBasis.policyBundle),
			projectorVersion: sourceBasis.projectorVersion,
			inheritedStateFingerprint: sourceBasis.inheritedPolicyState.fingerprint,
		};
		let policyState: CandidatePolicyStateCapsule;
		try {
			policyState = await input.projector.project(basis, { session: input.session });
		} catch (error) {
			if (error instanceof StateProjectionMismatch) throw error;
			if (error instanceof PolicyProjectionFault) {
				throw new MissingIdentitiesError(`policy identity is unavailable: ${error.message}`);
			}
			throw error;
		}
		validateCheckpointConsistency(policyState, cursor, input.session.metadata.id, info.lane);

		const fixedToolCatalogFingerprint = computeToolCatalogFingerprint(input.tools);
		const canonical = buildCanonicalInferenceRequest({
			model: { provider: info.configuration.model.provider, modelId: info.configuration.model.modelId },
			thinkingLevel: info.configuration.thinkingLevel,
			systemPrompt: input.systemPrompt,
			providerMessages,
			tools: input.tools,
			sampling: input.profile.sampling,
			streamOptions: input.streamOptions,
			profile: input.profile,
			policyBundleFingerprint: policyState.basis.policyBundle.fingerprint,
			projectorVersion: policyState.basis.projectorVersion,
			policyStateFingerprint: policyState.fingerprint,
			fixedToolCatalogFingerprint,
			logicalWorkspace: workspaceSnapshot.logical,
		});
		return {
			sourceSessionId: input.session.metadata.id,
			sourceLane: info.lane,
			cursor,
			workspaceSnapshotId: workspaceSnapshot.id,
			workspaceFingerprint: workspaceSnapshot.logical.contentFingerprint,
			logicalWorkspace: structuredClone(workspaceSnapshot.logical),
			contextFingerprint: canonicalContextFingerprint(canonical),
			requestFingerprint: canonicalRequestFingerprint(canonical),
			policyState: structuredClone(policyState),
			fixedToolCatalogFingerprint,
			resolvedSystemPrompt: input.systemPrompt,
			model: {
				provider: info.configuration.model.provider,
				modelId: info.configuration.model.modelId,
			},
			profile: structuredClone(input.profile),
		} satisfies ContinuationCheckpoint;
	});
	if (!captured.ok) return { ok: false, error: mapCaptureRejection(captured.error) };
	return { ok: true, value: captured.value };
}

function mapCaptureRejection(rejection: { _tag: string; message: string }): CheckpointCaptureRejected {
	switch (rejection._tag) {
		case "NoActiveOperation":
			return new NotBranchableCheckpointError(
				"the source lane has no open Run; settled or suspended runs are not branchable",
			);
		case "NotPostTurnCheckpoint":
			return new NotBranchableCheckpointError(rejection.message);
		case "CheckpointChanged":
			return new SourceCheckpointChangedError(rejection.message);
		default:
			return { kind: "closed", message: rejection.message };
	}
}

/**
 * DESIGN 5.8 consistency rule: the top-level source session/lane/cursor must
 * equal the checkpoint's projected policy-state basis.
 */
function validateCheckpointConsistency(
	policyState: CandidatePolicyStateCapsule,
	cursor: LeafTurnCursor,
	sessionId: string,
	lane: string,
): void {
	const basis = policyState.basis;
	if (basis.sessionId !== sessionId || basis.lane !== lane) {
		throw new StateProjectionMismatch(
			`Checkpoint session/lane ${sessionId}/${lane} does not match the policy-state basis ${basis.sessionId}/${basis.lane}`,
		);
	}
	if (basis.cursor.kind !== "post_turn") {
		throw new StateProjectionMismatch(`Checkpoint policy-state basis cursor is ${basis.cursor.kind}, not post_turn`);
	}
	const projected = basis.cursor.cursor;
	if (
		projected.operationId !== cursor.operationId ||
		projected.assistantEntryId !== cursor.assistantEntryId ||
		projected.leafId !== cursor.leafId
	) {
		throw new StateProjectionMismatch("Checkpoint cursor does not match the policy-state basis cursor");
	}
}

/**
 * Structural validation of an immutable checkpoint before any child work:
 * capsule shape plus the DESIGN 5.8 source/basis consistency rule. A valid
 * checkpoint is rejected with a typed error; drift against the recomputed
 * fingerprints is caught by the pre-dispatch gate instead.
 */
export function validateContinuationCheckpoint(
	checkpoint: ContinuationCheckpoint,
): ContinuationRejectedCheckpoint | undefined {
	if (typeof checkpoint.sourceSessionId !== "string" || checkpoint.sourceSessionId.length === 0) {
		return new NotBranchableCheckpointError("checkpoint has no source session id");
	}
	if (typeof checkpoint.sourceLane !== "string" || checkpoint.sourceLane.length === 0) {
		return new NotBranchableCheckpointError("checkpoint has no source lane");
	}
	const cursor = checkpoint.cursor;
	if (
		typeof cursor?.operationId !== "string" ||
		typeof cursor?.assistantEntryId !== "string" ||
		typeof cursor?.leafId !== "string"
	) {
		return new NotBranchableCheckpointError("checkpoint has an invalid cursor");
	}
	if (
		!isSha256Fingerprint(checkpoint.workspaceSnapshotId) ||
		!isSha256Fingerprint(checkpoint.workspaceFingerprint) ||
		!isSha256Fingerprint(checkpoint.contextFingerprint) ||
		!isSha256Fingerprint(checkpoint.requestFingerprint) ||
		!isSha256Fingerprint(checkpoint.fixedToolCatalogFingerprint)
	) {
		return new NotBranchableCheckpointError("checkpoint fingerprints must be sha256 digests");
	}
	if (checkpoint.workspaceFingerprint !== checkpoint.logicalWorkspace.contentFingerprint) {
		return new NotBranchableCheckpointError(
			"checkpoint workspace fingerprint does not match its logical workspace identity",
		);
	}
	if (
		typeof checkpoint.logicalWorkspace?.root !== "string" ||
		checkpoint.logicalWorkspace.root.length === 0 ||
		!isSha256Fingerprint(checkpoint.logicalWorkspace.contentFingerprint)
	) {
		return new NotBranchableCheckpointError("checkpoint has an invalid logical workspace identity");
	}
	if (
		typeof checkpoint.model?.provider !== "string" ||
		checkpoint.model.provider.length === 0 ||
		typeof checkpoint.model?.modelId !== "string" ||
		checkpoint.model.modelId.length === 0
	) {
		return new NotBranchableCheckpointError("checkpoint has an invalid model identity");
	}
	if (
		typeof checkpoint.profile?.hookProfileVersion !== "string" ||
		checkpoint.profile.hookProfileVersion.length === 0 ||
		typeof checkpoint.profile?.resourceProfileVersion !== "string" ||
		checkpoint.profile.resourceProfileVersion.length === 0 ||
		typeof checkpoint.profile?.contextPolicy?.version !== "string" ||
		checkpoint.profile.contextPolicy.version.length === 0
	) {
		return new NotBranchableCheckpointError("checkpoint has an invalid exact request profile");
	}
	for (const [field, value] of [
		["temperature", checkpoint.profile.sampling.temperature],
		["topP", checkpoint.profile.sampling.topP],
		["maxTokens", checkpoint.profile.sampling.maxTokens],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
			return new NotBranchableCheckpointError(`checkpoint sampling ${field} is invalid`);
		}
	}
	if (typeof checkpoint.resolvedSystemPrompt !== "string") {
		return new NotBranchableCheckpointError("checkpoint has no resolved system prompt");
	}
	const capsuleInvalid = validateCapsule(checkpoint.policyState);
	if (capsuleInvalid !== undefined) {
		return new NotBranchableCheckpointError(`checkpoint policy capsule is invalid: ${capsuleInvalid}`);
	}
	try {
		validateCheckpointConsistency(
			checkpoint.policyState,
			checkpoint.cursor,
			checkpoint.sourceSessionId,
			checkpoint.sourceLane,
		);
	} catch (error) {
		if (error instanceof StateProjectionMismatch) return error;
		throw error;
	}
	return undefined;
}

export type ContinuationRejectedCheckpoint = NotBranchableCheckpointError | StateProjectionMismatch;

async function nearestRunBasisEntry(session: Session, lane: string, leafId: string): Promise<CustomEntry> {
	const matches = await session.view(lane).findEntriesOnBranch({
		start: leafId,
		customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
		limit: 1,
	});
	const entry = matches[0];
	if (entry === undefined || entry.type !== "custom") {
		throw new NotBranchableCheckpointError(`no ${ADAPTIVE_RUN_BASIS_CUSTOM_TYPE} entry on the branch of ${leafId}`);
	}
	return entry;
}

function parseRunBasisData(entry: CustomEntry): AdaptiveRunBasisData {
	const data = entry.data;
	if (typeof data !== "object" || data === null) {
		throw new NotBranchableCheckpointError(`run basis entry ${entry.id} has no data`);
	}
	const basis = data as unknown as AdaptiveRunBasisData;
	if (basis.schemaVersion !== 1 || typeof basis.operationId !== "string" || basis.operationId.length === 0) {
		throw new NotBranchableCheckpointError(`run basis entry ${entry.id} is invalid`);
	}
	if (basis.start?.kind !== "prompt" && basis.start?.kind !== "exact_continuation") {
		throw new NotBranchableCheckpointError(`run basis entry ${entry.id} has an unsupported start`);
	}
	if (
		typeof basis.taskId !== "string" ||
		basis.taskId.length === 0 ||
		typeof basis.candidateId !== "string" ||
		basis.candidateId.length === 0
	) {
		throw new NotBranchableCheckpointError(`run basis entry ${entry.id} has invalid task or candidate identity`);
	}
	return basis;
}
