import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-agent-protocol$/,
				replacement: fileURLToPath(new URL("../agent-protocol/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-coding-agent$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-gui-adapter$/,
				replacement: fileURLToPath(new URL("../pi-gui-adapter/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-sdk-adapter$/,
				replacement: fileURLToPath(new URL("../pi-sdk-adapter/src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./test/setup.ts"],
		testTimeout: 10000,
	},
});
