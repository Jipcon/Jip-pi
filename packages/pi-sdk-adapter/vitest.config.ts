import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30_000,
			env: { PI_OFFLINE: "1" },
		},
		resolve: {
			alias: [
				// coding-agent src uses a node-prefix-less import in auth-storage.ts;
				// normalize it so resolution works from this package's test root.
				{
					find: /^timers\/promises$/,
					replacement: "node:timers/promises",
				},
				{
					find: /^@earendil-works\/pi-agent-protocol$/,
					replacement: fileURLToPath(new URL("../agent-protocol/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: workspaceSourcePaths.codingAgentIndex,
				},
				{
					find: /^@earendil-works\/pi-coding-agent\/(.+)$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/$1.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
			],
		},
	}),
);
