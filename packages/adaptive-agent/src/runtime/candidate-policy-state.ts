import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson, fingerprintOfJson, sha256Hex } from "./policy-bundle.ts";

export type CandidatePhase = "origin" | "working" | "verifying" | "answering" | "terminal";

export const CANDIDATE_PHASES = ["origin", "working", "verifying", "answering", "terminal"] as const;

export interface PerToolCounts {
	allow: number;
	guard: number;
	block: number;
	success: number;
	failure: number;
}

export interface ToolCounters extends PerToolCounts {
	duplicate: number;
	byTool: Record<string, PerToolCounts>;
}

export interface RecentFingerprint {
	kind: "action" | "failure";
	seq: number;
	hash: string;
}

export interface FileFreshness {
	path: string;
	reads: number;
	writes: number;
	edits: number;
	lastMutationSeq: number;
	lastMutationTimestamp: number;
}

export interface FileSummary {
	mutated: FileFreshness[];
	totalMutations: number;
	totalReads: number;
}

export interface BudgetCounter {
	used: number;
	limit: number;
}

export interface BudgetSummary {
	tokens: BudgetCounter;
	tools: BudgetCounter;
	turns: BudgetCounter;
}

export interface VerificationSummary {
	attempts: number;
	successes: number;
	failures: number;
	lastVerifiedSeq: number;
	debt: number;
	coverage: number;
}

export interface WorkspaceFileFact {
	path: string;
	size: number;
	mtimeMs: number;
	hash?: string;
}

export interface WorkspaceMetadata {
	files: WorkspaceFileFact[];
}

export interface WorkspaceSummary {
	fingerprint: string;
	files: WorkspaceFileFact[];
}

/**
 * Concrete, bounded, canonically serializable candidate state. Every field is
 * deterministic given the same durable facts and pinned PolicyBundle; the
 * `workspace` section carries caller-pinned workspace metadata and is excluded
 * from the state fingerprint so a batch-start fingerprint stays comparable to
 * a post-turn replay of the same durable prefix.
 */
export interface CandidatePolicyState {
	phase: CandidatePhase;
	turns: number;
	steps: number;
	tools: ToolCounters;
	recent: RecentFingerprint[];
	failures: RecentFingerprint[];
	files: FileSummary;
	budgets: BudgetSummary;
	verification: VerificationSummary;
	workspace?: WorkspaceSummary;
}

export const MAX_RECENT_FINGERPRINTS = 8;
export const MAX_MUTATED_FILES = 16;
export const MAX_WORKSPACE_FILES = 32;

const TOOL_KEYS = new Set(["read", "write", "edit", "bash", "other"]);

export function zeroToolCounts(): ToolCounters {
	return {
		allow: 0,
		guard: 0,
		block: 0,
		success: 0,
		failure: 0,
		duplicate: 0,
		byTool: {},
	};
}

/** Deterministic initial state for a task bound to the given bundle budgets. */
export function initialCandidateState(maxTurns: number, maxToolCalls: number, maxTokens: number): CandidatePolicyState {
	return {
		phase: "origin",
		turns: 0,
		steps: 0,
		tools: zeroToolCounts(),
		recent: [],
		failures: [],
		files: { mutated: [], totalMutations: 0, totalReads: 0 },
		budgets: {
			tokens: { used: 0, limit: maxTokens },
			tools: { used: 0, limit: maxToolCalls },
			turns: { used: 0, limit: maxTurns },
		},
		verification: { attempts: 0, successes: 0, failures: 0, lastVerifiedSeq: 0, debt: 0, coverage: 0 },
	};
}

/** Fingerprint over the deterministic core; the workspace section is excluded. */
export function fingerprintState(state: CandidatePolicyState): string {
	const { workspace: _workspace, ...core } = state;
	return fingerprintOfJson(core as unknown as JsonValue);
}

export function workspaceFingerprint(metadata: WorkspaceMetadata): string {
	return sha256Hex(canonicalJson({ files: metadata.files } as unknown as JsonValue));
}

