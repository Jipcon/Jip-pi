/**
 * Platform-default shell selection shared across pi packages.
 *
 * The coding-agent command-tool default reuses this resolver, and generic
 * shell entry points (for example interactive `!` commands) must do the same
 * instead of duplicating `process.platform` checks.
 */

/** The two shell capabilities pi can execute directly. */
export type ShellKind = "bash" | "pwsh";

/**
 * The platform-default shell kind:
 * - Windows → pwsh (PowerShell 7)
 * - Everything else → bash
 */
export function getDefaultShellKind(platform: NodeJS.Platform = process.platform): ShellKind {
	return platform === "win32" ? "pwsh" : "bash";
}
