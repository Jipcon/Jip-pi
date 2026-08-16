import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeTransactionRecord,
	JsonlSessionRepo,
	type JsonlTransactionRecordV1,
	NodeJsonlFileSystem,
} from "../../src/harness-v4.ts";
import { jsonlRepoFixture } from "./fixtures/v4-jsonl-backends.ts";

/** Directories shared by several repo instances in one test; removed after the test. */
const sharedDirectories = new Set<string>();

afterEach(() => {
	for (const directory of sharedDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	sharedDirectories.clear();
});

function repoDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-v4-jsonl-shared-"));
	sharedDirectories.add(directory);
	return directory;
}

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}

function readRaw(path: string): string {
	return readFileSync(path, "utf8");
}

function writeRaw(path: string, content: string): void {
	writeFileSync(path, content, "utf8");
}

function appendRaw(path: string, content: string): void {
	appendFileSync(path, content, "utf8");
}

function names(directory: string): string[] {
	return readdirSync(directory);
}

function sessionPath(repo: JsonlSessionRepo, id: string): string {
	return join(repo.directory, `${id}.jsonl`);
}

function record(
	firstSeq: number,
	timestamp: number,
	writes: JsonlTransactionRecordV1["writes"],
): JsonlTransactionRecordV1 {
	return { kind: "transaction", version: 1, firstSeq, timestamp, writes };
}

function entryWrite(id: string, parentId: string | null, timestamp: number) {
	return { kind: "entry" as const, entry: { id, parentId, type: "custom" as const, customType: "note" }, timestamp };
}

/** Creates a session with one durable custom entry "before" and returns the file path. */
async function seeded(
	repo: JsonlSessionRepo,
): Promise<{ path: string; metadata: import("../../src/harness-v4.ts").SessionMetadata }> {
	const session = await repo.create({ id: "torn", cwd: "D:\\work", parentSessionId: "parent" });
	await session.appendCustomEntry("note");
	const metadata = structuredClone(session.metadata);
	await session.close();
	return { path: sessionPath(repo, "torn"), metadata };
}

class HoldRenameFs extends NodeJsonlFileSystem {
	hold: Promise<void>;
	release: () => void;
	renames = 0;
	/** Renames with an index at or above this value wait for release. */
	holdFrom = 1;

	constructor() {
		super();
		this.release = () => {};
		this.hold = new Promise<void>((resolve) => {
			this.release = resolve;
		});
	}

	override rename(source: string, destination: string): Promise<void> {
		this.renames++;
		if (this.renames >= this.holdFrom) return this.hold.then(() => super.rename(source, destination));
		return super.rename(source, destination);
	}
}

class FailingAppendFs extends NodeJsonlFileSystem {
	readonly appended: string[] = [];
	failAt = Number.POSITIVE_INFINITY;
	partialBytes: number | undefined;

	override async appendFile(path: string, data: string): Promise<void> {
		if (this.appended.length + 1 >= this.failAt) {
			if (this.partialBytes !== undefined) {
				await super.appendFile(path, data.slice(0, this.partialBytes));
			}
			throw new Error("append boom");
		}
		this.appended.push(data);
		return super.appendFile(path, data);
	}
}

class FailingWriteFs extends NodeJsonlFileSystem {
	override async writeFile(_path: string, _data: string): Promise<void> {
		throw new Error("write boom");
	}
}

class FailingRenameFs extends NodeJsonlFileSystem {
	override async rename(_source: string, _destination: string): Promise<void> {
		throw new Error("rename boom");
	}
}

