/**
 * Theme compatibility tests for the generic interactive shell mode color:
 * - existing themes that only define `bashMode` keep working
 * - `shellMode` wins when both are present
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

function loadDarkTheme(): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8")) as {
		name: string;
		colors: Record<string, string | number>;
	};
}

function writeTheme(theme: { name: string; colors: Record<string, string | number> }): string {
	const testDir = mkdtempSync(join(tmpdir(), "pi-shell-mode-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${theme.name}.json`);
	writeFileSync(themePath, JSON.stringify(theme));
	return themePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("shellMode theme color", () => {
	it("falls back to bashMode when shellMode is omitted", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "legacy-bash-mode-theme";
		delete (themeJson.colors as Record<string, string | number>).shellMode;

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi("shellMode")).toBe(loadedTheme.getFgAnsi("bashMode"));
	});

	it("prefers an explicitly configured shellMode", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-shell-mode-theme";
		themeJson.colors.shellMode = "#123456";

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi("shellMode")).toBe("\x1b[38;2;18;52;86m");
		expect(loadedTheme.getFgAnsi("shellMode")).not.toBe(loadedTheme.getFgAnsi("bashMode"));
	});

	it("keeps getBashModeBorderColor working for legacy callers", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "legacy-border-theme";
		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");

		expect(loadedTheme.getBashModeBorderColor()("x")).toBe(loadedTheme.getShellModeBorderColor()("x"));
	});
});
