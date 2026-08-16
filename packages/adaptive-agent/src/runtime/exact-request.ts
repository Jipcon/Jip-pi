import type { AgentHarnessStreamOptions, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { LogicalWorkspaceIdentity } from "./execution-environment.ts";
import type { ExactSamplingVariant } from "./harness-v4-contract.ts";
import { canonicalizeTool, type FixedToolContract, sha256Hex } from "./policy-bundle.ts";

/**
 * Canonical JSON tolerant of finite non-integer numbers (temperature, top-p,
 * usage cost). Deterministic byte output for any structurally equal value;
 * NaN/Infinity are rejected instead of silently mis-fingerprinted.
 */
export function canonicalJsonLoose(value: unknown): string {
	return JSON.stringify(canonicalizeLoose(value));
}

function canonicalizeLoose(value: unknown): unknown {
	if (value === undefined) throw new Error("undefined is not canonical JSON");
	if (value === null) return null;
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Non-finite number is not canonical JSON: ${value}`);
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => canonicalizeLoose(item));
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as object).sort()) {
		sorted[key] = canonicalizeLoose((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

function fingerprintLoose(value: unknown): string {
	return sha256Hex(canonicalJsonLoose(value));
}

/** Semantic sampling parameters; `seed` is provenance-only and never fingerprinted. */
export interface SamplingControl {
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	seed?: number;
}

/**
 * Exact-compatible execution profile. All fields are pinned by the checkpoint;
 * hook/resource identity is versioned so content drift changes the request
 * fingerprint. Non-deterministic transforms are fail-closed elsewhere.
 */
export interface ExactRequestProfile {
	hookProfileVersion: string;
	resourceProfileVersion: string;
	sampling: Omit<SamplingControl, "seed">;
	/** Provider-declared seed capability; false means seeds are unsupported. */
	seedCapable: boolean;
	contextPolicy: { version: string; projectionPolicy: string; compactionState: string };
}

/** Stream options that are inference-relevant and therefore fingerprinted. */
export interface CanonicalStreamOptions {
	transport?: AgentHarnessStreamOptions["transport"];
	deferred?: AgentHarnessStreamOptions["deferred"];
	cacheRetention?: AgentHarnessStreamOptions["cacheRetention"];
}

/**
 * Pure canonical inference request: everything that can change the first
 * provider request of an exact continuation. Request/trace/session ids,
 * authentication material, timeouts, retry timing, physical paths, and the
 * entropy selector are absent by construction.
 */
export interface CanonicalInferenceRequest {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	providerMessages: Message[];
	tools: FixedToolContract[];
	sampling: Omit<SamplingControl, "seed">;
	streamOptions: CanonicalStreamOptions;
	hookProfileVersion: string;
	resourceProfileVersion: string;
	policyBundleFingerprint: string;
	projectorVersion: string;
	policyStateFingerprint: string;
	fixedToolCatalogFingerprint: string;
	logicalWorkspace: LogicalWorkspaceIdentity;
	contextPolicy: ExactRequestProfile["contextPolicy"];
}

export interface CanonicalInferenceRequestInput {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	providerMessages: Message[];
	/** Source-ordered provider-visible tools; name/description/schema enter the fingerprint. */
	tools: AgentTool[];
	sampling: SamplingControl;
	streamOptions: AgentHarnessStreamOptions;
	profile: ExactRequestProfile;
	policyBundleFingerprint: string;
	projectorVersion: string;
	policyStateFingerprint: string;
	fixedToolCatalogFingerprint: string;
	logicalWorkspace: LogicalWorkspaceIdentity;
}

/**
 * The single canonical request builder. Checkpoint capture and the child's
 * pre-dispatch gate must both derive their fingerprints through this function
 * from the same logical inputs.
 */
export function buildCanonicalInferenceRequest(input: CanonicalInferenceRequestInput): CanonicalInferenceRequest {
	const { seed: _seed, ...sampling } = input.sampling;
	void _seed;
	return {
		model: { ...input.model },
		thinkingLevel: input.thinkingLevel,
		systemPrompt: input.systemPrompt,
		providerMessages: structuredClone(input.providerMessages),
		tools: input.tools.map((tool) => canonicalizeTool(tool)),
		sampling: { ...sampling },
		streamOptions: {
			...(input.streamOptions.transport === undefined ? {} : { transport: input.streamOptions.transport }),
			...(input.streamOptions.deferred === undefined
				? {}
				: { deferred: structuredClone(input.streamOptions.deferred) }),
			...(input.streamOptions.cacheRetention === undefined
				? {}
				: { cacheRetention: structuredClone(input.streamOptions.cacheRetention) }),
		},
		hookProfileVersion: input.profile.hookProfileVersion,
		resourceProfileVersion: input.profile.resourceProfileVersion,
		policyBundleFingerprint: input.policyBundleFingerprint,
		projectorVersion: input.projectorVersion,
		policyStateFingerprint: input.policyStateFingerprint,
		fixedToolCatalogFingerprint: input.fixedToolCatalogFingerprint,
		logicalWorkspace: structuredClone(input.logicalWorkspace),
		contextPolicy: structuredClone(input.profile.contextPolicy),
	};
}

/** Model-context fingerprint: conversation, workspace, model, thinking, projection policy. */
export function canonicalContextFingerprint(request: CanonicalInferenceRequest): string {
	return fingerprintLoose({
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		systemPrompt: request.systemPrompt,
		providerMessages: request.providerMessages,
		logicalWorkspace: request.logicalWorkspace,
		contextPolicy: request.contextPolicy,
	});
}

/** Canonical request fingerprint: the context fingerprint plus every inference-relevant request field. */
export function canonicalRequestFingerprint(request: CanonicalInferenceRequest): string {
	return fingerprintLoose({
		contextFingerprint: canonicalContextFingerprint(request),
		tools: request.tools,
		sampling: request.sampling,
		streamOptions: request.streamOptions,
		hookProfileVersion: request.hookProfileVersion,
		resourceProfileVersion: request.resourceProfileVersion,
		policyBundleFingerprint: request.policyBundleFingerprint,
		projectorVersion: request.projectorVersion,
		policyStateFingerprint: request.policyStateFingerprint,
		fixedToolCatalogFingerprint: request.fixedToolCatalogFingerprint,
	});
}

export class RequestFingerprintMismatchError extends Error {
	constructor(detail: string) {
		super(`Request fingerprint mismatch: ${detail}`);
		this.name = "RequestFingerprintMismatch";
	}
}

export class NonDeterministicRequestPolicyError extends Error {
	constructor(detail: string) {
		super(`Non-deterministic request policy: ${detail}`);
		this.name = "NonDeterministicRequestPolicy";
	}
}

export class UnsupportedSamplingControlError extends Error {
	constructor(detail: string) {
		super(`Unsupported sampling control: ${detail}`);
		this.name = "UnsupportedSamplingControl";
	}
}

export class WorkspaceSnapshotMismatchError extends Error {
	constructor(detail: string) {
		super(`Workspace snapshot mismatch: ${detail}`);
		this.name = "WorkspaceSnapshotMismatch";
	}
}

export class MissingIdentitiesError extends Error {
	constructor(detail: string) {
		super(`Missing identities: ${detail}`);
		this.name = "MissingIdentities";
	}
}

export interface ExactRequestExpectation {
	contextFingerprint: string;
	requestFingerprint: string;
	fixedToolCatalogFingerprint: string;
	sampling: ExactSamplingVariant;
	seedCapable: boolean;
}

/**
 * Pre-dispatch second gate: recompute both fingerprints through the canonical
 * builder and compare them with the checkpoint/basis records. Any mismatch
 * throws before a provider call, effect intent, or streaming side effect.
 */
export function verifyExactRequest(request: CanonicalInferenceRequest, expected: ExactRequestExpectation): void {
	if (request.fixedToolCatalogFingerprint !== expected.fixedToolCatalogFingerprint) {
		throw new RequestFingerprintMismatchError(
			`fixed tool catalog ${request.fixedToolCatalogFingerprint} does not match pinned ${expected.fixedToolCatalogFingerprint}`,
		);
	}
	const contextFingerprint = canonicalContextFingerprint(request);
	if (contextFingerprint !== expected.contextFingerprint) {
		throw new RequestFingerprintMismatchError(
			`context fingerprint ${contextFingerprint} does not match pinned ${expected.contextFingerprint}`,
		);
	}
	const requestFingerprint = canonicalRequestFingerprint(request);
	if (requestFingerprint !== expected.requestFingerprint) {
		throw new RequestFingerprintMismatchError(
			`request fingerprint ${requestFingerprint} does not match pinned ${expected.requestFingerprint}`,
		);
	}
	if (expected.sampling.seed !== undefined && !expected.seedCapable) {
		throw new UnsupportedSamplingControlError(
			`sampling variant ${expected.sampling.id} requests seed ${expected.sampling.seed} but the provider does not support seeds`,
		);
	}
}
