import type { Usage } from "@earendil-works/pi-ai";
import type { Entry, EntryStructure, UsageRow } from "../base.ts";
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
} from "../storage.ts";
import { encodeTransactionRecord, parseHeader, parseTransactionRecord } from "./codec.ts";
import { invalidFile, JsonlParseError } from "./errors.ts";
import type { JsonlFileSystem, JsonlHeaderV1, JsonlStoredWriteV1, JsonlTransactionRecordV1 } from "./types.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface JsonlDurableState {
	seq: number;
	entries: Map<string, Entry>;
	registers: Map<string, Register>;
	usage: Map<string, UsageRow>;
	stats: SessionStats;
}

export interface JsonlStorageOptions {
	codec: SessionCodecLike;
	now?: () => number;
	onClose?: () => void;
}

export function emptyJsonlState(): JsonlDurableState {
	return {
		seq: 0,
		entries: new Map(),
		registers: new Map(),
		usage: new Map(),
		stats: { messageCount: 0, usage: structuredClone(ZERO_USAGE) },
	};
}

export function wrapFsError(error: unknown, message: string): SessionError {
	if (error instanceof SessionError) return error;
	const code = (error as { code?: string }).code;
	return new SessionError(
		code === "ENOENT" ? "not_found" : "storage",
		`${message}: ${error instanceof Error ? error.message : String(error)}`,
		error instanceof Error ? error : undefined,
	);
}

/**
 * Build a complete sibling temporary file, then atomically rename it over the
 * destination. The populate callback must create or overwrite `tempPath` with
 * the complete file. The destination is untouched until the rename commits,
 * and temporary-file removal is best-effort on failure. Callers must
 * serialize publications to the same destination because they share its
 * deterministic `.tmp` path.
 */
export async function publishFileAtomically(
	fs: JsonlFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		await fs.rename(tempPath, destinationPath);
	} catch (error) {
		try {
			await fs.remove(tempPath);
		} catch {
			// Best-effort cleanup; the original error wins.
		}
		throw error;
	}
}

function registerKey(namespace: RegisterNamespace, key: string): string {
	return `${namespace}\u0000${key}`;
}

