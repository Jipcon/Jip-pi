import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { CandidatePolicyState, PolicyBundle, PolicyBundleRef, PolicyRules } from "../../src/index.ts";
import {
	computeToolCatalogFingerprint,
	fingerprintPolicyBundle,
	InMemoryPolicyRegistry,
	PROJECTOR_VERSION,
} from "../../src/index.ts";

/** The fixed read/write/edit/bash catalog with the real schemas and stubbed effects. */
export function makeFixedTools(options?: {
	record?: (name: string, args: Record<string, unknown>) => void;
}): AgentTool[] {
	const real = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
	return real.map((tool) => ({
		...tool,
		execute: async (_id: string, params: unknown) => {
			options?.record?.(tool.name, params as Record<string, unknown>);
			const result: AgentToolResult<unknown> = {
				content: [{ type: "text", text: `${tool.name} ran` } satisfies TextContent],
				details: {},
			};
			return result;
		},
	}));
}

export const TEST_BUDGETS = { maxTurns: 8, maxToolCalls: 16, maxTokens: 100_000 };

export function permissiveBundle(catalogFingerprint: string): PolicyBundle {
	return {
		schemaVersion: 1,
		version: "permissive-v1",
		description: "Permissive baseline bundle",
		rules: {
			toolRules: [],
			verification: { commandPatterns: [] },
			budgets: TEST_BUDGETS,
			toolCatalogFingerprint: catalogFingerprint,
		},
	};
}

export function adaptiveBundle(catalogFingerprint: string, overrides?: Partial<PolicyRules>): PolicyBundle {
	const rules: PolicyRules = {
		toolRules: [
			{
				id: "block-writes",
				toolName: "write",
				decision: { kind: "block", reason: "writes are disabled by policy", reasonCodes: ["no-writes"] },
			},
			{
				id: "canonicalize-paths",
				toolName: "read",
				decision: { kind: "guard", reasonCodes: ["canonical-path"], pathArguments: ["path"] },
			},
		],
		verification: { commandPatterns: ["(^|\\s)(npm test|run tests|verify)(\\s|$)", "^npm test$"] },
		budgets: TEST_BUDGETS,
		toolCatalogFingerprint: catalogFingerprint,
		...overrides,
	};
	return {
		schemaVersion: 1,
		version: overrides === undefined ? "adaptive-v1" : "adaptive-v2",
		description: "Adaptive guardrail bundle",
		rules,
	};
}

export interface BundleFixtures {
	registry: InMemoryPolicyRegistry;
	permissive: PolicyBundleRef;
	adaptive: PolicyBundleRef;
	permissiveBundle: PolicyBundle;
	adaptiveBundle: PolicyBundle;
	catalogFingerprint: string;
}

export async function createBundleFixtures(options?: {
	adaptiveRules?: Partial<PolicyRules>;
	catalogFingerprint?: string;
}): Promise<BundleFixtures> {
	const catalogFingerprint = options?.catalogFingerprint ?? computeToolCatalogFingerprint(makeFixedTools());
	const registry = new InMemoryPolicyRegistry();
	const permissiveBundleValue = permissiveBundle(catalogFingerprint);
	const adaptiveBundleValue = adaptiveBundle(catalogFingerprint, options?.adaptiveRules);
	const [permissive, adaptive] = await Promise.all([
		registry.publish(permissiveBundleValue),
		registry.publish(adaptiveBundleValue),
	]);
	return {
		registry,
		permissive,
		adaptive,
		permissiveBundle: permissiveBundleValue,
		adaptiveBundle: adaptiveBundleValue,
		catalogFingerprint,
	};
}

export function originSnapshot(bundle: PolicyBundle): CandidatePolicyState {
	return {
		phase: "origin",
		turns: 0,
		steps: 0,
		tools: { allow: 0, guard: 0, block: 0, success: 0, failure: 0, duplicate: 0, byTool: {} },
		recent: [],
		failures: [],
		files: { mutated: [], totalMutations: 0, totalReads: 0 },
		budgets: {
			tokens: { used: 0, limit: bundle.rules.budgets.maxTokens },
			tools: { used: 0, limit: bundle.rules.budgets.maxToolCalls },
			turns: { used: 0, limit: bundle.rules.budgets.maxTurns },
		},
		verification: { attempts: 0, successes: 0, failures: 0, lastVerifiedSeq: 0, debt: 0, coverage: 0 },
	};
}

export function runBasisPayload(input: {
	taskId?: string;
	candidateId?: string;
	policyBundle: PolicyBundleRef;
	projectorVersion?: string;
	inheritedPolicyState: unknown;
	start?: { kind: "prompt" };
}): unknown {
	return {
		schemaVersion: 1,
		taskId: input.taskId ?? "task",
		candidateId: input.candidateId ?? "candidate",
		policyBundle: input.policyBundle,
		projectorVersion: input.projectorVersion ?? PROJECTOR_VERSION,
		inheritedPolicyState: input.inheritedPolicyState,
		start: input.start ?? { kind: "prompt" },
	};
}

export function fingerprintOf(bundle: PolicyBundle): string {
	return fingerprintPolicyBundle(bundle);
}
