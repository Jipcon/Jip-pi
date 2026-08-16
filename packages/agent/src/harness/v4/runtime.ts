import type { RetryPolicy } from "@earendil-works/pi-ai";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { JsonValue } from "./base.ts";
import type { OperationState } from "./operation.ts";
import type { CommitResult, Session, Transaction } from "./storage.ts";
import { SessionError } from "./storage.ts";
import type { Action, ActionInfo, CurrentOperation, HarnessEvent, RuntimeSnapshot, Tagged } from "./surface.ts";

export { HarnessClosedError, HarnessFaultError, HarnessNotImplementedError } from "./errors.ts";

import { HarnessClosedError, HarnessFaultError } from "./errors.ts";

export { nextAction, normalizeRetryPolicy } from "./generation.ts";

import { normalizeRetryPolicy } from "./generation.ts";

class MutationLine {
	private tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(operation, operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	whenIdle(): Promise<void> {
		return this.tail;
	}
}

interface DeferredValue<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): DeferredValue<T> {
	let resolve!: DeferredValue<T>["resolve"];
	let reject!: DeferredValue<T>["reject"];
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

interface ParkedAction {
	info: ActionInfo;
	identity?: { operationId: string };
	onCancel?: () => Promise<unknown> | unknown;
	release: DeferredValue<{ cancelled: boolean }>;
}

interface GateRunOptions<T> {
	/** Operation this action belongs to; operation abort wakes or cancels it. */
	operationId?: string;
	/** Replacement result when the parked action is cancelled before release. */
	onCancel?: () => Promise<T> | T;
}

export class ManualEffectGate {
	private readonly mode: "automatic" | "manual";
	private readonly parked: ParkedAction[] = [];
	private readonly changed = new Set<() => void>();
	private readonly active = new Set<Promise<unknown>>();
	private readonly tracked = new Set<Promise<unknown>>();
	private closedError: Error | undefined;

	constructor(mode: "automatic" | "manual") {
		this.mode = mode;
	}

	private notify(): void {
		for (const listener of this.changed) listener();
		this.changed.clear();
	}

	private waitForChange(): Promise<void> {
		return new Promise((resolve) => this.changed.add(resolve));
	}

	/**
	 * Track a drive promise: runToCompletion only returns once tracked work
	 * has settled, so async hops inside the interpreter cannot strand parked
	 * actions that are registered a microtask later.
	 */
	track<T>(promise: Promise<T>): void {
		this.tracked.add(promise);
		void promise.then(
			() => {
				this.tracked.delete(promise);
				this.notify();
			},
			() => {
				this.tracked.delete(promise);
				this.notify();
			},
		);
	}

	run<T>(info: ActionInfo, effect: () => Promise<T> | T, options: GateRunOptions<T> = {}): Promise<T> {
		if (this.closedError !== undefined) return Promise.reject(this.closedError);
		const run = async (): Promise<T> => {
			if (this.mode === "manual") {
				const release = deferred<{ cancelled: boolean }>();
				this.parked.push({
					info: structuredClone(info),
					...(options.operationId === undefined ? {} : { identity: { operationId: options.operationId } }),
					...(options.onCancel === undefined ? {} : { onCancel: options.onCancel }),
					release,
				});
				this.notify();
				const released = await release.promise;
				if (released.cancelled && options.onCancel !== undefined) return options.onCancel();
			}
			if (this.closedError !== undefined) throw this.closedError;
			return effect();
		};
		const promise = run();
		this.active.add(promise);
		void promise.then(
			() => {
				this.active.delete(promise);
				this.notify();
			},
			() => {
				this.active.delete(promise);
				this.notify();
			},
		);
		return promise;
	}

	/**
	 * Operation abort: every not-yet-released parked action of that operation
	 * is woken; actions that declared an `onCancel` replacement (external
	 * effects, hooks) resolve with it instead of running, everything else
	 * proceeds and re-validates against the durable cancelled state.
	 */
	cancelOperation(operationId: string): void {
		const remaining: ParkedAction[] = [];
		for (const action of this.parked) {
			if (action.identity?.operationId === operationId) action.release.resolve({ cancelled: true });
			else remaining.push(action);
		}
		this.parked.splice(0, this.parked.length, ...remaining);
		this.notify();
	}

