import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const tokens = readFileSync(resolve("src/renderer/styles/tokens.css"), "utf8");
const syntaxHighlight = readFileSync(resolve("src/renderer/styles/syntax-highlight.css"), "utf8");
const appStyles = readFileSync(resolve("src/renderer/styles/app.css"), "utf8");
const mainProcess = readFileSync(resolve("src/main/main.ts"), "utf8");

describe("fixed application palette", () => {
	test("uses one dark GUI palette without a light-theme override", () => {
		expect(tokens).toContain("--accent: #3b82f6");
		expect(tokens).toContain("--warning: #ffd43b");
		expect(tokens).not.toContain('data-theme="light"');
	});

	test("keeps VS Code Dark+ independent from GUI semantic tokens", () => {
		expect(syntaxHighlight).toContain("background: #1e1e1e");
		expect(syntaxHighlight).toContain("color: #569cd6");
		expect(syntaxHighlight).toContain("color: #b5cea8");
		expect(syntaxHighlight).toContain("color: #ce9178");
		expect(syntaxHighlight).not.toMatch(/var\(--(?:accent|warning)/);
	});

	test("keeps native Windows title-bar controls aligned with the renderer palette", () => {
		expect(mainProcess).toContain('backgroundColor: "#080808"');
		expect(mainProcess).toContain('color: "#101010"');
		expect(mainProcess).toContain('symbolColor: "#c7c7c7"');
	});

	test("keeps the whole title bar draggable, opting out only for interactive controls", () => {
		const topbar = appStyles.match(/\.topbar\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		const topbarRight = appStyles.match(/\.topbar-right\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		const interactive = appStyles.match(/button,\s*select\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		expect(topbar).toContain("-webkit-app-region: drag");
		expect(topbarRight).not.toContain("no-drag");
		expect(interactive).toContain("-webkit-app-region: no-drag");
	});

	test("clips the native textarea scrollbar to the rounded composer shell", () => {
		const composerShell = appStyles.match(/\.composer-shell\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		expect(composerShell).toContain("overflow: hidden");
	});

	test("composites popup menus as shadow, blue-noise dither, surface, then content", () => {
		const menu = appStyles.match(/\.session-context-menu\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		const layers = appStyles.match(
			/\.session-context-menu::before,\s*\.session-context-menu::after,\s*\.session-context-menu-surface\s*\{(?<rules>[^}]*)\}/,
		)?.groups?.rules;
		const shadow = appStyles.match(/\.session-context-menu::before\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		const dither = appStyles.match(/\.session-context-menu::after\s*\{(?<rules>[^}]*)\}/)?.groups?.rules;
		const surface = [...appStyles.matchAll(/\.session-context-menu-surface\s*\{(?<rules>[^}]*)\}/g)].at(-1)?.groups
			?.rules;

		expect(menu).toContain("isolation: isolate");
		expect(menu).toContain("background: transparent");
		expect(menu).toContain("box-shadow: none");
		expect(shadow?.match(/rgba\(0, 0, 0,/g)).toHaveLength(2);
		expect(shadow).not.toContain("var(--shadow-large)");
		expect(dither).toContain("image-set(");
		expect(dither).toContain("menu-blue-noise-1x.png");
		expect(dither).toContain("menu-blue-noise-2x.png");
		expect(dither).toContain("mask-composite: exclude, intersect");
		expect(layers).toContain("pointer-events: none");
		expect(surface).toContain("background: var(--surface-overlay)");

		for (const [fileName, size] of [
			["menu-blue-noise-1x.png", 64],
			["menu-blue-noise-2x.png", 128],
		] as const) {
			const filePath = resolve("src/renderer/assets", fileName);
			expect(existsSync(filePath), `${fileName} should exist`).toBe(true);
			if (!existsSync(filePath)) continue;
			const png = readFileSync(filePath);
			expect(png.readUInt32BE(16)).toBe(size);
			expect(png.readUInt32BE(20)).toBe(size);
		}
	});
});
