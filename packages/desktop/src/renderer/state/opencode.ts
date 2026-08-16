/**
 * OpenCode billing/usage hints shared by the renderer.
 *
 * The GUI never fabricates Go quota numbers: without an official quota
 * endpoint it only explains error messages and links to the console.
 */

export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

/** Error messages matching a Go/Zen usage-limit failure. */
const GO_LIMIT_PATTERNS = [
	/usage\s*limit/i,
	/quota/i,
	/balance/i,
	/insufficient/i,
	/limit\s*reached/i,
	/rate\s*limit/i,
	/429/i,
];

/** True when a redacted error message looks like a Go/Zen quota failure. */
export function looksLikeGoLimitError(message: string | undefined): boolean {
	if (!message) {
		return false;
	}
	return GO_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}
