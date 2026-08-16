import type { AgentMessage } from "../../types.ts";
import type { Entry, JsonValue, MessageEntry, ProvisionedEntry, UsageRow } from "./base.ts";
import { HARNESS_V4_STORAGE_VERSION } from "./base.ts";
import { SessionCodec } from "./codec.ts";
import { UuidV7Generator } from "./id.ts";
import { InMemorySessionStore, InMemoryStorage } from "./memory.ts";
import type { LaneState } from "./operation.ts";
import {
	type BranchScan,
	type CommitResult,
	type EntryQuery,
	type ForkOptions,
	type Register,
	type RegisterNamespace,
	type Session,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionSnapshot,
	type SessionStats,
	type SessionTree,
	type Storage,
	type Transaction,
	type TurnCommit,
	type TurnCommitQuery,
	type UsageScan,
} from "./storage.ts";

const IDLE_LANE_STATE: LaneState = { currentOperationId: null, pendingNextRun: [] };

/** The initial lane placement and idle state published by every new session. */
export const INITIAL_MAIN_LANE_WRITES: Transaction["writes"] = [
	{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
	{
		kind: "register",
		op: "set",
		namespace: "lane.state",
		key: "main",
		value: structuredClone(IDLE_LANE_STATE),
	},
];

export interface InMemorySessionCreateOptions {
	id?: string;
	parentSessionId?: string;
	cwd?: string;
}

export interface InMemorySessionListOptions {
	cwd?: string;
}

export interface InMemorySessionRepoOptions {
	codec?: SessionCodec;
	now?: () => number;
}

function provisionEntry(entry: Entry): ProvisionedEntry {
	const { seq, timestamp, ...provisioned } = structuredClone(entry);
	void seq;
	void timestamp;
	return provisioned as ProvisionedEntry;
}

function snapshotRegister<N extends RegisterNamespace>(
	registers: readonly Register[],
	namespace: N,
	key: string,
): Register<N> | undefined {
	return registers.find((register) => register.namespace === namespace && register.key === key) as
		| Register<N>
		| undefined;
}

function snapshotRegisters<N extends RegisterNamespace>(registers: readonly Register[], namespace: N): Register<N>[] {
	return registers.filter((register) => register.namespace === namespace) as Register<N>[];
}

function snapshotBranch(entries: readonly Entry[], start: string): Entry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: Entry[] = [];
	let current = byId.get(start);
	while (current !== undefined) {
		path.push(current);
		if (current.parentId === null) {
			current = undefined;
		} else {
			const parent = byId.get(current.parentId);
			if (parent === undefined) throw new SessionError("corruption", `Entry parent ${current.parentId} is missing`);
			current = parent;
		}
	}
	return path.reverse();
}

/** Fork writes computed from one coherent snapshot, shared by every backend repository. */
export function buildForkWrites(
	snapshot: SessionSnapshot,
	options: ForkOptions,
): { writes: Transaction["writes"]; entryTimestamps: ReadonlyMap<string, number> } {
	const allEntries = snapshot.entries;
	let entries: Entry[];
	let laneLeaves: Array<{ key: string; value: string | null }>;
	if (options.scope === "tree") {
		entries = allEntries;
		laneLeaves = snapshotRegisters(snapshot.registers, "lane.leaf").map(({ key, value }) => ({ key, value }));
	} else {
		const sourceLane = options.lane ?? "main";
		const sourceLeaf = snapshotRegister(snapshot.registers, "lane.leaf", sourceLane)?.value;
		if (sourceLeaf === undefined) {
			throw new SessionError("invalid_lane", `Source lane ${sourceLane} does not exist`);
		}
		let target = options.entryId ?? sourceLeaf;
		if (target !== null) {
			const targetEntry = allEntries.find((entry) => entry.id === target);
			if (targetEntry?.type !== "message") {
				throw new SessionError("invalid_fork_target", `Fork target ${target} does not exist`);
			}
			if ((options.position ?? "before") === "before") target = targetEntry.parentId;
		}
		entries = target === null ? [] : snapshotBranch(allEntries, target);
		laneLeaves = [{ key: sourceLane, value: target }];
	}

	const writes: Transaction["writes"] = entries.map((entry) => ({
		kind: "entry",
		entry: provisionEntry(entry),
	}));
	for (const leaf of laneLeaves) {
		writes.push({ kind: "register", op: "set", namespace: "lane.leaf", key: leaf.key, value: leaf.value });
		writes.push({
			kind: "register",
			op: "set",
			namespace: "lane.state",
			key: leaf.key,
			value: structuredClone(IDLE_LANE_STATE),
		});
		const configuration = snapshotRegister(snapshot.registers, "lane.config", leaf.key);
		if (configuration !== undefined) {
			writes.push({
				kind: "register",
				op: "set",
				namespace: "lane.config",
				key: leaf.key,
				value: configuration.value,
			});
		}
	}
	const copiedEntryIds = new Set(entries.map((entry) => entry.id));
	for (const namespace of ["fact.name", "fact.label", "fact.custom"] as const) {
		for (const fact of snapshotRegisters(snapshot.registers, namespace)) {
			if (namespace === "fact.label" && !copiedEntryIds.has(fact.key)) continue;
			writes.push({
				kind: "register",
				op: "set",
				namespace,
				key: fact.key,
				value: fact.value,
			} as Transaction["writes"][number]);
		}
	}
	return { writes, entryTimestamps: new Map(entries.map((entry) => [entry.id, entry.timestamp])) };
}

