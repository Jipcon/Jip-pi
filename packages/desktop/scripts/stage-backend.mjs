import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendBuildDirectory = resolve(desktopDirectory, "..", "coding-agent", "dist");
const destinationDirectory = resolve(desktopDirectory, "resources", "backend");
const executable = join(backendBuildDirectory, "pi.exe");

if (!existsSync(executable)) {
	throw new Error(`Backend binary not found: ${executable}. Run the coding-agent build:binary script first.`);
}

mkdirSync(destinationDirectory, { recursive: true });
for (const entry of readdirSync(backendBuildDirectory, { withFileTypes: true })) {
	const source = join(backendBuildDirectory, entry.name);
	const destination = join(destinationDirectory, entry.name);
	cpSync(source, destination, { recursive: entry.isDirectory(), force: true });
}

console.log(`Staged Pi backend from ${backendBuildDirectory} to ${destinationDirectory}`);
