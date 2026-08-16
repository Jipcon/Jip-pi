/**
 * Tests for the shared platform-default shell resolver.
 */

import { describe, expect, it } from "vitest";
import { getDefaultShellKind, type ShellKind } from "../src/shell-platform.ts";

describe("getDefaultShellKind", () => {
	it("returns pwsh on Windows", () => {
		expect(getDefaultShellKind("win32")).toBe("pwsh");
	});

	it("returns bash on Linux", () => {
		expect(getDefaultShellKind("linux")).toBe("bash");
	});

	it("returns bash on macOS", () => {
		expect(getDefaultShellKind("darwin").toLowerCase()).toContain("bash");
	});

	it("returns bash for unknown platforms", () => {
		const result: ShellKind = getDefaultShellKind("freebsd");
		expect(result).toBe("bash");
	});
});
