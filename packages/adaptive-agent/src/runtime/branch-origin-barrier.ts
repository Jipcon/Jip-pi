import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AbortResult,
	ActionInfo,
	AdaptiveAdmissionResult,
	AdaptiveAdvanceResult,
	AdaptiveAgentLane,
	AdaptiveRunBasisInput,
	AdaptiveTurnResult,
	AgentLane,
	BranchScan,
	CancelQueuedResult,
	CommitResult,
	CompactionResult,
	Entry,
	EntryQuery,
	JsonValue,
	LaneLastResult,
	LaneSnapshot,
	NavigationResult,
	NextRunResult,
	OpenOperationInfo,
	PostTurnCheckpointInfo,
	PostTurnCheckpointRejection,
	QueueResult,
	RecordUsageResult,
	Register,
	RegisterNamespace,
	ResumeResult,
	RunResult,
	Session,
	SessionStats,
	SessionTree,
	Transaction,
	TurnCommit,
	TurnCommitQuery,
	UsageRow,
	UsageScan,
	WatchHandle,
} from "@earendil-works/pi-agent-core/harness-v4";
import type { Api, ImageContent, Model, Usage } from "@earendil-works/pi-ai";
import {
	type BranchOriginRecord,
	type BranchOriginRegistry,
	SessionRegisterBranchOriginRegistry,
} from "./branch-origin.ts";
import { BranchOriginFrozenError } from "./workspace-errors.ts";

/**
 * Full-surface branch-origin barrier (Stage 8, S8.5): after a durable freeze
 * every public mutation surface of the source fails with zero writes and
 * zero effects. Getters, watch and close keep working. The runtime exposes
 * only these guarded handles for a frozen origin, never the raw Session.
 */

export interface BranchOriginBarrierOptions {
	session: Session;
	lane: string;
	registry?: BranchOriginRegistry;
	/**
	 * Test-only hook: runs before the final marker check, so a concurrent
	 * freeze can win the race deterministically (freeze vs advance/abort/
	 * queue/config: exactly one side succeeds).
	 */
	checkHook?: () => Promise<void>;
}

export class BranchOriginBarrier {
	private readonly options: BranchOriginBarrierOptions;
	private readonly registry: BranchOriginRegistry;

	constructor(options: BranchOriginBarrierOptions) {
		this.options = options;
		this.registry = options.registry ?? new SessionRegisterBranchOriginRegistry();
	}

	get(): Promise<BranchOriginRecord | undefined> {
		return this.registry.get({ session: this.options.session, lane: this.options.lane });
	}

	/** Throws BranchOriginFrozen when a durable freeze marker exists. */
	async assertAvailable(): Promise<void> {
		await this.options.checkHook?.();
		const frozen = await this.registry.get({ session: this.options.session, lane: this.options.lane });
		if (frozen === undefined) return;
		throw new BranchOriginFrozenError(
			`lane ${this.options.lane} is a read-only branch origin of group ${frozen.groupId}; the surface is frozen`,
		);
	}

	guardSession(): Session {
		return new BranchOriginGuardedSession(this.options.session, () => this.assertAvailable());
	}

	guardTree(tree: SessionTree): SessionTree {
		return new BranchOriginGuardedTree(tree, () => this.assertAvailable());
	}

	guardLane(lane: AgentLane): BranchOriginGuardedLane {
		return new BranchOriginGuardedLane(lane, () => this.assertAvailable());
	}
}

export class BranchOriginGuardedTree implements SessionTree {
	private readonly inner: SessionTree;
	private readonly guard: () => Promise<void>;

	constructor(inner: SessionTree, guard: () => Promise<void>) {
		this.inner = inner;
		this.guard = guard;
	}

