import type { Api, ImageContent, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../../types.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../compaction/compaction.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import { formatSkillInvocation } from "../skills.ts";
import type { AgentHarnessResources, AgentHarnessStreamOptions, AgentHarnessTool } from "../types.ts";
import type { JsonValue, LaneConfiguration } from "./base.ts";
import { HarnessEventBus } from "./events.ts";
import { HarnessHookRegistry } from "./hooks.ts";
import { LaneSessionTree, type LaneSessionTreeHost } from "./lane-session.ts";
import { MinimalNoToolRunRuntime, type MinimalRunLaneState } from "./minimal-run.ts";
import { type RestoredLane, restoreLane, toSuspendedOperation } from "./restore.ts";
import { HarnessClosedError, HarnessNotImplementedError, RuntimeCoordinator, taggedError } from "./runtime.ts";
import type { Session, SessionTree } from "./storage.ts";
import { SessionError } from "./storage.ts";
import type {
	AbortResult,
	ActionInfo,
	AdaptiveAdmissionResult,
	AdaptiveAdvanceResult,
	AdaptiveRunBasisInput,
	AdaptiveTurnResult,
	AgentHarness as AgentHarnessContract,
	AgentHarnessFactory as AgentHarnessFactoryContract,
	AgentHarnessOptions,
	AgentLane,
	CancelQueuedResult,
	Closed,
	CompactionResult,
	InvalidLane,
	LaneExists,
	LaneInfo,
	LaneSnapshot,
	NavigateOptions,
	NavigationResult,
	NextRunResult,
	OpenOperationInfo,
	PostTurnCheckpointInfo,
	PostTurnCheckpointRejection,
	QueueResult,
	RecordUsageResult,
	Resources,
	Result,
	ResumeResult,
	RunResult,
	SessionSnapshot,
	SuspendedOperation,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
	WatchHandle,
} from "./surface.ts";

const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: false, maxRetries: 0, baseDelayMs: 1_000 };

function cloneResources(resources: Resources): Resources {
	return structuredClone(resources);
}

function configurationFromOptions<TContext extends object | undefined>(
	options: AgentHarnessOptions<TContext>,
): LaneConfiguration {
	return {
		model: { provider: options.model.provider, modelId: options.model.id },
		thinkingLevel: options.thinkingLevel ?? "off",
		activeToolNames: [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])],
	};
}

function operationInfo(restored: RestoredLane): LaneInfo["operation"] {
	if (restored.kind === "idle") return null;
	const { operation, state } = restored.current;
	return {
		id: operation.operationId,
		kind: state.kind,
		status: state.control.status === "cancel_requested" ? "aborting" : "suspended",
	};
}

function openOperationInfo(restored: RestoredLane): OpenOperationInfo | null {
	if (restored.kind === "idle") return null;
	const { operation, state } = restored.current;
	const phase = state.kind === "run" ? state.phase : undefined;
	// A tools phase is an incomplete turn: the post-turn cursor only becomes
	// visible once the complete batch has durably settled.
	const hasCompletedTurn =
		phase !== undefined &&
		(phase.kind === "checkpoint" || phase.kind === "deferred" || phase.kind === "failure_drain");
	return {
		operationId: operation.operationId,
		kind: state.kind,
		status: state.control.status === "cancel_requested" ? "aborting" : "suspended",
		turnCursor:
			state.kind === "run" &&
			state.latestAssistantEntryId !== null &&
			hasCompletedTurn &&
			restored.current.leafId !== null
				? { assistantEntryId: state.latestAssistantEntryId, leafId: restored.current.leafId }
				: null,
	};
}

function laneError(message: string): never {
	throw new SessionError("corruption", message);
}

function closedResult(): RunResult {
	const message = "AgentHarness is closed";
	return { ok: false, error: taggedError("Closed", message, { message }) };
}

function unknownSkill(name: string): UnknownSkill {
	const message = `Unknown skill: ${name}`;
	return taggedError("UnknownSkill", message, { name, message });
}

