import type { AgentMessage } from "../../../types.ts";
import type { Entry, JsonValue, UsageRow } from "../base.ts";
import type {
	BranchScan,
	CommitResult,
	EntryQuery,
	Register,
	RegisterNamespace,
	Session,
	SessionStats,
	SessionTree,
	Transaction,
	TurnCommit,
	TurnCommitQuery,
	UsageScan,
} from "../storage.ts";

export interface InstrumentedSessionRegisterRead {
	namespace: RegisterNamespace;
	key: string;
}

/** Session decorator used to assert restore query shape without exposing backend internals. */
export class InstrumentedSession implements Session {
	readonly metadata: Session["metadata"];
	readonly idGenerator: Session["idGenerator"];
	private readonly inner: Session;
	private readonly committed: Transaction[] = [];
	private readonly registerReadLog: InstrumentedSessionRegisterRead[] = [];
	private readonly entryReadLog: string[][] = [];
	private listedRegisters = 0;
	private branchScanCount = 0;
	private historyScanCount = 0;

	constructor(inner: Session) {
		this.inner = inner;
		this.metadata = structuredClone(inner.metadata);
		this.idGenerator = inner.idGenerator;
	}

	commits(): Transaction[] {
		return structuredClone(this.committed);
	}

	registerReads(): InstrumentedSessionRegisterRead[] {
		return structuredClone(this.registerReadLog);
	}

	entryReads(): string[][] {
		return structuredClone(this.entryReadLog);
	}

	registerLists(): number {
		return this.listedRegisters;
	}

	branchScans(): number {
		return this.branchScanCount;
	}

	historyScans(): number {
		return this.historyScanCount;
	}

	view(lane: string): SessionTree {
		return this.inner.view(lane);
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		const result = await this.inner.commit(transaction);
		this.committed.push(structuredClone(transaction));
		return result;
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		this.entryReadLog.push([...ids]);
		return this.inner.getEntries(ids);
	}

	getRegister<N extends RegisterNamespace>(namespace: N, key: string): Promise<Register<N> | undefined> {
		this.registerReadLog.push({ namespace, key });
		return this.inner.getRegister(namespace, key);
	}

	listRegisters<N extends RegisterNamespace>(namespace: N, keyPrefix?: string): Promise<Register<N>[]> {
		this.listedRegisters++;
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
		return this.getEntries([id]).then((entries) => entries.get(id));
	}

	getStats(): Promise<SessionStats> {
		return this.inner.getStats();
	}

	getName(): Promise<string | undefined> {
		return this.inner.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.inner.setName(name);
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.inner.getLabel(targetId);
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.inner.setLabel(targetId, label);
	}

	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.inner.getCustomFact(key);
	}

	setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		return this.inner.setCustomFact(key, value);
	}

	findEntries(query?: EntryQuery): Promise<Entry[]> {
		this.historyScanCount++;
		return this.inner.findEntries(query);
	}

	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		this.historyScanCount++;
		return this.inner.findEntry(query);
	}

	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		this.branchScanCount++;
		return this.inner.findEntriesOnBranch(query);
	}

	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		this.branchScanCount++;
		return this.inner.findEntryOnBranch(query);
	}

	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		return this.inner.getTurnCommit(query);
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.inner.appendMessage(message);
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.inner.appendCustomEntry(customType, data);
	}
}
