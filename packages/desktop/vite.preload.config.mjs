import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-agent-protocol": fileURLToPath(
				new URL("../agent-protocol/src/index.ts", import.meta.url),
			),
		},
	},
	build: {
		outDir: ".vite/build",
		emptyOutDir: false,
		ssr: true,
		rollupOptions: {
			input: "src/preload/preload.ts",
			output: {
				// The main process loads preload.js through __dirname, so the
				// preload bundle must stay CommonJS.
				format: "cjs",
			},
		},
	},
});
