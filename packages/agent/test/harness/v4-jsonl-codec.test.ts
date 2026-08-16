import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
	encodeHeader,
	encodeTransactionRecord,
	type JsonlHeaderV1,
	JsonlParseError,
	type JsonlTransactionRecordV1,
	parseHeader,
	parseTransactionRecord,
	SessionCodec,
	type SessionError,
} from "../../src/harness-v4.ts";

const PATH = "sessions/example.jsonl";

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "header",
		format: "pi-harness-v4-jsonl",
		version: 1,
		storageVersion: 1,
		id: "session-1",
		createdAt: 123,
		cwd: "D:\\work",
		...overrides,
	};
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "transaction",
		version: 1,
		firstSeq: 3,
		timestamp: 100,
		writes: [
			{
				kind: "entry",
				entry: { id: "e1", parentId: null, type: "custom", customType: "note", data: { v: 1 } },
				timestamp: 5,
			},
		],
		...overrides,
	};
}

describe("JSONL v1 codec golden bytes", () => {
	it("encodes the header byte-for-byte", () => {
		const value: JsonlHeaderV1 = {
			kind: "header",
			format: "pi-harness-v4-jsonl",
			version: 1,
			storageVersion: 1,
			id: "session-1",
			createdAt: 123,
			cwd: "D:\\work",
		};
		strictEqual(
			encodeHeader(value),
			'{"kind":"header","format":"pi-harness-v4-jsonl","version":1,"storageVersion":1,"id":"session-1","createdAt":123,"cwd":"D:\\\\work"}\n',
		);
	});

	it("encodes a transaction with its stored entry timestamp byte-for-byte", () => {
		const value: JsonlTransactionRecordV1 = {
			kind: "transaction",
			version: 1,
			firstSeq: 3,
			timestamp: 100,
			writes: [
				{
					kind: "entry",
					entry: { id: "e1", parentId: null, type: "custom", customType: "note", data: { v: 1 } },
					timestamp: 5,
				},
			],
		};
		strictEqual(
			encodeTransactionRecord(value),
			'{"kind":"transaction","version":1,"firstSeq":3,"timestamp":100,"writes":[{"kind":"entry","entry":{"id":"e1","parentId":null,"type":"custom","customType":"note","data":{"v":1}},"timestamp":5}]}\n',
		);
	});

	it("keeps every record on exactly one physical line", () => {
		const line = encodeTransactionRecord(
			parseTransactionRecord(
				JSON.stringify(
					transaction({
						writes: [
							{
								kind: "entry",
								entry: { id: "e", parentId: null, type: "custom", customType: "note", data: "line\nbreak" },
								timestamp: 7,
							},
						],
					}),
				),
				PATH,
				2,
				3,
				new SessionCodec(),
			),
		);
		strictEqual(line.slice(0, -1).includes("\n"), false);
		strictEqual(line.endsWith("\n"), true);
	});
});

describe("JSONL v1 header parsing", () => {
	it("round-trips a header with optional fields", () => {
		deepStrictEqual(parseHeader(JSON.stringify(header({ parentSessionId: "parent-1" })), PATH), {
			kind: "header",
			format: "pi-harness-v4-jsonl",
			version: 1,
			storageVersion: 1,
			id: "session-1",
			createdAt: 123,
			cwd: "D:\\work",
			parentSessionId: "parent-1",
		});
	});

	it("reports unknown formats and versions as storage_version", () => {
		for (const bad of [
			header({ format: "pi-harness-v3-jsonl" }),
			header({ format: "something-else" }),
			header({ format: undefined }),
			header({ version: 4 }),
			header({ version: 2 }),
			header({ storageVersion: 2 }),
		]) {
			expect(() => parseHeader(JSON.stringify(bad), PATH)).toThrowError(
				expect.objectContaining({ code: "storage_version" } satisfies Partial<SessionError>),
			);
		}
	});

	it("reports complete but invalid headers as corruption", () => {
		for (const bad of [
			header({ kind: "not-a-header" }),
			header({ createdAt: -1 }),
			header({ createdAt: 1.5 }),
			header({ id: "" }),
			header({ id: 42 }),
			header({ cwd: 7 }),
			header({ parentSessionId: {} }),
			`{"kind":"header","format":"pi-harness-v4-jsonl","version":1,"storageVersion":1`,
		]) {
			const line = typeof bad === "string" ? bad : JSON.stringify(bad);
			expect(() => parseHeader(line, PATH)).toThrowError(
				expect.objectContaining({ code: "corruption" } satisfies Partial<SessionError>),
			);
		}
	});
});

