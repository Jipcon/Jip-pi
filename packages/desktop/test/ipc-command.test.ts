import { describe, expect, test } from "vitest";
import { toCommandResult } from "../src/main/ipc-command.ts";

describe("toCommandResult", () => {
	test("wraps values and void operations", async () => {
		await expect(toCommandResult(() => ["workspace"])).resolves.toEqual({ ok: true, value: ["workspace"] });
		await expect(toCommandResult(async () => {})).resolves.toEqual({ ok: true });
	});

	test("normalizes thrown errors", async () => {
		await expect(
			toCommandResult(() => {
				throw new Error("failed");
			}),
		).resolves.toEqual({ ok: false, error: "failed" });
		await expect(
			toCommandResult(() => {
				throw "plain failure";
			}),
		).resolves.toEqual({ ok: false, error: "plain failure" });
	});
});
