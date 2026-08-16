import { describe, expect, test } from "vitest";
import { workspacePathKey, workspacePathsEqual } from "../src/shared/workspace-path.ts";

describe("workspace path identity", () => {
	test("normalizes Windows drive paths", () => {
		expect(workspacePathKey("C:\\Users\\Dev\\Project\\")).toBe("c:/users/dev/project");
		expect(workspacePathsEqual("D:\\pi", "d:/PI/")).toBe(true);
	});

	test("normalizes UNC paths without losing their prefix", () => {
		expect(workspacePathKey("\\\\Server\\Share\\Project\\")).toBe("//server/share/project");
		expect(workspacePathsEqual("\\\\Server\\Share\\Project", "//server//share/project/")).toBe(true);
	});

	test("keeps POSIX paths case-sensitive", () => {
		expect(workspacePathKey("/work/project/")).toBe("/work/project");
		expect(workspacePathsEqual("/work/Project", "/work/project")).toBe(false);
	});
});
