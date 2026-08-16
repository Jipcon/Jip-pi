import { basename, join } from "node:path";
import { HARNESS_V4_STORAGE_VERSION } from "../base.ts";
import { SessionCodec } from "../codec.ts";
import { UuidV7Generator } from "../id.ts";
import { buildForkWrites, INITIAL_MAIN_LANE_WRITES, StorageSession } from "../session.ts";
import {
	type ForkOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type Transaction,
} from "../storage.ts";
import { encodeHeader, encodeTransactionRecord, parseHeader } from "./codec.ts";
import { NodeJsonlFileSystem } from "./fs.ts";
import { JsonlStorage, publishFileAtomically, wrapFsError } from "./storage.ts";
import {
	JSONL_FORMAT,
	JSONL_VERSION,
	type JsonlFileSystem,
	type JsonlHeaderV1,
	type JsonlSessionCreateOptions,
	type JsonlSessionListOptions,
	type JsonlStoredWriteV1,
	type JsonlTransactionRecordV1,
} from "./types.ts";

/** Head bytes read per file while listing; headers are tiny, larger heads fall back to a full read. */
const MAX_LIST_HEAD_BYTES = 64 * 1024;

/** Session ids are arbitrary strings; path components are percent-encoded to keep the path safe. */
export function encodeSessionFileName(id: string): string {
	let encoded = "";
	for (const byte of new TextEncoder().encode(id)) {
		const char = String.fromCharCode(byte);
		encoded += /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).padStart(2, "0")}`;
	}
	return `${encoded}.jsonl`;
}

function assertClock(timestamp: number): void {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
		throw new SessionError("storage", "Storage clock returned an invalid timestamp");
	}
}

function toStoredWrites(
	writes: Transaction["writes"],
	timestamp: number,
	preserveEntryTimestamps?: ReadonlyMap<string, number>,
): JsonlStoredWriteV1[] {
	return writes.map((write) =>
		write.kind === "entry"
			? {
					kind: "entry",
					entry: structuredClone(write.entry),
					timestamp: preserveEntryTimestamps?.get(write.entry.id) ?? timestamp,
				}
			: structuredClone(write),
	);
}

function metadataFromHeader(header: JsonlHeaderV1): SessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		storageVersion: header.storageVersion,
		...(header.cwd === undefined ? {} : { cwd: header.cwd }),
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
	};
}

export interface JsonlSessionRepoOptions {
	directory: string;
	fs?: JsonlFileSystem;
	codec?: SessionCodec;
	now?: () => number;
}

/**
 * JSONL session repository. Sessions are complete sibling-temp-file
 * publications with an atomic rename; commits are single appends under one
 * per-session writer. Paths never concatenate unencoded cwd/session ids.
 */
export class JsonlSessionRepo
	implements SessionRepo<SessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	readonly directory: string;
	private readonly fs: JsonlFileSystem;
	private readonly codec: SessionCodec;
	private readonly now: () => number;
	private readonly sessionIds: UuidV7Generator;
	private readonly writers = new Map<string, JsonlStorage>();
	private readonly publications = new Map<string, Promise<void>>();

	constructor(options: JsonlSessionRepoOptions) {
		this.directory = options.directory;
		this.fs = options.fs ?? new NodeJsonlFileSystem();
		this.codec = options.codec ?? new SessionCodec();
		this.now = options.now ?? Date.now;
		this.sessionIds = new UuidV7Generator(this.now);
		this.fs.ensureDirectory(this.directory);
	}

	/** Serializes publications to one session id; they share the deterministic `.tmp` path. */
	private publishLine<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.publications.get(id) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		this.publications.set(
			id,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	private pathFor(id: string): string {
		return join(this.directory, encodeSessionFileName(id));
	}

	create(options: JsonlSessionCreateOptions = {}): Promise<StorageSession> {
		const id = options.id ?? this.sessionIds.next();
		return this.publishLine(id, () => this.createNow(id, options));
	}

	private async createNow(id: string, options: JsonlSessionCreateOptions): Promise<StorageSession> {
		if (this.writers.has(id)) throw new SessionError("already_exists", `Session ${id} already exists`);
		const path = this.pathFor(id);
		if (await this.fs.exists(path)) throw new SessionError("already_exists", `Session ${id} already exists`);
		const createdAt = this.now();
		assertClock(createdAt);
		const header: JsonlHeaderV1 = {
			kind: "header",
			format: JSONL_FORMAT,
			version: JSONL_VERSION,
			storageVersion: HARNESS_V4_STORAGE_VERSION,
			id,
			createdAt,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		};
		const initialWrites = INITIAL_MAIN_LANE_WRITES.map((write) => structuredClone(write));
		const initialRecord: JsonlTransactionRecordV1 = {
			kind: "transaction",
			version: 1,
			firstSeq: 1,
			timestamp: createdAt,
			writes: toStoredWrites(initialWrites, createdAt),
		};
		const content = encodeHeader(header) + encodeTransactionRecord(initialRecord);
		try {
			await publishFileAtomically(this.fs, path, (tempPath) => this.fs.writeFile(tempPath, content));
		} catch (error) {
			throw wrapFsError(error, `Failed to publish session ${path}`);
		}
		return this.openNow(metadataFromHeader(header));
	}

	async open(metadata: SessionMetadata): Promise<StorageSession> {
		if (metadata.storageVersion !== HARNESS_V4_STORAGE_VERSION) {
			throw new SessionError(
				"storage_version",
				`Unsupported storage version ${metadata.storageVersion}; expected ${HARNESS_V4_STORAGE_VERSION}`,
			);
		}
		return this.openNow(metadata);
	}

	private async openNow(metadata: SessionMetadata): Promise<StorageSession> {
		const storage = await this.openStorage(metadata);
		return new StorageSession(storage.metadata, storage, this.now);
	}

	private async openStorage(metadata: SessionMetadata): Promise<JsonlStorage> {
		if (this.writers.has(metadata.id)) {
			throw new SessionError("storage", `Session ${metadata.id} already has an active writer`);
		}
		const path = this.pathFor(metadata.id);
		const storage = await JsonlStorage.load(this.fs, path, {
			codec: this.codec,
			now: this.now,
			onClose: () => {
				if (this.writers.get(metadata.id) === storage) this.writers.delete(metadata.id);
			},
		});
		if (storage.metadata.id !== metadata.id) {
			await storage.close();
			throw new SessionError(
				"corruption",
				`Session file ${path} holds session ${storage.metadata.id}; expected ${metadata.id}`,
			);
		}
		this.writers.set(metadata.id, storage);
		return storage;
	}

	async list(options: JsonlSessionListOptions = {}): Promise<SessionMetadata[]> {
		let files: string[];
		try {
			files = await this.fs.listFiles(this.directory);
		} catch (error) {
			throw wrapFsError(error, `Failed to list sessions in ${this.directory}`);
		}
		const results: SessionMetadata[] = [];
		for (const file of files) {
			if (!basename(file).endsWith(".jsonl")) continue;
			let head: string;
			try {
				head = await this.fs.readHead(file, MAX_LIST_HEAD_BYTES);
				if (!head.includes("\n")) head = await this.fs.readTextFile(file);
			} catch (error) {
				throw wrapFsError(error, `Failed to read session ${file}`);
			}
			const newlineIndex = head.indexOf("\n");
			const firstLine = newlineIndex === -1 ? head : head.slice(0, newlineIndex);
			const header = parseHeader(firstLine, file);
			results.push(metadataFromHeader(header));
		}
		return results
			.filter((candidate) => options.cwd === undefined || candidate.cwd === options.cwd)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map((candidate) => structuredClone(candidate));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		if (this.writers.has(metadata.id)) {
			throw new SessionError("storage", `Session ${metadata.id} still has an active writer`);
		}
		const path = this.pathFor(metadata.id);
		try {
			await this.fs.remove(path);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return;
			throw wrapFsError(error, `Failed to delete session ${path}`);
		}
	}

	async fork(source: SessionMetadata, options: ForkOptions & JsonlSessionCreateOptions): Promise<StorageSession> {
		const sourceAlreadyOpen = this.writers.has(source.id);
		const sourceStorage = this.writers.get(source.id) ?? (await this.openStorage(source));
		const id = options.id ?? this.sessionIds.next();
		try {
			const snapshot = await sourceStorage.snapshot();
			const { writes, entryTimestamps } = buildForkWrites(snapshot, options);
			const createdAt = this.now();
			assertClock(createdAt);
			const header: JsonlHeaderV1 = {
				kind: "header",
				format: JSONL_FORMAT,
				version: JSONL_VERSION,
				storageVersion: HARNESS_V4_STORAGE_VERSION,
				id,
				createdAt,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				parentSessionId: source.id,
			};
			const initialWrites = INITIAL_MAIN_LANE_WRITES.map((write) => structuredClone(write));
			const initialRecord: JsonlTransactionRecordV1 = {
				kind: "transaction",
				version: 1,
				firstSeq: 1,
				timestamp: createdAt,
				writes: toStoredWrites(initialWrites, createdAt),
			};
			const forkRecord: JsonlTransactionRecordV1 = {
				kind: "transaction",
				version: 1,
				firstSeq: 1 + initialWrites.length,
				timestamp: createdAt,
				writes: toStoredWrites(writes, createdAt, entryTimestamps),
			};
			const records: JsonlTransactionRecordV1[] = [initialRecord, ...(writes.length === 0 ? [] : [forkRecord])];
			return await this.publishLine(id, async () => {
				if (this.writers.has(id)) throw new SessionError("already_exists", `Session ${id} already exists`);
				const path = this.pathFor(id);
				if (await this.fs.exists(path)) {
					throw new SessionError("already_exists", `Session ${id} already exists`);
				}
				const content = encodeHeader(header) + records.map((record) => encodeTransactionRecord(record)).join("");
				try {
					await publishFileAtomically(this.fs, path, (tempPath) => this.fs.writeFile(tempPath, content));
				} catch (error) {
					throw wrapFsError(error, `Failed to publish session ${path}`);
				}
				return this.openNow(metadataFromHeader(header));
			});
		} finally {
			if (!sourceAlreadyOpen) await sourceStorage.close();
		}
	}
}