	getLeafId(): Promise<string | null> {
		return this.inner.getLeafId();
	}
	getEntry(id: string): Promise<Entry | undefined> {
		return this.inner.getEntry(id);
	}
	getStats(): Promise<SessionStats> {
		return this.inner.getStats();
	}
	getName(): Promise<string | undefined> {
		return this.inner.getName();
	}
	async setName(name: string | undefined): Promise<void> {
		await this.guard();
		await this.inner.setName(name);
	}
	getLabel(targetId: string): Promise<string | undefined> {
		return this.inner.getLabel(targetId);
	}
	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.guard();
		await this.inner.setLabel(targetId, label);
	}
	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.inner.getCustomFact(key);
	}
	async setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		await this.guard();
		await this.inner.setCustomFact(key, value);
	}
	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.inner.findEntries(query);
	}
	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.inner.findEntry(query);
	}
	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		return this.inner.findEntriesOnBranch(query);
	}
	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		return this.inner.findEntryOnBranch(query);
	}
	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		return this.inner.getTurnCommit(query);
	}
	async appendMessage(message: AgentMessage): Promise<string> {
		await this.guard();
		return this.inner.appendMessage(message);
	}
	async appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		await this.guard();
		return this.inner.appendCustomEntry(customType, data);
	}
}

export class BranchOriginGuardedSession implements Session {
	private readonly inner: Session;
	private readonly guard: () => Promise<void>;

	constructor(inner: Session, guard: () => Promise<void>) {
		this.inner = inner;
		this.guard = guard;
	}

	get metadata(): Session["metadata"] {
		return this.inner.metadata;
	}
	get idGenerator(): Session["idGenerator"] {
		return this.inner.idGenerator;
	}

	view(lane: string): SessionTree {
		return new BranchOriginGuardedTree(this.inner.view(lane), this.guard);
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		await this.guard();
		return this.inner.commit(transaction);
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.inner.getEntries(ids);
	}
	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined> {
		return this.inner.getRegister(namespace, key);
	}
	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]> {
		return this.inner.listRegisters(namespace, keyPrefix);
	}
	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.inner.scanUsage(query);
	}
	close(): Promise<void> {
		return this.inner.close();
	}
	getLeafId(): Promise<string | null> {
		return this.inner.getLeafId();
	}
	getEntry(id: string): Promise<Entry | undefined> {
		return this.inner.getEntry(id);
	}
	getStats(): Promise<SessionStats> {
		return this.inner.getStats();
	}
	getName(): Promise<string | undefined> {
		return this.inner.getName();
	}
	async setName(name: string | undefined): Promise<void> {
		await this.guard();
		await this.inner.setName(name);
	}
	getLabel(targetId: string): Promise<string | undefined> {
		return this.inner.getLabel(targetId);
	}
	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.guard();
		await this.inner.setLabel(targetId, label);
	}
	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.inner.getCustomFact(key);
	}
	async setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		await this.guard();
		await this.inner.setCustomFact(key, value);
	}
	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.inner.findEntries(query);
	}
	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.inner.findEntry(query);
	}
	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		return this.inner.findEntriesOnBranch(query);
	}
	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		return this.inner.findEntryOnBranch(query);
	}
	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		return this.inner.getTurnCommit(query);
	}
	async appendMessage(message: AgentMessage): Promise<string> {
		await this.guard();
		return this.inner.appendMessage(message);
	}
	async appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		await this.guard();
		return this.inner.appendCustomEntry(customType, data);
	}
}

/**
 * Guarded lane: every mutating surface checks the barrier first and fails
 * with BranchOriginFrozen (zero writes, zero effects); reads pass through.
 */
export class BranchOriginGuardedLane implements AgentLane, AdaptiveAgentLane {
	private readonly inner: AgentLane;
	private readonly guard: () => Promise<void>;

	constructor(inner: AgentLane, guard: () => Promise<void>) {
		this.inner = inner;
		this.guard = guard;
	}

	get name(): string {
		return this.inner.name;
	}
	get session(): SessionTree {
		const adaptive = this.inner as unknown as { session: SessionTree };
		return new BranchOriginGuardedTree(adaptive.session, this.guard);
	}

