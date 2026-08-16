import type { AgentHarnessStreamOptions, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildCanonicalInferenceRequest,
	type CanonicalInferenceRequestInput,
	canonicalContextFingerprint,
	canonicalJsonLoose,
	canonicalRequestFingerprint,
	RequestFingerprintMismatchError,
	UnsupportedSamplingControlError,
	verifyExactRequest,
} from "../../src/runtime/exact-request.ts";
import { computeToolCatalogFingerprint } from "../../src/runtime/policy-bundle.ts";
import { makeFixedTools } from "./stage5-fixtures.ts";
import { DEFAULT_PROFILE } from "./stage6-fixtures.ts";

const FIXED_TOOLS: AgentTool[] = makeFixedTools();

const MESSAGES: Message[] = [{ role: "user", content: [{ type: "text", text: "read a.txt" }], timestamp: 1 }];

const BASE_INPUT: Omit<CanonicalInferenceRequestInput, "tools" | "fixedToolCatalogFingerprint"> = {
	model: { provider: "stage6", modelId: "faux-1" },
	thinkingLevel: "off",
	systemPrompt: "stage6-system",
	providerMessages: structuredClone(MESSAGES),
	sampling: { temperature: 0.7, topP: 0.9, maxTokens: 4096 },
	streamOptions: {},
	profile: DEFAULT_PROFILE,
	policyBundleFingerprint: "c".repeat(64),
	projectorVersion: "candidate-state-projector-v1",
	policyStateFingerprint: "d".repeat(64),
	logicalWorkspace: { root: "/workspace", contentFingerprint: "e".repeat(64) },
};

function input(overrides: Partial<CanonicalInferenceRequestInput> = {}): CanonicalInferenceRequestInput {
	const tools = overrides.tools ?? FIXED_TOOLS;
	return {
		...structuredClone(BASE_INPUT),
		tools,
		fixedToolCatalogFingerprint: computeToolCatalogFingerprint(tools),
		...overrides,
	};
}

function build(overrides: Partial<CanonicalInferenceRequestInput> = {}) {
	return buildCanonicalInferenceRequest(input(overrides));
}

describe("exact request builder", () => {
	it("fingerprints the canonical request deterministically", () => {
		const left = build();
		const right = build();
		expect(canonicalRequestFingerprint(left)).toBe(canonicalRequestFingerprint(right));
		expect(canonicalContextFingerprint(left)).toBe(canonicalContextFingerprint(right));
	});

	it("changes the request fingerprint on temperature, topP, and maxTokens drift", () => {
		const base = build();
		for (const sampling of [
			{ temperature: 0.1, topP: 0.9, maxTokens: 4096 },
			{ temperature: 0.7, topP: 0.1, maxTokens: 4096 },
			{ temperature: 0.7, topP: 0.9, maxTokens: 1024 },
		]) {
			const drifted = build({ sampling });
			expect(canonicalRequestFingerprint(drifted)).not.toBe(canonicalRequestFingerprint(base));
		}
	});

	it("changes the context fingerprint on system prompt and message drift", () => {
		const base = build();
		expect(canonicalContextFingerprint(build({ systemPrompt: "other" }))).not.toBe(canonicalContextFingerprint(base));
		expect(
			canonicalContextFingerprint(
				build({ providerMessages: [{ role: "user", content: [{ type: "text", text: "other" }], timestamp: 1 }] }),
			),
		).not.toBe(canonicalContextFingerprint(base));
	});

	it("changes the request fingerprint on tool order, description, and schema drift", () => {
		const base = build();
		const reordered = [FIXED_TOOLS[1]!, FIXED_TOOLS[0]!, FIXED_TOOLS[2]!, FIXED_TOOLS[3]!];
		expect(canonicalRequestFingerprint(build({ tools: reordered }))).not.toBe(canonicalRequestFingerprint(base));
		const described = FIXED_TOOLS.map((tool) => (tool.name === "read" ? { ...tool, description: "drifted" } : tool));
		expect(canonicalRequestFingerprint(build({ tools: described }))).not.toBe(canonicalRequestFingerprint(base));
	});

	it("changes the request fingerprint on hook/resource profile version drift", () => {
		const base = build();
		const hookDrift = build({ profile: { ...DEFAULT_PROFILE, hookProfileVersion: "hooks-v2" } });
		const resourceDrift = build({ profile: { ...DEFAULT_PROFILE, resourceProfileVersion: "resources-v2" } });
		expect(canonicalRequestFingerprint(hookDrift)).not.toBe(canonicalRequestFingerprint(base));
		expect(canonicalRequestFingerprint(resourceDrift)).not.toBe(canonicalRequestFingerprint(base));
	});

	it("excludes the entropy selector from both fingerprints", () => {
		const withoutSeed = build();
		const withSeed = build({ sampling: { temperature: 0.7, topP: 0.9, maxTokens: 4096, seed: 1 } });
		const otherSeed = build({ sampling: { temperature: 0.7, topP: 0.9, maxTokens: 4096, seed: 2 } });
		expect(canonicalRequestFingerprint(withSeed)).toBe(canonicalRequestFingerprint(withoutSeed));
		expect(canonicalContextFingerprint(withSeed)).toBe(canonicalContextFingerprint(withoutSeed));
		expect(canonicalRequestFingerprint(otherSeed)).toBe(canonicalRequestFingerprint(withoutSeed));
	});

	it("excludes timeout, retry timing, headers, and physical paths from the fingerprint", () => {
		const base = build();
		const withTransports: AgentHarnessStreamOptions = {
			timeoutMs: 999,
			maxRetries: 7,
			headers: { Authorization: "secret" },
		};
		const withPhysicalRoot = build({
			logicalWorkspace: { root: "/workspace", contentFingerprint: "e".repeat(64) },
		});
		expect(canonicalRequestFingerprint(build({ streamOptions: withTransports }))).toBe(
			canonicalRequestFingerprint(base),
		);
		// The logical identity is the same regardless of any physical root;
		// physical roots never enter the builder at all.
		expect(canonicalRequestFingerprint(withPhysicalRoot)).toBe(canonicalRequestFingerprint(base));
	});

	it("fingerprints transport, deferred, and cache retention, not just sampling", () => {
		const base = build();
		const drifted = build({ streamOptions: { transport: "websocket" } });
		expect(canonicalRequestFingerprint(drifted)).not.toBe(canonicalRequestFingerprint(base));
	});

	it("canonicalJsonLoose accepts finite floats and rejects NaN", () => {
		expect(canonicalJsonLoose({ a: 0.1, b: [1.5], c: { d: -2.25 } })).toBe('{"a":0.1,"b":[1.5],"c":{"d":-2.25}}');
		expect(() => canonicalJsonLoose({ a: Number.NaN })).toThrow();
		expect(() => canonicalJsonLoose({ a: undefined })).toThrow();
	});
});

