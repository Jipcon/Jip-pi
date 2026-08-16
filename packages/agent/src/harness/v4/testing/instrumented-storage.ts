import type { Entry, EntryStructure, UsageRow } from "../base.ts";
import type {
	BranchScan,
	CommitResult,
	EntryScan,
	Register,
	RegisterNamespace,
	SessionSnapshot,
	SessionStats,
	Storage,
	Transaction,
	UsageScan,
} from "../storage.ts";

export interface InstrumentedCommit {
	transaction: Transaction;
	result: CommitResult;
}

/** Read-through test decorator that records successful transactions without gaining write authority. */
export class InstrumentedStorage implements Storage {
	private readonly committed: InstrumentedCommit[] = [];
	private readonly inner: Storage;

	constructor(inner: Storage) {
		this.inner = inner;
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		const snapshot = structuredClone(transaction);
		const result = await this.inner.commit(transaction);
		this.committed.push({ transaction: snapshot, result: structuredClone(result) });
		return result;
	}

	commits(): InstrumentedCommit[] {
		return structuredClone(this.committed);
	}

	clear(): void {
		this.committed.length = 0;
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

	scanBranch(query: BranchScan & { start: string }): Promise<Entry[]> {
		return this.inner.scanBranch(query);
	}

	scanBranchStructure(query: BranchScan & { start: string }): Promise<EntryStructure[]> {
		return this.inner.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		return this.inner.scanEntries(query);
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.inner.scanUsage(query);
	}

	getStats(): Promise<SessionStats> {
		return this.inner.getStats();
	}

	snapshot(): Promise<SessionSnapshot> {
		return this.inner.snapshot();
	}

	close(): Promise<void> {
		return this.inner.close();
	}
}