	peekAction(): Promise<ActionInfo | undefined> {
		return Promise.resolve(this.parked[0] === undefined ? undefined : structuredClone(this.parked[0].info));
	}

	executeAction(): Promise<ActionInfo | undefined> {
		if (this.closedError !== undefined) return Promise.reject(this.closedError);
		const action = this.parked.shift();
		if (action === undefined) return Promise.resolve(undefined);
		action.release.resolve({ cancelled: false });
		this.notify();
		return Promise.resolve(structuredClone(action.info));
	}

	async runToCompletion(): Promise<void> {
		for (;;) {
			if (this.closedError !== undefined) throw this.closedError;
			const action = this.parked.shift();
			if (action !== undefined) {
				action.release.resolve({ cancelled: false });
				await Promise.resolve();
				continue;
			}
			if (this.active.size === 0 && this.tracked.size === 0) return;
			await this.waitForChange();
		}
	}

	close(error: Error): void {
		if (this.closedError !== undefined) return;
		this.closedError = error;
		for (const action of this.parked.splice(0)) action.release.reject(error);
		this.notify();
	}

	async whenIdle(): Promise<void> {
		await Promise.allSettled([...this.active]);
	}
}

function cloneStreamOptions(options: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
	return structuredClone(options);
}

type EventPublisher = (event: HarnessEvent) => void;

export interface LaneCommitPlan<T> {
	transaction: Transaction;
	complete(result: CommitResult): T;
}

type CommitWriter = (transaction: Transaction) => Promise<CommitResult>;

export class RuntimeCoordinator {
	readonly gate: ManualEffectGate;
	/** Close/fault signal: aborted exactly once when the harness seals. */
	readonly signal: AbortSignal;
	private readonly session: Session;
	private readonly settingsLine = new MutationLine();
	private readonly laneLines = new Map<string, MutationLine>();
	private readonly controller = new AbortController();
	private readonly operationControllers = new Map<string, AbortController>();
	private readonly publish: EventPublisher | undefined;
	private streamOptions: AgentHarnessStreamOptions;
	private retryPolicy: RetryPolicy;
	private settingsRevision = 0;
	private state: "open" | "closing" | "closed" | "faulted" = "open";
	private faultError: HarnessFaultError | undefined;
	private readonly admitted = new Set<Promise<unknown>>();
	private closePromise: Promise<void> | undefined;

	constructor(
		session: Session,
		drive: "automatic" | "manual",
		streamOptions: AgentHarnessStreamOptions,
		retryPolicy: RetryPolicy,
		publish?: EventPublisher,
	) {
		this.session = session;
		this.gate = new ManualEffectGate(drive);
		this.streamOptions = cloneStreamOptions(streamOptions);
		this.retryPolicy = structuredClone(retryPolicy);
		this.signal = this.controller.signal;
		this.publish = publish;
	}

	/**
	 * Process-local per-operation signal. Provider, tool, and sleep effects use
	 * it; aborting one operation never affects another lane. The close
	 * controller aborts every operation controller on close/fault.
	 */
	operationSignal(operationId: string): AbortSignal {
		const existing = this.operationControllers.get(operationId);
		if (existing !== undefined) return existing.signal;
		const controller = new AbortController();
		this.operationControllers.set(operationId, controller);
		return controller.signal;
	}

	/** Abort one operation's signal and wake its parked manual actions. */
	abortOperation(operationId: string): void {
		this.gate.cancelOperation(operationId);
		this.operationControllers.get(operationId)?.abort();
	}

	/** Drop the process-local controller once the operation is terminal. */
	releaseOperation(operationId: string): void {
		this.operationControllers.delete(operationId);
	}

	/** Close/fault: abort the close signal and every operation signal. */
	abortAll(reason: Error): void {
		this.controller.abort(reason);
		for (const controller of this.operationControllers.values()) controller.abort(reason);
	}

	private rejection(): Error | undefined {
		if (this.state === "faulted") return this.faultError;
		if (this.state === "closing" || this.state === "closed") return new HarnessClosedError();
		return undefined;
	}

	private admit<T>(operation: () => Promise<T> | T): Promise<T> {
		const rejection = this.rejection();
		if (rejection !== undefined) return Promise.reject(rejection);
		const promise = Promise.resolve().then(operation);
		this.admitted.add(promise);
		void promise.then(
			() => this.admitted.delete(promise),
			() => this.admitted.delete(promise),
		);
		return promise;
	}

