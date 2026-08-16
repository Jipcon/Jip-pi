import { HARNESS_V4_STORAGE_VERSION } from "../base.ts";
import { type SessionCodecLike, SessionError, type Write } from "../storage.ts";
import { invalidFile, JsonlParseError, unsupportedFile } from "./errors.ts";
import {
	JSONL_FORMAT,
	JSONL_VERSION,
	type JsonlHeaderV1,
	type JsonlStoredWriteV1,
	type JsonlTransactionRecordV1,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string, line: number, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw invalidFile(path, line, `has invalid ${field}`);
	}
	return value;
}

function requireSafeInteger(value: unknown, path: string, line: number, field: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw invalidFile(path, line, `has invalid ${field}`);
	}
	return value as number;
}

function optionalString(value: unknown, path: string, line: number, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalidFile(path, line, `has invalid ${field}`);
	return value;
}

export function encodeHeader(header: JsonlHeaderV1): string {
	return `${JSON.stringify(header)}\n`;
}

export function parseHeader(line: string, path: string): JsonlHeaderV1 {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidFile(path, 1, "is not a valid JSON header", error instanceof Error ? error : undefined);
	}
	if (!isRecord(value)) throw invalidFile(path, 1, "is not a JSON object header");
	if (value.kind !== "header") throw invalidFile(path, 1, "is not a header");
	if (value.format !== JSONL_FORMAT) {
		throw unsupportedFile(path, `unknown format ${String(value.format)}`);
	}
	if (value.version !== JSONL_VERSION) {
		throw unsupportedFile(path, `unsupported format version ${String(value.version)}`);
	}
	if (value.storageVersion !== HARNESS_V4_STORAGE_VERSION) {
		throw unsupportedFile(path, `unsupported storage version ${String(value.storageVersion)}`);
	}
	return {
		kind: "header",
		format: JSONL_FORMAT,
		version: JSONL_VERSION,
		storageVersion: HARNESS_V4_STORAGE_VERSION,
		id: requireString(value.id, path, 1, "id"),
		createdAt: requireSafeInteger(value.createdAt, path, 1, "createdAt"),
		...(value.cwd === undefined ? {} : { cwd: optionalString(value.cwd, path, 1, "cwd") }),
		...(value.parentSessionId === undefined
			? {}
			: { parentSessionId: optionalString(value.parentSessionId, path, 1, "parentSessionId") }),
	};
}

export function encodeTransactionRecord(record: JsonlTransactionRecordV1): string {
	return `${JSON.stringify(record)}\n`;
}

/**
 * Strictly parses one transaction record. `expectedFirstSeq` enforces seq
 * continuity across records. A JSON syntax failure surfaces as
 * `JsonlParseError`; every complete-but-invalid record surfaces as
 * corruption so the loader can distinguish torn tails from real damage.
 */
export function parseTransactionRecord(
	line: string,
	path: string,
	lineNumber: number,
	expectedFirstSeq: number,
	codec: SessionCodecLike,
): JsonlTransactionRecordV1 {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new JsonlParseError(path, lineNumber, error instanceof Error ? error : undefined);
	}
	if (!isRecord(value)) throw invalidFile(path, lineNumber, "is not a JSON object");
	if (value.kind !== "transaction") throw invalidFile(path, lineNumber, "has unknown record kind");
	if (value.version !== 1) throw invalidFile(path, lineNumber, "has unsupported record version");
	const firstSeq = requireSafeInteger(value.firstSeq, path, lineNumber, "firstSeq", 1);
	if (firstSeq !== expectedFirstSeq) {
		throw invalidFile(path, lineNumber, `has firstSeq ${firstSeq}; expected ${expectedFirstSeq}`);
	}
	const timestamp = requireSafeInteger(value.timestamp, path, lineNumber, "timestamp");
	if (!Array.isArray(value.writes) || value.writes.length === 0) {
		throw invalidFile(path, lineNumber, "has no writes");
	}
	for (let index = 0; index < value.writes.length; index++) {
		const write = value.writes[index];
		if (!isRecord(write)) throw invalidFile(path, lineNumber, `writes[${index}] is not an object`);
		if (write.kind === "entry") {
			requireSafeInteger(write.timestamp, path, lineNumber, `writes[${index}].timestamp`);
		} else if (write.kind === "usage" || write.kind === "register") {
			// Positional seq is the only durable authority; stored seqs are rejected.
			if (write.seq !== undefined) throw invalidFile(path, lineNumber, `writes[${index}] carries a stored seq`);
			if (write.timestamp !== undefined) {
				throw invalidFile(path, lineNumber, `writes[${index}] carries a stored timestamp`);
			}
		} else {
			throw invalidFile(path, lineNumber, `writes[${index}] has unknown write kind`);
		}
	}
	try {
		codec.validateTransaction({ writes: value.writes as unknown as Write[] });
	} catch (error) {
		if (error instanceof SessionError && error.code === "invalid_payload") {
			throw invalidFile(path, lineNumber, `has invalid payload: ${error.message}`, error);
		}
		throw error;
	}
	return {
		kind: "transaction",
		version: 1,
		firstSeq,
		timestamp,
		writes: value.writes as unknown as JsonlStoredWriteV1[],
	};
}