	// ------------------------------------------------------------ reads
	getLeafId(): Promise<string | null> {
		return this.inner.getLeafId();
	}
	getLastResult(): Promise<LaneLastResult | undefined> {
		return this.inner.getLastResult();
	}
	getOpenOperation(): Promise<OpenOperationInfo | null> {
		return this.inner.getOpenOperation();
	}
	getModel(): Promise<Model<Api> | undefined> {
		return this.inner.getModel();
	}
	getThinkingLevel(): Promise<ThinkingLevel> {
		return this.inner.getThinkingLevel();
	}
	getActiveTools(): Promise<string[]> {
		return this.inner.getActiveTools();
	}
	peekAction(): Promise<ActionInfo | undefined> {
		return this.inner.peekAction();
	}
	waitForIdle(): Promise<void> {
		return this.inner.waitForIdle();
	}
	watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.inner.watch();
	}

	// ---------------------------------------------------- mutation surface
	async prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	async prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		await this.guard();
		return typeof input === "string" ? this.inner.prompt(input, images) : this.inner.prompt(input);
	}
	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		await this.guard();
		return this.inner.skill(name, additionalInstructions);
	}
	async promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		await this.guard();
		return this.inner.promptFromTemplate(name, args);
	}
	async compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
		await this.guard();
		return this.inner.compact(options);
	}
	async navigateTree(
		targetId: string | null,
		options?: { summarize?: boolean; label?: string; customInstructions?: string },
	): Promise<NavigationResult> {
		await this.guard();
		return this.inner.navigateTree(targetId, options);
	}
	async resume(): Promise<ResumeResult> {
		await this.guard();
		return this.inner.resume();
	}
	async abort(): Promise<AbortResult> {
		await this.guard();
		return this.inner.abort();
	}
	async steer(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		await this.guard();
		return this.inner.steer(message, images);
	}
	async followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		await this.guard();
		return this.inner.followUp(message, images);
	}
	async nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult> {
		await this.guard();
		return this.inner.nextRun(message, images);
	}
	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		await this.guard();
		return this.inner.cancelQueued(entryId);
	}
	async recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		await this.guard();
		return this.inner.recordUsage(usage, options);
	}
	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		await this.guard();
		await this.inner.runWhenIdle(callback);
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		await this.guard();
		return this.inner.executeAction();
	}
	async runToCompletion(): Promise<void> {
		await this.guard();
		await this.inner.runToCompletion();
	}
	async setModel(model: Model<Api>): Promise<void> {
		await this.guard();
		await this.inner.setModel(model);
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.guard();
		await this.inner.setThinkingLevel(level);
	}
	async setActiveTools(names: string[]): Promise<void> {
		await this.guard();
		await this.inner.setActiveTools(names);
	}

	// ---------------------------------------------------- adaptive surface
	async promptAdaptive(message: AgentMessage | AgentMessage[], basis: AdaptiveRunBasisInput): Promise<RunResult> {
		await this.guard();
		return (this.inner as unknown as AdaptiveAgentLane).promptAdaptive(message, basis);
	}
	async promptAdaptiveTurn(
		message: AgentMessage | AgentMessage[],
		basis: AdaptiveRunBasisInput,
	): Promise<AdaptiveTurnResult> {
		await this.guard();
		return (this.inner as unknown as AdaptiveAgentLane).promptAdaptiveTurn(message, basis);
	}
	async resumeAdaptiveTurn(): Promise<AdaptiveAdvanceResult> {
		await this.guard();
		return (this.inner as unknown as AdaptiveAgentLane).resumeAdaptiveTurn();
	}
	async acceptAdaptiveContinuation(
		basis: AdaptiveRunBasisInput,
		options?: { systemPromptOverride?: string; resumeData?: Record<string, JsonValue> },
	): Promise<AdaptiveAdmissionResult> {
		await this.guard();
		return (this.inner as unknown as AdaptiveAgentLane).acceptAdaptiveContinuation(basis, options);
	}
	async capturePostTurnCheckpoint<T>(
		callback: (info: PostTurnCheckpointInfo) => T | Promise<T>,
	): Promise<{ ok: true; value: T } | { ok: false; error: PostTurnCheckpointRejection }> {
		await this.guard();
		return (this.inner as unknown as AdaptiveAgentLane).capturePostTurnCheckpoint(callback);
	}
}
