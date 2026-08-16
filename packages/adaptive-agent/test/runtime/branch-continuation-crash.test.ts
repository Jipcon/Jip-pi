import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySessionRepo, JsonlSessionRepo } from "../../../agent/src/harness-v4.ts";
import type { V4SessionRepo } from "../../../agent/test/harness/fixtures/v4-jsonl-backends.ts";
import {
	type ContinuationCandidate,
	type ContinuationCheckpoint,
	ContinuationGroupFault,
	ContinuationJournalFault,
	exactContinuationGroupId,
	JsonlContinuationJournal,
	MemoryContinuationJournal,
} from "../../src/index.ts";
import type { ContinuationJournal } from "../../src/runtime/continuation-journal.ts";
import { ADAPTIVE_RUN_BASIS_CUSTOM_TYPE } from "../../src/runtime/harness-v4-contract.ts";
import { createBranchContinuation, createStage6Source, type Stage6Source } from "./stage6-fixtures.ts";

const VARIANTS = [{ id: "a" }, { id: "b" }];

/** Total journal appends of one complete two-sibling fork. */
const TOTAL_APPENDS = 1 + 2 * 4 + 1; // group_planned + 4 per child + group_ready

function crashJournal(inner: ContinuationJournal, crashAfterAppends: number): ContinuationJournal {
	let appends = 0;
	return {
		append: async (event) => {
			await inner.append(event);
			appends++;
			if (appends >= crashAfterAppends) {
				throw new ContinuationJournalFault(`simulated crash after ${appends} journal appends`);
			}
		},
		events: (groupId) => inner.events(groupId),
		close: () => inner.close(),
	};
}

interface Backend {
	name: string;
	createSessionRepo(): V4SessionRepo;
	createJournal(): ContinuationJournal;
}

const cleanupDirectories = new Set<string>();

afterEach(() => {
	for (const directory of cleanupDirectories) {
		rmSync(directory, { recursive: true, force: true });
	}
	cleanupDirectories.clear();
});

const BACKENDS: Backend[] = [
	{
		name: "memory",
		createSessionRepo: () => new InMemorySessionRepo({ now: () => 3_400_000_000_000 }),
		createJournal: () => new MemoryContinuationJournal(),
	},
	{
		name: "jsonl",
		createSessionRepo: () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-stage6-crash-sessions-"));
			cleanupDirectories.add(directory);
			return new JsonlSessionRepo({ directory, now: () => 3_400_000_000_000 });
		},
		createJournal: () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-stage6-crash-journal-"));
			cleanupDirectories.add(directory);
			return new JsonlContinuationJournal({ filePath: join(directory, "journal.jsonl") });
		},
	},
];

describe.each(BACKENDS)("BranchContinuation crash matrix ($name backends)", (backend) => {
	async function createStack(): Promise<{ source: Stage6Source; journal: ContinuationJournal }> {
		const source = await createStage6Source({ repo: backend.createSessionRepo(), id: `source-${backend.name}` });
		return { source, journal: backend.createJournal() };
	}

	function branchFor(source: Stage6Source, journal: ContinuationJournal) {
		return createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
			},
		});
	}

	async function assertNoTwins(
		source: Stage6Source,
		journal: ContinuationJournal,
		checkpoint: ContinuationCheckpoint,
		candidates: ContinuationCandidate[],
	): Promise<void> {
		expect(await source.repo.list()).toHaveLength(3);
		for (const candidate of candidates) {
			// Reattach never admitted a second Run: each child keeps exactly
			// the copied source basis entry plus its own basis entry.
			const basisEntries = await candidate.session.findEntries({
				type: "custom",
				customType: ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
			});
			expect(basisEntries).toHaveLength(2);
		}
		// The journal recorded every event exactly once.
		const groupId = exactContinuationGroupId(checkpoint, VARIANTS);
		const events = await journal.events(groupId);
		expect(new Set(events.map((event) => JSON.stringify(event))).size).toBe(events.length);
	}

	for (let crashAfter = 1; crashAfter <= TOTAL_APPENDS; crashAfter++) {
		it(`recovers after a crash at journal append ${crashAfter} without twin children`, async () => {
			const { source, journal } = await createStack();
			const checkpoint = structuredClone(source.checkpoint);
			const crashed = branchFor(source, crashJournal(journal, crashAfter));
			await expect(crashed.forkExact(checkpoint, structuredClone(VARIANTS))).rejects.toBeInstanceOf(
				ContinuationJournalFault,
			);
			expect(source.faux.state.callCount).toBe(1);

			// Recovery: same stores, fresh coordination instances.
			const recovered = branchFor(source, journal).forkExact(checkpoint, structuredClone(VARIANTS));
			const result = await recovered;
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toHaveLength(2);
			await assertNoTwins(source, journal, checkpoint, result.value);
			expect(source.faux.state.callCount).toBe(1);

			// Every sibling can now dispatch exactly one first request.
			source.faux.setResponses([fauxAssistantMessage("c0"), fauxAssistantMessage("c1")]);
			for (const candidate of result.value) {
				const advanced = await candidate.executor.execute({ kind: "advance" });
				expect(advanced).toMatchObject({ ok: true, value: { kind: "turn" } });
			}
			expect(source.faux.state.callCount).toBe(3);
			await Promise.all(result.value.map((candidate) => candidate.close()));
			await source.harness.close();
		});
	}

	it("faults and reattaches when a mid-group child harness fault aborts the first attempt", async () => {
		const { source, journal } = await createStack();
		const checkpoint = structuredClone(source.checkpoint);
		const failing = createBranchContinuation({
			journal,
			workspacePort: source.workspacePort,
			sessionRepo: source.repo,
			childHarness: {
				models: source.models,
				model: source.model,
				tools: source.tools,
				registry: source.fixtures.registry,
				afterCreate: (harness, _session, variant) => {
					void harness;
					if (variant.id === "b") throw new ContinuationGroupFault("simulated child fault");
				},
			},
		});
		await expect(failing.forkExact(checkpoint, structuredClone(VARIANTS))).rejects.toBeInstanceOf(
			ContinuationGroupFault,
		);
		expect(source.faux.state.callCount).toBe(1);

		const result = await branchFor(source, journal).forkExact(checkpoint, structuredClone(VARIANTS));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toHaveLength(2);
		await assertNoTwins(source, journal, checkpoint, result.value);
		await Promise.all(result.value.map((candidate) => candidate.close()));
		await source.harness.close();
	});
});
