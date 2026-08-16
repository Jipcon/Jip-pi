import { describe, expect, test } from "vitest";
import { JsonlParser } from "../src/rpc-parser.ts";

function collect(options: { onError?: (line: string, error: Error) => void } = {}) {
	const records: unknown[] = [];
	const parser = new JsonlParser({
		onRecord: (record) => records.push(record),
		onError: options.onError,
	});
	return { parser, records };
}

describe("JsonlParser framing", () => {
	test("parses multiple records from a single chunk", () => {
		const { parser, records } = collect();
		parser.push('{"a":1}\n{"b":2}\n{"c":3}\n');
		expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	test("accumulates a record split across multiple chunks", () => {
		const { parser, records } = collect();
		const payload = '{"message":"hello world","n":42}';
		for (const char of payload) {
			parser.push(char);
		}
		parser.push("\n");
		expect(records).toEqual([{ message: "hello world", n: 42 }]);
	});

	test("handles CRLF-delimited input", () => {
		const { parser, records } = collect();
		parser.push('{"a":1}\r\n{"b":2}\r\n');
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("preserves U+2028 / U+2029 inside JSON strings", () => {
		const { parser, records } = collect();
		parser.push(`{"text":"a\u2028b\u2029c"}\n`);
		expect(records).toEqual([{ text: "a\u2028b\u2029c" }]);
	});

	test("preserves multi-byte UTF-8 split across chunk boundaries", () => {
		const { parser, records } = collect();
		const line = Buffer.from('{"text":"你好，世界"}\n', "utf8");
		const mid = Math.floor(line.length / 2);
		parser.push(line.subarray(0, mid));
		parser.push(line.subarray(mid));
		expect(records).toEqual([{ text: "你好，世界" }]);
	});

	test("skips empty lines", () => {
		const { parser, records } = collect();
		parser.push('\n\n{"a":1}\n\n');
		expect(records).toEqual([{ a: 1 }]);
	});

	test("reports malformed JSON and continues parsing", () => {
		const errors: Array<{ line: string }> = [];
		const { parser, records } = collect({
			onError: (line) => errors.push({ line }),
		});
		parser.push('this is not json\n{"ok":true}\n');
		expect(errors).toHaveLength(1);
		expect(records).toEqual([{ ok: true }]);
	});

	test("flush emits a trailing record without final LF", () => {
		const { parser, records } = collect();
		parser.push('{"a":1}\n{"b":2}');
		parser.flush();
		expect(records).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("never throws on binary garbage", () => {
		const { parser, records } = collect();
		expect(() => parser.push(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x0a]))).not.toThrow();
		expect(records).toEqual([]);
	});
});
