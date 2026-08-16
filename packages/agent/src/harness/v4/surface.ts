import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { AgentEventSink } from "../../agent-loop.ts";
import type { AgentMessage, AgentTool, AgentToolCall, AgentToolResult, QueueMode, ThinkingLevel } from "../../types.ts";
import type { BranchPreparation, BranchSummaryResult } from "../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings, CompactResult } from "../compaction/compaction.ts";
import type {
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessTool,
	PromptTemplate,
	Skill,
} from "../types.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	Entry,
	EntryType,
	JsonValue,
	LaneConfiguration,
	MessageEntry,
	SettledAssistantMessage,
	UsageRow,
} from "./base.ts";
import type {
	CompactionState,
	Continuation,
	Deferred,
	Generation,
	LaneLastResult,
	LaneState,
	NavigationState,
	NormalizedRetryPolicy,
	Operation,
	OperationError,
	OperationState,
	RunPhase,
	RunState,
	SummaryGeneration,
} from "./operation.ts";
import type { Register, Session, SessionStats, SessionTree } from "./storage.ts";

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

export type Tagged<Tag extends string, Properties extends object = Record<never, never>> = Error & {
	readonly _tag: Tag;
} & Readonly<Properties>;

export type LaneBusy = Tagged<
	"LaneBusy",
	{ lane: string; operationId: string; operationKind: "run" | "compaction" | "navigation"; message: string }
>;
export type MissingIdentities = Tagged<
	"MissingIdentities",
	{ lane: string; tools: string[]; models: string[]; message: string }
>;
export type NoActiveRun = Tagged<"NoActiveRun", { lane: string; message: string }>;
export type NoActiveOperation = Tagged<"NoActiveOperation", { lane: string; message: string }>;
export type NothingToResume = Tagged<"NothingToResume", { lane: string; message: string }>;
export type NothingToCompact = Tagged<"NothingToCompact", { lane: string; message: string }>;
export type InvalidMessage = Tagged<"InvalidMessage", { lane: string; reason: string; message: string }>;
export type InvalidNavigation = Tagged<"InvalidNavigation", { lane: string; reason: string; message: string }>;
export type UnknownSkill = Tagged<"UnknownSkill", { name: string; message: string }>;
export type UnknownTemplate = Tagged<"UnknownTemplate", { name: string; message: string }>;
export type UnknownTarget = Tagged<"UnknownTarget", { targetId: string; message: string }>;
export type LaneExists = Tagged<"LaneExists", { lane: string; message: string }>;
export type InvalidLane = Tagged<"InvalidLane", { lane: string; reason: string; message: string }>;
export type Closed = Tagged<"Closed", { message: string }>;

export type OptionalFinalAssistant =
	| { finalEntryId: string; finalMessage: AssistantMessage }
	| { finalEntryId?: never; finalMessage?: never };

export interface MissingIdentitySuspension {
	kind: "suspended";
	reason: "missing_identities";
	missing: { tools: string[]; models: string[] };
}

export type RunOutcome =
	| ({ kind: "completed"; leafId: string; runCompletion?: "assistant" | "terminated_tools" } & OptionalFinalAssistant)
	| ({ kind: "aborted"; leafId: string } & OptionalFinalAssistant)
	| ({ kind: "failed"; leafId: string; error: OperationError } & OptionalFinalAssistant)
	| {
			kind: "suspended";
			reason: "deferred";
			leafId: string;
			finalEntryId: string;
			deferred: DeferredHandle;
			startedAt: number;
	  }
	| (MissingIdentitySuspension & { leafId: string; startedAt: number });

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError }
	| (MissingIdentitySuspension & { leafId: string });

export type NavigationOutcome =
	| {
			kind: "completed";
			oldLeafId: string | null;
			newLeafId: string | null;
			summaryEntry?: BranchSummaryEntry;
	  }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError }
	| (MissingIdentitySuspension & { leafId: string | null });

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);

export type RunResult = Result<
	{ runId: string } & RunOutcome,
	LaneBusy | MissingIdentities | InvalidMessage | UnknownSkill | UnknownTemplate | Closed
>;

/** Post-turn yield of an adaptive drive; the Run stays open, nothing durable is written. */
export type AdaptiveTurnYield = {
	runId: string;
	kind: "turn";
	assistantEntryId: string;
	leafId: string;
};