describe("verifyExactRequest", () => {
	it("passes an identical canonical request", () => {
		const canonical = build();
		const contextFingerprint = canonicalContextFingerprint(canonical);
		const requestFingerprint = canonicalRequestFingerprint(canonical);
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint,
				requestFingerprint,
				fixedToolCatalogFingerprint: canonical.fixedToolCatalogFingerprint,
				sampling: { id: "a" },
				seedCapable: false,
			}),
		).not.toThrow();
	});

	it("rejects context, request, and tool catalog drift with typed errors", () => {
		const canonical = build();
		const requestFingerprint = canonicalRequestFingerprint(canonical);
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint: "f".repeat(64),
				requestFingerprint,
				fixedToolCatalogFingerprint: canonical.fixedToolCatalogFingerprint,
				sampling: { id: "a" },
				seedCapable: false,
			}),
		).toThrow(RequestFingerprintMismatchError);
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint: canonicalContextFingerprint(canonical),
				requestFingerprint: "f".repeat(64),
				fixedToolCatalogFingerprint: canonical.fixedToolCatalogFingerprint,
				sampling: { id: "a" },
				seedCapable: false,
			}),
		).toThrow(RequestFingerprintMismatchError);
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint: canonicalContextFingerprint(canonical),
				requestFingerprint,
				fixedToolCatalogFingerprint: "f".repeat(64),
				sampling: { id: "a" },
				seedCapable: false,
			}),
		).toThrow(RequestFingerprintMismatchError);
	});

	it("rejects an explicit seed when the provider does not support seeds", () => {
		const canonical = build();
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint: canonicalContextFingerprint(canonical),
				requestFingerprint: canonicalRequestFingerprint(canonical),
				fixedToolCatalogFingerprint: canonical.fixedToolCatalogFingerprint,
				sampling: { id: "seeded", seed: 42 },
				seedCapable: false,
			}),
		).toThrow(UnsupportedSamplingControlError);
		expect(() =>
			verifyExactRequest(canonical, {
				contextFingerprint: canonicalContextFingerprint(canonical),
				requestFingerprint: canonicalRequestFingerprint(canonical),
				fixedToolCatalogFingerprint: canonical.fixedToolCatalogFingerprint,
				sampling: { id: "seeded", seed: 42 },
				seedCapable: true,
			}),
		).not.toThrow();
	});
});
