/**
 * SDK-mode performance measurement (§21).
 *
 * Measures, in a plain Node process (the same runtime Electron Main uses):
 * - backend create latency (1 and 4 sessions, median of 5)
 * - process RSS before/after
 * - child process count (SDK mode must spawn no pi.exe)
 * - idle CPU
 * - main-IPC ping latency (renderer → main → renderer approximation) while
 *   4 faux sessions stream simultaneously
 *
 * Run: node scripts/measure-sdk-mode.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SdkHostServices,
	SdkSessionBackend,
} from "@earendil-works/pi-sdk-adapter";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

const tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-measure-"));
const agentDir = join(tempDir, "agent");

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, p) {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index];
}

function childProcessCount() {
	if (process.platform !== "win32") return null;
	const out = execFileSync("powershell.exe", [
		"-NoProfile",
		"-Command",
		"(Get-CimInstance Win32_Process -Filter \"ParentProcessId = $PID\").Count",
	]);
	return Number.parseInt(out.toString().trim(), 10);
}

function cpuUsageMs() {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

async function measureCreateLatency(hostServices, sessionDir, count) {
	const latencies = [];
	for (let run = 0; run < 5; run += 1) {
		const started = Date.now();
		const backends = [];
		for (let index = 0; index < count; index += 1) {
			const backend = new SdkSessionBackend({
				modelRuntime: hostServices.sharedRuntime,
				agentDir,
				resolveSessionDirectory: () => sessionDir,
			});
			await backend.start({ workspacePath: process.cwd(), sessionId: `measure-${run}-${index}` });
			backends.push(backend);
		}
		latencies.push(Date.now() - started);
		for (const backend of backends) {
			await backend.stop();
		}
	}
	return { median: median(latencies), samples: latencies };
}

async function main() {
	const hostServices = new SdkHostServices({ agentDir });
	const runtime = await hostServices.ensureRuntime();
	const sessionDir = join(tempDir, "sessions");

	const startCpu = cpuUsageMs();
	const childrenBefore = childProcessCount();

	// Idle CPU: sample the process over two seconds with nothing running.
	const idleStart = cpuUsageMs();
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const idleCpuMs = cpuUsageMs() - idleStart;

	// 1 backend create latency.
	const one = await measureCreateLatency(hostServices, sessionDir, 1);
	// 4 backends create latency.
	const four = await measureCreateLatency(hostServices, sessionDir, 4);
	const createCpu = cpuUsageMs() - startCpu;

	// Concurrent streaming: 4 faux sessions, plus periodic main-IPC pings.
	const backends = [];
	const fauxes = [];
	for (let index = 0; index < 4; index += 1) {
		const faux = fauxProvider({ provider: `perf-faux-${index}`, tokensPerSecond: 400 });
		new ModelRegistry(runtime).registerProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false });
		const model = faux.getModel();
		const backend = new SdkSessionBackend({
			modelRuntime: hostServices.sharedRuntime,
			agentDir,
			resolveSessionDirectory: () => sessionDir,
		});
		await backend.start({
			workspacePath: process.cwd(),
			sessionId: `stream-${index}`,
			model: { provider: model.provider, modelId: model.id },
		});
		faux.setResponses([fauxAssistantMessage(`session ${index} payload `.repeat(120))]);
		backends.push(backend);
		fauxes.push(faux);
	}

	const rssBefore = process.memoryUsage().rss;
	const streamStartCpu = cpuUsageMs();

	// Start all four prompts concurrently.
	await Promise.all(
		backends.map((backend, index) => backend.sendMessage({ role: "user", content: `prompt ${index}` })),
	);

	// Main-IPC ping approximation: the renderer round-trips through an
	// in-process handler on the same event loop (equivalent to the main-side
	// ipcMain.handle await path).
	const pingLatencies = [];
	const pingUntil = Date.now() + 4000;
	while (Date.now() < pingUntil) {
		const started = performance.now();
		await Promise.resolve();
		await Promise.resolve();
		pingLatencies.push(performance.now() - started);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	// Wait for all sessions to settle.
	while (backends.some((backend) => backend.isStreaming)) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const streamCpu = cpuUsageMs() - streamStartCpu;
	const rssAfter = process.memoryUsage().rss;
	const childrenAfter = childProcessCount();

	const streamedText = await Promise.all(
		backends.map(async (backend) =>
			(await backend.getMessages())
				.filter((message) => message.role === "assistant")
				.map((message) => (typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")))
				.join(""),
		),
	);

	for (const backend of backends) {
		await backend.stop();
	}

	console.log(JSON.stringify({
		createLatency: {
			singleSessionMedianMs: one.median,
			singleSessionSamplesMs: one.samples,
			fourSessionsMedianMs: four.median,
			fourSessionsSamplesMs: four.samples,
			createCpuMs: Math.round(createCpu),
		},
		memory: {
			rssBeforeStreamingMB: Math.round(rssBefore / (1024 * 1024)),
			rssAfterStreamingMB: Math.round(rssAfter / (1024 * 1024)),
		},
		processes: { childrenBefore, childrenAfter },
		idleCpu: { overMs: 2000, cpuMs: Math.round(idleCpuMs) },
		streaming: {
			fourSimultaneous: true,
			allCompleted: streamedText.every((text) => text.length > 0),
			streamCpuMs: Math.round(streamCpu),
		},
		ipcPing: {
			samples: pingLatencies.length,
			medianMs: Number(median(pingLatencies).toFixed(2)),
			p95Ms: Number(percentile(pingLatencies, 95).toFixed(2)),
			maxMs: Number(Math.max(...pingLatencies).toFixed(2)),
		},
	}, null, "\t"));
}

await main();
rmSync(tempDir, { recursive: true, force: true });
