import { sha256Hex } from "./policy-bundle.ts";
import type { WorkspacePatch } from "./workspace-manager.ts";

/**
 * Hard Verifier (Stage 8, S8.3): runs inside the candidate workspace, never
 * through the frozen model. Authoritative evidence is bounded: exit/result,
 * coverage, duration, and a hash/length/prefixed summary; full shell output
 * never enters the journal or the belief.
 */

export interface HardVerifier {
	readonly id: string;
	readonly version: string;
	/** "safe" verifiers may be re-run after a crash; "never" ones settle as interrupted. */
	readonly replay: "safe" | "never";
	verify(input: {
		taskId: string;
		candidateId: string;
		cwd: string;
		signal: AbortSignal;
	}): Promise<HardVerifierResult>;
}

export interface BoundedSummary {
	hash: string;
	length: number;
	prefix: string;
}

export interface HardVerifierResult {
	status: "pass" | "fail";
	exitCode?: number;
	/** Integer percent 0..100. */
	coverage: number;
	durationMs: number;
	summary: BoundedSummary;
}

export const MAX_VERIFIER_SUMMARY_LENGTH = 200;

/** Bounded, sanitized evidence derived from raw verifier output. */
export function summarizeVerifierOutput(output: string): BoundedSummary {
	const collapsed = output.replace(/\s+/g, " ").trim();
	return {
		hash: sha256Hex(output),
		length: output.length,
		prefix: collapsed.slice(0, MAX_VERIFIER_SUMMARY_LENGTH),
	};
}

export interface VerifierWorkspaceMutation {
	kind: "tracked" | "untracked" | "both";
	detail: string;
}

/**
 * Deterministic workspace fingerprint of one diff: the pair of patch/manifest
 * hashes. Ignored build caches never enter either hash, so a verifier that
 * only touches ignored content leaves the fingerprint unchanged.
 */
export function workspaceDiffFingerprint(diff: WorkspacePatch): string {
	return sha256Hex(`${diff.summary.trackedPatchHash}:${diff.summary.untrackedManifestHash}`);
}

/** Verifier-workspace mutation detection between the pre/post diffs. */
export function detectWorkspaceMutation(
	before: WorkspacePatch,
	after: WorkspacePatch,
): VerifierWorkspaceMutation | undefined {
	const trackedChanged = before.summary.trackedPatchHash !== after.summary.trackedPatchHash;
	const untrackedChanged = before.summary.untrackedManifestHash !== after.summary.untrackedManifestHash;
	if (!trackedChanged && !untrackedChanged) return undefined;
	if (trackedChanged && untrackedChanged) {
		return {
			kind: "both",
			detail: "the verifier modified tracked and included untracked workspace content",
		};
	}
	if (trackedChanged) return { kind: "tracked", detail: "the verifier modified tracked workspace content" };
	return { kind: "untracked", detail: "the verifier modified included untracked workspace content" };
}

/** Runs one verifier effect with the exact contract input. */
export async function runHardVerifier(input: {
	verifier: HardVerifier;
	taskId: string;
	candidateId: string;
	cwd: string;
	signal: AbortSignal;
}): Promise<HardVerifierResult> {
	const startedAt = Date.now();
	const result = await input.verifier.verify({
		taskId: input.taskId,
		candidateId: input.candidateId,
		cwd: input.cwd,
		signal: input.signal,
	});
	return { ...structuredClone(result), durationMs: Date.now() - startedAt };
}
