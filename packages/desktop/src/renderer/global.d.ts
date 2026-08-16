/**
 * Global renderer typings: the only backend-facing API available in the
 * renderer is `window.agent` (exposed by the preload script).
 */

import type { AgentApi } from "../preload/preload.ts";

declare global {
	interface Window {
		agent: AgentApi;
	}
}
