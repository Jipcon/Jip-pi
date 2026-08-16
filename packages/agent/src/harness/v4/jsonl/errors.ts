import { SessionError } from "../storage.ts";

/** A line that could not be parsed as JSON at all (the torn-tail candidate signal). */
export class JsonlParseError extends SyntaxError {
	readonly line: number;

	constructor(path: string, line: number, cause?: Error) {
		super(
			`Invalid JSONL v4 session ${path}: line ${line} is not valid JSON`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "JsonlParseError";
		this.line = line;
	}
}

/** A complete but invalid line or an inconsistent record prefix: corruption, never a torn tail. */
export function invalidFile(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("corruption", `Invalid JSONL v4 session ${path}: line ${line} ${message}`, cause);
}

/** An unrecognized format, format version, or storage version. */
export function unsupportedFile(path: string, message: string): SessionError {
	return new SessionError("storage_version", `Unsupported JSONL v4 session ${path}: ${message}`);
}
