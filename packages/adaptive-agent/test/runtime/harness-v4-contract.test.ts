import { describe, expect, expectTypeOf, it } from "vitest";
import type { AdaptiveRunIntent as CoreAdaptiveRunIntent } from "../../../agent/src/harness-v4.ts";
import {
	ADAPTIVE_RUN_BASIS_CUSTOM_TYPE,
	ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE,
	type AdaptiveRunBasisData,
	type AdaptiveRunIntent,
	type AdaptiveToolBatchData,
	type CandidatePolicyState,
	type DurableToolDecision,
	type LeafTurnJsonValue,
	type ProjectionBasis,
} from "../../src/index.ts";

function requireJsonValue<_Value extends LeafTurnJsonValue>(): void {}

describe("Adaptive Harness v4 contract", () => {
	it("uses stable custom-entry discriminants", () => {
		expect(ADAPTIVE_RUN_BASIS_CUSTOM_TYPE).toBe("adaptive.run_basis");
		expect(ADAPTIVE_TOOL_BATCH_CUSTOM_TYPE).toBe("adaptive.tool_batch");
	});

	it("keeps the Adaptive run intent compatible with the core reference shape", () => {
		expectTypeOf<AdaptiveRunIntent>().toMatchTypeOf<CoreAdaptiveRunIntent>();
	});

	it("versions both durable Adaptive payloads", () => {
		expectTypeOf<AdaptiveRunBasisData["schemaVersion"]>().toEqualTypeOf<1>();
		expectTypeOf<AdaptiveToolBatchData["schemaVersion"]>().toEqualTypeOf<1>();
		requireJsonValue<AdaptiveToolBatchData>();
		requireJsonValue<AdaptiveRunIntent>();
		requireJsonValue<ProjectionBasis["cursor"]>();
		requireJsonValue<DurableToolDecision>();
	});

	it("pins the candidate snapshot to the concrete bounded state type", () => {
		expectTypeOf<AdaptiveRunBasisData["inheritedPolicyState"]["snapshot"]>().toEqualTypeOf<CandidatePolicyState>();
	});
});
