import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { SessionInfo } from "@earendil-works/pi-agent-protocol";
import type { SessionStorageConfig } from "../shared/ipc.ts";
import { workspacePathKey } from "../shared/workspace-path.ts";
import { resolveSessionDirectory } from "./session-storage.ts";

interface SessionCatalogOptions {
	sessionStorage: SessionStorageConfig;
	recentWorkspaces: string[];
	hiddenWorkspaces?: string[];
	/** Overrides used by tests; production follows Jip-pi's environment and home directory. */
	defaultSessionRoot?: string;
	environmentSessionRoot?: string | null;
}

interface CatalogRoot {
	path: string;
	depth: number;
}

const MAX_CONCURRENT_READS = 10;

function expandTilde(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

function defaultSessionRoot(): string {
	const configuredAgentRoot = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentRoot = configuredAgentRoot ? resolve(expandTilde(configuredAgentRoot)) : join(homedir(), ".pi", "agent");
	return join(agentRoot, "sessions");
}

function catalogRoots(options: SessionCatalogOptions): CatalogRoot[] {
	const roots = new Map<string, CatalogRoot>();
	const addRoot = (path: string | undefined | null, depth: number): void => {
		if (!path?.trim()) return;
		const resolvedPath = resolve(expandTilde(path.trim()));
		const key = workspacePathKey(resolvedPath);
		const current = roots.get(key);
		if (!current || current.depth < depth) {
			roots.set(key, { path: resolvedPath, depth });
		}
	};

	addRoot(options.defaultSessionRoot ?? defaultSessionRoot(), 1);
	const environmentRoot =
		options.environmentSessionRoot === undefined
			? process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
			: options.environmentSessionRoot;
	addRoot(environmentRoot, 1);

	if (options.sessionStorage.mode === "custom") {
		addRoot(options.sessionStorage.customRoot, 1);
	}
	for (const workspace of options.recentWorkspaces) {
		const directory = resolveSessionDirectory(workspace, options.sessionStorage);
		addRoot(directory, 0);
	}

	return [...roots.values()];
}

async function collectSessionFiles(root: string, depth: number): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const files = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => join(root, entry.name));
		if (depth === 0) {
			return files;
		}
		const nested = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => collectSessionFiles(join(root, entry.name), depth - 1)),
		);
		return files.concat(...nested);
	} catch {
		return [];
	}
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textContent(message: Record<string, unknown>): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.map((block) => objectValue(block))
		.filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join(" ");
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

async function readSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: Record<string, unknown> | null = null;
		let name: string | undefined;
		let messageCount = 0;
		let preview = "";
		let lastActivity: number | undefined;
		const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

		for await (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const entry = objectValue(parsed);
			if (!entry) continue;
			if (!header) {
				if (entry.type !== "session" || typeof entry.id !== "string") {
					return null;
				}
				header = entry;
				continue;
			}

			if (entry.type === "session_info") {
				name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
			}
			if (entry.type !== "message") continue;
			messageCount += 1;
			const message = objectValue(entry.message);
			if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
			const activity = typeof message.timestamp === "number" ? message.timestamp : parseTimestamp(entry.timestamp);
			if (activity !== undefined) {
				lastActivity = Math.max(lastActivity ?? 0, activity);
			}
			if (!preview && message.role === "user") {
				preview = textContent(message);
			}
		}

		if (!header || typeof header.id !== "string") return null;
		const createdAt = parseTimestamp(header.timestamp);
		return {
			id: header.id,
			file: filePath,
			workspacePath: typeof header.cwd === "string" ? header.cwd : undefined,
			name,
			createdAt,
			updatedAt: lastActivity ?? createdAt ?? stats.mtimeMs,
			messageCount,
			preview: preview || "(no messages)",
		};
	} catch {
		return null;
	}
}

async function readSessionInfos(files: string[]): Promise<SessionInfo[]> {
	const results: Array<SessionInfo | null> = new Array(files.length).fill(null);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(MAX_CONCURRENT_READS, files.length) }, async () => {
		while (nextIndex < files.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await readSessionInfo(files[index]);
		}
	});
	await Promise.all(workers);
	return results.filter((session): session is SessionInfo => session !== null);
}

export async function listSessionCatalog(options: SessionCatalogOptions): Promise<SessionInfo[]> {
	const fileGroups = await Promise.all(
		catalogRoots(options).map((root) => collectSessionFiles(root.path, root.depth)),
	);
	const filesByPath = new Map<string, string>();
	for (const file of fileGroups.flat()) {
		filesByPath.set(workspacePathKey(file), file);
	}
	const sessions = await readSessionInfos([...filesByPath.values()]);
	const hiddenWorkspaces = new Set((options.hiddenWorkspaces ?? []).map((workspace) => workspacePathKey(workspace)));
	const sessionsById = new Map<string, SessionInfo>();
	for (const session of sessions) {
		if (session.workspacePath && hiddenWorkspaces.has(workspacePathKey(session.workspacePath))) {
			continue;
		}
		const current = sessionsById.get(session.id);
		if (!current || (session.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
			sessionsById.set(session.id, session);
		}
	}
	return [...sessionsById.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export async function findCatalogSession(
	options: SessionCatalogOptions,
	sessionId: string,
): Promise<SessionInfo | null> {
	return (await listSessionCatalog(options)).find((session) => session.id === sessionId) ?? null;
}

async function readSessionLeaf(
	filePath: string,
	expectedSessionId: string,
): Promise<{ leafId: string | null; entryIds: Set<string> }> {
	let headerSeen = false;
	let leafId: string | null = null;
	const entryIds = new Set<string>();
	const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const entry = objectValue(parsed);
		if (!entry) continue;
		if (!headerSeen) {
			if (entry.type !== "session" || entry.id !== expectedSessionId) {
				throw new Error(`Session file no longer matches ${expectedSessionId}`);
			}
			headerSeen = true;
			continue;
		}
		if (typeof entry.id === "string") {
			entryIds.add(entry.id);
			leafId = entry.id;
		}
	}
	if (!headerSeen) {
		throw new Error(`Invalid session file for ${expectedSessionId}`);
	}
	return { leafId, entryIds };
}

function newEntryId(entryIds: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = randomUUID().slice(0, 8);
		if (!entryIds.has(id)) return id;
	}
	return randomUUID();
}

async function fileNeedsLeadingNewline(filePath: string): Promise<boolean> {
	const handle = await open(filePath, "r");
	try {
		const stats = await handle.stat();
		if (stats.size === 0) return false;
		const lastByte = Buffer.alloc(1);
		await handle.read(lastByte, 0, 1, stats.size - 1);
		return lastByte[0] !== 10;
	} finally {
		await handle.close();
	}
}

export async function renameCatalogSession(
	options: SessionCatalogOptions,
	sessionId: string,
	name: string,
): Promise<SessionInfo[]> {
	const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
	if (!sanitizedName) {
		throw new Error("Session name cannot be empty");
	}
	if (sanitizedName.length > 160) {
		throw new Error("Session name cannot exceed 160 characters");
	}
	const session = await findCatalogSession(options, sessionId);
	if (!session?.file) {
		throw new Error(`Session not found: ${sessionId}`);
	}
	const { leafId, entryIds } = await readSessionLeaf(session.file, sessionId);
	const entry = {
		type: "session_info",
		id: newEntryId(entryIds),
		parentId: leafId,
		timestamp: new Date().toISOString(),
		name: sanitizedName,
	};
	const prefix = (await fileNeedsLeadingNewline(session.file)) ? "\n" : "";
	await appendFile(session.file, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
	return listSessionCatalog(options);
}