export type AdaptiveTurnValue = AdaptiveTurnYield | ({ runId: string } & RunOutcome);
export type AdaptiveTurnResult = Result<
	AdaptiveTurnValue,
	LaneBusy | MissingIdentities | InvalidMessage | UnknownSkill | UnknownTemplate | Closed
>;
export type AdaptiveAdvanceResult = Result<AdaptiveTurnValue, LaneBusy | NothingToResume | MissingIdentities | Closed>;
export type CompactionResult = Result<
	{ runId: string } & CompactionOutcome,
	LaneBusy | MissingIdentities | NothingToCompact | Closed
>;
export type NavigationResult = Result<
	{ runId: string } & NavigationOutcome,
	LaneBusy | MissingIdentities | InvalidNavigation | UnknownTarget | Closed
>;
export type ResumeResult = Result<ResumeOutcome, LaneBusy | NothingToResume | MissingIdentities | Closed>;
export type QueueResult = Result<{ entryId: string }, NoActiveRun | InvalidMessage | Closed>;
export type NextRunResult = Result<{ entryId: string }, InvalidMessage | Closed>;
export type CancelQueuedResult = Result<{ kind: "cancelled" | "already_consumed" | "not_found" }, Closed>;
export type AbortResult = Result<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	NoActiveOperation | Closed
>;
export type RecordUsageResult = Result<{ usageId: string; totals: Usage }, Closed>;

export interface HarnessFault extends Error {
	readonly cause: unknown;
}

export interface HarnessClosed extends Error {}

export interface NavigateOptions {
	summarize?: boolean;
	label?: string;
	customInstructions?: string;
}

export interface ActionInfo {
	kind: string;
	description: string;
	details?: JsonValue;
}

export type EventListener<Event extends HarnessEvent = HarnessEvent> = (event: Event) => void | Promise<void>;