function unknownTemplate(name: string): UnknownTemplate {
	const message = `Unknown prompt template: ${name}`;
	return taggedError("UnknownTemplate", message, { name, message });
}

class AgentLaneShell implements AgentLane {
	readonly name: string;
	session: SessionTree;
	protected readonly owner: AgentHarness<never>;

	constructor(name: string, tree: SessionTree, owner?: AgentHarness<never>) {
		this.name = name;
		this.session = tree;
		this.owner = owner ?? (this as unknown as AgentHarness<never>);
	}

	protected unavailable<T>(operation: string): Promise<T> {
		return this.owner.unavailable(operation);
	}

	getLeafId(): Promise<string | null> {
		return this.owner.getRestored(this.name).then((restored) => restored.currentLeafId);
	}

	getLastResult(): ReturnType<AgentLane["getLastResult"]> {
		return this.owner.durableSession
			.getRegister("lane.lastResult", this.name)
			.then((register) => structuredClone(register?.value));
	}

	prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.owner.runPrompt(this.name, input, images);
	}

	skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.owner.runSkill(this.name, name, additionalInstructions);
	}

	promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		return this.owner.runPromptTemplate(this.name, name, args);
	}

	compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.unavailable("compact");
	}

	navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}

	resume(): Promise<ResumeResult> {
		return this.owner.runResume(this.name);
	}

	getOpenOperation(): Promise<OpenOperationInfo | null> {
		return this.owner.getOpenOperationForLane(this.name);
	}

	abort(): Promise<AbortResult> {
		return this.owner.runAbort(this.name);
	}

	steer(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.owner.runSteer(this.name, message, images);
	}

	followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.owner.runFollowUp(this.name, message, images);
	}

	nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult> {
		return this.owner.runNextRun(this.name, message, images);
	}

	cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		return this.owner.runCancelQueued(this.name, entryId);
	}

	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.owner.runRecordUsage(this.name, usage, options);
	}

	waitForIdle(): Promise<void> {
		return this.owner.runWaitForIdle(this.name);
	}

	runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		return this.owner.runRunWhenIdle(this.name, callback);
	}

	peekAction(): Promise<ActionInfo | undefined> {
		return this.owner.coordinator.gate.peekAction();
	}

	executeAction(): Promise<ActionInfo | undefined> {
		return this.owner.coordinator.gate.executeAction();
	}

	runToCompletion(): Promise<void> {
		return this.owner.coordinator.gate.runToCompletion();
	}

	getModel(): Promise<Model<Api> | undefined> {
		return this.owner.getLaneModel(this.name);
	}

	setModel(model: Model<Api>): Promise<void> {
		return this.owner.setLaneConfiguration(this.name, "model", {
			provider: model.provider,
			modelId: model.id,
		});
	}

	getThinkingLevel(): Promise<ThinkingLevel> {
		return this.owner.getLaneConfiguration(this.name).then((configuration) => configuration.thinkingLevel);
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.owner.setLaneConfiguration(this.name, "thinkingLevel", level);
	}

	getActiveTools(): Promise<string[]> {
		return this.owner.getLaneConfiguration(this.name).then((configuration) => [...configuration.activeToolNames]);
	}

	setActiveTools(names: string[]): Promise<void> {
		return this.owner.setLaneConfiguration(this.name, "activeToolNames", [...names]);
	}

	watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.unavailable("watch");
	}
}

interface RestoredRuntimeLane {
	restored: RestoredLane;
	currentLeafId: string | null;
}