describe("JSONL v1 transaction parsing", () => {
	const codec = new SessionCodec();

	it("round-trips entry, usage, and register writes", () => {
		const record = {
			kind: "transaction",
			version: 1,
			firstSeq: 1,
			timestamp: 10,
			writes: [
				{
					kind: "entry",
					entry: {
						id: "root",
						parentId: null,
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
					},
					timestamp: 9,
				},
				{
					kind: "usage",
					row: {
						id: "u1",
						entryId: "root",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						adjustment: false,
					},
				},
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "name" },
				{ kind: "register", op: "delete", namespace: "fact.custom", key: "gone" },
			],
		};
		const parsed = parseTransactionRecord(JSON.stringify(record), PATH, 2, 1, codec);
		strictEqual(parsed.firstSeq, 1);
		strictEqual(parsed.writes.length, 4);
		deepStrictEqual(
			encodeTransactionRecord(parsed),
			encodeTransactionRecord(record as unknown as JsonlTransactionRecordV1),
		);
	});

	it("enforces seq continuity by position", () => {
		expect(() =>
			parseTransactionRecord(JSON.stringify(transaction({ firstSeq: 4 })), PATH, 2, 3, codec),
		).toThrowError(expect.objectContaining({ code: "corruption" }));
		expect(() =>
			parseTransactionRecord(JSON.stringify(transaction({ firstSeq: 0 })), PATH, 2, 1, codec),
		).toThrowError(expect.objectContaining({ code: "corruption" }));
		expect(() =>
			parseTransactionRecord(JSON.stringify(transaction({ firstSeq: 1.5 })), PATH, 2, 1, codec),
		).toThrowError(expect.objectContaining({ code: "corruption" }));
	});

	it("rejects unknown kinds, versions, and empty writes", () => {
		for (const bad of [
			transaction({ kind: "entry" }),
			transaction({ version: 2 }),
			transaction({ version: "1" }),
			transaction({ timestamp: -1 }),
			transaction({ writes: [] }),
			transaction({ writes: [{ kind: "mystery" }] }),
		]) {
			expect(() => parseTransactionRecord(JSON.stringify(bad), PATH, 2, 3, codec)).toThrowError(
				expect.objectContaining({ code: "corruption" } satisfies Partial<SessionError>),
			);
		}
	});

	it("rejects stored seq/timestamp outside entry writes", () => {
		for (const write of [
			{
				kind: "usage",
				seq: 3,
				row: {
					id: "u",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					adjustment: false,
				},
			},
			{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "x", timestamp: 1 },
		]) {
			expect(() =>
				parseTransactionRecord(JSON.stringify(transaction({ writes: [write] })), PATH, 2, 3, codec),
			).toThrowError(expect.objectContaining({ code: "corruption" } satisfies Partial<SessionError>));
		}
	});

	it("requires a stored timestamp on entry writes", () => {
		const write = { kind: "entry", entry: { id: "e", parentId: null, type: "custom", customType: "note" } };
		expect(() =>
			parseTransactionRecord(JSON.stringify(transaction({ writes: [write] })), PATH, 2, 3, codec),
		).toThrowError(expect.objectContaining({ code: "corruption" } satisfies Partial<SessionError>));
	});

	it("validates v4 payloads through the session codec", () => {
		const bad = transaction({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: 42, pendingNextRun: [] },
					timestamp: undefined,
				},
			],
		});
		expect(() => parseTransactionRecord(JSON.stringify(bad), PATH, 2, 3, codec)).toThrowError(
			expect.objectContaining({ code: "corruption" } satisfies Partial<SessionError>),
		);
	});

	it("surfaces a JSON syntax failure as JsonlParseError with its line", () => {
		try {
			parseTransactionRecord(`{"kind":"transaction","version":1,"firstSeq":3,"tim`, PATH, 7, 3, codec);
			throw new Error("Expected parse failure");
		} catch (error) {
			expect(error).toBeInstanceOf(JsonlParseError);
			expect((error as JsonlParseError).line).toBe(7);
		}
	});
});