class SessionTreeView implements SessionTree {
	private readonly owner: StorageSession;
	private readonly lane: string;

	constructor(owner: StorageSession, lane: string) {
		this.owner = owner;
		this.lane = lane;
	}

	getLeafId(): Promise<string | null> {
		return this.owner.getLaneLeaf(this.lane);
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.owner.getEntry(id);
	}

	getStats(): Promise<SessionStats> {
		return this.owner.getStats();
	}

	getName(): Promise<string | undefined> {
		return this.owner.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.owner.setName(name);
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.owner.getLabel(targetId);
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.owner.setLabel(targetId, label);
	}

	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.owner.getCustomFact(key);
	}

	setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		return this.owner.setCustomFact(key, value);
	}

	findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return this.owner.findEntries(query);
	}

	findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		return this.owner.findEntry(query);
	}

	findEntriesOnBranch(query: BranchScan = {}): Promise<Entry[]> {
		return this.owner.findEntriesOnLaneBranch(this.lane, query);
	}

	findEntryOnBranch(query: BranchScan = {}): Promise<Entry | undefined> {
		return this.owner.findEntryOnLaneBranch(this.lane, query);
	}

	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		return this.owner.getTurnCommit(query);
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.owner.appendMessageToLane(this.lane, message);
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.owner.appendCustomEntryToLane(this.lane, customType, data);
	}
}

/**
 * Backend-neutral durable session handle: one serialized mutation queue over a
 * `Storage` implementation plus the shared tree/lane/fact/query surface.
 */
export class StorageSession implements Session {
	readonly metadata: SessionMetadata;
	readonly idGenerator: UuidV7Generator;
	private readonly mainView: SessionTreeView;
	private readonly storage: Storage;
	private mutationQueue: Promise<void> = Promise.resolve();
	private sealed = false;
	private closePromise: Promise<void> | undefined;

	constructor(metadata: SessionMetadata, storage: Storage, now: () => number) {
		this.metadata = structuredClone(metadata);
		this.storage = storage;
		this.idGenerator = new UuidV7Generator(now);
		this.mainView = new SessionTreeView(this, "main");
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		if (this.sealed) return Promise.reject(new SessionError("closed", `Session ${this.metadata.id} is closed`));
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	view(lane: string): SessionTree {
		if (lane.length === 0) throw new SessionError("invalid_lane", "Lane name must not be empty");
		return lane === "main" ? this.mainView : new SessionTreeView(this, lane);
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		return this.mutate(() => this.storage.commit(transaction));
	}

	private readable<T>(operation: () => Promise<T>): Promise<T> {
		if (this.sealed) return Promise.reject(new SessionError("closed", `Session ${this.metadata.id} is closed`));
		return operation();
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.readable(() => this.storage.getEntries(ids));
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined> {
		return this.readable(() => this.storage.getRegister(namespace, key));
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]> {
		return this.readable(() => this.storage.listRegisters(namespace, keyPrefix));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.readable(() => this.storage.scanUsage(query));
	}

	async close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.sealed = true;
		this.closePromise = this.mutationQueue.then(() => this.storage.close());
		return this.closePromise;
	}

	getLeafId(): Promise<string | null> {
		return this.mainView.getLeafId();
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.getEntries([id]).then((entries) => entries.get(id));
	}

	getStats(): Promise<SessionStats> {
		return this.readable(() => this.storage.getStats());
	}

	async getName(): Promise<string | undefined> {
		return (await this.getRegister("fact.name", ""))?.value;
	}

	setName(name: string | undefined): Promise<void> {
		return this.setFact("fact.name", "", name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return (await this.getRegister("fact.label", targetId))?.value;
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		if ((await this.getEntry(targetId)) === undefined) {
			throw new SessionError("not_found", `Entry ${targetId} does not exist`);
		}
		return this.setFact("fact.label", targetId, label);
	}

	async getCustomFact(key: string): Promise<JsonValue | undefined> {
		return (await this.getRegister("fact.custom", key))?.value;
	}

	setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		return this.setFact("fact.custom", key, value);
	}

	private async setFact(
		namespace: "fact.name" | "fact.label" | "fact.custom",
		key: string,
		value: string | JsonValue | undefined,
	): Promise<void> {
		await this.commit({
			writes: [
				value === undefined
					? { kind: "register", op: "delete", namespace, key }
					: ({ kind: "register", op: "set", namespace, key, value } as Transaction["writes"][number]),
			],
		});
	}

	findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		const order = query.order ?? "desc";
		const fromSeq = order === "asc" && query.cursor !== undefined ? query.cursor.seq + 1 : undefined;
		const toSeq = order === "desc" && query.cursor !== undefined ? query.cursor.seq - 1 : undefined;
		return this.readable(() =>
			this.storage.scanEntries({
				type: query.type,
				customType: query.customType,
				order,
				limit: query.limit,
				fromSeq,
				toSeq,
			}),
		);
	}