	private laneLine(lane: string): MutationLine {
		const existing = this.laneLines.get(lane);
		if (existing !== undefined) return existing;
		const line = new MutationLine();
		this.laneLines.set(lane, line);
		return line;
	}

	mutateLane<T>(lane: string, operation: () => Promise<T> | T): Promise<T> {
		return this.admit(() => this.laneLine(lane).run(operation));
	}

	mutateLaneAndCommit<T>(lane: string, prepare: () => Promise<LaneCommitPlan<T>> | LaneCommitPlan<T>): Promise<T> {
		return this.admit(() =>
			this.laneLine(lane).run(async () => {
				const plan = await prepare();
				const result = await this.write(plan.transaction);
				return plan.complete(result);
			}),
		);
	}

	mutateLaneWithWriter<T>(lane: string, operation: (write: CommitWriter) => Promise<T> | T): Promise<T> {
		return this.admit(() => this.laneLine(lane).run(() => operation((transaction) => this.write(transaction))));
	}

	mutateSettings<T>(operation: () => Promise<T> | T): Promise<T> {
		return this.admit(() =>
			this.settingsLine.run(async () => {
				const result = await operation();
				this.settingsRevision++;
				return result;
			}),
		);
	}

	withSettingsAndLane<T>(lane: string, operation: (snapshot: RuntimeSnapshot) => Promise<T> | T): Promise<T> {
		return this.admit(() =>
			this.settingsLine.run(() => {
				const snapshot = this.runtimeSnapshot();
				return this.laneLine(lane).run(() => operation(snapshot));
			}),
		);
	}

	withSettingsAndLaneWriter<T>(
		lane: string,
		operation: (snapshot: RuntimeSnapshot, write: CommitWriter) => Promise<T> | T,
	): Promise<T> {
		return this.admit(() =>
			this.settingsLine.run(() => {
				const snapshot = this.runtimeSnapshot();
				return this.laneLine(lane).run(() => operation(snapshot, (transaction) => this.write(transaction)));
			}),
		);
	}

	async commit(transaction: Transaction): Promise<CommitResult>;
	async commit<T>(transaction: Transaction, writer: () => Promise<T>): Promise<T>;
	async commit<T>(transaction: Transaction, writer?: () => Promise<T>): Promise<CommitResult | T> {
		return this.admit(async () => {
			if (writer !== undefined) {
				try {
					return await writer();
				} catch (error) {
					throw this.fault(error);
				}
			}
			return this.write(transaction);
		});
	}

	private async write(transaction: Transaction): Promise<CommitResult> {
		try {
			return await this.session.commit(transaction);
		} catch (error) {
			throw this.fault(error);
		}
	}

	commitTransition(
		current: CurrentOperation,
		next: OperationState,
		expectedConfigurationSeq?: number,
		expectedSettingsRevision?: number,
	): Promise<CurrentOperation | undefined> {
		const commitOnLane = () =>
			this.laneLine(current.operation.lane).run(async () => {
				const operationId = current.operation.operationId;
				const [operationState, laneState, configuration] = await Promise.all([
					this.session.getRegister("op.state", operationId),
					this.session.getRegister("lane.state", current.operation.lane),
					this.session.getRegister("lane.config", current.operation.lane),
				]);
				if (
					operationState === undefined ||
					laneState === undefined ||
					laneState.value.currentOperationId !== operationId
				) {
					return undefined;
				}
				if (
					operationState.seq !== current.operationStateSeq ||
					laneState.seq !== current.laneStateSeq ||
					(expectedConfigurationSeq !== undefined && configuration?.seq !== expectedConfigurationSeq)
				) {
					return undefined;
				}
				if (configuration === undefined) {
					throw new SessionError("corruption", `Lane ${current.operation.lane} has no configuration`);
				}
				if (current.operation.intent.kind !== next.kind) {
					throw new SessionError(
						"corruption",
						`Operation ${operationId} cannot transition from ${current.operation.intent.kind} to ${next.kind}`,
					);
				}
				const result = await this.write({
					writes: [{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: next }],
				});
				const operationStateSeq = result.seqs[0];
				if (operationStateSeq === undefined) {
					throw new SessionError("corruption", `Transition commit for ${operationId} returned no register seq`);
				}
				return {
					operation: structuredClone(current.operation),
					state: structuredClone(next),
					operationStateSeq,
					laneState: structuredClone(laneState.value),
					laneStateSeq: laneState.seq,
					leafId: current.leafId,
					configuration: structuredClone(configuration.value),
					configurationSeq: configuration.seq,
				};
			});

		return this.admit(() => {
			if (expectedSettingsRevision === undefined) return commitOnLane();
			return this.settingsLine.run(() =>
				this.settingsRevision === expectedSettingsRevision ? commitOnLane() : undefined,
			);
		});
	}

