import type { AgentMessage } from "../../types.ts";
import type { Entry, JsonValue } from "./base.ts";
import type { BranchScan, EntryQuery, SessionStats, SessionTree, TurnCommit, TurnCommitQuery } from "./storage.ts";

/**
 * Host side of Harness-aware lane writes: both append operations route
 * through the Harness mutation line instead of writing the tree directly.
 */
export interface LaneSessionTreeHost {
	laneAppendMessage(lane: string, message: AgentMessage): Promise<string>;
	laneAppendCustomEntry(lane: string, customType: string, data?: JsonValue): Promise<string>;
}

/**
 * Lane-bound SessionTree wrapper. Read/query/fact APIs delegate to the
 * underlying session view; the two append APIs are Harness-aware: idle lanes
 * place immediately, open/suspended Runs defer through pending.entry +
 * inbox.writes, and structural operations release the lane line and retry
 * after the operation ends.
 */
export class LaneSessionTree implements SessionTree {
	readonly lane: string;
	private readonly delegate: SessionTree;
	private readonly host: LaneSessionTreeHost;

	constructor(lane: string, delegate: SessionTree, host: LaneSessionTreeHost) {
		this.lane = lane;
		this.delegate = delegate;
		this.host = host;
	}

	getLeafId(): Promise<string | null> {
		return this.delegate.getLeafId();
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.delegate.getEntry(id);
	}

	getStats(): Promise<SessionStats> {
		return this.delegate.getStats();
	}

	getName(): Promise<string | undefined> {
		return this.delegate.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.delegate.setName(name);
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.delegate.getLabel(targetId);
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.delegate.setLabel(targetId, label);
	}

	getCustomFact(key: string): Promise<JsonValue | undefined> {
		return this.delegate.getCustomFact(key);
	}

	setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		return this.delegate.setCustomFact(key, value);
	}

	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.delegate.findEntries(query);
	}

	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.delegate.findEntry(query);
	}

	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		return this.delegate.findEntriesOnBranch(query);
	}

	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		return this.delegate.findEntryOnBranch(query);
	}

	getTurnCommit(query: TurnCommitQuery): Promise<TurnCommit | undefined> {
		return this.delegate.getTurnCommit(query);
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.host.laneAppendMessage(this.lane, message);
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.host.laneAppendCustomEntry(this.lane, customType, data);
	}
}