function cloneState(state: JsonlDurableState): JsonlDurableState {
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

/**
 * Applies one record's writes positionally: `writes[i]` receives the durable
 * seq `firstSeq + i`, and entry writes keep their stored timestamp. Throws
 * the same draft-validation errors as the in-memory backend.
 */
function applyStoredWrites(state: JsonlDurableState, firstSeq: number, writes: readonly JsonlStoredWriteV1[]): void {
	for (let index = 0; index < writes.length; index++) {
		const write = writes[index]!;
		const seq = firstSeq + index;
		if (write.kind === "entry") {
			if (state.entries.has(write.entry.id) || state.usage.has(write.entry.id)) {
				throw new SessionError("already_exists", `Entry or usage id ${write.entry.id} already exists`);
			}
			if (write.entry.parentId !== null && !state.entries.has(write.entry.parentId)) {
				throw new SessionError("invalid_entry", `Parent entry ${write.entry.parentId} does not exist`);
			}
			const entry = structuredClone({ ...write.entry, seq, timestamp: write.timestamp }) as Entry;
			state.entries.set(entry.id, entry);
			if (entry.type === "message") state.stats.messageCount++;
			continue;
		}
		if (write.kind === "usage") {
			if (state.entries.has(write.row.id) || state.usage.has(write.row.id)) {
				throw new SessionError("already_exists", `Entry or usage id ${write.row.id} already exists`);
			}
			if (write.row.entryId !== undefined && !state.entries.has(write.row.entryId)) {
				throw new SessionError("invalid_entry", `Usage entry ${write.row.entryId} does not exist`);
			}
			const row = structuredClone({ ...write.row, seq }) as UsageRow;
			state.usage.set(row.id, row);
			addUsage(state.stats.usage, row.usage);
			continue;
		}

		const key = registerKey(write.namespace, write.key);
		if (write.op === "delete") {
			state.registers.delete(key);
		} else {
			const register = structuredClone({
				namespace: write.namespace,
				key: write.key,
				value: write.value,
				seq,
			}) as Register;
			state.registers.set(key, register);
		}
	}
	state.seq = firstSeq + writes.length - 1;
}

function applyRecord(
	state: JsonlDurableState,
	record: JsonlTransactionRecordV1,
	path: string,
	lineNumber: number,
): void {
	try {
		applyStoredWrites(state, record.firstSeq, record.writes);
	} catch (error) {
		if (error instanceof SessionError && (error.code === "already_exists" || error.code === "invalid_entry")) {
			throw invalidFile(path, lineNumber, `has invalid transaction: ${error.message}`, error);
		}
		throw error;
	}
}

interface RebuiltSession {
	header: JsonlHeaderV1;
	state: JsonlDurableState;
}

/**
 * Rebuilds the durable state from a complete transaction prefix, repairing a
 * torn final line in place. Guarantees: a complete final record without its
 * LF is accepted and the LF is appended; an unparseable final line is dropped
 * and the legal prefix is published atomically; a complete but invalid final
 * line is corruption with the original bytes untouched; interior damage is
 * corruption; a missing or torn header fails without any tail repair.
 */
async function rebuild(
	fs: JsonlFileSystem,
	path: string,
	content: string,
	codec: SessionCodecLike,
): Promise<RebuiltSession> {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0 || !lines[0]) throw invalidFile(path, 1, "is missing a header");
	const header = parseHeader(lines[0], path);
	if (lines.length === 1 && !content.endsWith("\n")) {
		throw invalidFile(path, 1, "has a torn header without a trailing newline");
	}
	const state = emptyJsonlState();
	let expectedFirstSeq = 1;
	let repairedTornTail = false;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!;
		const isLast = index === lines.length - 1;
		try {
			const record = parseTransactionRecord(line, path, index + 1, expectedFirstSeq, codec);
			applyRecord(state, record, path, index + 1);
			expectedFirstSeq += record.writes.length;
		} catch (error) {
			if (!isLast || content.endsWith("\n")) {
				if (error instanceof JsonlParseError) throw invalidFile(path, index + 1, "is not valid JSON", error);
				throw error;
			}
			if (!(error instanceof JsonlParseError)) throw error;
			const validPrefix = `${lines.slice(0, index).join("\n")}\n`;
			await publishFileAtomically(fs, path, (tempPath) => fs.writeFile(tempPath, validPrefix));
			repairedTornTail = true;
			break;
		}
	}
	if (!content.endsWith("\n") && !repairedTornTail) {
		await fs.appendFile(path, "\n");
	}
	return { header, state };
}

/**
 * Durable JSONL storage: one file per session, one append per transaction.
 * The handle rebuilds from the complete transaction prefix on open and never
 * depends on a previous process's memory state. An append failure faults the
 * handle (a reopen is required) without exposing the un-durable draft.
 */
export class JsonlStorage implements Storage {
	readonly metadata: SessionMetadata;
	private readonly fs: JsonlFileSystem;
	private readonly path: string;
	private readonly codec: SessionCodecLike;
	private readonly now: () => number;
	private readonly onClose: (() => void) | undefined;
	private state: JsonlDurableState;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private faultError: SessionError | undefined;

	private constructor(
		fs: JsonlFileSystem,
		path: string,
		state: JsonlDurableState,
		metadata: SessionMetadata,
		options: JsonlStorageOptions,
	) {
		this.fs = fs;
		this.path = path;
		this.state = state;
		this.metadata = structuredClone(metadata);
		this.codec = options.codec;
		this.now = options.now ?? Date.now;
		this.onClose = options.onClose;
	}