describe("JSONL v1 storage lifecycle", () => {
	it("publishes a complete create file with header and initial lane transaction", async () => {
		const repo = jsonlRepoFixture({ now: () => 42 });
		const session = await repo.create({ id: "golden" });
		await session.close();
		const content = readRaw(sessionPath(repo, "golden"));
		const lines = content.split("\n");
		strictEqual(lines.at(-1), "");
		strictEqual(lines.length, 3);
		const header = JSON.parse(lines[0]!);
		expect(header).toMatchObject({
			kind: "header",
			format: "pi-harness-v4-jsonl",
			version: 1,
			storageVersion: 1,
			id: "golden",
			createdAt: 42,
		});
		const initial = JSON.parse(lines[1]!);
		expect(initial).toMatchObject({ kind: "transaction", version: 1, firstSeq: 1, timestamp: 42 });
		strictEqual(initial.writes.length, 2);
	});

	it("reopens a complete prefix and continues appending with continuous seqs", async () => {
		const repo = jsonlRepoFixture({ now: () => 100 });
		const session = await repo.create({ id: "reopen" });
		await session.appendCustomEntry("note");
		const metadata = structuredClone(session.metadata);
		await session.close();

		const reopened = await repo.open(metadata);
		const second = await reopened.appendCustomEntry("more");
		const third = await reopened.appendCustomEntry("again");
		await reopened.close();

		const final = await repo.open(metadata);
		const entries = await final.findEntries({ order: "asc" });
		deepStrictEqual(
			entries.map((entry) => ({ id: entry.id, seq: entry.seq, timestamp: entry.timestamp })),
			[
				{ id: entries[0]!.id, seq: 3, timestamp: 100 },
				{ id: second, seq: 5, timestamp: 100 },
				{ id: third, seq: 7, timestamp: 100 },
			],
		);
		await final.close();
	});

	it("lists only published sessions and filters by cwd", async () => {
		const repo = jsonlRepoFixture();
		const a = await repo.create({ id: "list-a", cwd: "C:\\one" });
		const b = await repo.create({ id: "list-b", cwd: "C:\\two" });
		await a.close();
		await b.close();
		deepStrictEqual(
			(await repo.list()).map((item) => item.id),
			["list-a", "list-b"],
		);
		deepStrictEqual(
			(await repo.list({ cwd: "C:\\one" })).map((item) => item.id),
			["list-a"],
		);
		expect((await repo.list()).sort((left, right) => (left.cwd ?? "").localeCompare(right.cwd ?? ""))).toEqual([
			expect.objectContaining({ cwd: "C:\\one" }),
			expect.objectContaining({ cwd: "C:\\two" }),
		]);
	});

	it("rejects open while the writer is active and deletes after close", async () => {
		const repo = jsonlRepoFixture();
		const session = await repo.create({ id: "delete-me" });
		const metadata = structuredClone(session.metadata);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "storage" });
		await expect(repo.delete(metadata)).rejects.toMatchObject({ code: "storage" });
		await session.close();
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "not_found" });
		await repo.delete(metadata);
	});

	it("rejects a header id that does not match the opened metadata", async () => {
		const repo = jsonlRepoFixture();
		const session = await repo.create({ id: "id-check" });
		const metadata = structuredClone(session.metadata);
		await session.close();
		writeRaw(sessionPath(repo, "someone-else"), readRaw(sessionPath(repo, "id-check")));
		await expect(repo.open({ ...metadata, id: "someone-else" })).rejects.toMatchObject({ code: "corruption" });
	});
});

