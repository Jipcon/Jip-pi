import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	loadDesktopSettings,
	rememberDesktopWorkspace,
	removeDesktopWorkspace,
	removeDesktopWorkspaceIfEmpty,
	saveDesktopSettings,
} from "../src/main/desktop-settings.ts";
import {
	encodeWorkspaceDirectory,
	normalizeSessionStorageConfig,
	resolveSessionDirectory,
} from "../src/main/session-storage.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-desktop-settings-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("session storage settings", () => {
	test("resolves workspace and custom modes without changing Pi's default mode", () => {
		const workspace = resolve(makeTemporaryDirectory(), "project");
		const customRoot = resolve(makeTemporaryDirectory(), "sessions");

		expect(resolveSessionDirectory(workspace, { mode: "default" })).toBeUndefined();
		expect(resolveSessionDirectory(workspace, { mode: "workspace" })).toBe(join(workspace, ".pi", "sessions"));
		expect(resolveSessionDirectory(workspace, { mode: "custom", customRoot })).toBe(
			join(customRoot, encodeWorkspaceDirectory(workspace)),
		);
	});

	test("normalizes an absolute custom root and rejects relative paths", () => {
		const customRoot = resolve(makeTemporaryDirectory(), "sessions");
		const normalized = normalizeSessionStorageConfig({ mode: "custom", customRoot: `  ${customRoot}  ` });
		expect(normalized).toEqual({ mode: "custom", customRoot });
		expect(isAbsolute(normalized.customRoot ?? "")).toBe(true);
		expect(() => normalizeSessionStorageConfig({ mode: "custom", customRoot: "relative/sessions" })).toThrow(
			"absolute path",
		);
	});

	test("persists valid settings and falls back safely for invalid JSON", () => {
		const directory = makeTemporaryDirectory();
		const settingsFile = join(directory, "nested", "desktop-settings.json");
		const config = { mode: "workspace" } as const;
		saveDesktopSettings(settingsFile, {
			sessionStorage: config,
			recentWorkspaces: ["D:\\pi", "D:\\pi", "D:\\Dict_app"],
			hiddenWorkspaces: ["D:\\old", "D:\\old"],
		});
		expect(existsSync(settingsFile)).toBe(true);
		expect(loadDesktopSettings(settingsFile)).toEqual({
			sessionStorage: config,
			recentWorkspaces: [resolve("D:\\pi"), resolve("D:\\Dict_app")],
			hiddenWorkspaces: [resolve("D:\\old")],
		});
		expect(loadDesktopSettings(join(directory, "missing.json"))).toEqual({
			sessionStorage: { mode: "workspace" },
			recentWorkspaces: [],
			hiddenWorkspaces: [],
		});
	});

	test("keeps workspace order stable and appends a restored workspace", () => {
		const root = makeTemporaryDirectory();
		const first = resolve(root, "first");
		const second = resolve(root, "second");
		const third = resolve(root, "third");
		const settings = {
			sessionStorage: { mode: "default" } as const,
			recentWorkspaces: [first, second],
			hiddenWorkspaces: [] as string[],
		};

		expect(rememberDesktopWorkspace(settings, first).recentWorkspaces).toEqual([first, second]);
		expect(rememberDesktopWorkspace(settings, third).recentWorkspaces).toEqual([first, second, third]);

		const removed = removeDesktopWorkspace(settings, first);
		expect(removed.recentWorkspaces).toEqual([second]);
		expect(removed.hiddenWorkspaces).toEqual([first]);

		const restored = rememberDesktopWorkspace(removed, first);
		expect(restored.recentWorkspaces).toEqual([second, first]);
		expect(restored.hiddenWorkspaces).toEqual([]);

		expect(removeDesktopWorkspaceIfEmpty(settings, first, [first, second])).toBe(settings);
		const cleared = removeDesktopWorkspaceIfEmpty(settings, first, [second]);
		expect(cleared.recentWorkspaces).toEqual([second]);
		expect(cleared.hiddenWorkspaces).toEqual([first]);
	});
});
