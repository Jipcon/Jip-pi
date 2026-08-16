import type { DeferredHandle } from "@earendil-works/pi-ai";
import type { QueueMode } from "../../types.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { JsonValue, LaneConfiguration } from "./base.ts";

export interface AdaptiveRunIntentReference {
	basisEntryId: string;
}

interface RunIntentBase {
	kind: "run";
	promptEntryIds: string[];
	systemPromptOverride?: string;
	resumeData?: Record<string, JsonValue>;
}

export interface StandardRunIntent extends RunIntentBase {
	adaptive?: never;
}

export interface AdaptiveRunIntent extends RunIntentBase {
	adaptive: AdaptiveRunIntentReference;
}

export type RunIntent = StandardRunIntent | AdaptiveRunIntent;

export type OperationIntent =
	| RunIntent
	| { kind: "compaction"; customInstructions?: string }
	| {
			kind: "navigation";
			targetId: string | null;
			summarize: boolean;
			label?: string;
			customInstructions?: string;
	  };

export interface Operation {
	operationId: string;
	lane: string;
	sourceLeafId: string | null;
	startedAt: number;
	intent: OperationIntent;
}

export type Control =
	| { status: "running" }
	| {
			status: "cancel_requested";
			requestedAt: number;
			drainedSteer: string[];
			drainedFollowUp: string[];
	  };

export interface Inbox {
	steer: string[];
	followUp: string[];
	writes: string[];
}

export interface OperationError {
	code: string;
	message: string;
	details?: JsonValue;
}

export type Continuation =
	| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
	| { kind: "may_finish"; includeFinalAssistant: boolean };

export interface CheckpointPhase {
	kind: "checkpoint";
	continuation: Continuation;
	triggerEntryId: string;
	thresholdCheckedTriggerEntryId?: string;
	skipInboxOnce?: boolean;
}

export interface NormalizedRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
}

export interface GenerationContext {
	stepId: string;
	triggerEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	overflowRecoveryUsed: boolean;
}

export type Generation =
	| { status: "ready"; context: GenerationContext; nextAttempt: number }
	| {
			status: "effect_pending";
			context: GenerationContext;
			attempt: number;
			responseEntryId: string;
			usageId: string;
			intendedOutputLimit: number;
			contextWindow: number;
	  }
	| {
			status: "retry_wait";
			context: GenerationContext;
			nextAttempt: number;
			notBefore: number;
			errorMessage: string;
	  };

export type ToolCall =
	| { status: "planned"; sourceIndex: number; resultEntryId: string; blocked?: true; truncated?: true }
	| {
			status: "effect_pending";
			sourceIndex: number;
			resultEntryId: string;
			replay: "never" | "safe";
	  }
	| {
			status: "completed";
			sourceIndex: number;
			resultEntryId: string;
			terminate: boolean;
	  };

export type ToolArgumentAuthority =
	| { kind: "standard_tool_args_registers" }
	| { kind: "adaptive_pending" }
	| { kind: "adaptive_tool_batch_entry"; entryId: string };

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	argumentAuthority: ToolArgumentAuthority;
	calls: ToolCall[];
}

export type Deferred =
	| {
			status: "suspended";
			stepId: string;
			sourceEntryId: string;
			poll: number;
			configuration: LaneConfiguration;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			status: "effect_pending";
			stepId: string;
			sourceEntryId: string;
			poll: number;
			responseEntryId: string;
			usageId: string;
			configuration: LaneConfiguration;
			streamOptions: AgentHarnessStreamOptions;
	  };

export type StructuralDecision = { taskId: string } & (
	| { status: "deciding" }
	| { status: "generating"; generation: SummaryGeneration }
);

export interface SummaryContext {
	taskId: string;
	resultEntryId: string;
	kind: "compaction" | "branch_summary";
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	reason?: "manual" | "threshold" | "overflow";
}

export type SummaryGeneration =
	| { status: "ready"; context: SummaryContext; nextAttempt: number }
	| {
			status: "effect_pending";
			context: SummaryContext;
			attempt: number;
			request?: { index: number; usageId: string };
			usageIds: string[];
	  }
	| {
			status: "retry_wait";
			context: SummaryContext;
			nextAttempt: number;
			notBefore: number;
			errorMessage: string;
	  };

export type RunPhase =
	| CheckpointPhase
	| { kind: "assistant"; generation: Generation }
	| { kind: "tools"; batch: ToolBatch }
	| {
			kind: "compaction";
			reason: "threshold" | "overflow";
			structural: StructuralDecision;
			resumeAfter: CheckpointPhase;
	  }
	| { kind: "deferred"; deferred: Deferred }
	| {
			kind: "failure_drain";
			error: OperationError;
			provenance: { kind: "response"; entryId: string } | { kind: "structural"; taskId: string };
	  };

export interface RunState {
	kind: "run";
	control: Control;
	settings: {
		compaction: CompactionSettings;
		steeringMode: QueueMode;
		followUpMode: QueueMode;
		toolExecution: "sequential" | "parallel";
	};
	phase: RunPhase;
	inbox: Inbox;
	latestAssistantEntryId: string | null;
}

export interface CompactionState {
	kind: "compaction";
	control: Control;
	customInstructions?: string;
	structural: StructuralDecision;
}

export type NavigationState =
	| {
			kind: "navigation";
			control: Control;
			targetId: string | null;
			label?: string;
			summarize: false;
			phase: { kind: "ready_to_commit" };
	  }
	| {
			kind: "navigation";
			control: Control;
			targetId: string;
			label?: string;
			customInstructions?: string;
			summarize: true;
			phase: { kind: "summary"; structural: StructuralDecision };
	  };

export type OperationState = RunState | CompactionState | NavigationState;

export interface LaneState {
	currentOperationId: string | null;
	pendingNextRun: string[];
}

export type LaneLastResult = {
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	leafId: string | null;
	finalAssistantEntryId?: string;
} & (
	| { outcome: "failed"; error: OperationError; runCompletion?: never }
	| {
			outcome: "completed";
			error?: never;
			runCompletion?: "assistant" | "terminated_tools";
	  }
	| { outcome: "declined" | "aborted"; error?: never; runCompletion?: never }
);

export interface DeferredSource {
	entryId: string;
	handle: DeferredHandle;
}