describe("JSONL v1 torn-tail contract", () => {
	it("recovers a complete record with its LF", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		const before = readRaw(path);
		appendRaw(path, encodeTransactionRecord(record(5, 500, [entryWrite("after", null, 500)])));
		const reopened = await repo.open(metadata);
		expect(await reopened.getEntry("after")).toMatchObject({ id: "after", seq: 5, timestamp: 500 });
		await reopened.close();
		strictEqual(readRaw(path).slice(0, before.length), before);
	});

	it("accepts a complete record missing its LF and atomically appends one", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		appendRaw(path, encodeTransactionRecord(record(5, 500, [entryWrite("after", null, 500)])).slice(0, -1));
		const reopened = await repo.open(metadata);
		expect(await reopened.getEntry("after")).toBeDefined();
		await reopened.close();
		strictEqual(readRaw(path).endsWith("\n"), true);
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("drops an incomplete final JSON line and atomically publishes the legal prefix", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		const before = readRaw(path);
		appendRaw(path, `{"kind":"transaction","version":1,"firstSeq":5,"tim`);
		const reopened = await repo.open(metadata);
		expect(await reopened.getEntry("after")).toBeUndefined();
		const entries = await reopened.findEntries({ order: "asc" });
		strictEqual(entries.length, 1);
		await reopened.close();
		strictEqual(readRaw(path), before);
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("reports a complete but invalid final record as corruption without truncating", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		const invalid = {
			kind: "transaction",
			version: 1,
			firstSeq: 5,
			timestamp: 500,
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: 42, pendingNextRun: [] },
				},
			],
		} as unknown as JsonlTransactionRecordV1;
		appendRaw(path, encodeTransactionRecord(invalid));
		const before = readRaw(path);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "corruption" });
		strictEqual(readRaw(path), before);
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("reports a seq discontinuity in the final record as corruption", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		appendRaw(path, encodeTransactionRecord(record(9, 500, [entryWrite("after", null, 500)])));
		const before = readRaw(path);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "corruption" });
		strictEqual(readRaw(path), before);
	});

	it("reports a malformed interior line as corruption with the original bytes untouched", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		const lines = readRaw(path).split("\n");
		lines.splice(2, 0, "{not json at all");
		const damaged = lines.join("\n");
		writeRaw(path, damaged);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "corruption" });
		strictEqual(readRaw(path), damaged);
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("fails open without touching the file or leaving temp files when repair writes fail", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		appendRaw(path, `{"kind":"transaction","version":1,"firstSeq":5,"tim`);
		const damaged = readRaw(path);
		const broken = new JsonlSessionRepo({ directory: repo.directory, fs: new FailingWriteFs(), now: () => 500 });
		await expect(broken.open(metadata)).rejects.toMatchObject({ code: "storage" });
		strictEqual(readRaw(path), damaged);
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("fails open without touching the file when the repair rename fails", async () => {
		const repo = jsonlRepoFixture({ now: () => 500 });
		const { path, metadata } = await seeded(repo);
		appendRaw(path, `{"kind":"transaction","version":1,"firstSeq":5,"tim`);
		const damaged = readRaw(path);
		const broken = new JsonlSessionRepo({ directory: repo.directory, fs: new FailingRenameFs(), now: () => 500 });
		await expect(broken.open(metadata)).rejects.toMatchObject({ code: "storage" });
		strictEqual(readRaw(path), damaged);
	});

	it("fails a missing or torn header directly without tail repair", async () => {
		const repo = jsonlRepoFixture();
		const cases: Array<{ content: string; code: string }> = [
			{ content: "", code: "corruption" },
			{
				content: `{"kind":"header","format":"pi-harness-v4-jsonl","version":1,"storageVersion":1,"id":"torn","createdAt":1}`,
				code: "corruption",
			},
			{ content: "not a header\n", code: "corruption" },
			{
				content: `{"kind":"header","format":"pi-harness-v3-jsonl","version":1,"storageVersion":1,"id":"torn","createdAt":1}\n`,
				code: "storage_version",
			},
		];
		for (const [index, testCase] of cases.entries()) {
			const id = `header-${index}`;
			const path = join(repo.directory, `${id}.jsonl`);
			writeRaw(path, testCase.content);
			await expect(repo.open({ id, createdAt: 1, storageVersion: 1 })).rejects.toMatchObject({
				code: testCase.code,
			});
			strictEqual(readRaw(path), testCase.content);
		}
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});
});

describe("JSONL v1 append failure", () => {
	it("faults the handle on append failure and requires a reopen", async () => {
		const failingFs = new FailingAppendFs();
		failingFs.failAt = 2;
		const broken = new JsonlSessionRepo({ directory: repoDirectory(), fs: failingFs, now: () => 7 });
		const session = await broken.create({ id: "fault" });
		await session.appendCustomEntry("ok");
		await expect(session.appendCustomEntry("boom")).rejects.toMatchObject({ code: "storage" });
		await expect(session.getStats()).rejects.toMatchObject({ code: "storage" });
		await expect(session.appendCustomEntry("sealed")).rejects.toMatchObject({ code: "storage" });
		await session.close();

		const fresh = new JsonlSessionRepo({ directory: broken.directory, now: () => 7 });
		const reopened = await fresh.open(session.metadata);
		const entries = await reopened.findEntries({ order: "asc" });
		strictEqual(entries.length, 1);
		await reopened.appendCustomEntry("recovered");
		await reopened.close();
	});

	it("repairs a torn tail left by a partial failed append on reopen", async () => {
		const failingFs = new FailingAppendFs();
		failingFs.failAt = 2;
		failingFs.partialBytes = 12;
		const broken = new JsonlSessionRepo({ directory: repoDirectory(), fs: failingFs, now: () => 7 });
		const session = await broken.create({ id: "partial" });
		await session.appendCustomEntry("ok");
		await expect(session.appendCustomEntry("boom")).rejects.toMatchObject({ code: "storage" });
		await session.close();

		const fresh = new JsonlSessionRepo({ directory: broken.directory, now: () => 7 });
		const reopened = await fresh.open(session.metadata);
		strictEqual((await reopened.findEntries()).length, 1);
		await reopened.close();
	});
});