export class AgentHarness<TContext extends object | undefined = object | undefined>
	extends AgentLaneShell
	implements AgentHarnessContract<TContext>, LaneSessionTreeHost
{
	readonly hooks: HarnessHookRegistry;
	readonly events: HarnessEventBus;
	readonly durableSession: Session;
	readonly coordinator: RuntimeCoordinator;
	private readonly options: AgentHarnessOptions<TContext>;
	private readonly runRuntime: MinimalNoToolRunRuntime<TContext>;
	private readonly laneStates = new Map<string, RestoredRuntimeLane>();
	private readonly laneShells = new Map<string, AgentLaneShell>();
	private tools: AgentHarnessTool<TContext>[];
	private resources: Resources;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private toolExecution: "sequential" | "parallel";
	private closed = false;

	private constructor(options: AgentHarnessOptions<TContext>) {
		const events = new HarnessEventBus();
		super("main", options.session);
		this.durableSession = options.session;
		this.options = options;
		this.events = events;
		this.hooks = new HarnessHookRegistry(events);
		this.coordinator = new RuntimeCoordinator(
			options.session,
			options.drive ?? "automatic",
			options.streamOptions ?? {},
			options.retry ?? DEFAULT_RETRY_POLICY,
			(event) => events.emit(event),
		);
		this.tools = [...(options.tools ?? [])];
		this.resources = cloneResources(options.resources ?? {});
		this.compactionSettings = structuredClone(options.compaction ?? DEFAULT_COMPACTION_SETTINGS);
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.toolExecution = options.toolExecution ?? "parallel";
		this.runRuntime = new MinimalNoToolRunRuntime({
			session: this.durableSession,
			models: options.models,
			coordinator: this.coordinator,
			hooks: this.hooks,
			events: this.events,
			drive: options.drive ?? "automatic",
			...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
			...(options.toolContext === undefined ? {} : { toolContext: options.toolContext }),
			...(options.toProviderMessages === undefined ? {} : { toProviderMessages: options.toProviderMessages }),
			...(options.entryProjectors === undefined ? {} : { entryProjectors: options.entryProjectors }),
			...(options.telemetryContext === undefined ? {} : { telemetryContext: options.telemetryContext }),
			...(options.adaptiveToolPolicy === undefined ? {} : { adaptiveToolPolicy: options.adaptiveToolPolicy }),
			...(options.exactContinuationDispatchGate === undefined
				? {}
				: { exactContinuationDispatchGate: options.exactContinuationDispatchGate }),
			getTools: () => [...this.tools],
			getResources: () => cloneResources(this.resources),
			getRunSettings: () => ({
				compaction: structuredClone(this.compactionSettings),
				steeringMode: this.steeringMode,
				followUpMode: this.followUpMode,
				toolExecution: this.toolExecution,
			}),
			onLaneState: (lane, state) => this.setRuntimeLaneState(lane, state),
		});
		this.session = this.treeFor("main");
		this.laneShells.set("main", this);
	}

	static async create<TContext extends object | undefined>(
		options: AgentHarnessOptions<TContext>,
	): Promise<{ harness: AgentHarness<TContext>; suspended: SuspendedOperation[] }> {
		const harness = new AgentHarness(options);
		try {
			const laneRegisters = await options.session.listRegisters("lane.leaf");
			const lanes = laneRegisters.map((register) => register.key).sort((left, right) => left.localeCompare(right));
			const mainRestored = await harness.restoreMain(configurationFromOptions(options));
			harness.laneStates.set("main", {
				restored: mainRestored,
				currentLeafId: mainRestored.kind === "idle" ? mainRestored.leafId : mainRestored.current.leafId,
			});
			for (const lane of lanes.filter((name) => name !== "main")) {
				const restored = await restoreLane(options.session, lane);
				harness.laneStates.set(lane, {
					restored,
					currentLeafId: restored.kind === "idle" ? restored.leafId : restored.current.leafId,
				});
			}
			const suspended = [...harness.laneStates.values()]
				.map(({ restored }) => (restored.kind === "suspended" ? toSuspendedOperation(restored) : undefined))
				.filter((value): value is SuspendedOperation => value !== undefined);
			for (const item of suspended) item.missing = harness.missingIdentities(item.lane);
			return { harness, suspended };
		} catch (error) {
			await harness.close();
			throw error;
		}
	}

	private async restoreMain(configuration: LaneConfiguration): Promise<RestoredLane> {
		try {
			return await restoreLane(this.durableSession, "main");
		} catch (error) {
			if (
				!(error instanceof SessionError) ||
				error.code !== "corruption" ||
				!error.message.includes("lane.config/main")
			) {
				throw error;
			}
			await this.coordinator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration }],
			});
			return restoreLane(this.durableSession, "main");
		}
	}

	private missingIdentities(lane: string): SuspendedOperation["missing"] {
		const laneState = this.laneStates.get(lane);
		if (laneState === undefined || laneState.restored.kind === "idle") return { tools: [], models: [] };
		const configuration = laneState.restored.current.configuration;
		const models =
			this.options.models.getModel(configuration.model.provider, configuration.model.modelId) === undefined
				? [`${configuration.model.provider}/${configuration.model.modelId}`]
				: [];
		const availableTools = new Set(this.tools.map((tool) => tool.name));
		const tools = configuration.activeToolNames.filter((name) => !availableTools.has(name));
		return { tools, models };
	}

	private setRuntimeLaneState(lane: string, state: MinimalRunLaneState): void {
		if (state.kind === "open") {
			const current = structuredClone(state.current);
			this.laneStates.set(lane, {
				restored: { kind: "suspended", current, loaded: new Map() },
				currentLeafId: current.leafId,
			});
			return;
		}
		this.laneStates.set(lane, {
			restored: {
				kind: "idle",
				lane,
				leafId: state.leafId,
				laneState: structuredClone(state.laneState),
				laneStateSeq: state.laneStateSeq,
			},
			currentLeafId: state.leafId,
		});
	}

	runPrompt(lane: string, input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.runRuntime.prompt(lane, input, images);
	}

	runSkill(lane: string, name: string, additionalInstructions?: string): Promise<RunResult> {
		if (this.closed) return Promise.resolve(closedResult());
		const skill = this.resources.skills?.find((candidate) => candidate.name === name);
		if (skill === undefined) return Promise.resolve({ ok: false, error: unknownSkill(name) });
		return this.runPrompt(lane, formatSkillInvocation(skill, additionalInstructions));
	}

	runPromptTemplate(lane: string, name: string, args?: string[]): Promise<RunResult> {
		if (this.closed) return Promise.resolve(closedResult());
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (template === undefined) return Promise.resolve({ ok: false, error: unknownTemplate(name) });
		return this.runPrompt(lane, formatPromptTemplateInvocation(template, args));
	}

	promptAdaptive(message: AgentMessage | AgentMessage[], basis: AdaptiveRunBasisInput): Promise<RunResult> {
		return this.runRuntime.promptAdaptive(this.name, message, basis);
	}

	promptAdaptiveTurn(
		message: AgentMessage | AgentMessage[],
		basis: AdaptiveRunBasisInput,
	): Promise<AdaptiveTurnResult> {
		return this.runRuntime.promptAdaptiveTurn(this.name, message, basis);
	}

	resumeAdaptiveTurn(): Promise<AdaptiveAdvanceResult> {
		return this.runRuntime.resumeAdaptiveTurn(this.name);
	}

	acceptAdaptiveContinuation(
		basis: AdaptiveRunBasisInput,
		options?: { systemPromptOverride?: string; resumeData?: Record<string, JsonValue> },
	): Promise<AdaptiveAdmissionResult> {
		return this.runRuntime.acceptAdaptiveContinuation(this.name, basis, options);
	}

	capturePostTurnCheckpoint<T>(
		callback: (info: PostTurnCheckpointInfo) => T | Promise<T>,
	): Promise<Result<T, PostTurnCheckpointRejection>> {
		return this.runRuntime.capturePostTurnCheckpoint(this.name, callback);
	}

	runResume(lane: string): Promise<ResumeResult> {
		return this.runRuntime.resume(lane);
	}

	runAbort(lane: string): Promise<AbortResult> {
		return this.runRuntime.abort(lane);
	}

	runWaitForIdle(lane: string): Promise<void> {
		return this.runRuntime.waitForIdle(lane);
	}

	runRunWhenIdle(lane: string, callback: () => void | Promise<void>): Promise<void> {
		return this.runRuntime.runWhenIdle(lane, callback);
	}

	runSteer(lane: string, message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runRuntime.steer(lane, message, images);
	}

	runFollowUp(lane: string, message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runRuntime.followUp(lane, message, images);
	}

	runNextRun(lane: string, message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult> {
		return this.runRuntime.nextRun(lane, message, images);
	}

	runCancelQueued(lane: string, entryId: string): Promise<CancelQueuedResult> {
		return this.runRuntime.cancelQueued(lane, entryId);
	}

	runRecordUsage(
		lane: string,
		usage: Usage,
		options?: { entryId?: string; details?: JsonValue },
	): Promise<RecordUsageResult> {
		return this.runRuntime.recordUsage(lane, usage, options);
	}

	laneAppendMessage(lane: string, message: AgentMessage): Promise<string> {
		return this.runRuntime.appendLaneMessage(lane, message);
	}

	laneAppendCustomEntry(lane: string, customType: string, data?: JsonValue): Promise<string> {
		return this.runRuntime.appendLaneCustomEntry(lane, customType, data);
	}

	private treeFor(lane: string): SessionTree {
		return new LaneSessionTree(lane, this.durableSession.view(lane), this);
	}

	getOpenOperationForLane(lane: string): Promise<OpenOperationInfo | null> {
		const state = this.laneStates.get(lane);
		if (state === undefined) return Promise.reject(new SessionError("invalid_lane", `Lane ${lane} does not exist`));
		return Promise.resolve(openOperationInfo(state.restored));
	}

	getRestored(lane: string): Promise<RestoredRuntimeLane> {
		const restored = this.laneStates.get(lane);
		return restored === undefined
			? Promise.reject(new SessionError("invalid_lane", `Lane ${lane} does not exist`))
			: Promise.resolve(restored);
	}

	unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosedError() : new HarnessNotImplementedError(operation));
	}

	async getLaneConfiguration(lane: string): Promise<LaneConfiguration> {
		const register = await this.durableSession.getRegister("lane.config", lane);
		if (register === undefined) laneError(`Lane ${lane} has no configuration`);
		return structuredClone(register.value);
	}

	async getLaneModel(lane: string): Promise<Model<Api> | undefined> {
		const configuration = await this.getLaneConfiguration(lane);
		return this.options.models.getModel(configuration.model.provider, configuration.model.modelId);
	}

	setLaneConfiguration<Key extends keyof LaneConfiguration>(
		lane: string,
		key: Key,
		value: LaneConfiguration[Key],
	): Promise<void> {
		return this.coordinator.mutateLaneAndCommit(lane, async () => {
			const register = await this.durableSession.getRegister("lane.config", lane);
			if (register === undefined) laneError(`Lane ${lane} has no configuration`);
			// Full-value overwrite with a defensive clone; callers mutating their
			// input afterwards must not affect the durable configuration.
			const previous = structuredClone(register.value);
			const next = { ...previous, [key]: structuredClone(value) };
			return {
				transaction: {
					writes: [{ kind: "register", op: "set", namespace: "lane.config", key: lane, value: next }],
				},
				complete: (result) => {
					const restored = this.laneStates.get(lane)?.restored;
					if (restored?.kind === "suspended") {
						restored.current.configuration = structuredClone(next);
						restored.current.configurationSeq = result.seqs[0] ?? restored.current.configurationSeq;
					}
					switch (key) {
						case "model":
							this.events.emit({
								type: "config_update",
								lane,
								property: "model",
								value: structuredClone(next.model),
								previous: structuredClone(previous.model),
							});
							break;
						case "thinkingLevel":
							this.events.emit({
								type: "config_update",
								lane,
								property: "thinkingLevel",
								value: structuredClone(next.thinkingLevel),
								previous: structuredClone(previous.thinkingLevel),
							});
							break;
						case "activeToolNames":
							this.events.emit({
								type: "config_update",
								lane,
								property: "activeTools",
								value: structuredClone(next.activeToolNames),
								previous: structuredClone(previous.activeToolNames),
							});
							break;
					}
					return undefined;
				},
			};
		});
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		if (!this.laneStates.has(name)) return undefined;
		const existing = this.laneShells.get(name);
		if (existing !== undefined) return existing;
		const shell = new AgentLaneShell(name, this.treeFor(name), this as unknown as AgentHarness<never>);
		this.laneShells.set(name, shell);
		return shell;
	}

	createLane(
		_name: string,
		_at: string | null,
	): Promise<Result<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>> {
		return this.unavailable("createLane");
	}

	lanes(): Promise<LaneInfo[]> {
		return Promise.resolve(
			[...this.laneStates.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, lane]) => ({
					name,
					leafId: lane.currentLeafId,
					operation: operationInfo(lane.restored),
				})),
		);
	}

	getTools(): Promise<AgentHarnessTool<TContext>[]> {
		return Promise.resolve([...this.tools]);
	}

	setTools(tools: AgentHarnessTool<TContext>[]): Promise<void> {
		return this.coordinator.mutateSettings(() => {
			this.tools = [...tools];
			this.events.emit({ type: "config_update", property: "tools" });
		});
	}

	getResources(): Promise<Resources> {
		return Promise.resolve(cloneResources(this.resources));
	}

	setResources(resources: AgentHarnessResources): Promise<void> {
		return this.coordinator.mutateSettings(() => {
			this.resources = cloneResources(resources);
			this.events.emit({ type: "config_update", property: "resources" });
		});
	}

	getStreamOptions(): Promise<AgentHarnessStreamOptions> {
		return Promise.resolve(this.coordinator.getStreamOptions());
	}

	async setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> {
		await this.coordinator.setStreamOptions(options);
		this.events.emit({ type: "config_update", property: "streamOptions" });
	}

	getRetryPolicy(): Promise<RetryPolicy> {
		return Promise.resolve(this.coordinator.getRetryPolicy());
	}

	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		await this.coordinator.setRetryPolicy(policy);
		this.events.emit({ type: "config_update", property: "retryPolicy" });
	}

	getCompactionSettings(): Promise<CompactionSettings> {
		return Promise.resolve(structuredClone(this.compactionSettings));
	}

	setCompactionSettings(settings: CompactionSettings): Promise<void> {
		return this.coordinator.mutateSettings(() => {
			this.compactionSettings = structuredClone(settings);
			this.events.emit({ type: "config_update", property: "compactionSettings" });
		});
	}

	getSteeringMode(): Promise<QueueMode> {
		return Promise.resolve(this.steeringMode);
	}

	setSteeringMode(mode: QueueMode): Promise<void> {
		return this.coordinator.mutateSettings(() => {
			this.steeringMode = mode;
			this.events.emit({ type: "config_update", property: "steeringMode" });
		});
	}

	getFollowUpMode(): Promise<QueueMode> {
		return Promise.resolve(this.followUpMode);
	}

	setFollowUpMode(mode: QueueMode): Promise<void> {
		return this.coordinator.mutateSettings(() => {
			this.followUpMode = mode;
			this.events.emit({ type: "config_update", property: "followUpMode" });
		});
	}

	watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		return this.unavailable("watchSession");
	}

	close(): Promise<void> {
		this.closed = true;
		this.runRuntime.closeWaiters();
		return this.coordinator.close();
	}
}

export const agentHarnessFactory: AgentHarnessFactoryContract = {
	create: <TContext extends object | undefined>(options: AgentHarnessOptions<TContext>) =>
		AgentHarness.create(options),
};
