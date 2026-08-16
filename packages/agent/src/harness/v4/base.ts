import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";

export const HARNESS_V4_STORAGE_VERSION = 1 as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SettledAssistantMessage = AssistantMessage & {
	stopReason: Exclude<StopReason, "pending">;
};

export type EntryType = "message" | "compaction" | "branch_summary" | "custom";

export interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	terminate?: true;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, "seq" | "timestamp">
	: never;

export type EntryStructure = Pick<Entry, "id" | "parentId" | "seq" | "timestamp" | "type" | "customType">;

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export type PendingEntry =
	| { type: "message"; payload: AgentMessage }
	| { type: "custom"; customType: string; payload?: JsonValue };

export interface DurableFileOperations {
	read: string[];
	written: string[];
	edited: string[];
}

export type DurableStructuralPreparation =
	| {
			kind: "compaction";
			messagesToSummarize: AgentMessage[];
			turnPrefixMessages: AgentMessage[];
			retainedTail: AgentMessage[];
			isSplitTurn: boolean;
			tokensBefore: number;
			previousSummary?: string;
			fileOps: DurableFileOperations;
			settings: CompactionSettings;
	  }
	| {
			kind: "branch_summary";
			messages: AgentMessage[];
			fileOps: DurableFileOperations;
			totalTokens: number;
	  };

export interface IdGenerator {
	next(timestampMs?: number): string;
}
