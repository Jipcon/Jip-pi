import type { ProvisionedEntry } from "../base.ts";
import type { Write } from "../storage.ts";

export const JSONL_FORMAT = "pi-harness-v4-jsonl" as const;
export const JSONL_VERSION = 1 as const;

export interface JsonlHeaderV1 {
	kind: "header";
	format: typeof JSONL_FORMAT;
	version: typeof JSONL_VERSION;
	storageVersion: number;
	id: string;
	createdAt: number;
	cwd?: string;
	parentSessionId?: string;
}

/** Entry write whose storage-assigned timestamp is the durable authority for fork copies. */
export interface JsonlStoredEntryWriteV1 {
	kind: "entry";
	entry: ProvisionedEntry;
	timestamp: number;
}

/**
 * Usage and register writes carry no storage-assigned seq: the durable seq is
 * fixed by the transaction position (`firstSeq + index`).
 */
export type JsonlStoredWriteV1 = Exclude<Write, { kind: "entry" }> | JsonlStoredEntryWriteV1;

export interface JsonlTransactionRecordV1 {
	kind: "transaction";
	version: 1;
	firstSeq: number;
	timestamp: number;
	writes: JsonlStoredWriteV1[];
}

/**
 * File operations used by the JSONL backend. Callers may decorate this
 * boundary (tests split appends to manufacture torn tails); the crash hook
 * itself is never part of the production API.
 */
export interface JsonlFileSystem {
	ensureDirectory(path: string): void;
	listFiles(directory: string): Promise<string[]>;
	readTextFile(path: string): Promise<string>;
	readHead(path: string, maxBytes: number): Promise<string>;
	writeFile(path: string, data: string): Promise<void>;
	appendFile(path: string, data: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export interface JsonlSessionCreateOptions {
	id?: string;
	parentSessionId?: string;
	cwd?: string;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}