/** Canonical JSON of the complete state including the workspace section. */
export function canonicalStateJson(state: CandidatePolicyState): string {
	return canonicalJson(state as unknown as JsonValue);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidFileFreshness(value: unknown): value is FileFreshness {
	if (!isRecord(value)) return false;
	return (
		typeof value.path === "string" &&
		value.path.length > 0 &&
		isCount(value.reads) &&
		isCount(value.writes) &&
		isCount(value.edits) &&
		isCount(value.lastMutationSeq) &&
		isCount(value.lastMutationTimestamp)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation of a reconstructed snapshot; returns a reason or undefined. */
export function validateCandidatePolicyState(value: unknown): string | undefined {
	if (!isRecord(value)) return "state must be an object";
	if (typeof value.phase !== "string" || !(CANDIDATE_PHASES as readonly string[]).includes(value.phase)) {
		return "state phase is invalid";
	}
	if (!isCount(value.turns) || !isCount(value.steps)) return "state counters must be counts";
	const tools = value.tools;
	if (!isRecord(tools)) return "state tools must be an object";
	for (const key of ["allow", "guard", "block", "success", "failure", "duplicate"]) {
		if (!isCount(tools[key])) return `state tools.${key} must be a count`;
	}
	if (!isRecord(tools.byTool)) return "state tools.byTool must be an object";
	for (const [name, counts] of Object.entries(tools.byTool)) {
		if (!TOOL_KEYS.has(name)) return `state tools.byTool has unknown tool ${name}`;
		if (!isRecord(counts)) return `state tools.byTool.${name} must be an object`;
		for (const key of ["allow", "guard", "block", "success", "failure"]) {
			if (!isCount(counts[key])) return `state tools.byTool.${name}.${key} must be a count`;
		}
	}
	for (const [field, list] of [
		["recent", value.recent],
		["failures", value.failures],
	] as const) {
		if (!Array.isArray(list)) return `state ${field} must be an array`;
		if (list.length > MAX_RECENT_FINGERPRINTS) return `state ${field} exceeds the bounded size`;
		for (const item of list) {
			if (!isRecord(item)) return `state ${field} items must be objects`;
			if (item.kind !== "action" && item.kind !== "failure") return `state ${field} item kind is invalid`;
			if (!isCount(item.seq)) return `state ${field} item seq must be a count`;
			if (typeof item.hash !== "string" || item.hash.length !== 64)
				return `state ${field} item hash must be a sha256`;
		}
	}
	const files = value.files;
	if (!isRecord(files)) return "state files must be an object";
	if (!Array.isArray(files.mutated)) return "state files.mutated must be an array";
	if (files.mutated.length > MAX_MUTATED_FILES) return "state files.mutated exceeds the bounded size";
	for (const item of files.mutated) {
		if (!isValidFileFreshness(item)) return "state files.mutated items are invalid";
	}
	if (!isCount(files.totalMutations) || !isCount(files.totalReads)) return "state files counters must be counts";
	const budgets = value.budgets;
	if (!isRecord(budgets)) return "state budgets must be an object";
	for (const key of ["tokens", "tools", "turns"]) {
		const counter = budgets[key];
		if (!isRecord(counter) || !isCount(counter.used) || !isCount(counter.limit)) {
			return `state budgets.${key} must be a counter`;
		}
	}
	const verification = value.verification;
	if (!isRecord(verification)) return "state verification must be an object";
	for (const key of ["attempts", "successes", "failures", "lastVerifiedSeq", "debt"]) {
		if (!isCount(verification[key])) return `state verification.${key} must be a count`;
	}
	if (
		typeof verification.coverage !== "number" ||
		!Number.isSafeInteger(verification.coverage) ||
		verification.coverage < 0 ||
		verification.coverage > 100
	) {
		return "state verification.coverage must be an integer percent 0-100";
	}
	if (value.workspace !== undefined) {
		const workspace = value.workspace;
		if (!isRecord(workspace)) return "state workspace must be an object";
		if (typeof workspace.fingerprint !== "string" || workspace.fingerprint.length !== 64) {
			return "state workspace.fingerprint must be a sha256";
		}
		if (!Array.isArray(workspace.files) || workspace.files.length > MAX_WORKSPACE_FILES) {
			return "state workspace.files exceeds the bounded size";
		}
		for (const item of workspace.files) {
			if (!isRecord(item) || typeof item.path !== "string" || item.path.length === 0) {
				return "state workspace.files items must name a path";
			}
			if (!isCount(item.size) || !isCount(item.mtimeMs)) return "state workspace.files items must carry counts";
			if (item.hash !== undefined && (typeof item.hash !== "string" || item.hash.length !== 64)) {
				return "state workspace.files item hash must be a sha256";
			}
		}
	}
	return undefined;
}

export function summarizeWorkspace(metadata: WorkspaceMetadata): WorkspaceSummary {
	const files = [...metadata.files]
		.sort((left, right) => left.path.localeCompare(right.path))
		.slice(0, MAX_WORKSPACE_FILES)
		.map((file) => ({ ...file }));
	return { fingerprint: workspaceFingerprint(metadata), files };
}
