import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import { canonicalJson, sha256Hex } from "./policy-bundle.ts";
import { WorkspaceCaseCollisionError, WorkspacePathEscapeError } from "./workspace-errors.ts";

/**
 * Capture content policy. Ignored files never reach this layer (git enumerates
 * with --exclude-standard); deny rules apply first and are recorded as
 * exclusions with a reason. The resolved policy hash enters the workspace
 * fingerprint, so any policy change produces a different snapshot.
 */
export interface WorkspacePolicy {
	/** Case-insensitive deny patterns matched against the repo-relative path. */
	denyPatterns?: string[];
	maxUntrackedFileBytes?: number;
	maxTotalUntrackedBytes?: number;
	maxUntrackedFiles?: number;
	maxRelativePathLength?: number;
	/** Recreate in-root links on fork; links escaping the root are always rejected. */
	allowLinks?: boolean;
}

export interface ResolvedWorkspacePolicy {
	denyPatterns: string[];
	maxUntrackedFileBytes: number;
	maxTotalUntrackedBytes: number;
	maxUntrackedFiles: number;
	maxRelativePathLength: number;
	allowLinks: boolean;
}

export const DEFAULT_DENY_PATTERNS = [
	".env*",
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	"id_rsa*",
	"id_ed25519*",
	"*credentials*",
	"*secret*",
	".netrc",
	".htpasswd",
];

const WINDOWS_RESERVED_NAMES = new Set(
	["con", "prn", "aux", "nul", "clock$"].concat(
		Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
		Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
	),
);

export function resolveWorkspacePolicy(policy?: WorkspacePolicy): ResolvedWorkspacePolicy {
	return {
		denyPatterns: [...(policy?.denyPatterns ?? []), ...DEFAULT_DENY_PATTERNS],
		maxUntrackedFileBytes: policy?.maxUntrackedFileBytes ?? 16 * 1024 * 1024,
		maxTotalUntrackedBytes: policy?.maxTotalUntrackedBytes ?? 256 * 1024 * 1024,
		maxUntrackedFiles: policy?.maxUntrackedFiles ?? 4096,
		maxRelativePathLength: policy?.maxRelativePathLength ?? 180,
		allowLinks: policy?.allowLinks ?? true,
	};
}

/** Deterministic hash of the effective policy (defaults included). */
export function workspacePolicyHash(policy?: WorkspacePolicy): string {
	return resolvedPolicyHash(resolveWorkspacePolicy(policy));
}

/** Deterministic hash of an already-resolved policy. */
export function resolvedPolicyHash(policy: ResolvedWorkspacePolicy): string {
	return sha256Hex(
		canonicalJson({
			denyPatterns: [...policy.denyPatterns].sort(),
			maxUntrackedFileBytes: policy.maxUntrackedFileBytes,
			maxTotalUntrackedBytes: policy.maxTotalUntrackedBytes,
			maxUntrackedFiles: policy.maxUntrackedFiles,
			maxRelativePathLength: policy.maxRelativePathLength,
			allowLinks: policy.allowLinks,
		} as unknown as JsonValue),
	);
}

/** Case-insensitive wildcard match over one pattern (gitignore-like `*` only). */
function wildcardMatches(pattern: string, path: string): boolean {
	const lowerPattern = pattern.toLowerCase();
	const lowerPath = path.toLowerCase();
	const segments = lowerPattern.split("*");
	if (segments.length === 1) return lowerPath === lowerPattern;
	let index = 0;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i]!;
		if (segment.length === 0) continue;
		const found = lowerPath.indexOf(segment, index);
		if (found < 0) return false;
		index = found + segment.length;
	}
	const last = segments[segments.length - 1]!;
	return last.length === 0 || lowerPath.endsWith(last);
}

/** Returns true when the path matches a deny pattern (basename or full path). */
export function isDeniedPath(path: string, policy: ResolvedWorkspacePolicy): boolean {
	const normalized = path.replaceAll("\\", "/");
	const basename = normalized.split("/").at(-1) ?? normalized;
	return policy.denyPatterns.some(
		(pattern) => wildcardMatches(pattern, normalized) || wildcardMatches(pattern, basename),
	);
}

/**
 * Validates one repo-relative, forward-slash manifest path against Windows
 * filesystem hazards. Throws typed errors; returns the normalized path.
 */
export function validateWorkspaceRelativePath(path: string, policy: ResolvedWorkspacePolicy): string {
	const normalized = path.replaceAll("\\", "/");
	if (normalized.length === 0 || normalized === ".") {
		throw new WorkspacePathEscapeError("path is empty");
	}
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		throw new WorkspacePathEscapeError(`path ${JSON.stringify(normalized)} is absolute`);
	}
	if (normalized.length > policy.maxRelativePathLength) {
		throw new WorkspacePathEscapeError(
			`path ${JSON.stringify(normalized)} exceeds the ${policy.maxRelativePathLength} character length bound`,
		);
	}
	const segments = normalized.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new WorkspacePathEscapeError(`path ${JSON.stringify(normalized)} contains a traversal segment`);
		}
		if (/[\u0000-\u001f<>:"|?*]/.test(segment)) {
			throw new WorkspacePathEscapeError(`path ${JSON.stringify(normalized)} contains an invalid character`);
		}
		if (segment.endsWith(".") || segment.endsWith(" ")) {
			throw new WorkspacePathEscapeError(`path ${JSON.stringify(normalized)} ends with a dot or space`);
		}
		const base = segment.split(".")[0]!.toLowerCase();
		if (WINDOWS_RESERVED_NAMES.has(base)) {
			throw new WorkspacePathEscapeError(`path ${JSON.stringify(normalized)} uses a Windows reserved name`);
		}
	}
	return normalized;
}

/** Throws WorkspaceCaseCollision when `path` duplicates an existing lowercase key. */
export function assertNoCaseCollision(path: string, seen: Set<string>): void {
	const key = path.replaceAll("\\", "/").toLowerCase();
	if (seen.has(key)) {
		throw new WorkspaceCaseCollisionError(
			`path ${JSON.stringify(path)} collides case-insensitively with another path`,
		);
	}
	seen.add(key);
}

/** Normalizes a validated relative path for physical joining (platform form). */
export function physicalSegments(validatedPath: string): string[] {
	return validatedPath.split("/");
}
