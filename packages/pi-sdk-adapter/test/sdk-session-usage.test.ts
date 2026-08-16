import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readSessionUsage } from "../src/sdk-session-usage.ts";

const CONTEXT_WINDOW = 200_000;

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-sdk-session-usage-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSession(name: string, entries: unknown[]): Promise<string> {
	const file = join(dir, `${name}.jsonl`);
	await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	return file;
}

function sessionHeader(): Record<string, unknown> {
	return {
		type: "session",
		id: "s1",
		timestamp: "2026-08-16T00:00:00.000Z",
		cwd: "/workspace",
	};
}

function userEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-16T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantEntry(id: string, parentId: string, usage: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-16T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
		},
	};
}

const USAGE_A = {
	input: 1000,
	output: 200,
	cacheRead: 300,
	cacheWrite: 50,
	totalTokens: 1550,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.01, cacheWrite: 0.005, total: 0.05 },
};

describe("readSessionUsage", () => {
	test("aggregates tokens and cost and estimates context usage", async () => {
		const file = await writeSession("basic", [
			sessionHeader(),
			userEntry("m1", null, "hello"),
			assistantEntry("m2", "m1", USAGE_A),
		]);

		const usage = await readSessionUsage(file, {
			sessionId: "s1",
			resolveContextWindow: () => CONTEXT_WINDOW,
		});

		expect(usage.sessionId).toBe("s1");
		expect(usage.tokens).toEqual({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, total: 1550 });
		expect(usage.cost).toBeCloseTo(0.05, 10);
		// Last entry is the assistant: estimate equals its usage tokens.
		expect(usage.contextUsage).toEqual({
			tokens: 1550,
			contextWindow: CONTEXT_WINDOW,
			percent: (1550 / CONTEXT_WINDOW) * 100,
		});
	});

	test("counts tool result and branch summary usage and estimates trailing messages", async () => {
		const file = await writeSession("trailing", [
			sessionHeader(),
			userEntry("m1", null, "hello"),
			assistantEntry("m2", "m1", {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
			}),
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: "2026-08-16T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "output" }],
					isError: false,
					usage: {
						input: 20,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 30,
						cost: { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
				},
			},
			{
				type: "branch_summary",
				id: "b1",
				parentId: "m3",
				timestamp: "2026-08-16T00:00:04.000Z",
				summary: "summarized",
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
				},
			},
		]);

		const usage = await readSessionUsage(file, {
			sessionId: "s1",
			resolveContextWindow: () => CONTEXT_WINDOW,
		});

		expect(usage.tokens).toEqual({ input: 125, output: 65, cacheRead: 0, cacheWrite: 0, total: 190 });
		expect(usage.cost).toBeCloseTo(0.013, 10);
		// Messages after the last assistant usage are estimated on top.
		expect(usage.contextUsage?.tokens).toBeGreaterThan(150);
		expect(usage.contextUsage?.contextWindow).toBe(CONTEXT_WINDOW);
		expect(usage.contextUsage?.percent).toBe(((usage.contextUsage?.tokens ?? 0) / CONTEXT_WINDOW) * 100);
	});

	test("reports unknown context usage when a compaction ends the session", async () => {
		const file = await writeSession("post-compaction", [
			sessionHeader(),
			userEntry("m1", null, "hello"),
			assistantEntry("m2", "m1", USAGE_A),
			{
				type: "compaction",
				id: "c1",
				parentId: "m2",
				timestamp: "2026-08-16T00:00:05.000Z",
				summary: "compacted",
				firstKeptEntryId: "m1",
				tokensBefore: 1550,
			},
		]);

		const usage = await readSessionUsage(file, {
			sessionId: "s1",
			resolveContextWindow: () => CONTEXT_WINDOW,
		});

		expect(usage.tokens.total).toBe(1550);
		expect(usage.contextUsage).toEqual({ tokens: null, contextWindow: CONTEXT_WINDOW, percent: null });
	});

	test("omits context usage when the context window is unknown", async () => {
		const file = await writeSession("no-window", [
			sessionHeader(),
			userEntry("m1", null, "hello"),
			assistantEntry("m2", "m1", USAGE_A),
		]);

		const usage = await readSessionUsage(file, {
			sessionId: "s1",
			resolveContextWindow: () => undefined,
		});

		expect(usage.tokens.total).toBe(1550);
		expect(usage.contextUsage).toBeUndefined();
	});

	test("tolerates legacy usage without cost and cache fields", async () => {
		const file = await writeSession("legacy", [
			sessionHeader(),
			userEntry("m1", null, "hello"),
			assistantEntry("m2", "m1", { input: 100, output: 50 }),
		]);

		const usage = await readSessionUsage(file, {
			sessionId: "s1",
			resolveContextWindow: () => CONTEXT_WINDOW,
		});

		expect(usage.tokens).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 });
		expect(usage.cost).toBe(0);
		expect(usage.contextUsage?.tokens).toBe(150);
	});
});
