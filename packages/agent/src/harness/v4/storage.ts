import type { Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentMessage } from "../../types.ts";
import type {
	CustomEntry,
	DurableStructuralPreparation,
	Entry,
	EntryStructure,
	EntryType,
	IdGenerator,
	JsonValue,
	LaneConfiguration,
	MessageEntry,
	PendingEntry,
	ProvisionedEntry,
	UsageRow,
} from "./base.ts";
import type { LaneLastResult, LaneState, Operation, OperationState } from "./operation.ts";

export interface RegisterValues {
	"lane.leaf": string | null;
	"lane.config": LaneConfiguration;
	"lane.state": LaneState;
	"lane.lastResult": LaneLastResult;
	"op.meta": Operation;
	"op.state": OperationState;
	"op.tool_args": Record<string, JsonValue>;
	"op.preparation": DurableStructuralPreparation;
	"pending.entry": PendingEntry;
	"fact.name": string;
	"fact.label": string;
	"fact.custom": JsonValue;
}

export type RegisterNamespace = keyof RegisterValues;

export interface Register<N extends RegisterNamespace = RegisterNamespace> {
	namespace: N;
	key: string;
	value: RegisterValues[N];
	seq: number;
}

export type RegisterSetWrite = {
	[N in RegisterNamespace]: {
		kind: "register";
		op: "set";
		namespace: N;
		key: string;
		value: RegisterValues[N];
	};
}[RegisterNamespace];

export type Write =
	| { kind: "entry"; entry: ProvisionedEntry }
	| { kind: "usage"; row: Omit<UsageRow, "seq"> }
	| RegisterSetWrite
	| { kind: "register"; op: "delete"; namespace: RegisterNamespace; key: string };

export interface Transaction {
	writes: Write[];
}

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
}

export interface EntryCursor {
	seq: number;
}

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface BranchScan {
	start?: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export interface UsageScan {
	fromSeq?: number;
	toSeq?: number;
	/** Exact entry associations used by post-turn durability queries. */
	entryIds?: string[];
	order?: "asc" | "desc";
	limit?: number;
}

export interface SessionStats {
	messageCount: number;
	usage: Usage;
}

/** One coherent durable boundary used by repository fork operations. */
export interface SessionSnapshot {
	entries: Entry[];
	registers: Register[];
	usage: UsageRow[];
	stats: SessionStats;
}

export interface Storage {
	commit(tx: Transaction): Promise<CommitResult>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined>;
	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]>;
	scanBranch(query: BranchScan & { start: string }): Promise<Entry[]>;
	scanBranchStructure(query: BranchScan & { start: string }): Promise<EntryStructure[]>;
	scanEntries(query: EntryScan): Promise<Entry[]>;
	scanUsage(query: UsageScan): Promise<UsageRow[]>;
	getStats(): Promise<SessionStats>;
	/** Enqueues one coherent source boundary for repository fork operations. */
	snapshot(): Promise<SessionSnapshot>;
	close(): Promise<void>;
}

export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: "asc" | "desc";
	limit?: number;
	cursor?: EntryCursor;
}

/** Stable query input used by Adaptive adapters to validate a durable post-turn boundary. */
export interface TurnCommitQuery {
	assistantEntryId: string;
	leafId: string;
}

export interface TurnCommit {
	assistantEntry: MessageEntry;
	toolResultEntries: MessageEntry[];
	usageRows: UsageRow[];
}

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<Entry | undefined>;
	getStats(): Promise<SessionStats>;
	getName(): Promise<string | undefined>;
	setName(name: string | undefined): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;
	getCustomFact(key: string): Promise<JsonValue | undefined>;
	setCustomFact(key: string, value: JsonValue | undefined): Promise<void>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;
	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]>;
	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined>;
	/**
	 * Resolves the assistant entry, complete source-ordered tool-result suffix,
	 * and associated usage rows for one committed turn. Undefined means the
	 * supplied ids do not describe a complete post-turn boundary.
	 */
	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined>;
	appendMessage(message: AgentMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: JsonValue): Promise<string>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	storeGeneration?: number;
	cwd?: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface SessionCodecOptions {
	customMessageSchemas?: Record<string, TSchema>;
}

export interface SessionCodecLike {
	validateTransaction(transaction: Transaction): void;
	validateStoredEntry?(entry: Entry): void;
	validateStoredRegister?<N extends RegisterNamespace>(register: Register<N>): void;
}

export interface Session<M extends SessionMetadata = SessionMetadata> extends SessionTree {
	readonly metadata: M;
	readonly idGenerator: IdGenerator;
	view(lane: string): SessionTree;
	commit(tx: Transaction): Promise<CommitResult>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined>;
	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]>;
	scanUsage(query: UsageScan): Promise<UsageRow[]>;
	close(): Promise<void>;
}

export type ForkOptions =
	| { scope?: "branch"; entryId?: string; position?: "before" | "at"; lane?: string }
	| { scope: "tree" };

export interface SessionRepo<
	M extends SessionMetadata = SessionMetadata,
	C extends { id?: string; parentSessionId?: string } = { id?: string; parentSessionId?: string },
	L = void,
> {
	create(options: C): Promise<Session<M>>;
	open(metadata: M): Promise<Session<M>>;
	list(options?: L): Promise<M[]>;
	delete(metadata: M): Promise<void>;
	fork(source: M, options: ForkOptions & C): Promise<Session<M>>;
}

export interface SearchQuery {
	text: string;
	limit?: number;
}

export interface SessionSearchHit {
	sessionId: string;
	score?: number;
	top?: { entryId: string; snippet?: string; timestamp: number };
}

export interface EntrySearchHit {
	sessionId: string;
	entryId: string;
	timestamp: number;
	snippet?: string;
	score?: number;
}

export interface SessionSearchService {
	searchSessions(query: SearchQuery): Promise<SessionSearchHit[]>;
	searchEntries?(query: SearchQuery): Promise<EntrySearchHit[]>;
	sync(): Promise<void>;
	notify(sessionId: string): void;
	remove(sessionId: string): Promise<void>;
	close(): Promise<void>;
}

export type SessionErrorCode =
	| "not_found"
	| "already_exists"
	| "invalid_entry"
	| "invalid_payload"
	| "invalid_lane"
	| "invalid_query"
	| "invalid_fork_target"
	| "storage_version"
	| "closed"
	| "corruption"
	| "storage";

export class SessionError extends Error {
	readonly code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export interface CustomEntryType<TData extends JsonValue = JsonValue> {
	customType: string;
	data: TData;
}

export type TypedCustomEntry<T extends CustomEntryType> = CustomEntry & {
	customType: T["customType"];
	data: T["data"];
};
