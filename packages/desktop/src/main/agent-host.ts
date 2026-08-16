/**
 * AgentHost: shared session catalog cache and SDK-backed session file
 * operations used by the backend managers and the IPC wiring.
 *
 * The catalog is disk-only: it never creates runtime backends for display.
 * Full history and session identity creation delegate to Pi's own parsing
 * and SessionManager through the SDK adapter.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, SessionInfo, SessionUsage } from "@earendil-works/pi-agent-protocol";
import {
	createSessionFile as createSessionFileWithSdk,
	type ReadSessionUsageOptions,
	readSessionHistory as readSessionHistoryWithSdk,
	readSessionUsage as readSessionUsageWithSdk,
} from "@earendil-works/pi-sdk-adapter";

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

	/** Full message history of a persisted session through Pi's own parser. */
	readSessionHistory(filePath: string): Promise<AgentMessage[]> {
		return readSessionHistoryWithSdk(filePath);
	}

	/**
	 * Token/cost totals and context usage for a persisted session, computed
	 * from the JSONL file without a live backend.
	 */
	readSessionUsage(filePath: string, options: ReadSessionUsageOptions): Promise<SessionUsage> {
		return readSessionUsageWithSdk(filePath, options);
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
