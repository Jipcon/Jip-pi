import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ContinuationJournal,
	type ContinuationJournalEvent,
	ContinuationJournalFault,
	continuationChildId,
	continuationGroupId,
	JsonlContinuationJournal,
	MemoryContinuationJournal,
} from "../../src/runtime/continuation-journal.ts";

const GROUP = {
	sourceSessionId: "session",
	sourceLane: "main",
	cursor: { operationId: "op", assistantEntryId: "assistant", leafId: "leaf" },
	workspaceSnapshotId: "a".repeat(64),
	contextFingerprint: "b".repeat(64),
	requestFingerprint: "c".repeat(64),
	policyStateFingerprint: "d".repeat(64),
	variants: [{ id: "a" }, { id: "b", seed: 2 }],
};

function plannedEvent(groupId: string): ContinuationJournalEvent {
	return {
		type: "group_planned",
		groupId,
		source: {
			sessionId: GROUP.sourceSessionId,
			lane: GROUP.sourceLane,
			cursor: GROUP.cursor,
			workspaceSnapshotId: GROUP.workspaceSnapshotId,
			contextFingerprint: GROUP.contextFingerprint,
			requestFingerprint: GROUP.requestFingerprint,
			policyStateFingerprint: GROUP.policyStateFingerprint,
		},
		variants: GROUP.variants.map((variant) => ({ ...variant })),
	};
}

function forkedEvent(
	groupId: string,
	childId: string,
	sampleIndex: number,
	sessionId: string,
): ContinuationJournalEvent {
	return { type: "child_session_forked", groupId, childId, sampleIndex, sessionId, lane: "main" };
}

describe.each([
	{ name: "memory", create: (): ContinuationJournal => new MemoryContinuationJournal() },
	{
		name: "jsonl",
		create: (): ContinuationJournal => {
			const directory = mkdtempSync(join(tmpdir(), "pi-continuation-journal-"));
			cleanupDirectories.add(directory);
			return new JsonlContinuationJournal({ filePath: join(directory, "journal.jsonl") });
		},
	},
])("ContinuationJournal ($name backend)", ({ create }) => {
	it("appends and reads a complete group in order", async () => {
		const journal = create();
		const groupId = continuationGroupId(GROUP);
		const childId = continuationChildId(groupId, 0);
		await journal.append(plannedEvent(groupId));
		await journal.append(forkedEvent(groupId, childId, 0, "child-session"));
		await journal.append({ type: "child_ready", groupId, childId, sampleIndex: 0 });
		await journal.append({ type: "group_ready", groupId });
		expect(await journal.events(groupId)).toEqual([
			plannedEvent(groupId),
			forkedEvent(groupId, childId, 0, "child-session"),
			{ type: "child_ready", groupId, childId, sampleIndex: 0 },
			{ type: "group_ready", groupId },
		]);
		await journal.close();
	});

	it("duplicates the same event idempotently and faults on conflicting content", async () => {
		const journal = create();
		const groupId = continuationGroupId(GROUP);
		await journal.append(plannedEvent(groupId));
		await journal.append(plannedEvent(groupId));
		expect(await journal.events(groupId)).toEqual([plannedEvent(groupId)]);
		const conflicting: ContinuationJournalEvent = {
			type: "group_planned",
			groupId,
			source: {
				sessionId: GROUP.sourceSessionId,
				lane: GROUP.sourceLane,
				cursor: GROUP.cursor,
				workspaceSnapshotId: GROUP.workspaceSnapshotId,
				contextFingerprint: "e".repeat(64),
				requestFingerprint: GROUP.requestFingerprint,
				policyStateFingerprint: GROUP.policyStateFingerprint,
			},
			variants: GROUP.variants.map((variant) => ({ ...variant })),
		};
		await expect(journal.append(conflicting)).rejects.toBeInstanceOf(ContinuationJournalFault);
		await journal.close();
	});

	it("derives stable group and child identities from the same inputs", () => {
		const groupId = continuationGroupId(GROUP);
		expect(continuationGroupId(structuredClone(GROUP))).toBe(groupId);
		expect(continuationChildId(groupId, 0)).toBe(continuationChildId(groupId, 0));
		expect(continuationChildId(groupId, 0)).not.toBe(continuationChildId(groupId, 1));
		expect(continuationGroupId({ ...GROUP, variants: [{ id: "a" }] })).not.toBe(groupId);
	});

	it("does not mix groups", async () => {
		const journal = create();
		const groupId = continuationGroupId(GROUP);
		const otherGroupId = continuationGroupId({ ...GROUP, requestFingerprint: "e".repeat(64) });
		await journal.append(plannedEvent(groupId));
		await journal.append(plannedEvent(otherGroupId));
		expect(await journal.events(groupId)).toHaveLength(1);
		expect((await journal.events(otherGroupId))[0]?.groupId).toBe(otherGroupId);
		await journal.close();
	});
});

