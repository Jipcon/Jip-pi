/**
 * Compatibility layer: capability discovery and version-tolerant helpers.
 *
 * The GUI never guesses what the backend supports; it asks. This module turns
 * successful RPC probes into the protocol's `Capabilities` map and builds the
 * `BackendHandshake` that describes the running backend.
 */

import {
	AGENT_PROTOCOL_VERSION,
	type BackendHandshake,
	type Capabilities,
	type ModelInfo,
} from "@earendil-works/pi-agent-protocol";
import { normalizeModel, normalizeSessionUsage } from "./event-normalizer.ts";
import type { PiJsonEvent, RpcClient, RpcRequestResult } from "./rpc-client.ts";

export const BACKEND_ID = "pi";
export const BACKEND_NAME = "Pi";

export interface CapabilityProbe {
	command: string;
	capability: string;
	/**
	 * Optional predicate on the response data. When omitted, a successful
	 * response enables the capability.
	 */
	predicate?: (data: unknown) => boolean;
}

/**
 * Probe capabilities by issuing the corresponding RPC commands.
 * Failed probes simply leave the capability unset.
 */
export async function detectCapabilities(client: RpcClient, probes: CapabilityProbe[]): Promise<Capabilities> {
	const capabilities: Capabilities = {};
	for (const probe of probes) {
		try {
			const result = await client.request<RpcRequestResult>({ type: probe.command });
			if (result.success && (probe.predicate === undefined || probe.predicate(result.data))) {
				capabilities[probe.capability] = true;
			}
		} catch {
			// Timeout / closed client: capability stays unknown.
		}
	}
	return capabilities;
}

/** The default set of capability probes for the Pi RPC backend. */
export function defaultCapabilityProbes(): CapabilityProbe[] {
	return [
		{
			command: "list_sessions",
			capability: "sessions",
			predicate: (data) => Array.isArray((data as { sessions?: unknown } | undefined)?.sessions),
		},
		{
			command: "get_available_models",
			capability: "models",
			predicate: (data) => Array.isArray((data as { models?: unknown } | undefined)?.models),
		},
		{ command: "abort", capability: "abort" },
		{ command: "get_available_thinking_levels", capability: "reasoningLevels" },
		{
			command: "get_commands",
			capability: "commands",
			predicate: (data) => Array.isArray((data as { commands?: unknown } | undefined)?.commands),
		},
		{
			command: "get_session_stats",
			capability: "sessionUsage",
			predicate: (data) => normalizeSessionUsage(data) !== null,
		},
	];
}

/** Build a handshake describing the running backend. */
export function buildHandshake(capabilities: Capabilities, version?: string): BackendHandshake {
	return {
		protocolVersion: AGENT_PROTOCOL_VERSION,
		backend: {
			id: BACKEND_ID,
			name: BACKEND_NAME,
			version,
		},
		capabilities,
	};
}

/** Normalize a list of raw models (get_available_models data). */
export function normalizeModelList(data: unknown): ModelInfo[] {
	if (typeof data !== "object" || data === null) {
		return [];
	}
	const models = (data as { models?: unknown }).models;
	if (!Array.isArray(models)) {
		return [];
	}
	return models.map(normalizeModel).filter((model): model is ModelInfo => model !== null);
}

/** Extract the Pi version string from a backend info event if present. */
export function extractVersion(events: PiJsonEvent[]): string | undefined {
	for (const event of events) {
		if (event.type === "backend_info" && typeof event.version === "string") {
			return event.version;
		}
	}
	return undefined;
}
