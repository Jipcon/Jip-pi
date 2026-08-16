import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentHarnessV4 = fileURLToPath(new URL("../agent/src/harness-v4.ts", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-agent-core\/harness-v4$/, replacement: agentHarnessV4 },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
	test: {
		environment: "node",
	},
});
