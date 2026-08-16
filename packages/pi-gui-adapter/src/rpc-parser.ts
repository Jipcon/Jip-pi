/**
 * Strict JSONL framing parser for the Pi RPC protocol.
 *
 * Framing rules (must match `packages/coding-agent/src/modes/rpc/jsonl.ts`):
 * - Records are delimited by LF (`\n`) only.
 * - Optional CRLF input: a trailing `\r` is stripped from each record.
 * - U+2028 / U+2029 are valid inside JSON strings and MUST NOT split records.
 * - Node's `readline` is NOT protocol-compliant here; this parser implements
 *   its own buffer instead.
 * - Malformed records are reported through `onError` and skipped; the parser
 *   never throws and never stops the stream.
 *
 * Only stdout of the backend process is fed into this parser. stderr must be
 * routed to diagnostics and never into the JSON parser.
 */

import { StringDecoder } from "node:string_decoder";

export interface JsonlParserCallbacks {
	onRecord: (record: unknown) => void;
	onError?: (line: string, error: Error) => void;
}

export class JsonlParser {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private readonly callbacks: JsonlParserCallbacks;

	constructor(callbacks: JsonlParserCallbacks) {
		this.callbacks = callbacks;
	}

	/** Feed a chunk of stdout data. Accepts strings, Buffers or Uint8Array. */
	push(chunk: string | Uint8Array): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.drain();
	}

	/**
	 * Flush any remaining buffered bytes (e.g. on stream end).
	 * A trailing record without a final LF is still emitted.
	 */
	flush(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.length > 0) {
			this.emitLine(this.buffer);
			this.buffer = "";
		}
	}

	private drain(): void {
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			this.emitLine(line);
		}
	}

	private emitLine(rawLine: string): void {
		// Strip a single trailing \r to accept CRLF-delimited input.
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			return;
		}
		try {
			this.callbacks.onRecord(JSON.parse(line));
		} catch (error) {
			this.callbacks.onError?.(line, error instanceof Error ? error : new Error(String(error)));
		}
	}
}