const cleanupDirectories = new Set<string>();

afterEach(() => {
	for (const directory of cleanupDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

describe("JsonlContinuationJournal process-crash boundaries", () => {
	function createBackend(): { directory: string; filePath: string; open: () => JsonlContinuationJournal } {
		const directory = mkdtempSync(join(tmpdir(), "pi-continuation-journal-crash-"));
		cleanupDirectories.add(directory);
		const filePath = join(directory, "journal.jsonl");
		return { directory, filePath, open: () => new JsonlContinuationJournal({ filePath }) };
	}

	it("recovers a complete journal after close and reopen", async () => {
		const backend = createBackend();
		const journal = backend.open();
		const groupId = continuationGroupId(GROUP);
		await journal.append(plannedEvent(groupId));
		await journal.append({ type: "group_ready", groupId });
		await journal.close();

		const reopened = backend.open();
		expect(await reopened.events(groupId)).toEqual([plannedEvent(groupId), { type: "group_ready", groupId }]);
		await reopened.close();
	});

	it("drops only a torn tail, never a complete line", async () => {
		const backend = createBackend();
		const journal = backend.open();
		const groupId = continuationGroupId(GROUP);
		await journal.append(plannedEvent(groupId));
		await journal.close();

		// Simulate a process crash mid-write of the next line.
		writeFileSync(backend.filePath, `${JSON.stringify(forkedEvent(groupId, "child", 0, "session"))}\n`, {
			flag: "a",
		});
		writeFileSync(backend.filePath, `{"type":"group_ready","groupId":"${groupId}","t`, { flag: "a" });

		const reopened = backend.open();
		const events = await reopened.events(groupId);
		expect(events).toHaveLength(2);
		expect(events[1]).toEqual(forkedEvent(groupId, "child", 0, "session"));
		await reopened.close();
	});

	it("faults on a corrupt complete line before a later complete line", async () => {
		const backend = createBackend();
		const journal = backend.open();
		const groupId = continuationGroupId(GROUP);
		await journal.append(plannedEvent(groupId));
		await journal.close();
		writeFileSync(backend.filePath, `{not-json}\n${JSON.stringify(forkedEvent(groupId, "child", 0, "session"))}\n`, {
			flag: "a",
		});
		const reopened = backend.open();
		await expect(reopened.events(groupId)).rejects.toBeInstanceOf(ContinuationJournalFault);
		await reopened.close();
	});

	it("treats a missing file as an empty journal", async () => {
		const backend = createBackend();
		const journal = backend.open();
		expect(await journal.events("missing")).toEqual([]);
		await journal.close();
	});

	it("faults appends after close", async () => {
		const backend = createBackend();
		const journal = backend.open();
		await journal.close();
		await expect(journal.append(plannedEvent(continuationGroupId(GROUP)))).rejects.toBeInstanceOf(
			ContinuationJournalFault,
		);
	});
});
