import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type AdaptiveRunIntent,
	HARNESS_V4_STORAGE_VERSION,
	type HarnessEvent,
	type Operation,
	type Register,
	type RunState,
	type SessionTree,
	type ToolBatch,
	type UsageScan,
	type Write,
} from "../../src/harness-v4.ts";

describe("Harness v4 Slice 1 contract", () => {
	it("freezes the initial storage schema version", () => {
		expect(HARNESS_V4_STORAGE_VERSION).toBe(1);
		expectTypeOf(HARNESS_V4_STORAGE_VERSION).toEqualTypeOf<1>();
	});

	it("types adaptive run acceptance as a basis-entry reference", () => {
		const intent = {
			kind: "run",
			promptEntryIds: [],
			adaptive: { basisEntryId: "basis-entry" },
		} satisfies AdaptiveRunIntent;
		const operation = {
			operationId: "operation",
			lane: "main",
			sourceLeafId: "source",
			startedAt: 1,
			intent,
		} satisfies Operation;

		expect(operation.intent.adaptive.basisEntryId).toBe("basis-entry");
	});

	it("keeps register writes namespace-typed", () => {
		const write = {
			kind: "register",
			op: "set",
			namespace: "lane.state",
			key: "main",
			value: { currentOperationId: null, pendingNextRun: [] },
		} satisfies Write;

		expectTypeOf(write.value).toMatchTypeOf<Register<"lane.state">["value"]>();
		expect(write.namespace).toBe("lane.state");
	});

	it("distinguishes standard and adaptive tool argument authority", () => {
		const batch = {
			assistantEntryId: "assistant",
			configuration: {
				model: { provider: "provider", modelId: "model" },
				thinkingLevel: "off",
				activeToolNames: ["read"],
			},
			turnId: "turn",
			argumentAuthority: { kind: "adaptive_tool_batch_entry", entryId: "tool-batch" },
			calls: [{ status: "planned", sourceIndex: 0, resultEntryId: "result" }],
		} satisfies ToolBatch;

		expect(batch.argumentAuthority.kind).toBe("adaptive_tool_batch_entry");
	});

	it("exposes exact post-turn usage and event query types", () => {
		expectTypeOf<UsageScan>().toHaveProperty("entryIds");
		expectTypeOf<SessionTree["getTurnCommit"]>().toBeFunction();
		expectTypeOf<Extract<HarnessEvent, { type: "turn_end" }>>().toHaveProperty("lane");
		expectTypeOf<RunState["phase"]>().not.toBeNever();
	});
});
