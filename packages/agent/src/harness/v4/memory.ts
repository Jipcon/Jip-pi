import type { Usage } from "@earendil-works/pi-ai";
import { type Entry, type EntryStructure, HARNESS_V4_STORAGE_VERSION, type UsageRow } from "./base.ts";
import {
	type BranchScan,
	type CommitResult,
	type EntryScan,
	type Register,
	type RegisterNamespace,
	type SessionCodecLike,
	SessionError,
	type SessionMetadata,
	type SessionSnapshot,
	type SessionStats,
	type Storage,
	type Transaction,
	type UsageScan,
} from "./storage.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface MemoryState {
	seq: number;
	entries: Map<string, Entry>;
	registers: Map<string, Register>;
	usage: Map<string, UsageRow>;
	stats: SessionStats;
}

/** Backwards-compatible alias kept for the shared snapshot shape. */
export type InMemorySessionSnapshot = SessionSnapshot;

export interface InMemoryStorageOptions {
	codec: SessionCodecLike;
	now?: () => number;
	preserveEntryTimestamps?: ReadonlyMap<string, number>;
}

/** Shared durable state. Each open storage handle is single-writer and independently closeable. */
export class InMemorySessionStore {
	readonly metadata: SessionMetadata;
	state: MemoryState;
	activeStorage: InMemoryStorage | undefined;

	constructor(metadata: SessionMetadata) {
		this.metadata = structuredClone(metadata);
		this.state = {
			seq: 0,
			entries: new Map(),
			registers: new Map(),
			usage: new Map(),
			stats: { messageCount: 0, usage: structuredClone(ZERO_USAGE) },
		};
	}
}

function registerKey(namespace: RegisterNamespace, key: string): string {
	return `${namespace}\u0000${key}`;
}

function cloneState(state: MemoryState): MemoryState {
	return {
		seq: state.seq,
		entries: new Map([...state.entries].map(([id, entry]) => [id, structuredClone(entry)])),
		registers: new Map([...state.registers].map(([key, register]) => [key, structuredClone(register)])),
		usage: new Map([...state.usage].map(([id, row]) => [id, structuredClone(row)])),
		stats: structuredClone(state.stats),
	};
}

function addUsage(total: Usage, addition: Usage): void {
	total.input += addition.input;
	total.output += addition.output;
	total.cacheRead += addition.cacheRead;
	total.cacheWrite += addition.cacheWrite;
	total.totalTokens += addition.totalTokens;
	total.cost.input += addition.cost.input;
	total.cost.output += addition.cost.output;
	total.cost.cacheRead += addition.cost.cacheRead;
	total.cost.cacheWrite += addition.cost.cacheWrite;
	total.cost.total += addition.cost.total;
	if (addition.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + addition.cacheWrite1h;
	if (addition.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + addition.reasoning;
}

function validateLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
		throw new SessionError("invalid_query", "Query limit must be a non-negative safe integer");
	}
}

function validateSequenceBound(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new SessionError("invalid_query", `${name} must be a non-negative safe integer`);
	}
}

function entryMatches(entry: Entry, query: { type?: Entry["type"]; customType?: string }): boolean {
	return (
		(query.type === undefined || entry.type === query.type) &&
		(query.customType === undefined || entry.customType === query.customType)
	);
}

export class InMemoryStorage implements Storage {
	readonly metadata: SessionMetadata;
	readonly store: InMemorySessionStore;
	private readonly codec: SessionCodecLike;
	private readonly now: () => number;
	private readonly preserveEntryTimestamps: ReadonlyMap<string, number> | undefined;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(metadata: SessionMetadata, options: InMemoryStorageOptions, store?: InMemorySessionStore) {
		if (metadata.storageVersion !== HARNESS_V4_STORAGE_VERSION) {
			throw new SessionError(
				"storage_version",
				`Unsupported storage version ${metadata.storageVersion}; expected ${HARNESS_V4_STORAGE_VERSION}`,
			);
		}
		this.metadata = structuredClone(metadata);
		this.codec = options.codec;
		this.now = options.now ?? Date.now;
		this.preserveEntryTimestamps = options.preserveEntryTimestamps;
		this.store = store ?? new InMemorySessionStore(metadata);
		if (this.store.metadata.id !== metadata.id || this.store.metadata.storageVersion !== metadata.storageVersion) {
			throw new SessionError("storage", "Storage metadata does not match the shared memory store");
		}
		if (this.store.activeStorage !== undefined) {
			throw new SessionError("storage", `Session ${metadata.id} already has an active writer`);
		}
		this.store.activeStorage = this;
	}