	fault(cause: unknown): HarnessFaultError {
		if (this.faultError !== undefined) return this.faultError;
		const error = new HarnessFaultError(cause);
		this.faultError = error;
		this.state = "faulted";
		this.abortAll(error);
		this.gate.close(error);
		this.publish?.({ type: "fault", code: "storage", message: error.message });
		return error;
	}

	isFaulted(): boolean {
		return this.state === "faulted";
	}

	runtimeSnapshot(): RuntimeSnapshot {
		return {
			settingsRevision: this.settingsRevision,
			streamOptions: cloneStreamOptions(this.streamOptions),
			retryPolicy: normalizeRetryPolicy(this.retryPolicy),
		};
	}

	getStreamOptions(): AgentHarnessStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> {
		return this.mutateSettings(() => {
			this.streamOptions = cloneStreamOptions(options);
		});
	}

	getRetryPolicy(): RetryPolicy {
		return structuredClone(this.retryPolicy);
	}

	setRetryPolicy(policy: RetryPolicy): Promise<void> {
		return this.mutateSettings(() => {
			this.retryPolicy = structuredClone(policy);
		});
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		const closeError = this.faultError ?? new HarnessClosedError();
		if (this.state === "open") this.state = "closing";
		this.abortAll(closeError);
		this.gate.close(closeError);
		this.closePromise = (async () => {
			await Promise.allSettled([...this.admitted]);
			await Promise.all([
				this.settingsLine.whenIdle(),
				...Array.from(this.laneLines.values(), (line) => line.whenIdle()),
			]);
			await this.gate.whenIdle();
			await this.session.close();
			if (this.state !== "faulted") this.state = "closed";
		})();
		return this.closePromise;
	}
}

export function actionInfo(kind: string, description: string, details?: JsonValue): ActionInfo {
	return details === undefined ? { kind, description } : { kind, description, details };
}

export function taggedError<Tag extends string, Properties extends object>(
	tag: Tag,
	message: string,
	properties: Properties,
): Tagged<Tag, Properties> {
	const error = new Error(message) as Tagged<Tag, Properties>;
	Object.assign(error, properties, { _tag: tag });
	return error;
}

function unreachable(value: never): never {
	throw new Error(`Unknown action ${(value as { kind?: unknown }).kind as string}`);
}

/** Produce the JSON-safe manual-drive view for every planner action variant. */
export function describeAction(action: Action): ActionInfo {
	switch (action.kind) {
		case "transition":
			return actionInfo("transition", `Transition ${action.next.kind} operation`);
		case "dispatch":
			return actionInfo("dispatch", `Dispatch ${action.effect.kind} effect`, {
				kind: action.effect.kind,
				key: action.effect.key,
			});
		case "await_effect":
			return actionInfo("await_effect", `Await effect ${action.key}`, { key: action.key });
		case "settle":
			return actionInfo("settle", `Settle ${action.plan.kind} effect from durable state`, {
				kind: action.plan.kind,
				key: action.plan.key,
			});
		case "drain":
			return actionInfo("drain", "Apply deferred writes and consume queue input", {
				entries: action.plan.entries.length,
			});
		case "prepare_tools":
			return actionInfo("prepare_tools", "Prepare pending tool calls");
		case "clear_tools":
			return actionInfo("clear_tools", "Clear the adaptive tool batch");
		case "recover_tool":
			return actionInfo(
				"recover_tool",
				`Recover tool call ${action.plan.kind === "tool" ? action.plan.sourceIndex : "?"}`,
				{ key: action.plan.key },
			);
		case "wait":
			return actionInfo("wait", `Wait until ${action.until}`, { until: action.until });
		case "suspend":
			return actionInfo("suspend", `Suspend with ${action.result.kind} result`);
		case "finish":
			return actionInfo("finish", `Finish with ${action.result.kind} result`);
		default:
			return unreachable(action);
	}
}