export interface WatchHandle<Snapshot> {
	snapshot: Snapshot;
	start(listener: EventListener): void;
	unsubscribe(): void;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	getLastResult(): Promise<LaneLastResult | undefined>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	getOpenOperation(): Promise<OpenOperationInfo | null>;
	abort(): Promise<AbortResult>;
	steer(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api> | undefined>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

/**
 * Opaque Adaptive payload completed by the Harness with the accepted
 * operation id before it is written as `adaptive.run_basis`.
 */
export type AdaptiveRunBasisInput = { [key: string]: JsonValue };

/** Narrow internal surface used by the Adaptive Harness v4 adapter. */
export interface AdaptiveAgentLane extends AgentLane {
	promptAdaptive(message: AgentMessage | AgentMessage[], basis: AdaptiveRunBasisInput): Promise<RunResult>;
	/** Start an adaptive Run and stop at the first complete post-turn yield. */
	promptAdaptiveTurn(
		message: AgentMessage | AgentMessage[],
		basis: AdaptiveRunBasisInput,
	): Promise<AdaptiveTurnResult>;
	/** Advance an open adaptive Run by at most one complete turn. */
	resumeAdaptiveTurn(): Promise<AdaptiveAdvanceResult>;
	/**
	 * Zero-prompt exact-continuation admission: one atomic transaction writes
	 * the `adaptive.run_basis` entry (parent = current leaf), the operation
	 * metadata/state and the lane state. `promptEntryIds` is empty, the
	 * initial trigger is the basis entry, no hook runs, and no provider
	 * effect is dispatched. The basis start must be `exact_continuation`.
	 */
	acceptAdaptiveContinuation(
		basis: AdaptiveRunBasisInput,
		options?: { systemPromptOverride?: string; resumeData?: Record<string, JsonValue> },
	): Promise<AdaptiveAdmissionResult>;
	/**
	 * Narrow capture seam: holds the source lane mutation line, verifies the
	 * open Run is parked at a complete post-turn continuation checkpoint
	 * (assistant entry plus full tool batch durable, next action is an
	 * assistant continuation, no pending queue input, no retry/abort), runs
	 * the callback, and re-verifies the durable checkpoint did not change.
	 * The callback must not call this lane's mutating APIs.
	 */
	capturePostTurnCheckpoint<T>(
		callback: (info: PostTurnCheckpointInfo) => T | Promise<T>,
	): Promise<Result<T, PostTurnCheckpointRejection>>;
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

/** Current-operation query used by the Adaptive Adapter for its cursor guard. */
export interface OpenOperationInfo {
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	status: "running" | "suspended" | "aborting";
	/** Durable post-turn cursor of the open operation, once a turn has completed. */
	turnCursor: { assistantEntryId: string; leafId: string } | null;
}

export interface SuspendedOperation {
	lane: string;
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	reason: "crash" | "deferred" | "missing_identities";
	startedAt: number;
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

/** Durable state observed by a zero-prompt exact-continuation admission. */
export type AdaptiveAdmissionValue = {
	runId: string;
	operationId: string;
	basisEntryId: string;
};

export type AdaptiveAdmissionResult = Result<
	AdaptiveAdmissionValue,
	LaneBusy | MissingIdentities | InvalidMessage | Closed
>;

/** Open-operation view handed to a post-turn checkpoint capture callback. */
export interface PostTurnCheckpointInfo {
	lane: string;
	operationId: string;
	turnCursor: { assistantEntryId: string; leafId: string };
	triggerEntryId: string;
	configuration: LaneConfiguration;
}

export type PostTurnCheckpointRejection =
	| Tagged<"NoActiveOperation", { lane: string; message: string }>
	| Tagged<"NotPostTurnCheckpoint", { lane: string; operationId: string; reason: string; message: string }>
	| Tagged<"CheckpointChanged", { lane: string; operationId: string; message: string }>
	| Closed;

/**
 * Facts the runtime assembles before the first provider dispatch of a Run.
 * The gate recomputes the canonical request from exactly these facts; the
 * runtime must assemble them from the same sources `streamAssistant` uses.
 */
export interface ExactContinuationDispatchFacts {
	lane: string;
	operationId: string;
	basisEntryId: string;
	/** Raw `adaptive.run_basis` payload; the gate owns its schema. */
	basisData: JsonValue;
	configuration: LaneConfiguration;
	systemPrompt: string;
	messages: AgentMessage[];
	providerMessages: Message[];
	tools: AgentTool[];
	streamOptions: AgentHarnessStreamOptions;
	hooksRegistered: { transformContext: boolean; beforeRequest: boolean; beforePayload: boolean };
	/** True when a non-default `toProviderMessages` transform is configured. */
	customMessageTransform: boolean;
}

/**
 * Pre-dispatch second gate for exact continuations. Runs before the provider
 * intent commit; a rejection must surface as a typed error before any
 * provider call, effect intent, or streaming side effect.
 */
export interface ExactContinuationDispatchGate {
	verifyFirstDispatch(
		facts: ExactContinuationDispatchFacts,
	): Promise<{ metadataPatch?: Record<string, unknown> } | undefined>;
}

export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type EntryProjector = (entry: CustomEntry) => AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>;

export interface AgentHarnessOptions<TContext extends object | undefined = object | undefined> {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: AgentHarnessTool<TContext>[];
	toolContext?: TContext | (() => TContext | Promise<TContext>);
	systemPrompt?: string | ((context: TContext) => string | Promise<string>);
	resources?: Resources;
	streamOptions?: AgentHarnessStreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	telemetryContext?: TelemetryContext;
	adaptiveToolPolicy?: AdaptiveToolBatchClearance;
	/** Pre-dispatch second gate armed only for exact-continuation Run starts. */
	exactContinuationDispatchGate?: ExactContinuationDispatchGate;
}

export interface AgentHarness<TContext extends object | undefined = object | undefined> extends AdaptiveAgentLane {
	lane(name: string): Promise<AgentLane | undefined>;
	createLane(
		name: string,
		at: string | null,
	): Promise<Result<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>>;
	lanes(): Promise<LaneInfo[]>;
	getTools(): Promise<AgentHarnessTool<TContext>[]>;
	setTools(tools: AgentHarnessTool<TContext>[]): Promise<void>;
	getResources(): Promise<Resources>;
	setResources(resources: Resources): Promise<void>;
	getStreamOptions(): Promise<AgentHarnessStreamOptions>;
	setStreamOptions(options: AgentHarnessStreamOptions): Promise<void>;
	getRetryPolicy(): Promise<RetryPolicy>;
	setRetryPolicy(policy: RetryPolicy): Promise<void>;
	getCompactionSettings(): Promise<CompactionSettings>;
	setCompactionSettings(settings: CompactionSettings): Promise<void>;
	getSteeringMode(): Promise<QueueMode>;
	setSteeringMode(mode: QueueMode): Promise<void>;
	getFollowUpMode(): Promise<QueueMode>;
	setFollowUpMode(mode: QueueMode): Promise<void>;
	watchSession(): Promise<WatchHandle<SessionSnapshot>>;
	readonly hooks: Hooks;
	readonly events: Events;
	close(): Promise<void>;
}

export interface AgentHarnessFactory {
	create<TContext extends object | undefined>(
		options: AgentHarnessOptions<TContext>,
	): Promise<{
		harness: AgentHarness<TContext>;
		suspended: SuspendedOperation[];
	}>;
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
		startedAt: number;
		suspended?: SuspendedOperation;
		streamingMessage?: AssistantMessage;
		runningTools: {
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult?: AgentToolResult<unknown>;
		}[];
		retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
	};
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: {
		entryId: string;
		type: EntryType;
		customType?: string;
		message?: AgentMessage;
		data?: JsonValue;
	}[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type HarnessEventPayload =
	| { type: "run_start"; runId: string }
	| { type: "run_resume"; runId: string }
	| { type: "run_suspend"; runId: string; reason: "deferred"; deferred: DeferredHandle }
	| {
			type: "run_suspend";
			runId: string;
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
	  }
	| { type: "run_abort"; runId: string; steer: AgentMessage[]; followUp: AgentMessage[] }
	| ({ type: "run_end"; runId: string; leafId: string | null } & (
			| ({ outcome: "completed" | "aborted" } & OptionalFinalAssistant)
			| ({ outcome: "failed"; error: OperationError } & OptionalFinalAssistant)
	  ))
	| { type: "fault"; code: string; message: string }
	| ({ type: "handler_error"; error: string; stack?: string } & (
			| { kind: "hook"; hook: string }
			| { kind: "event"; event: string }
	  ))
	| { type: "turn_start"; runId: string; turnId: string }
	| {
			type: "turn_end";
			runId: string;
			turnId: string;
			message: AssistantMessage;
			toolResults: ToolResultMessage[];
	  }
	| {
			type: "retry_scheduled";
			runId: string;
			step: string;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "retry_start"; runId: string; step: string; attempt: number }
	| { type: "retry_end"; runId: string; step: string; attempt: number; success: boolean; finalError?: string }
	| { type: "message_start"; runId?: string; message: AgentMessage }
	| { type: "message_update"; runId: string; message: AgentMessage; event: AssistantMessageEvent }
	| { type: "message_end"; runId?: string; message: AgentMessage; entryId?: string }
	| { type: "tool_start"; runId: string; turnId: string; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_update";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_end";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			terminate: boolean;
	  }
	| { type: "entry_added"; entry: Entry }
	| { type: "write_pending"; runId: string; entryId: string; entryType: EntryType }
	| { type: "queue_update"; steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] }
	| ({ type: "fact_update" } & (
			| { fact: "name"; name: string | undefined }
			| { fact: "label"; targetId: string; label: string | undefined }
			| { fact: "custom"; key: string; value: JsonValue | undefined }
	  ))
	| ({ type: "config_update" } & (
			| { property: "model"; value: { provider: string; modelId: string }; previous: unknown }
			| { property: "thinkingLevel"; value: ThinkingLevel; previous: ThinkingLevel }
			| { property: "activeTools"; value: string[]; previous: string[] }
			| {
					property:
						| "tools"
						| "resources"
						| "streamOptions"
						| "retryPolicy"
						| "compactionSettings"
						| "steeringMode"
						| "followUpMode";
			  }
	  ))
	| { type: "compaction_start"; runId: string; reason: "manual" | "threshold" | "overflow" }
	| ({ type: "compaction_end"; runId: string; reason: "manual" | "threshold" | "overflow" } & (
			| { outcome: "completed"; entry: CompactionEntry; fromHook: boolean }
			| { outcome: "declined" | "aborted" }
			| { outcome: "failed"; error: OperationError }
	  ))
	| { type: "navigation_start"; runId: string; targetId: string | null }
	| ({ type: "navigation_end"; runId: string; oldLeafId: string | null; newLeafId: string | null } & (
			| { outcome: "completed"; summaryEntry?: BranchSummaryEntry }
			| { outcome: "declined" | "aborted"; summaryEntry?: never; error?: never }
			| { outcome: "failed"; error: OperationError; summaryEntry?: never }
	  ))
	| { type: "lane_created"; at: string | null }
	| { type: "usage"; lane: string; row: UsageRow; totals: Usage };

type SpecialEventPayload = Extract<
	HarnessEventPayload,
	{ type: "fault" | "fact_update" | "usage" | "config_update" | "handler_error" }
>;
type LaneEventPayload = Exclude<HarnessEventPayload, SpecialEventPayload>;
type ConfigEventPayload = Extract<HarnessEventPayload, { type: "config_update" }>;
type LaneConfigEventPayload = Extract<ConfigEventPayload, { property: "model" | "thinkingLevel" | "activeTools" }>;
type GlobalConfigEventPayload = Exclude<ConfigEventPayload, LaneConfigEventPayload>;
type HandlerErrorPayload = Extract<HarnessEventPayload, { type: "handler_error" }>;

export type HarnessEvent =
	| (LaneEventPayload & { lane: string; recovery?: true })
	| (LaneConfigEventPayload & { lane: string; recovery?: true })
	| (Extract<HarnessEventPayload, { type: "fault" | "fact_update" }> & {
			lane?: never;
			recovery?: never;
	  })
	| (Extract<HarnessEventPayload, { type: "usage" }> & { recovery?: never })
	| (GlobalConfigEventPayload & { lane?: never; recovery?: never })
	| (HandlerErrorPayload & ({ lane: string; recovery?: true } | { lane?: never; recovery?: never }));

export type HarnessEventType = HarnessEvent["type"];

export interface Events {
	on<Type extends HarnessEventType>(
		type: Type,
		listener: EventListener<Extract<HarnessEvent, { type: Type }>>,
	): () => void;
}

export type BeforeResumePrepared =
	| { kind: "run"; prompt: AgentMessage[]; systemPromptOverride?: string }
	| { kind: "compaction"; sourceLeafId: string | null; customInstructions?: string }
	| {
			kind: "navigation";
			sourceLeafId: string | null;
			targetId: string | null;
			summarize: boolean;
			label?: string;
			customInstructions?: string;
	  };

export interface HookMap {
	before_run: {
		event: { prompt: AgentMessage[]; systemPrompt: string; resources: Resources };
		result: { messages?: AgentMessage[]; systemPrompt?: string; resumeData?: JsonValue } | undefined;
	};
	before_resume: { event: BeforeResumePrepared & { resumeData?: JsonValue }; result: undefined };
	before_run_end: {
		event: { runId: string; messages: AgentMessage[] };
		result: { followUp?: string } | undefined;
	};
	transform_context: {
		event: { messages: AgentMessage[] };
		result: { messages: AgentMessage[] } | undefined;
	};
	before_request: {
		event: {
			model: Model<Api>;
			step: "assistant" | "deferred" | "compaction" | "branch_summary";
			attempt: number;
			streamOptions: AgentHarnessStreamOptions;
		};
		result: { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined;
	};
	before_payload: {
		event: { model: Model<Api>; payload: unknown };
		result: { payload: unknown } | undefined;
	};
	after_response: {
		event: { status?: number; headers?: Record<string, string>; message: SettledAssistantMessage };
		result: { message?: SettledAssistantMessage } | undefined;
	};
	before_tool: {
		event: { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
		result: { args?: Record<string, JsonValue>; block?: { reason: string; terminate?: boolean } } | undefined;
	};
	after_tool: {
		event: {
			toolCallId: string;
			toolName: string;
			args: Record<string, JsonValue>;
			content: AgentToolResult<unknown>["content"];
			details?: JsonValue;
			isError: boolean;
			usage?: Usage;
		};
		result:
			| {
					content?: AgentToolResult<unknown>["content"];
					details?: JsonValue;
					isError?: boolean;
					usage?: Usage;
					terminate?: boolean;
			  }
			| undefined;
	};
	before_compaction: {
		event: {
			reason: "manual" | "threshold" | "overflow";
			preparation: CompactionPreparation;
			customInstructions?: string;
		};
		result: { decline?: boolean; compaction?: CompactResult } | undefined;
	};
	before_navigation: {
		event: { targetId: string; preparation: BranchPreparation; customInstructions?: string };
		result: { decline?: boolean; summary?: BranchSummaryResult } | undefined;
	};
}

export type HookName = keyof HookMap;
export type HookInvocation<Name extends HookName> = HookMap[Name]["event"] & {
	lane: string;
	runId: string;
};
export type HookHandler<Name extends HookName> = (
	event: HookInvocation<Name>,
) => Promise<HookMap[Name]["result"]> | HookMap[Name]["result"];

export interface Hooks {
	on<Name extends HookName>(name: Name, handler: HookHandler<Name>, options?: { id?: string }): () => void;
}

export interface CurrentOperation {
	operation: Operation;
	state: OperationState;
	operationStateSeq: number;
	laneState: LaneState;
	laneStateSeq: number;
	leafId: string | null;
	configuration: LaneConfiguration;
	configurationSeq: number;
}

export type EffectKey = string;

export type EffectPlan = { telemetryContext: TelemetryContext; operationId: string } & (
	| {
			kind: "assistant";
			key: EffectKey;
			generation: Extract<Generation, { status: "effect_pending" }>;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			kind: "summary";
			key: EffectKey;
			generation: Extract<SummaryGeneration, { status: "effect_pending" }>;
	  }
	| {
			kind: "tool";
			key: EffectKey;
			assistantEntryId: string;
			turnId: string;
			sourceIndex: number;
			args: { kind: "register"; key: string } | { kind: "batch_entry"; entryId: string };
			recovery?: true;
	  }
	| {
			kind: "deferred";
			key: EffectKey;
			deferred: Extract<Deferred, { status: "effect_pending" }>;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| { kind: "cancel_deferred"; key: EffectKey; sourceEntryId: string; handle: DeferredHandle }
	| { kind: "hook"; key: EffectKey; name: HookName; event: unknown }
);

export type SummaryAttemptOutcome =
	| { kind: "success"; result: CompactResult | BranchSummaryResult }
	| { kind: "retry" | "failure"; error: OperationError };

export type EffectOutput =
	| { kind: "not_started"; key: EffectKey }
	| { kind: "assistant" | "deferred"; key: EffectKey; message: SettledAssistantMessage }
	| { kind: "summary"; key: EffectKey; outcome: SummaryAttemptOutcome }
	| { kind: "tool_raw"; key: EffectKey; result: AgentToolResult<unknown>; isError: boolean }
	| { kind: "hook"; key: EffectKey; result: unknown }
	| { kind: "cancel_deferred"; key: EffectKey };

export type SettlementOutput =
	| Exclude<EffectOutput, { kind: "tool_raw" }>
	| {
			kind: "tool";
			key: EffectKey;
			result: AgentToolResult<unknown>;
			isError: boolean;
			terminate: boolean;
	  };

export type OperationResult = RunOutcome | CompactionOutcome | NavigationOutcome;

export interface SettlementResult {
	current: CurrentOperation;
	dispatch?: EffectPlan;
	suspend?: OperationResult;
	consumeDeferredPoll?: true;
	/** Entry materialized by the settlement transaction; feeds the planner synchronously. */
	settledEntry?: Entry;
	/** The before_run_end hook ran for the current finish boundary; the planner must not re-dispatch it. */
	hookConsumed?: boolean;
}

/** One pending item materialized by a drain transaction; ids are reserved at admission time. */
export interface InboxDrainEntry {
	id: string;
	type: "message" | "custom";
	customType?: string;
	message?: AgentMessage;
	data?: JsonValue;
}

/**
 * Pure planner output for one checkpoint/failure drain transaction. The commit
 * re-validates the consumed id prefixes against the latest durable inbox and
 * rebuilds the successor state from that latest state, so the plan itself only
 * carries the source-ordered entries, consumed ids, and successor phase.
 */
export interface InboxDrainPlan {
	/** Successor operation state (phase and inbox) computed from the plan-time state. */
	next: RunState;
	entries: InboxDrainEntry[];
	consumedWrites: string[];
	consumedSteer: string[];
	consumedFollowUp: string[];
	/** Plan-time source phase; the commit re-verifies the durable phase still matches it. */
	source: { kind: "checkpoint"; continuation: Continuation["kind"] } | { kind: "failure_drain" };
}

export interface RuntimeSnapshot {
	settingsRevision: number;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
}

export interface PlannerInputs {
	running: ReadonlyMap<EffectKey, EffectPlan>;
	deferredPollsRemaining: 0 | 1;
	deferredCancellations: ReadonlySet<string>;
	loaded: ReadonlyMap<string, Entry | Register>;
	runtime: RuntimeSnapshot;
	context?: AgentMessage[];
	/**
	 * Process-local: the current checkpoint is a normal may_finish boundary
	 * whose before_run_end hook has not run in this drive yet. Undefined
	 * (direct pure-planner tests) never dispatches the hook.
	 */
	runBeforeRunEndHook?: boolean;
	/**
	 * Registered custom-entry projector types. A pending custom write projects
	 * into provider context iff its customType is registered; the registry is
	 * process-local configuration and re-decidable after crash.
	 */
	projectedCustomTypes?: ReadonlySet<string>;
	now: number;
	/** Stable id source injected by the interpreter; the planner stays deterministic. */
	nextId: () => string;
	/** Resolved model window for the captured configuration; required at assistant ready. */
	model?: { maxTokens: number; contextWindow: number };
	telemetryContext: TelemetryContext;
}

export type Action =
	| {
			kind: "transition";
			next: OperationState;
			telemetryContext: TelemetryContext;
			expectedConfigurationSeq?: number;
			expectedSettingsRevision?: number;
	  }
	| { kind: "dispatch"; intent?: OperationState; effect: EffectPlan; consumeDeferredPoll?: true }
	| { kind: "await_effect"; key: EffectKey }
	| { kind: "wait"; until: number; telemetryContext: TelemetryContext }
	| { kind: "suspend"; result: OperationResult }
	| { kind: "finish"; result: OperationResult }
	| {
			kind: "settle";
			plan: EffectPlan;
			output: SettlementOutput;
			telemetryContext: TelemetryContext;
	  }
	| { kind: "drain"; plan: InboxDrainPlan; telemetryContext: TelemetryContext }
	| { kind: "prepare_tools"; telemetryContext: TelemetryContext }
	| { kind: "clear_tools"; telemetryContext: TelemetryContext }
	| {
			kind: "recover_tool";
			plan: EffectPlan;
			synthetic: SettlementOutput;
			telemetryContext: TelemetryContext;
	  };

export interface SummaryRequestOutputResponse {
	kind: "response";
	message: SettledAssistantMessage;
}

export type SummaryRequestOutput = SummaryRequestOutputResponse | { kind: "not_started" };

export interface Effects {
	commitTransition(
		current: CurrentOperation,
		next: OperationState,
		telemetry: TelemetryContext,
		expectedConfigurationSeq?: number,
		expectedSettingsRevision?: number,
	): Promise<CurrentOperation | undefined>;
	commitEffectSettlement(
		current: CurrentOperation,
		plan: EffectPlan,
		output: SettlementOutput,
		telemetry: TelemetryContext,
	): Promise<SettlementResult | undefined>;
	commitToolIntent(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		sourceIndex: number,
		args: Record<string, JsonValue>,
		replay: "never" | "safe",
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; dispatch: EffectPlan } | undefined>;
	/**
	 * Atomic checkpoint/failure drain: inserts source-ordered entries, deletes
	 * the consumed pending registers, moves lane.leaf, and updates the inbox
	 * plus continuation/trigger/skipInboxOnce in one transaction. Undefined
	 * means the durable inbox no longer matches the consumed prefixes and the
	 * interpreter must re-restore and replan.
	 */
	commitInboxDrain(
		current: CurrentOperation,
		plan: InboxDrainPlan,
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; entries: Entry[] } | undefined>;
	commitAdaptiveBatchIntent(
		current: CurrentOperation,
		batch: Extract<RunPhase, { kind: "tools" }>["batch"],
		entryData: JsonValue,
		decisions: AdaptiveToolClearanceDecision[],
		telemetry: TelemetryContext,
	): Promise<{ current: CurrentOperation; dispatches: EffectPlan[]; entry: Entry } | undefined>;
	commitTerminal(current: CurrentOperation, result: OperationResult): Promise<CurrentOperation | undefined>;
	finalizeTool(
		plan: Extract<EffectPlan, { kind: "tool" }>,
		output: Extract<EffectOutput, { kind: "tool_raw" }>,
	): Promise<Extract<SettlementOutput, { kind: "tool" }>>;
	runSummaryRequest(plan: {
		taskId: string;
		attempt: number;
		requestIndex: number;
		usageId: string;
		configuration: LaneConfiguration;
		messages: AgentMessage[];
		telemetryContext: TelemetryContext;
	}): Promise<SummaryRequestOutput>;
	settleSummaryRequest(
		current: CurrentOperation,
		plan: { taskId: string; attempt: number; requestIndex: number; usageId: string },
		response: SettledAssistantMessage,
		telemetry: TelemetryContext,
	): Promise<CurrentOperation>;
	run(plan: EffectPlan): Promise<EffectOutput>;
	sleep(delayMs: number, telemetry: TelemetryContext, operationId: string): Promise<void>;
	sleepUntil(until: number, telemetry: TelemetryContext, operationId: string): Promise<void>;
}

export interface StreamAssistantConfig {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	systemPrompt?: string;
	tools?: AgentTool[];
	transformContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<AgentMessage[]>;
	toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	models: Models;
	streamOptions?: AgentHarnessStreamOptions;
	transformPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	transformResponse?: (
		message: SettledAssistantMessage,
		metadata: { status?: number; headers?: Record<string, string> },
	) => Promise<SettledAssistantMessage>;
	telemetryContext: TelemetryContext;
	signal: AbortSignal;
}

export type StreamAssistant = (
	messages: AgentMessage[],
	config: StreamAssistantConfig,
	emit: AgentEventSink,
) => Promise<SettledAssistantMessage>;

export interface PreparedToolCall {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: Record<string, JsonValue>;
}

export interface ImmediateOutcome {
	kind: "immediate";
	result: AgentToolResult<unknown>;
	isError: true;
	terminate: boolean;
}

export interface FinalizedToolCall {
	toolCall: AgentToolCall;
	result: AgentToolResult<unknown>;
	isError: boolean;
	terminate: boolean;
}

export interface ToolCallbacks {
	beforeToolCall?(call: AgentToolCall, args: Record<string, JsonValue>): Promise<HookMap["before_tool"]["result"]>;
	afterToolCall?(
		call: AgentToolCall,
		args: Record<string, JsonValue>,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<HookMap["after_tool"]["result"]>;
	executeTool?(call: PreparedToolCall): Promise<{ result: AgentToolResult<unknown>; isError: boolean }>;
	onToolStart?(call: AgentToolCall, effectiveArgs: Record<string, JsonValue>): Promise<void>;
	onToolResult?(call: AgentToolCall, message: ToolResultMessage, terminate: boolean): Promise<void>;
}

/** Batch-level ToolPolicy clearance seam. Core owns the bridge; policies live in Adaptive. */
export interface AdaptiveToolClearanceDecision {
	kind: "allow" | "argument_guard" | "block";
	sourceIndex: number;
	toolCallId: string;
	toolName: string;
	effectiveArgs?: Record<string, JsonValue>;
	replay: "safe" | "never";
	reason?: string;
}

export interface AdaptiveToolClearanceResult {
	policyStateFingerprint: string;
	decisions: AdaptiveToolClearanceDecision[];
}

export interface AdaptiveToolClearanceCall {
	sourceIndex: number;
	call: AgentToolCall;
}

export interface AdaptiveToolClearanceInput {
	batch: Extract<RunPhase, { kind: "tools" }>["batch"];
	assistantEntry: MessageEntry;
	/** Source-ordered proposed calls that are not marked truncated. */
	calls: AdaptiveToolClearanceCall[];
	tools: AgentTool[];
	/** Durable identity only: Core never interprets PolicyBundle or candidate state. */
	sessionId: string;
	lane: string;
	operationId: string;
	/** The `adaptive.run_basis` entry id of this Run, when admitted adaptively. */
	basisEntryId: string | undefined;
}

export interface AdaptiveToolBatchClearance {
	clearBatch(input: AdaptiveToolClearanceInput): Promise<AdaptiveToolClearanceResult>;
}

export type PrepareToolCall = (
	call: AgentToolCall,
	tools: AgentTool[],
	callbacks: ToolCallbacks,
	telemetry: TelemetryContext,
	signal: AbortSignal,
) => Promise<PreparedToolCall | ImmediateOutcome>;

export type ExecuteToolCall = (
	call: PreparedToolCall,
	emit: AgentEventSink,
	telemetry: TelemetryContext,
	signal: AbortSignal,
) => Promise<{ result: AgentToolResult<unknown>; isError: boolean }>;

export type FinalizeToolCall = (
	call: PreparedToolCall,
	executed: { result: AgentToolResult<unknown>; isError: boolean },
	callbacks: ToolCallbacks,
	telemetry: TelemetryContext,
	signal: AbortSignal,
) => Promise<FinalizedToolCall>;

export type RestoredOperationState = RunState | CompactionState | NavigationState;
export type HarnessSessionStats = SessionStats;
