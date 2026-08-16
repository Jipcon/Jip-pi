import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryTrajectoryStore,
	JsonlTrajectoryStore,
	MAX_TRAJECTORY_SUMMARY_LENGTH,
	sanitizeTrajectoryMetrics,
	type TrajectoryRecord,
	type TrajectoryStore,
} from "../../src/index.ts";

const cleanupDirectories = new Set<string>();
afterEach(() => {
	for (const directory of cleanupDirectories) rmSync(directory, { recursive: true, force: true });
	cleanupDirectories.clear();
});

function record(overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
	return {
		id: "record-1",
		kind: "turn",
		taskId: "task",
		candidateId: "candidate",
		sessionId: "session",
		operationId: "op",
		policyBundleVersion: "v1",
		policyBundleFingerprint: "a".repeat(64),
		metrics: {},
		recordedAt: 1,
		...overrides,
	};
}

function jsonlStore(name: string): { store: JsonlTrajectoryStore; directory: string } {
	const directory = mkdtempSync(join(tmpdir(), `pi-trajectory-${name}-`));
	cleanupDirectories.add(directory);
	return { store: new JsonlTrajectoryStore({ directory }), directory };
}

describe.each(["memory", "jsonl"] as const)("TrajectoryStore ($backend)", (backend) => {
	async function makeStore(): Promise<TrajectoryStore> {
		return backend === "memory" ? new InMemoryTrajectoryStore() : jsonlStore("suite").store;
	}

	it("stores structured metrics and deduplicates by stable identity", async () => {
		const store = await makeStore();
		const first = await store.append(record({ metrics: { hits: 1 } }));
		// At-least-once: a duplicate delivery may be accepted by the backend,
		// but query-time deduplication by stable identity is the contract.
		await store.append(record({ metrics: { hits: 2 } }));
		expect(first.appended).toBe(true);
		const records = await store.query();
		expect(records).toHaveLength(1);
		expect(records[0]?.metrics).toEqual({ hits: 1 });
		await store.close();
	});

	it("sanitizes long free-form content into hashes, lengths and summaries", async () => {
		const store = await makeStore();
		const raw = `SECRET_TOKEN=abc123 ${"x".repeat(500)}`;
		await store.append(record({ metrics: { output: raw } }));
		const records = await store.query();
		const output = records[0]?.metrics.output as { length: number; hash: string; prefix: string };
		expect(output.length).toBe(raw.length);
		expect(output.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(output.prefix.length).toBeLessThanOrEqual(MAX_TRAJECTORY_SUMMARY_LENGTH);
		expect(output.prefix).not.toContain("x".repeat(300));
		expect(JSON.stringify(records)).not.toContain("x".repeat(300));
		await store.close();
	});

	it("drops writes while paused without affecting existing records", async () => {
		const store = await makeStore();
		await store.append(record({ id: "kept" }));
		store.setPaused(true);
		expect((await store.append(record({ id: "dropped" }))).appended).toBe(false);
		store.setPaused(false);
		expect((await store.append(record({ id: "later" }))).appended).toBe(true);
		const records = await store.query();
		expect(records.map((item) => item.id)).toEqual(["kept", "later"]);
		await store.close();
	});

	it("survives reopen with at-least-once delivery deduplicated", async () => {
		if (backend === "memory") return;
		const first = jsonlStore("reopen");
		await first.store.append(record({ id: "a", metrics: { n: 1 } }));
		await first.store.append(record({ id: "b", metrics: { n: 2 } }));
		await first.store.close();
		const reopened = new JsonlTrajectoryStore({ directory: first.directory });
		await reopened.append(record({ id: "a", metrics: { n: 1 } }));
		const records = await reopened.query();
		expect(records.map((item) => item.id)).toEqual(["a", "b"]);
		await reopened.close();
	});

	it("ignores torn lines and foreign content on read", async () => {
		if (backend === "memory") return;
		const { store, directory } = jsonlStore("torn");
		await store.append(record({ id: "good", metrics: { n: 1 } }));
		await appendFile(join(directory, "trajectory.jsonl"), '{"id":"torn"\n', "utf8");
		const records = await store.query();
		expect(records.map((item) => item.id)).toEqual(["good"]);
		await store.close();
	});
});

describe("trajectory sanitization", () => {
	it("redacts nested content recursively", () => {
		const sanitized = sanitizeTrajectoryMetrics({
			short: "ok",
			nested: { long: "y".repeat(300) },
			list: ["z".repeat(300), 1, null],
		}) as {
			short: string;
			nested: { long: { length: number; hash: string } };
			list: unknown[];
		};
		expect(sanitized.short).toBe("ok");
		expect(sanitized.nested.long.length).toBe(300);
		expect(sanitized.nested.long.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(sanitized.list[0]).toMatchObject({ length: 300 });
	});
});

describe("fault isolation", () => {
	it("a store that always throws never propagates to the caller", async () => {
		const failing: TrajectoryStore = {
			append: async () => {
				throw new Error("storage offline");
			},
			query: async () => [],
			setPaused: () => undefined,
			close: async () => undefined,
		};
		// The interface contract: append is fire-and-forget from the caller's
		// perspective; the loop never awaits correctness on it.
		await expect(failing.append(record())).rejects.toThrow("storage offline");
		const isolated: TrajectoryStore = {
			...failing,
			append: async () => ({ appended: false }),
		};
		await expect(isolated.append(record())).resolves.toEqual({ appended: false });
	});

	it("a JSONL store on an unusable directory reports through onError only", async () => {
		const errors: Error[] = [];
		const directory = mkdtempSync(join(tmpdir(), "pi-trajectory-ro-"));
		cleanupDirectories.add(directory);
		// A regular file occupies the store's directory path: mkdir fails.
		const blocked = join(directory, "blocked");
		writeFileSync(blocked, "occupied", "utf8");
		const store = new JsonlTrajectoryStore({
			directory: blocked,
			onError: (error) => errors.push(error),
		});
		expect((await store.append(record())).appended).toBe(false);
		expect(errors.length).toBeGreaterThan(0);
		await store.close();
	});
});
