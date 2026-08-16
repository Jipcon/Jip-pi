import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	buildContextMessages,
	HARNESS_V4_STORAGE_VERSION,
	InMemorySessionRepo,
	InMemoryStorage,
	SessionCodec,
	type SessionError,
	UuidV7Generator,
} from "../../src/harness-v4.ts";
import {
	createSessionBackendConformance,
	InstrumentedStorage,
	type SessionBackendFixture,
} from "../../src/harness-v4-testing.ts";
import type { AgentMessage } from "../../src/types.ts";

const ZERO_USAGE = {
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

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 1,
	};
}

const conformance = createSessionBackendConformance(() =>
	Promise.resolve<SessionBackendFixture>({
		repository: new InMemorySessionRepo(),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	}),
);

describe("Harness v4 in-memory backend conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});

describe("Harness v4 Slice 2 focused behavior", () => {
	it("mints UUIDv7 follower ids with the leader timestamp", () => {
		const generator = new UuidV7Generator(() => 1_700_000_000_000);
		const leader = generator.next();
		const follower = generator.next(UuidV7Generator.timestamp(leader));

		expect(leader).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(UuidV7Generator.timestamp(follower)).toBe(UuidV7Generator.timestamp(leader));
		expect(follower).not.toBe(leader);
	});

	it("mints direct append ids at reservation time, not from caller message timestamps", async () => {
		const now = 1_700_000_000_000;
		const session = await new InMemorySessionRepo({ now: () => now }).create({ id: "append-id" });
		const id = await session.appendMessage(userMessage("old caller timestamp"));

		expect(UuidV7Generator.timestamp(id)).toBe(now);
	});

	it("projects only valid provider context after the newest compaction", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "context" });
		const root = await session.appendMessage(userMessage("old"));
		await session.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: session.idGenerator.next(),
						parentId: root,
						type: "compaction",
						summary: "summary",
						retainedTail: [userMessage("kept")],
						tokensBefore: 100,
						fromHook: false,
					},
				},
			],
		});
		const compaction = (await session.findEntry({ type: "compaction" }))?.id;
		if (!compaction) throw new Error("Expected compaction");
		await session.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: "error",
						parentId: compaction,
						type: "message",
						message: assistantMessage("drop", "error"),
					},
				},
				{
					kind: "entry",
					entry: {
						id: "adaptive",
						parentId: "error",
						type: "custom",
						customType: "adaptive.run_basis",
						data: { schemaVersion: 1 },
					},
				},
				{
					kind: "entry",
					entry: {
						id: "answer",
						parentId: "adaptive",
						type: "message",
						message: assistantMessage("answer"),
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "answer" },
			],
		});
		const entries = await session.findEntriesOnBranch({
			start: "answer",
			stopAtType: "compaction",
			order: "oldestFirst",
		});
		const messages = await buildContextMessages(entries);

		expect(messages).toEqual([
			expect.objectContaining({ role: "compactionSummary", summary: "summary" }),
			userMessage("kept"),
			assistantMessage("answer"),
		]);
	});

	it("validates registered custom messages and rejects unknown roles", async () => {
		const codec = new SessionCodec({
			customMessageSchemas: {
				notice: Type.Object({
					role: Type.Literal("notice"),
					text: Type.String(),
					timestamp: Type.Number(),
				}),
			},
		});
		const repo = new InMemorySessionRepo({ codec });
		const session = await repo.create({ id: "custom-message" });

		await expect(
			session.appendMessage({ role: "unknown", text: "bad", timestamp: 1 } as unknown as AgentMessage),
		).rejects.toMatchObject({ code: "invalid_payload" } satisfies Partial<SessionError>);
		await expect(
			session.appendMessage({ role: "notice", text: "ok", timestamp: 1 } as unknown as AgentMessage),
		).resolves.toBeTypeOf("string");
	});

	it("rejects malformed built-in message payloads before commit", async () => {
		const session = await new InMemorySessionRepo().create({ id: "invalid-message" });

		await expect(
			session.appendMessage({
				role: "user",
				content: [{ type: "text" }],
				timestamp: 1,
			} as unknown as AgentMessage),
		).rejects.toMatchObject({ code: "invalid_payload" } satisfies Partial<SessionError>);
		expect(await session.findEntries()).toEqual([]);
	});

	it("seals new storage admission while close drains accepted work", async () => {
		const session = await new InMemorySessionRepo().create({ id: "close" });
		const accepted = session.appendCustomEntry("note", { accepted: true });
		const closing = session.close();

		await expect(accepted).resolves.toBeTypeOf("string");
		await closing;
		await expect(session.getStats()).rejects.toMatchObject({ code: "closed" } satisfies Partial<SessionError>);
		await expect(session.appendCustomEntry("note")).rejects.toMatchObject({
			code: "closed",
		} satisfies Partial<SessionError>);
		await expect(session.close()).resolves.toBeUndefined();
	});

	it("records exact transaction writes only in the testing decorator", async () => {
		const storage = new InMemoryStorage(
			{
				id: "instrumented",
				createdAt: 1,
				storageVersion: HARNESS_V4_STORAGE_VERSION,
			},
			{ codec: new SessionCodec() },
		);
		const instrumented = new InstrumentedStorage(storage);
		const tx = {
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "name" }] as const,
		};

		await instrumented.commit({ writes: [...tx.writes] });
		const commits = instrumented.commits();
		expect(commits).toHaveLength(1);
		expect(commits[0]?.transaction.writes).toEqual(tx.writes);
		(commits[0]?.transaction.writes[0] as { value: string }).value = "mutated";
		expect((await storage.getRegister("fact.name", ""))?.value).toBe("name");
	});
});
