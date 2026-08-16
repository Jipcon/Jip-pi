import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../../types.ts";
import type { Entry, JsonValue } from "../base.ts";
import type { Session, SessionErrorCode, SessionRepo } from "../storage.ts";
import type { SessionBackendConformanceCase, SessionBackendFixtureFactory } from "./types.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMessage(
	text: string,
	options: { toolCalls?: Array<{ id: string; name: string }>; usage?: Usage } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(options.toolCalls ?? []).map(({ id, name }) => ({ type: "toolCall" as const, id, name, arguments: {} })),
		],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: options.usage ?? ZERO_USAGE,
		stopReason: options.toolCalls === undefined ? "stop" : "toolUse",
		timestamp: 1,
	};
}

function toolResultMessage(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 1,
	};
}

async function rejectsWithCode(operation: Promise<unknown>, code: SessionErrorCode): Promise<void> {
	await rejects(
		operation,
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code,
		`Expected SessionError with code ${code}`,
	);
}

async function ids(entries: Promise<Entry[]>): Promise<string[]> {
	return (await entries).map((entry) => entry.id);
}

type ConformanceTest = (repository: SessionRepo) => Promise<void>;

function createCase(
	factory: SessionBackendFixtureFactory,
	group: string,
	name: string,
	test: ConformanceTest,
): SessionBackendConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture.repository);
		},
	};
}

async function createThreadLane(session: Session, leafId: string | null): Promise<void> {
	await session.commit({
		writes: [
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "thread", value: leafId },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "thread",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		],
	});
}