	/** Loads (and repairs a torn tail in) one complete session file. */
	static async load(fs: JsonlFileSystem, path: string, options: JsonlStorageOptions): Promise<JsonlStorage> {
		let content: string;
		try {
			content = await fs.readTextFile(path);
		} catch (error) {
			throw wrapFsError(error, `Failed to read session ${path}`);
		}
		let rebuilt: RebuiltSession;
		try {
			rebuilt = await rebuild(fs, path, content, options.codec);
		} catch (error) {
			if (error instanceof SessionError) throw error;
			throw wrapFsError(error, `Failed to repair session ${path}`);
		}
		const header = rebuilt.header;
		const metadata: SessionMetadata = {
			id: header.id,
			createdAt: header.createdAt,
			storageVersion: header.storageVersion,
			...(header.cwd === undefined ? {} : { cwd: header.cwd }),
			...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		};
		return new JsonlStorage(fs, path, rebuilt.state, metadata, options);
	}

	private assertUsable(): void {
		if (this.closed) throw new SessionError("closed", `Storage for session ${this.metadata.id} is closed`);
		if (this.faultError !== undefined) throw this.faultError;
	}

	private fault(cause: unknown): void {
		if (this.faultError === undefined) {
			this.faultError = new SessionError(
				"storage",
				`Storage for session ${this.metadata.id} faulted on append and requires a reopen`,
				cause instanceof Error ? cause : undefined,
			);
		}
	}

	private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		this.codec.validateTransaction(transaction);
		return this.serialize(() => this.commitNow(transaction));
	}

	private async commitNow(transaction: Transaction): Promise<CommitResult> {
		if (transaction.writes.length === 0) {
			throw new SessionError("invalid_payload", "A transaction must contain at least one write");
		}
		const timestamp = this.now();
		if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
			throw new SessionError("storage", "Storage clock returned an invalid timestamp");
		}
		const storedWrites: JsonlStoredWriteV1[] = transaction.writes.map((write) =>
			write.kind === "entry"
				? { kind: "entry", entry: structuredClone(write.entry), timestamp }
				: structuredClone(write),
		);
		const firstSeq = this.state.seq + 1;
		const draft = cloneState(this.state);
		applyStoredWrites(draft, firstSeq, storedWrites);
		const record: JsonlTransactionRecordV1 = {
			kind: "transaction",
			version: 1,
			firstSeq,
			timestamp,
			writes: storedWrites,
		};
		const line = encodeTransactionRecord(record);
		try {
			await this.fs.appendFile(this.path, line);
		} catch (error) {
			this.fault(error);
			throw wrapFsError(error, `Failed to append session ${this.path}`);
		}
		this.state = draft;
		return { firstSeq, seqs: storedWrites.map((_, index) => firstSeq + index), timestamp };
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.serialize(() => {
			const result = new Map<string, Entry>();
			for (const id of ids) {
				const entry = this.state.entries.get(id);
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
			const register = this.state.registers.get(registerKey(namespace, key));
			if (register !== undefined) this.codec.validateStoredRegister?.(register);
			return register === undefined ? undefined : (structuredClone(register) as Register<N>);
		});
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix = ""): Promise<Register<N>[]> {
		return this.serialize(() =>
			[...this.state.registers.values()]
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
		let current = this.state.entries.get(query.start);
		if (current === undefined) throw new SessionError("not_found", `Entry ${query.start} does not exist`);
		const visited = new Set<string>();
		while (current !== undefined) {
			if (visited.has(current.id)) throw new SessionError("corruption", `Entry cycle detected at ${current.id}`);
			visited.add(current.id);
			path.push(current);
			if (current.id === query.stopAtId || current.type === query.stopAtType) break;
			current = current.parentId === null ? undefined : this.state.entries.get(current.parentId);
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
			let entries = [...this.state.entries.values()].filter(
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
			let rows = [...this.state.usage.values()].filter(
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
		return this.serialize(() => structuredClone(this.state.stats));
	}

	snapshot(): Promise<SessionSnapshot> {
		return this.serialize(() => {
			const state = this.state;
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
		this.onClose?.();
	}
}