	async findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		return (await this.findEntries({ ...query, limit: 1 }))[0];
	}

	findEntriesOnBranch(query: BranchScan = {}): Promise<Entry[]> {
		return this.mainView.findEntriesOnBranch(query);
	}

	findEntryOnBranch(query: BranchScan = {}): Promise<Entry | undefined> {
		return this.mainView.findEntryOnBranch(query);
	}

	async getLaneLeaf(lane: string): Promise<string | null> {
		const register = await this.getRegister("lane.leaf", lane);
		if (register === undefined) throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
		return register.value;
	}

	async findEntriesOnLaneBranch(lane: string, query: BranchScan): Promise<Entry[]> {
		const start = query.start ?? (await this.getLaneLeaf(lane));
		if (start === null) return [];
		return this.storage.scanBranch({ ...query, start });
	}

	async findEntryOnLaneBranch(lane: string, query: BranchScan): Promise<Entry | undefined> {
		return (await this.findEntriesOnLaneBranch(lane, { ...query, limit: 1 }))[0];
	}

	async getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		const entries = await this.getEntries([query.assistantEntryId, query.leafId]);
		const assistant = entries.get(query.assistantEntryId);
		if (assistant?.type !== "message" || assistant.message.role !== "assistant") return undefined;
		if (!entries.has(query.leafId)) return undefined;

		const segment = await this.storage.scanBranch({
			start: query.leafId,
			stopAtId: query.assistantEntryId,
			order: "oldestFirst",
		});
		if (segment[0]?.id !== query.assistantEntryId || segment.at(-1)?.id !== query.leafId) return undefined;
		const calls = assistant.message.content.filter((part) => part.type === "toolCall");
		const toolResultEntries: MessageEntry[] = [];
		let callIndex = 0;
		for (const entry of segment.slice(1)) {
			if (entry.type === "custom") continue;
			if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
			if (entry.message.toolCallId !== calls[callIndex]?.id) return undefined;
			toolResultEntries.push(entry);
			callIndex++;
		}
		if (callIndex !== calls.length) return undefined;
		const associatedIds = [assistant.id, ...toolResultEntries.map((entry) => entry.id)];
		const usageRows = await this.storage.scanUsage({ entryIds: associatedIds, order: "asc" });
		if (!usageRows.some((row) => row.entryId === assistant.id)) return undefined;
		return { assistantEntry: assistant, toolResultEntries, usageRows };
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.mainView.appendMessage(message);
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.mainView.appendCustomEntry(customType, data);
	}

	appendMessageToLane(lane: string, message: AgentMessage): Promise<string> {
		return this.appendToLane(lane, {
			id: this.idGenerator.next(),
			parentId: null,
			type: "message",
			message,
		});
	}

	appendCustomEntryToLane(lane: string, customType: string, data?: JsonValue): Promise<string> {
		return this.appendToLane(lane, {
			id: this.idGenerator.next(),
			parentId: null,
			type: "custom",
			customType,
			...(data === undefined ? {} : { data }),
		});
	}

	private mutateDirect<T>(operation: () => Promise<T>): Promise<T> {
		return this.mutate(operation);
	}

	private appendToLane(lane: string, entry: ProvisionedEntry): Promise<string> {
		return this.mutateDirect(async () => {
			const leaf = await this.storage.getRegister("lane.leaf", lane);
			if (leaf === undefined) throw new SessionError("invalid_lane", `Lane ${lane} does not exist`);
			const provisioned = { ...entry, parentId: leaf.value } as ProvisionedEntry;
			await this.storage.commit({
				writes: [
					{ kind: "entry", entry: provisioned },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: provisioned.id },
				],
			});
			return provisioned.id;
		});
	}
}

