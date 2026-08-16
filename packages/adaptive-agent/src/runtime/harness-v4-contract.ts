import type { CandidatePolicyState, WorkspaceMetadata } from "./candidate-policy-state.ts";
import type { LeafTurnCursor, LeafTurnJsonValue } from "./leaf-turn-executor.ts";
import type { PolicyBundleRef } from "./policy-bundle.ts";

export const ADAPTIVE_RUN_BASIS_CUSTOM_TYPE = "adaptive.run_basis" as const;
export const ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE = "adaptive.tool_batch" as const;

export type ProjectionBasis = {
	taskId: string;
	candidateId: string;
	sessionId: string;
	lane: string;
	operationId: string;
	cursor:
		| { kind: "task_origin" }
		| {
				kind: "post_turn";
				cursor: LeafTurnCursor;
				terminalOutcome?: "completed" | "failed" | "aborted";
		  }
		| { kind: "tool_batch_start"; assistantEntryId: string };
	policyBundle: PolicyBundleRef;
	projectorVersion: string;
	inheritedStateFingerprint: string;
	/** Caller-pinned workspace metadata snapshot participating in the projection. */
	workspaceMetadata?: WorkspaceMetadata;
};

export type CandidatePolicyStateRef = {
	basis: ProjectionBasis;
	fingerprint: string;
};

/**
 * Canonical projector-owned payload. Its semantics are pinned by
 * projectorVersion and the PolicyBundle fingerprint.
 */
export type CandidatePolicyStateSnapshot = CandidatePolicyState;

export type CandidatePolicyStateCapsule = CandidatePolicyStateRef & {
	snapshot: CandidatePolicyStateSnapshot;
};

export type ExactSamplingVariant = {
	id: string;
	seed?: number;
};

export type AdaptiveRunStart =
	| { kind: "prompt" }
	| {
			kind: "exact_continuation";
			source: {
				parentSessionId: string;
				sourceCursor: LeafTurnCursor;
			};
			contextFingerprint: string;
			requestFingerprint: string;
			fixedToolCatalogFingerprint: string;
			sampling: ExactSamplingVariant;
	  };

export type AdaptiveRunBasisData = {
	schemaVersion: 1;
	operationId: string;
	taskId: string;
	candidateId: string;
	policyBundle: PolicyBundleRef;
	projectorVersion: string;
	inheritedPolicyState: CandidatePolicyStateCapsule;
	start: AdaptiveRunStart;
};

export type AdaptiveRunIntent = {
	kind: "run";
	promptEntryIds: string[];
	adaptive: { basisEntryId: string };
	systemPromptOverride?: string;
	resumeData?: Record<string, LeafTurnJsonValue>;
};

export type DurableToolDecision =
	| {
			kind: "allow" | "argument_guard";
			sourceIndex: number;
			toolCallId: string;
			toolName: string;
			effectiveArgs: Record<string, LeafTurnJsonValue>;
			replay: "safe" | "never";
	  }
	| {
			kind: "block";
			sourceIndex: number;
			toolCallId: string;
			toolName: string;
			reason: string;
	  };

export type AdaptiveToolBatchData = {
	schemaVersion: 1;
	policyStateFingerprint: string;
	decisions: DurableToolDecision[];
};

export type ToolBatchPolicyBasis = CandidatePolicyStateRef & {
	basis: ProjectionBasis & {
		cursor: { kind: "tool_batch_start"; assistantEntryId: string };
	};
};

export type AdaptiveCustomEntryPayloads = {
	[ADAPTIVE_RUN_BASIS_CUSTOM_TYPE]: AdaptiveRunBasisData;
	[ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE]: AdaptiveToolBatchData;
};
