import type { SessionMetadata, SessionRepo } from "../storage.ts";

/** A fresh backend instance owned by one conformance case. */
export interface SessionBackendFixture extends AsyncDisposable {
	readonly repository: SessionRepo<SessionMetadata, { id?: string; parentSessionId?: string }, never>;
}

export type SessionBackendFixtureFactory = () => Promise<SessionBackendFixture>;

export interface SessionBackendConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
