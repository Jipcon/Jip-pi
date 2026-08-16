import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listSessionCatalog, renameCatalogSession } from "../src/main/session-catalog.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-desktop-catalog-"));
	temporaryDirectories.push(directory);
	return directory;
}

function writeSession(
	filePath: string,
	options: { id: string; cwd: string; name?: string; timestamp: string; messageTimestamp: number },
): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	const entries: unknown[] = [
		{ type: "session", version: 3, id: options.id, timestamp: options.timestamp, cwd: options.cwd },
		{
			type: "message",
			id: `${options.id}-user`,
			parentId: null,
			timestamp: options.timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: `Question from ${options.id}` }],
				timestamp: options.messageTimestamp,
			},
		},
		{
			type: "message",
			id: `${options.id}-assistant`,
			parentId: `${options.id}-user`,
			timestamp: options.timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Answer" }],
				timestamp: options.messageTimestamp + 1,
			},
		},
	];
	if (options.name) {
		entries.push({
			type: "session_info",
			id: `${options.id}-name`,
			parentId: `${options.id}-assistant`,
			timestamp: options.timestamp,
			name: options.name,
		});
	}
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("session catalog", () => {
	test("discovers default and workspace-local sessions with their project paths", async () => {
		const root = makeTemporaryDirectory();
		const defaultRoot = join(root, "default-sessions");
		const workspace = join(root, "workspace-project");
		writeSession(join(defaultRoot, "--D--pi--", "older.jsonl"), {
			id: "older-session",
			cwd: "D:\\pi",
			name: "Official GUI",
			timestamp: "2026-08-08T01:00:00.000Z",
			messageTimestamp: Date.parse("2026-08-08T01:00:00.000Z"),
		});
		writeSession(join(workspace, ".pi", "sessions", "newer.jsonl"), {
			id: "newer-session",
			cwd: workspace,
			timestamp: "2026-08-08T02:00:00.000Z",
			messageTimestamp: Date.parse("2026-08-08T02:00:00.000Z"),
		});
		mkdirSync(defaultRoot, { recursive: true });
		writeFileSync(join(defaultRoot, "invalid.jsonl"), "not-json\n", "utf8");

		const sessions = await listSessionCatalog({
			sessionStorage: { mode: "workspace" },
			recentWorkspaces: [workspace],
			defaultSessionRoot: defaultRoot,
			environmentSessionRoot: null,
		});

		expect(sessions.map((session) => session.id)).toEqual(["newer-session", "older-session"]);
		expect(sessions[0]).toMatchObject({
			workspacePath: workspace,
			messageCount: 2,
			preview: "Question from newer-session",
		});
		expect(sessions[1]).toMatchObject({
			workspacePath: "D:\\pi",
			name: "Official GUI",
			messageCount: 2,
		});

		const withoutHiddenWorkspace = await listSessionCatalog({
			sessionStorage: { mode: "workspace" },
			recentWorkspaces: [workspace],
			hiddenWorkspaces: [workspace],
			defaultSessionRoot: defaultRoot,
			environmentSessionRoot: null,
		});
		expect(withoutHiddenWorkspace.map((session) => session.id)).toEqual(["older-session"]);
	});

	test("returns an empty catalog when configured roots do not exist", async () => {
		const root = makeTemporaryDirectory();
		await expect(
			listSessionCatalog({
				sessionStorage: { mode: "default" },
				recentWorkspaces: [],
				defaultSessionRoot: join(root, "missing"),
				environmentSessionRoot: null,
			}),
		).resolves.toEqual([]);
	});

	test("renames a discovered session without trusting a renderer-supplied file path", async () => {
		const root = makeTemporaryDirectory();
		const defaultRoot = join(root, "default-sessions");
		const filePath = join(defaultRoot, "--D--pi--", "session.jsonl");
		writeSession(filePath, {
			id: "rename-session",
			cwd: "D:\\pi",
			timestamp: "2026-08-08T01:00:00.000Z",
			messageTimestamp: Date.parse("2026-08-08T01:00:00.000Z"),
		});
		const options = {
			sessionStorage: { mode: "default" } as const,
			recentWorkspaces: [],
			defaultSessionRoot: defaultRoot,
			environmentSessionRoot: null,
		};

		const sessions = await renameCatalogSession(options, "rename-session", "  Renamed globally  ");

		expect(sessions[0]?.name).toBe("Renamed globally");
		expect(readFileSync(filePath, "utf8")).toContain('"type":"session_info"');
		expect(readFileSync(filePath, "utf8")).toContain('"name":"Renamed globally"');
	});
});
