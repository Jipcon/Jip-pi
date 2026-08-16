import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, DeferredHandle, ToolResultMessage, Usage } from "@earendil-works/pi-ai";

export type LeafTurnJsonValue =
	| null
	| boolean
	| number
	| string
	| LeafTurnJsonValue[]
	| { [key: string]: LeafTurnJsonValue };

/** Structural result owned by the Adaptive Interface, independent of a Harness version. */
export type LeafTurnExecutionResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type LeafTurnOperationKind = "run" | "compaction" | "navigation";

export interface LeafTurnOperationError {
	code: string;
	message: string;
	details?: LeafTurnJsonValue;
}

type OptionalFinalAssistant =
	| { finalEntryId: string; finalMessage: AssistantMessage }
	| { finalEntryId?: never; finalMessage?: never };

/** Terminal Run outcome normalized from the Harness Adapter. */
export type LeafTurnRunSettlement =
	| ({ kind: "completed"; leafId: string } & OptionalFinalAssistant)
	| ({ kind: "aborted"; leafId: string } & OptionalFinalAssistant)
	| ({ kind: "failed"; leafId: string; error: LeafTurnOperationError } & OptionalFinalAssistant);

/** Open operation descriptor normalized from Harness v4 restore/suspension state. */
export interface LeafTurnSuspension {
	lane: string;
	operationId: string;
	kind: LeafTurnOperationKind;
	reason: "crash" | "deferred" | "missing_identities";
	startedAt: number;
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

/** Durable post-turn cursor; never use a process-local turn id for concurrency control. */
export type LeafTurnCursor = {
	operationId: string;
	assistantEntryId: string;
	leafId: string;
};

/** Start a new Run or advance an already-open Run by at most one assistant turn. */
export type LeafTurnCommand =
	| {
			kind: "start";
			prompt: AgentMessage | AgentMessage[];
	  }
	| {
			kind: "advance";
			afterCursor?: LeafTurnCursor;
	  };

/** Durable result of one assistant response and its complete tool batch. */
export interface LeafTurnResult {
	operationId: string;
	cursor: LeafTurnCursor;
	beforeLeafId: string | null;
	afterLeafId: string;
	assistantEntryId: string;
	toolResultEntryIds: string[];
	usageRowIds: string[];
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	/** Convenience aggregate; usageRowIds are the durable ledger references. */
	usage: Usage;
}

export type LeafTurnOutcome =
	| {
			kind: "turn";
			turn: LeafTurnResult;
			run: { kind: "open" } | { kind: "settled"; result: LeafTurnRunSettlement };
	  }
	| {
			kind: "suspended";
			operation: LeafTurnSuspension;
	  };

export interface CheckpointMismatch {
	kind: "checkpoint_mismatch";
	expected: LeafTurnCursor;
	actual: LeafTurnCursor | null;
	message: string;
}

export interface DriverBusy {
	kind: "driver_busy";
	message: string;
}

export interface LeafTurnLaneBusy {
	kind: "lane_busy";
	lane: string;
	operationId: string;
	operationKind: LeafTurnOperationKind;
	message: string;
}

export interface LeafTurnMissingIdentities {
	kind: "missing_identities";
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}

export interface LeafTurnInvalidMessage {
	kind: "invalid_message";
	lane: string;
	reason: string;
	message: string;
}

export interface LeafTurnNothingToResume {
	kind: "nothing_to_resume";
	lane: string;
	message: string;
}

export interface LeafTurnUnexpectedOperation {
	kind: "unexpected_operation";
	lane: string;
	operationId: string;
	operationKind: Exclude<LeafTurnOperationKind, "run">;
	message: string;
}

export interface LeafTurnClosed {
	kind: "closed";
	message: string;
}

/** Typed rejection kind of an exact-continuation admission or pre-dispatch gate failure. */
export type LeafTurnExactRejectedKind =
	| "not_branchable_checkpoint"
	| "source_checkpoint_changed"
	| "workspace_snapshot_mismatch"
	| "non_deterministic_request_policy"
	| "state_projection_mismatch"
	| "request_fingerprint_mismatch"
	| "unsupported_sampling_control";

export interface LeafTurnExactRejected {
	kind: LeafTurnExactRejectedKind;
	message: string;
}

export type LeafTurnRejected =
	| CheckpointMismatch
	| DriverBusy
	| LeafTurnLaneBusy
	| LeafTurnMissingIdentities
	| LeafTurnInvalidMessage
	| LeafTurnNothingToResume
	| LeafTurnUnexpectedOperation
	| LeafTurnExactRejected
	| LeafTurnClosed;

export interface LeafTurnAbortOutcome {
	operationId: string;
	steer: AgentMessage[];
	followUp: AgentMessage[];
}

export interface LeafTurnNoActiveOperation {
	kind: "no_active_operation";
	lane: string;
	message: string;
}

export type LeafTurnAbortRejected = LeafTurnNoActiveOperation | LeafTurnClosed;

/**
 * Durable production Interface. Its Adapter derives identities from immutable
 * Harness v4 entries and current operation state, and must not begin a second
 * provider request before returning.
 */
export interface LeafTurnExecutor {
	execute(command: LeafTurnCommand): Promise<LeafTurnExecutionResult<LeafTurnOutcome, LeafTurnRejected>>;
	abort(): Promise<LeafTurnExecutionResult<LeafTurnAbortOutcome, LeafTurnAbortRejected>>;
}

/** Process-local observation shared by Legacy and Harness semantic characterization. */
export interface LeafTurnSemanticObservation {
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	usage: Usage;
}

/**
 * Characterization Interface for one assistant response and its complete tool batch.
 * Provider/tool failures are represented by the returned message/results. Misuse and
 * broken runtime invariants reject the promise.
 */
export interface LeafTurnSemanticExecutor {
	execute(prompt: AgentMessage | AgentMessage[]): Promise<LeafTurnSemanticObservation>;
	abort(): void;
}
