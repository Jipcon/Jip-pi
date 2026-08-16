import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const aiSrc = fileURLToPath(new URL("../ai/src/", import.meta.url));

const workspaceAliases = [
	{
		find: /^@earendil-works\/pi-agent-protocol$/,
		replacement: fileURLToPath(new URL("../agent-protocol/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-agent-core$/,
		replacement: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-ai$/,
		replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-ai\/(.+)$/,
		replacement: `${aiSrc}$1.ts`,
	},
	{
		find: /^@earendil-works\/pi-tui$/,
		replacement: fileURLToPath(new URL("../tui/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-telemetry$/,
		replacement: fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-gui-adapter$/,
		replacement: fileURLToPath(new URL("../pi-gui-adapter/src/index.ts", import.meta.url)),
	},
	{
		find: /^@earendil-works\/pi-sdk-adapter$/,
		replacement: fileURLToPath(new URL("../pi-sdk-adapter/src/index.ts", import.meta.url)),
	},
];

export default defineConfig({
	resolve: {
		alias: workspaceAliases,
	},
	build: {
		outDir: ".vite/build",
		emptyOutDir: false,
		ssr: true,
		rollupOptions: {
			input: "src/main/main.ts",
			// The coding-agent SDK is ESM-only and relies on import.meta.url
			// (fileURLToPath, createRequire, import.meta.resolve, jiti).
			// Keep it out of the CJS main bundle: Vite would rewrite
			// import.meta to `{}` and the app would crash at startup with
			// fileURLToPath(undefined). sdk-spike.ts loads it at runtime via
			// a real dynamic import instead.
			external: [/^@earendil-works\/pi-coding-agent$/],
			output: {
				// Electron main expects a CommonJS bundle (package.json main
				// points at main.js and the code uses __dirname).
				format: "cjs",
				// Preserve the external dynamic import as import() in CJS
				// output instead of rewriting it to require() (which cannot
				// load the ESM-only SDK).
				dynamicImportInCjs: true,
			},
		},
	},
});