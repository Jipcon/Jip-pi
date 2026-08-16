import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-agent-protocol$/,
				replacement: fileURLToPath(new URL("../agent-protocol/src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		environment: "node",
	},
});