	private assertOpen(): void {
		if (this.closed) throw new SessionError("closed", `Storage for session ${this.metadata.id} is closed`);
	}

	private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
		this.assertOpen();
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		this.codec.validateTransaction(transaction);
		return this.serialize(() => {
			if (transaction.writes.length === 0) {
				throw new SessionError("invalid_payload", "A transaction must contain at least one write");
			}
			const draft = cloneState(this.store.state);
			const timestamp = this.now();
			if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
				throw new SessionError("storage", "Storage clock returned an invalid timestamp");
			}
			const seqs: number[] = [];

			for (const write of transaction.writes) {
				const seq = ++draft.seq;
				seqs.push(seq);
				if (write.kind === "entry") {
					if (draft.entries.has(write.entry.id) || draft.usage.has(write.entry.id)) {
						throw new SessionError("already_exists", `Entry or usage id ${write.entry.id} already exists`);
					}
					if (write.entry.parentId !== null && !draft.entries.has(write.entry.parentId)) {
						throw new SessionError("invalid_entry", `Parent entry ${write.entry.parentId} does not exist`);
					}
					const entry = structuredClone({
						...write.entry,
						seq,
						timestamp: this.preserveEntryTimestamps?.get(write.entry.id) ?? timestamp,
					}) as Entry;
					draft.entries.set(entry.id, entry);
					if (entry.type === "message") draft.stats.messageCount++;
					continue;
				}
				if (write.kind === "usage") {
					if (draft.entries.has(write.row.id) || draft.usage.has(write.row.id)) {
						throw new SessionError("already_exists", `Entry or usage id ${write.row.id} already exists`);
					}
					if (write.row.entryId !== undefined && !draft.entries.has(write.row.entryId)) {
						throw new SessionError("invalid_entry", `Usage entry ${write.row.entryId} does not exist`);
					}
					const row = structuredClone({ ...write.row, seq }) as UsageRow;
					draft.usage.set(row.id, row);
					addUsage(draft.stats.usage, row.usage);
					continue;
				}

				const key = registerKey(write.namespace, write.key);
				if (write.op === "delete") {
					draft.registers.delete(key);
				} else {
					const register = structuredClone({
						namespace: write.namespace,
						key: write.key,
						value: write.value,
						seq,
					}) as Register;
					draft.registers.set(key, register);
				}
			}

			this.store.state = draft;
			return { firstSeq: seqs[0]!, seqs, timestamp };
		});
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.serialize(() => {
			const result = new Map<string, Entry>();
			for (const id of ids) {
				const entry = this.store.state.entries.get(id);
				if (entry !== undefined) {
					this.codec.validateStoredEntry?.(entry);
					result.set(id, structuredClone(entry));
				}
			}
			return result;
		});
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined> {
		return this.serialize(() => {
			const register = this.store.state.registers.get(registerKey(namespace, key));
			if (register !== undefined) this.codec.validateStoredRegister?.(register);
			return register === undefined ? undefined : (structuredClone(register) as Register<N>);
		});
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix = ""): Promise<Register<N>[]> {
		return this.serialize(() =>
			[...this.store.state.registers.values()]
				.filter((register) => register.namespace === namespace && register.key.startsWith(keyPrefix))
				.sort((left, right) => left.seq - right.seq)
				.map((register) => {
					this.codec.validateStoredRegister?.(register);
					return structuredClone(register) as Register<N>;
				}),
		);
	}

	scanBranch(query: BranchScan & { start: string }): Promise<Entry[]> {
		return this.serialize(() => this.scanBranchNow(query).map((entry) => structuredClone(entry)));
	}

	scanBranchStructure(query: BranchScan & { start: string }): Promise<EntryStructure[]> {
		return this.serialize(() =>
			this.scanBranchNow(query).map(({ id, parentId, seq, timestamp, type, customType }) => ({
				id,
				parentId,
				seq,
				timestamp,
				type,
				...(customType === undefined ? {} : { customType }),
			})),
		);
	}

	private scanBranchNow(query: BranchScan & { start: string }): Entry[] {
		validateLimit(query.limit);
		validateSequenceBound(query.cursor?.seq, "Query cursor");
		if (query.type !== undefined && query.customType !== undefined && query.type !== "custom") {
			throw new SessionError("invalid_query", "customType requires type custom or no type filter");
		}
		const path: Entry[] = [];
		let current = this.store.state.entries.get(query.start);
		if (current === undefined) throw new SessionError("not_found", `Entry ${query.start} does not exist`);
		const visited = new Set<string>();
		while (current !== undefined) {
			if (visited.has(current.id)) throw new SessionError("corruption", `Entry cycle detected at ${current.id}`);
			visited.add(current.id);
			path.push(current);
			if (current.id === query.stopAtId || current.type === query.stopAtType) break;
			current = current.parentId === null ? undefined : this.store.state.entries.get(current.parentId);
			if (current === undefined && path.at(-1)?.parentId !== null) {
				throw new SessionError("corruption", `Entry parent ${path.at(-1)?.parentId} is missing`);
			}
		}
		let filtered = path.filter((entry) => entryMatches(entry, query));
		if (query.cursor !== undefined) {
			filtered = filtered.filter((entry) =>
				(query.order ?? "newestFirst") === "oldestFirst"
					? entry.seq > query.cursor!.seq
					: entry.seq < query.cursor!.seq,
			);
		}
		if ((query.order ?? "newestFirst") === "oldestFirst") filtered.reverse();
		return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		return this.serialize(() => {
			validateLimit(query.limit);
			validateSequenceBound(query.fromSeq, "fromSeq");
			validateSequenceBound(query.toSeq, "toSeq");
			if (query.type !== undefined && query.customType !== undefined && query.type !== "custom") {
				throw new SessionError("invalid_query", "customType requires type custom or no type filter");
			}
			let entries = [...this.store.state.entries.values()].filter(
				(entry) =>
					entryMatches(entry, query) &&
					(query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
					(query.toSeq === undefined || entry.seq <= query.toSeq),
			);
			entries.sort((left, right) =>
				(query.order ?? "asc") === "asc" ? left.seq - right.seq : right.seq - left.seq,
			);
			if (query.limit !== undefined) entries = entries.slice(0, query.limit);
			return entries.map((entry) => structuredClone(entry));
		});
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.serialize(() => {
			validateLimit(query.limit);
			validateSequenceBound(query.fromSeq, "fromSeq");
			validateSequenceBound(query.toSeq, "toSeq");
			const entryIds = query.entryIds === undefined ? undefined : new Set(query.entryIds);
			let rows = [...this.store.state.usage.values()].filter(
				(row) =>
					(query.fromSeq === undefined || row.seq >= query.fromSeq) &&
					(query.toSeq === undefined || row.seq <= query.toSeq) &&
					(entryIds === undefined || (row.entryId !== undefined && entryIds.has(row.entryId))),
			);
			rows.sort((left, right) => ((query.order ?? "asc") === "asc" ? left.seq - right.seq : right.seq - left.seq));
			if (query.limit !== undefined) rows = rows.slice(0, query.limit);
			return rows.map((row) => structuredClone(row));
		});
	}

	getStats(): Promise<SessionStats> {
		return this.serialize(() => structuredClone(this.store.state.stats));
	}

	/** Enqueues one coherent source boundary for repository fork operations. */
	snapshot(): Promise<InMemorySessionSnapshot> {
		return this.serialize(() => {
			const state = this.store.state;
			for (const entry of state.entries.values()) this.codec.validateStoredEntry?.(entry);
			for (const register of state.registers.values()) this.codec.validateStoredRegister?.(register);
			return structuredClone({
				entries: [...state.entries.values()].sort((left, right) => left.seq - right.seq),
				registers: [...state.registers.values()].sort((left, right) => left.seq - right.seq),
				usage: [...state.usage.values()].sort((left, right) => left.seq - right.seq),
				stats: state.stats,
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return this.queue;
		this.closed = true;
		await this.queue;
		if (this.store.activeStorage === this) this.store.activeStorage = undefined;
	}
}
