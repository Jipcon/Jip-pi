import { describe, it } from "vitest";
import { createSessionBackendConformance, type SessionBackendFixture } from "../../src/harness-v4-testing.ts";
import { jsonlRepoFixture } from "./fixtures/v4-jsonl-backends.ts";

const conformance = createSessionBackendConformance(() =>
	Promise.resolve<SessionBackendFixture>({
		repository: jsonlRepoFixture(),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	}),
);

describe("Harness v4 JSONL backend conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}
});
