/**
 * Stage the electron-builder app directory at release/staging.
 *
 * The staged tree contains exactly what the packaged app needs:
 * - the vite bundles (.vite/main build, .vite/renderer output)
 * - the externalized coding-agent SDK closure (resources/sdk/node_modules,
 *   staged by stage-sdk.mjs) as real node_modules directories
 * - assets/ (the window icon is loaded at runtime from app.asar/assets)
 * - a trimmed package.json whose dependency list contains only the
 *   externalized SDK, so electron-builder's production dependency walker
 *   ships the staged closure and does not try to resolve bundled-only
 *   dependencies (react, katex, ...) that live exclusively in the vite
 *   bundles.
 *
 * The Pi backend binary is not staged here; electron-builder copies
 * resources/backend into <install>/resources/backend via extraResources.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = resolve(desktopDirectory, "release", "staging");
const viteOutputDirectory = resolve(desktopDirectory, ".vite");
const sdkClosureDirectory = resolve(desktopDirectory, "resources", "sdk", "node_modules");
const assetsDirectory = resolve(desktopDirectory, "assets");
const sdkPackageName = "@earendil-works/pi-coding-agent";

const manifest = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));

if (!existsSync(join(viteOutputDirectory, "build", "main.js"))) {
	throw new Error(".vite/build/main.js is missing. Run the desktop build:vite script first.");
}
if (!existsSync(join(viteOutputDirectory, "build", "preload.js"))) {
	throw new Error(".vite/build/preload.js is missing. Run the desktop build:vite script first.");
}
if (!existsSync(sdkClosureDirectory)) {
	throw new Error("Staged SDK node_modules is missing. Run the desktop stage:sdk script first.");
}
if (!manifest.dependencies?.[sdkPackageName]) {
	throw new Error(`Desktop package.json is missing the ${sdkPackageName} dependency.`);
}

// The runtime dependency list is only the externalized SDK; everything else
// is bundled by vite. electron (devDependency) is kept so electron-builder
// can read the Electron version it must download and package.
const stagedManifest = {
	name: manifest.name,
	productName: manifest.productName,
	version: manifest.version,
	description: manifest.description,
	license: manifest.license,
	author: manifest.author,
	main: manifest.main,
	dependencies: { [sdkPackageName]: manifest.dependencies[sdkPackageName] },
	devDependencies: { electron: manifest.devDependencies.electron },
};

rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });
writeFileSync(join(stagingDirectory, "package.json"), `${JSON.stringify(stagedManifest, null, "\t")}\n`);
cpSync(viteOutputDirectory, join(stagingDirectory, ".vite"), { recursive: true });
cpSync(assetsDirectory, join(stagingDirectory, "assets"), { recursive: true });
cpSync(sdkClosureDirectory, join(stagingDirectory, "node_modules"), { recursive: true, dereference: true });

console.log(`Staged electron-builder app directory at ${stagingDirectory}`);
