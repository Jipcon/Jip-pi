import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";

/**
 * Canonical JSON used for every adaptive fingerprint. Object keys are sorted
 * recursively and numbers are rejected unless they are safe integers, so the
 * same logical value always serializes to the same bytes.
 */
export function canonicalJson(value: JsonValue): string {
	return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: JsonValue): unknown {
	if (value === undefined) throw new Error("undefined is not canonical JSON");
	if (value === null) return null;
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new Error(`Non-integer or unsafe number is not canonical JSON: ${value}`);
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => canonicalizeJsonValue(item));
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) sorted[key] = canonicalizeJsonValue(value[key]);
	return sorted;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintOfJson(value: JsonValue): string {
	return sha256Hex(canonicalJson(value));
}

export function isSha256Fingerprint(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

export const TOOL_POLICY_FAULT_FINGERPRINT = "policy-fault";

export const PROJECTOR_VERSION = "candidate-state-projector-v1";

export const FIXED_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

/**
 * Canonical contract of one provider-visible tool: name, description and the
 * JSON serialization of its parameter schema. The TypeBox schemas of the fixed
 * tools serialize deterministically (plain object literals, symbol metadata
 * dropped by JSON.stringify).
 */
export interface FixedToolContract {
	name: string;
	description: string;
	schemaJson: string;
}

export function canonicalizeTool(tool: AgentTool): FixedToolContract {
	const schemaJson = JSON.stringify(tool.parameters);
	if (schemaJson === undefined) {
		throw new Error(`Tool ${tool.name} parameters are not JSON-serializable`);
	}
	return { name: tool.name, description: tool.description, schemaJson };
}

/** Fingerprint over the ordered provider-visible catalog (names, descriptions, schemas). */
export function computeToolCatalogFingerprint(tools: readonly AgentTool[]): string {
	const contracts = tools.map((tool) => canonicalizeTool(tool));
	return sha256Hex(canonicalJson(contracts as unknown as JsonValue));
}

/** Strict catalog check: fixed names, fixed order, and fingerprint equality. */
export function validateFixedToolCatalog(tools: readonly AgentTool[], expectedFingerprint: string): string | undefined {
	if (tools.length !== FIXED_TOOL_NAMES.length) {
		return `expected ${FIXED_TOOL_NAMES.length} tools, got ${tools.length}`;
	}
	for (let index = 0; index < FIXED_TOOL_NAMES.length; index++) {
		if (tools[index]?.name !== FIXED_TOOL_NAMES[index]) {
			return `expected tool ${FIXED_TOOL_NAMES[index]} at index ${index}, got ${tools[index]?.name ?? "none"}`;
		}
	}
	const fingerprint = computeToolCatalogFingerprint(tools);
	if (fingerprint !== expectedFingerprint) {
		return `tool catalog drift: fingerprint ${fingerprint} does not match pinned ${expectedFingerprint}`;
	}
	return undefined;
}

export type ToolRuleDecisionKind = "allow" | "guard" | "block";

export interface ToolRuleDecision {
	kind: ToolRuleDecisionKind;
	reasonCodes: string[];
	/** Extra reason for block decisions. */
	reason?: string;
	/** Replay declaration; never exceeds the tool's own declaration. */
	replay?: "never" | "safe";
	/**
	 * Guard rules only canonicalize the named path-like arguments; all other
	 * arguments pass through unchanged. Material rewrites are not expressible.
	 */
	pathArguments?: string[];
}

export interface ToolRuleCondition {
	toolNames?: string[];
	pathMatches?: string;
	commandMatches?: string;
	argMatches?: Record<string, string>;
	phases?: string[];
}

export interface ToolRule {
	id: string;
	toolName?: string;
	when?: ToolRuleCondition;
	decision: ToolRuleDecision;
}

export interface PolicyRules {
	toolRules: ToolRule[];
	verification: { commandPatterns: string[] };
	budgets: { maxTurns: number; maxToolCalls: number; maxTokens: number };
	/** Pinned fingerprint of the fixed provider-visible tool catalog. */
	toolCatalogFingerprint: string;
}

export interface PolicyBundle {
	schemaVersion: 1;
	version: string;
	parentVersion?: string;
	description?: string;
	rules: PolicyRules;
}

export type PolicyBundleRef = {
	version: string;
	fingerprint: string;
};

const PHASES = new Set(["origin", "working", "verifying", "answering", "terminal"]);

function compilePatterns(patterns: ReadonlyArray<string | undefined>, path: string): string | undefined {
	for (const pattern of patterns) {
		if (pattern === undefined) continue;
		if (pattern.length === 0) return `${path}: empty pattern`;
		try {
			new RegExp(pattern);
		} catch (error) {
			return `${path}: invalid regular expression ${pattern}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return undefined;
}

/** Full bundle validation; returns a reason or undefined when valid. */
export function validatePolicyBundle(bundle: PolicyBundle): string | undefined {
	if (bundle.schemaVersion !== 1) return `unsupported bundle schemaVersion ${bundle.schemaVersion}`;
	if (typeof bundle.version !== "string" || bundle.version.length === 0)
		return "bundle version must be a non-empty string";
	if (!isRecord(bundle.rules)) return "bundle rules must be an object";
	if (!isSha256Fingerprint(bundle.rules.toolCatalogFingerprint)) {
		return "bundle rules must pin a valid toolCatalogFingerprint";
	}
	const budgets = bundle.rules.budgets;
	if (
		!isRecord(budgets) ||
		!isPositiveSafeInteger(budgets.maxTurns) ||
		!isPositiveSafeInteger(budgets.maxToolCalls) ||
		!isPositiveSafeInteger(budgets.maxTokens)
	) {
		return "bundle budgets must be positive safe integers";
	}
	if (bundle.rules.verification === undefined) return "bundle rules must define verification.commandPatterns";
	const invalidVerification = compilePatterns(
		bundle.rules.verification.commandPatterns,
		"rules.verification.commandPatterns",
	);
	if (invalidVerification !== undefined) return invalidVerification;
	if (!Array.isArray(bundle.rules.toolRules)) return "bundle rules.toolRules must be an array";
	for (let index = 0; index < bundle.rules.toolRules.length; index++) {
		const rule = bundle.rules.toolRules[index];
		const invalid = validateToolRule(rule, `rules.toolRules[${index}]`);
		if (invalid !== undefined) return invalid;
	}
	return undefined;
}

function validateToolRule(rule: ToolRule, path: string): string | undefined {
	if (!isRecord(rule) || typeof rule.id !== "string" || rule.id.length === 0)
		return `${path}: rule id must be a non-empty string`;
	if (rule.toolName !== undefined && (typeof rule.toolName !== "string" || rule.toolName.length === 0)) {
		return `${path}: toolName must be a non-empty string`;
	}
	const decision = rule.decision;
	if (!isRecord(decision)) return `${path}: decision must be an object`;
	if (decision.kind !== "allow" && decision.kind !== "guard" && decision.kind !== "block") {
		return `${path}: unsupported decision kind`;
	}
	if (!Array.isArray(decision.reasonCodes) || decision.reasonCodes.some((code) => typeof code !== "string")) {
		return `${path}: decision.reasonCodes must be an array of strings`;
	}
	if (decision.replay !== undefined && decision.replay !== "never" && decision.replay !== "safe") {
		return `${path}: decision.replay must be never or safe`;
	}
	if (decision.kind === "guard") {
		// Guards only canonicalize path-like arguments; without them the rule
		// would be a material rewrite, which the MVP forbids.
		if (!Array.isArray(decision.pathArguments) || decision.pathArguments.length === 0) {
			return `${path}: guard decisions must declare pathArguments`;
		}
		if (decision.pathArguments.some((name) => typeof name !== "string" || name.length === 0)) {
			return `${path}: guard pathArguments must be non-empty strings`;
		}
		if (rule.toolName === "bash") return `${path}: guard rules cannot target bash (no path arguments)`;
	}
	if (rule.when !== undefined) {
		const when = rule.when;
		if (!isObjectValue(when)) return `${path}: when must be an object`;
		if (
			when.toolNames !== undefined &&
			(!Array.isArray(when.toolNames) || when.toolNames.some((name) => typeof name !== "string"))
		) {
			return `${path}: when.toolNames must be an array of strings`;
		}
		const invalidPathMatches = compilePatterns([when.pathMatches], `${path}.when.pathMatches`);
		if (when.pathMatches !== undefined && invalidPathMatches !== undefined) return invalidPathMatches;
		const invalidCommandMatches = compilePatterns([when.commandMatches], `${path}.when.commandMatches`);
		if (when.commandMatches !== undefined && invalidCommandMatches !== undefined) return invalidCommandMatches;
		if (when.argMatches !== undefined) {
			if (!isObjectValue(when.argMatches)) return `${path}: when.argMatches must be an object`;
			const invalid = compilePatterns(Object.values(when.argMatches), `${path}.when.argMatches`);
			if (invalid !== undefined) return invalid;
		}
		if (when.phases !== undefined) {
			if (
				!Array.isArray(when.phases) ||
				when.phases.some((phase) => typeof phase !== "string" || !PHASES.has(phase))
			) {
				return `${path}: when.phases must be an array of known phases`;
			}
		}
	}
	return undefined;
}

function isObjectValue(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Canonical bundle content fingerprint: the hash of the bundle without the fingerprint field (it has none). */
export function fingerprintPolicyBundle(bundle: PolicyBundle): string {
	return fingerprintOfJson(bundle as unknown as JsonValue);
}
