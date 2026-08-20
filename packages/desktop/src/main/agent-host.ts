/**
 * AgentHost: shared session catalog cache and SDK-backed session identity
 * creation used by the backend managers and the IPC wiring.
 *
 * The catalog is disk-only: it never creates runtime backends for display.
 * Session identity creation delegates to Pi's own SessionManager through
 * the SDK adapter; historical content reads go through the one-pass session
 * projection wired in main.ts.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-agent-protocol";
import { createSessionFile as createSessionFileWithSdk } from "@earendil-works/pi-sdk-adapter";

export interface AgentHostOptions {
	listCatalog(): Promise<SessionInfo[]>;
	renameCatalogSession(sessionId: string, name: string): Promise<SessionInfo[]>;
}

/** The shared agent config directory (~/.pi/agent, or PI_CODING_AGENT_DIR). */
export function agentDirPath(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) {
		const expanded = configured === "~" ? homedir() : configured.replace(/^~(?=[/\\])/, homedir());
		return resolve(expanded);
	}
	return join(homedir(), ".pi", "agent");
}

export class AgentHost {
	private cache: SessionInfo[] | null = null;
	private readonly options: AgentHostOptions;

	constructor(options: AgentHostOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.cache = null;
	}

	/** List sessions, reusing the last scan until invalidated. */
	async listSessions(): Promise<SessionInfo[]> {
		if (this.cache === null) {
			this.cache = await this.options.listCatalog();
		}
		return [...this.cache];
	}

	async findSession(sessionId: string): Promise<SessionInfo | null> {
		return (await this.listSessions()).find((session) => session.id === sessionId) ?? null;
	}

	/** Create a persisted session identity through the SDK SessionManager. */
	createSessionFile(workspacePath: string, sessionDir?: string): Promise<{ sessionId: string; sessionFile: string }> {
		return createSessionFileWithSdk(workspacePath, sessionDir);
	}

	/** Rename on disk (no live backend for the target). */
	async renameCatalogSession(sessionId: string, name: string): Promise<void> {
		await this.options.renameCatalogSession(sessionId, name);
		this.invalidate();
	}
}
