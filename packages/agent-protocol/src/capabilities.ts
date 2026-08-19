/**
 * Capability discovery model.
 *
 * The GUI decides which controls to show based on the backend's reported
 * capabilities instead of guessing what a concrete agent runtime supports.
 */

export interface Capabilities {
	sessions?: boolean;
	sessionPersistence?: boolean;
	sessionUsage?: boolean;
	models?: boolean;
	abort?: boolean;
	tools?: boolean;
	compaction?: boolean;
	reasoningLevels?: boolean;
	commands?: boolean;
	fileDiffs?: boolean;
	extensionUI?: boolean;
	/** Editing a past user message by forking a new session before it. */
	messageEdit?: boolean;
	[key: string]: unknown;
}

export interface BackendInfo {
	id: string;
	name: string;
	version?: string;
}

export interface BackendHandshake {
	/** Protocol version of the AgentBackend interface implemented by the adapter. */
	protocolVersion: string;
	backend: BackendInfo;
	capabilities: Capabilities;
}

/** The protocol version implemented by this package. */
export const AGENT_PROTOCOL_VERSION = "1.0.0";
