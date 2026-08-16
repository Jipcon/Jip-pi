import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	// Pin the dev server port so the main process can find it deterministically
	// (the forge-provided MAIN_WINDOW_VITE_DEV_SERVER_URL define is racy).
	// PI_DESKTOP_VITE_PORT lets parallel dev sessions pick a free port.
	server: {
		port: Number(process.env.PI_DESKTOP_VITE_PORT ?? 5173),
		strictPort: true,
		// Packaging writes into release/ and .vite while the dev server runs
		// (electron-builder renames win-unpacked.tmp during packaging); the
		// chokidar watcher must not hold directory handles there.
		watch: {
			ignored: ["**/release/**", "**/.vite/**", "**/resources/**"],
		},
	},
	build: {
		outDir: ".vite/renderer/main_window",
		emptyOutDir: true,
	},
	resolve: {
		alias: {
			"@earendil-works/pi-agent-protocol": fileURLToPath(
				new URL("../agent-protocol/src/index.ts", import.meta.url),
			),
		},
	},
});
