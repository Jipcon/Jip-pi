import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
	InMemorySessionRepo,
	JsonlSessionRepo,
	type SessionCodec,
	type SessionMetadata,
	type SessionRepo,
} from "../../../src/harness-v4.ts";

/** Repository shape shared by the memory and JSONL backend factories. */
export type V4SessionRepo = SessionRepo<SessionMetadata, { id?: string; parentSessionId?: string }, { cwd?: string }>;

const cleanupDirectories = new Set<string>();

afterEach(() => {
	for (const directory of cleanupDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

export interface V4Backend {
	name: string;
	create(options?: { now?: () => number; codec?: SessionCodec }): V4SessionRepo;
}

/** Memory + JSONL factory pairs used to re-run recovery suites without copying assertions. */
export function v4Backends(): V4Backend[] {
	return [
		{
			name: "memory",
			create: (options) => new InMemorySessionRepo({ now: options?.now, codec: options?.codec }),
		},
		{
			name: "jsonl",
			create: (options) => {
				const directory = mkdtempSync(join(tmpdir(), "pi-v4-jsonl-"));
				cleanupDirectories.add(directory);
				return new JsonlSessionRepo({ directory, now: options?.now, codec: options?.codec });
			},
		},
	];
}

/** One JSONL repository on a fresh temp directory, removed after the current test. */
export function jsonlRepoFixture(options?: { now?: () => number; codec?: SessionCodec }): JsonlSessionRepo {
	const directory = mkdtempSync(join(tmpdir(), "pi-v4-jsonl-"));
	cleanupDirectories.add(directory);
	return new JsonlSessionRepo({ directory, now: options?.now, codec: options?.codec });
}
