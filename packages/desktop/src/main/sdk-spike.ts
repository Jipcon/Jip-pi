/**
 * Phase 1 packaging spike: verify that the Electron main process can embed
 * the Pi coding-agent SDK directly through the pi-sdk-adapter (host services
 * + one session backend → dispose) in dev, package, and make forms.
 *
 * Enabled via PI_DESKTOP_SDK_SPIKE=1. Results are appended to
 * <userData>/sdk-spike.log so packaged runs are verifiable.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SdkHostServices, SdkSessionBackend } from "@earendil-works/pi-sdk-adapter";
import { app } from "electron";
import { DEFAULT_SESSION_STORAGE } from "../shared/ipc.ts";
import { agentDirPath } from "./agent-host.ts";
import { resolveSessionDirectory } from "./session-storage.ts";

function log(message: string): void {
	const line = `[${new Date().toISOString()}] ${message}`;
	appendFileSync(spikeLogPath(), `${line}\n`, "utf8");
}

function spikeLogPath(): string {
	return join(app.getPath("userData"), "sdk-spike.log");
}

export async function runSdkSpike(): Promise<void> {
	mkdirSync(app.getPath("userData"), { recursive: true });
	log(`spike start (electron ${process.versions.electron}, node ${process.versions.node})`);
	const startedAt = Date.now();
	const workspace = process.env.PI_DESKTOP_SDK_SPIKE_WORKSPACE ?? process.cwd();
	try {
		const hostServices = new SdkHostServices({ agentDir: agentDirPath() });
		const runtime = await hostServices.ensureRuntime();
		const backend = new SdkSessionBackend({
			modelRuntime: runtime,
			agentDir: agentDirPath(),
			resolveSessionDirectory: (workspacePath) => resolveSessionDirectory(workspacePath, DEFAULT_SESSION_STORAGE),
		});
		await backend.start({ workspacePath: workspace });
		log(`createAgentSession ok in ${Date.now() - startedAt}ms sessionId=${backend.sessionId}`);
		backend.subscribe((event) => {
			if (event.type === "agent_started") {
				log("event: agent_started");
			}
		});
		await backend.stop();
		log("dispose ok");
	} catch (error) {
		log(`spike FAILED: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
	}
	log("spike done");
}