/** Runner-independent durable semantics shared by every Harness v4 session backend. */
export function createSessionBackendConformance(
	factory: SessionBackendFixtureFactory,
): readonly SessionBackendConformanceCase[] {
	return [
		createCase(factory, "transactions", "rolls back every write after a late failure", async (repository) => {
			const session = await repository.create({ id: "rollback" });
			await rejectsWithCode(
				session.commit({
					writes: [
						{
							kind: "entry",
							entry: { id: "shared", parentId: null, type: "custom", customType: "note", data: 1 },
						},
						{ kind: "usage", row: { id: "shared", usage: ZERO_USAGE, adjustment: false } },
					],
				}),
				"already_exists",
			);
			strictEqual(await session.getEntry("shared"), undefined);
			deepStrictEqual(await session.scanUsage({}), []);
			const result = await session.commit({
				writes: [{ kind: "entry", entry: { id: "root", parentId: null, type: "custom", customType: "note" } }],
			});
			strictEqual(result.seqs.length, 1);
			strictEqual(result.firstSeq, result.seqs[0]);
			await session.close();
		}),

		createCase(factory, "transactions", "assigns one ordered sequence to all write kinds", async (repository) => {
			const session = await repository.create({ id: "sequence" });
			const result = await session.commit({
				writes: [
					{ kind: "entry", entry: { id: "root", parentId: null, type: "custom", customType: "note" } },
					{ kind: "register", op: "set", namespace: "fact.custom", key: "value", value: 1 },
					{ kind: "usage", row: { id: "usage", entryId: "root", usage: ZERO_USAGE, adjustment: false } },
				],
			});
			deepStrictEqual(result.seqs, [result.firstSeq, result.firstSeq + 1, result.firstSeq + 2]);
			strictEqual((await session.getEntry("root"))?.seq, result.seqs[0]);
			strictEqual((await session.getRegister("fact.custom", "value"))?.seq, result.seqs[1]);
			strictEqual((await session.scanUsage({}))[0]?.seq, result.seqs[2]);
			await session.close();
		}),

		createCase(factory, "registers and facts", "distinguishes JSON null from deletion", async (repository) => {
			const session = await repository.create({ id: "facts" });
			await session.setName("");
			await session.setCustomFact("nullable", null);
			strictEqual(await session.getName(), "");
			strictEqual(await session.getCustomFact("nullable"), null);
			const beforeDelete = (await session.getRegister("fact.custom", "nullable"))?.seq;
			await session.setCustomFact("nullable", undefined);
			strictEqual(await session.getCustomFact("nullable"), undefined);
			const absentDelete = await session.commit({
				writes: [{ kind: "register", op: "delete", namespace: "fact.custom", key: "nullable" }],
			});
			await session.setCustomFact("nullable", { restored: true });
			ok(absentDelete.firstSeq > (beforeDelete ?? 0));
			ok((await session.getRegister("fact.custom", "nullable"))!.seq > absentDelete.firstSeq);
			await session.close();
		}),

		createCase(factory, "registers and facts", "rejects labels for entries that do not exist", async (repository) => {
			const session = await repository.create({ id: "labels" });
			await rejectsWithCode(session.setLabel("missing", "checkpoint"), "not_found");
			deepStrictEqual(await session.listRegisters("fact.label"), []);
			await session.close();
		}),

		createCase(
			factory,
			"validation and immutability",
			"rejects invalid JSON without advancing durable state",
			async (repository) => {
				const session = await repository.create({ id: "invalid-json" });
				const cyclic: { self?: unknown } = {};
				cyclic.self = cyclic;
				for (const value of [
					{ missing: undefined },
					[undefined],
					{ bigint: 1n },
					{ nan: Number.NaN },
					new Map(),
					cyclic,
				]) {
					await rejectsWithCode(session.appendCustomEntry("invalid", value as JsonValue), "invalid_payload");
				}
				deepStrictEqual(await session.findEntries(), []);
				strictEqual(await session.getLeafId(), null);
				await session.close();
			},
		),

		createCase(
			factory,
			"validation and immutability",
			"copies caller input and every read result",
			async (repository) => {
				const session = await repository.create({ id: "immutable" });
				const data = { nested: { value: 1 } };
				const id = await session.appendCustomEntry("note", data);
				data.nested.value = 2;
				const first = await session.getEntry(id);
				if (first?.type !== "custom") throw new Error("Expected custom entry");
				(first.data as { nested: { value: number } }).nested.value = 3;
				const second = await session.getEntry(id);
				deepStrictEqual(second?.type === "custom" ? second.data : undefined, { nested: { value: 1 } });
				const register = await session.getRegister("lane.state", "main");
				if (register === undefined) throw new Error("Expected lane state");
				register.value.pendingNextRun.push("mutated");
				deepStrictEqual((await session.getRegister("lane.state", "main"))?.value.pendingNextRun, []);
				await session.close();
			},
		),

		createCase(
			factory,
			"tree queries",
			"keeps lane placement while sharing immutable ancestry",
			async (repository) => {
				const session = await repository.create({ id: "lanes" });
				const root = await session.appendMessage(userMessage("root"));
				await createThreadLane(session, root);
				const [mainLeaf, threadLeaf] = await Promise.all([
					session.appendCustomEntry("main.note", { lane: "main" }),
					session.view("thread").appendCustomEntry("thread.note"),
				]);
				strictEqual(await session.getLeafId(), mainLeaf);
				strictEqual(await session.view("thread").getLeafId(), threadLeaf);
				deepStrictEqual(await ids(session.findEntriesOnBranch({ order: "oldestFirst" })), [root, mainLeaf]);
				deepStrictEqual(await ids(session.view("thread").findEntriesOnBranch({ order: "oldestFirst" })), [
					root,
					threadLeaf,
				]);
				deepStrictEqual(await ids(session.findEntriesOnBranch({ customType: "main.note", stopAtId: root })), [
					mainLeaf,
				]);
				await session.close();
			},
		),

		createCase(
			factory,
			"tree queries",
			"supports filters cursors stops and custom entries without data",
			async (repository) => {
				const session = await repository.create({ id: "queries" });
				const root = await session.appendMessage(userMessage("root"));
				const empty = await session.appendCustomEntry("note");
				const second = await session.appendCustomEntry("note", 2);
				const tail = await session.appendMessage(userMessage("tail"));
				const emptyEntry = await session.getEntry(empty);
				strictEqual(emptyEntry?.type === "custom" && "data" in emptyEntry, false);
				deepStrictEqual(await ids(session.findEntries({ customType: "note", order: "asc", limit: 1 })), [empty]);
				deepStrictEqual(await ids(session.findEntries()), [tail, second, empty, root]);
				const secondEntry = await session.getEntry(second);
				if (secondEntry === undefined) throw new Error("Expected second entry");
				deepStrictEqual(await ids(session.findEntries({ order: "asc", cursor: { seq: secondEntry.seq } })), [tail]);
				deepStrictEqual(
					await ids(session.findEntriesOnBranch({ start: tail, stopAtId: empty, order: "oldestFirst" })),
					[empty, second, tail],
				);
				deepStrictEqual(await ids(session.findEntriesOnBranch({ start: tail, stopAtId: root, type: "message" })), [
					tail,
					root,
				]);
				await session.close();
			},
		),

		createCase(
			factory,
			"usage and turn commits",
			"projects ledger statistics independently from messages",
			async (repository) => {
				const session = await repository.create({ id: "stats" });
				await session.appendMessage(userMessage("question"));
				const answer = await session.appendMessage(assistantMessage("answer"));
				const usage: Usage = {
					input: 10,
					output: 5,
					cacheRead: 3,
					cacheWrite: 2,
					totalTokens: 20,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				};
				await session.commit({
					writes: [{ kind: "usage", row: { id: "usage", entryId: answer, usage, adjustment: false } }],
				});
				deepStrictEqual(await session.getStats(), { messageCount: 2, usage });
				await session.close();
			},
		),

		createCase(
			factory,
			"usage and turn commits",
			"requires an exact source-ordered tool suffix and usage row",
			async (repository) => {
				const session = await repository.create({ id: "turn" });
				await session.appendMessage(userMessage("question"));
				const assistant = await session.appendMessage(
					assistantMessage("tools", {
						toolCalls: [
							{ id: "call-1", name: "one" },
							{ id: "call-2", name: "two" },
						],
					}),
				);
				const first = await session.appendMessage(toolResultMessage("call-1", "one"));
				const leaf = await session.appendMessage(toolResultMessage("call-2", "two"));
				strictEqual(await session.getTurnCommit({ assistantEntryId: assistant, leafId: leaf }), undefined);
				await session.commit({
					writes: [
						{
							kind: "usage",
							row: { id: "turn-usage", entryId: assistant, usage: ZERO_USAGE, adjustment: false },
						},
					],
				});
				const turn = await session.getTurnCommit({ assistantEntryId: assistant, leafId: leaf });
				deepStrictEqual(
					turn?.toolResultEntries.map((entry) => entry.id),
					[first, leaf],
				);
				deepStrictEqual(
					turn?.usageRows.map((row) => row.id),
					["turn-usage"],
				);
				strictEqual(await session.getTurnCommit({ assistantEntryId: assistant, leafId: first }), undefined);
				await session.close();
			},
		),

		createCase(
			factory,
			"repository lifecycle",
			"lists closes and reopens one durable session",
			async (repository) => {
				const session = await repository.create({ id: "persisted" });
				const id = await session.appendMessage(userMessage("persisted"));
				const metadata = structuredClone(session.metadata);
				deepStrictEqual(
					(await repository.list()).map((item) => item.id),
					["persisted"],
				);
				await rejectsWithCode(repository.open(metadata), "storage");
				await session.close();
				const reopened = await repository.open(metadata);
				strictEqual((await reopened.getEntry(id))?.id, id);
				await reopened.close();
				await repository.delete(metadata);
				await rejectsWithCode(repository.open(metadata), "not_found");
				await repository.delete(metadata);
			},
		),

		createCase(factory, "repository lifecycle", "rejects incompatible storage metadata", async (repository) => {
			const session = await repository.create({ id: "version" });
			const metadata = { ...session.metadata, storageVersion: session.metadata.storageVersion + 1 };
			await session.close();
			await rejectsWithCode(repository.open(metadata), "storage_version");
		}),

		createCase(factory, "forks", "forks a branch without operation or usage state", async (repository) => {
			const source = await repository.create({ id: "source-branch" });
			const root = await source.appendMessage(userMessage("root"));
			const tail = await source.appendMessage(assistantMessage("tail"));
			await source.setName("Source");
			await source.setCustomFact("policy", { value: 1 });
			await source.commit({
				writes: [
					{ kind: "usage", row: { id: "source-usage", entryId: tail, usage: ZERO_USAGE, adjustment: false } },
					{
						kind: "register",
						op: "set",
						namespace: "pending.entry",
						key: "pending",
						value: { type: "custom", customType: "note", payload: 1 },
					},
				],
			});
			const fork = await repository.fork(source.metadata, { id: "branch", entryId: tail, position: "before" });
			deepStrictEqual(await ids(fork.findEntries({ order: "asc" })), [root]);
			strictEqual(await fork.getLeafId(), root);
			strictEqual(await fork.getName(), "Source");
			deepStrictEqual(await fork.getCustomFact("policy"), { value: 1 });
			deepStrictEqual(await fork.scanUsage({}), []);
			deepStrictEqual(await fork.listRegisters("pending.entry"), []);
			strictEqual((await fork.getRegister("lane.state", "main"))?.value.currentOperationId, null);
			strictEqual(fork.metadata.parentSessionId, source.metadata.id);
			await source.close();
			await fork.close();
		}),

		createCase(factory, "forks", "forks the full tree with every lane placement", async (repository) => {
			const source = await repository.create({ id: "source-tree" });
			const root = await source.appendMessage(userMessage("root"));
			await createThreadLane(source, root);
			const mainLeaf = await source.appendMessage(userMessage("main"));
			const threadLeaf = await source.view("thread").appendMessage(userMessage("thread"));
			const fork = await repository.fork(source.metadata, { scope: "tree", id: "tree" });
			deepStrictEqual(await ids(fork.findEntries({ order: "asc" })), [root, mainLeaf, threadLeaf]);
			strictEqual(await fork.getLeafId(), mainLeaf);
			strictEqual(await fork.view("thread").getLeafId(), threadLeaf);
			strictEqual((await fork.getStats()).messageCount, 3);
			await source.close();
			await fork.close();
		}),

		createCase(factory, "concurrency", "linearizes concurrent commits without sequence reuse", async (repository) => {
			const session = await repository.create({ id: "concurrent" });
			const results = await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					session.commit({
						writes: [
							{
								kind: "register",
								op: "set",
								namespace: "fact.custom",
								key: `key-${index}`,
								value: index,
							},
						],
					}),
				),
			);
			const sequences = results.flatMap((result) => result.seqs);
			strictEqual(new Set(sequences).size, sequences.length);
			deepStrictEqual(
				sequences,
				[...sequences].sort((left, right) => left - right),
			);
			const registers = await session.listRegisters("fact.custom", "key-");
			strictEqual(registers.length, 8);
			notStrictEqual(registers[0]?.seq, registers.at(-1)?.seq);
			await session.close();
		}),
	];
}