describe("JSONL v1 create and fork publication", () => {
	it("never lists or opens a create whose rename has not committed", async () => {
		const gate = new HoldRenameFs();
		const repo = new JsonlSessionRepo({ directory: repoDirectory(), fs: gate, now: () => 1 });
		const creating = repo.create({ id: "held-create" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		strictEqual(gate.renames, 1);
		deepStrictEqual(await repo.list(), []);
		await expect(repo.open({ id: "held-create", createdAt: 1, storageVersion: 1 })).rejects.toMatchObject({
			code: "not_found",
		});
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 1);
		gate.release();
		const session = await creating;
		deepStrictEqual(
			(await repo.list()).map((item) => item.id),
			["held-create"],
		);
		await session.close();
	});

	it("publishes a fork only at its rename with entries and lane placement complete", async () => {
		const gate = new HoldRenameFs();
		gate.holdFrom = 2;
		const repo = new JsonlSessionRepo({ directory: repoDirectory(), fs: gate, now: () => 2 });
		const source = await repo.create({ id: "fork-source" });
		const root = await source.appendMessage(userMessage("root"));
		const tail = await source.appendMessage(userMessage("tail"));
		await source.setName("Source");
		await source.commit({
			writes: [
				{
					kind: "usage",
					row: {
						id: "u",
						entryId: tail,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						adjustment: false,
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: "p",
					value: { type: "custom", customType: "note" },
				},
			],
		});

		const forking = repo.fork(source.metadata, { id: "fork-child", entryId: tail, position: "before" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		strictEqual(gate.renames, 2);
		deepStrictEqual(
			(await repo.list()).map((item) => item.id),
			["fork-source"],
		);
		await expect(repo.open({ id: "fork-child", createdAt: 2, storageVersion: 1 })).rejects.toMatchObject({
			code: "not_found",
		});
		gate.release();
		const child = await forking;

		strictEqual(await child.getLeafId(), root);
		deepStrictEqual(
			(await child.findEntries({ order: "asc" })).map((entry) => entry.id),
			[root],
		);
		strictEqual(await child.getName(), "Source");
		deepStrictEqual(await child.scanUsage({}), []);
		deepStrictEqual(await child.listRegisters("pending.entry"), []);
		strictEqual((await child.getRegister("lane.state", "main"))?.value.currentOperationId, null);
		strictEqual(child.metadata.parentSessionId, source.metadata.id);
		expect((await child.getEntry(root))?.timestamp).toBe((await source.getEntry(root))?.timestamp);
		await source.close();
		await child.close();
	});

	it("leaves no tmp publications after a clean create", async () => {
		const repo = jsonlRepoFixture();
		const session = await repo.create({ id: "cleanup" });
		await session.close();
		strictEqual(names(repo.directory).filter((name) => name.endsWith(".tmp")).length, 0);
	});

	it("rejects create and fork over an existing destination", async () => {
		const repo = jsonlRepoFixture();
		const session = await repo.create({ id: "occupied" });
		await session.close();
		await expect(repo.create({ id: "occupied" })).rejects.toMatchObject({ code: "already_exists" });
		await expect(
			repo.fork({ id: "occupied", createdAt: 1, storageVersion: 1 }, { scope: "tree", id: "occupied" }),
		).rejects.toMatchObject({ code: "already_exists" });
	});
});