interface SessionRecord {
	metadata: SessionMetadata;
	store: InMemorySessionStore;
}

/** Backwards-compatible alias kept for the shared backend-neutral session handle. */
export { StorageSession as InMemorySession };

export class InMemorySessionRepo
	implements SessionRepo<SessionMetadata, InMemorySessionCreateOptions, InMemorySessionListOptions>
{
	private readonly records = new Map<string, SessionRecord>();
	private readonly codec: SessionCodec;
	private readonly now: () => number;
	private readonly sessionIds: UuidV7Generator;

	constructor(options: InMemorySessionRepoOptions = {}) {
		this.codec = options.codec ?? new SessionCodec();
		this.now = options.now ?? Date.now;
		this.sessionIds = new UuidV7Generator(this.now);
	}

	create(options: InMemorySessionCreateOptions = {}): Promise<StorageSession> {
		return this.createSession(options);
	}

	private async createSession(
		options: InMemorySessionCreateOptions,
		preserveEntryTimestamps?: ReadonlyMap<string, number>,
	): Promise<StorageSession> {
		const id = options.id ?? this.sessionIds.next();
		if (this.records.has(id)) throw new SessionError("already_exists", `Session ${id} already exists`);
		const metadata: SessionMetadata = {
			id,
			createdAt: this.now(),
			storageVersion: HARNESS_V4_STORAGE_VERSION,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		};
		const store = new InMemorySessionStore(metadata);
		const storage = new InMemoryStorage(
			metadata,
			{
				codec: this.codec,
				now: this.now,
				preserveEntryTimestamps,
			},
			store,
		);
		try {
			await storage.commit({ writes: INITIAL_MAIN_LANE_WRITES.map((write) => structuredClone(write)) });
		} catch (error) {
			await storage.close();
			throw error;
		}
		this.records.set(id, { metadata: structuredClone(metadata), store });
		return new StorageSession(metadata, storage, this.now);
	}

	async open(metadata: SessionMetadata): Promise<StorageSession> {
		if (metadata.storageVersion !== HARNESS_V4_STORAGE_VERSION) {
			throw new SessionError(
				"storage_version",
				`Unsupported storage version ${metadata.storageVersion}; expected ${HARNESS_V4_STORAGE_VERSION}`,
			);
		}
		const record = this.records.get(metadata.id);
		if (record === undefined) throw new SessionError("not_found", `Session ${metadata.id} does not exist`);
		const storage = new InMemoryStorage(record.metadata, { codec: this.codec, now: this.now }, record.store);
		return new StorageSession(record.metadata, storage, this.now);
	}

	list(options: InMemorySessionListOptions = {}): Promise<SessionMetadata[]> {
		const metadata = [...this.records.values()]
			.map((record) => record.metadata)
			.filter((candidate) => options.cwd === undefined || candidate.cwd === options.cwd)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map((candidate) => structuredClone(candidate));
		return Promise.resolve(metadata);
	}

	delete(metadata: SessionMetadata): Promise<void> {
		const record = this.records.get(metadata.id);
		if (record === undefined) return Promise.resolve();
		if (record.store.activeStorage !== undefined) {
			return Promise.reject(new SessionError("storage", `Session ${metadata.id} still has an active writer`));
		}
		this.records.delete(metadata.id);
		return Promise.resolve();
	}

	async fork(source: SessionMetadata, options: ForkOptions & InMemorySessionCreateOptions): Promise<StorageSession> {
		const record = this.records.get(source.id);
		if (record === undefined) throw new SessionError("not_found", `Session ${source.id} does not exist`);
		const sourceAlreadyOpen = record.store.activeStorage !== undefined;
		const sourceStorage =
			record.store.activeStorage ??
			new InMemoryStorage(record.metadata, { codec: this.codec, now: this.now }, record.store);
		const closeSource = !sourceAlreadyOpen;
		let child: StorageSession | undefined;
		try {
			const snapshot = await sourceStorage.snapshot();
			const { writes, entryTimestamps } = buildForkWrites(snapshot, options);
			child = await this.createSession(
				{
					id: options.id,
					cwd: options.cwd ?? record.metadata.cwd,
					parentSessionId: source.id,
				},
				entryTimestamps,
			);
			if (writes.length > 0) await child.commit({ writes });
			return child;
		} catch (error) {
			if (child !== undefined) {
				await child.close();
				this.records.delete(child.metadata.id);
			}
			throw error;
		} finally {
			if (closeSource) await sourceStorage.close();
		}
	}
}
