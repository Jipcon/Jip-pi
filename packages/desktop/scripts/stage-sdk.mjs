/**
 * Stage the Pi coding-agent SDK dependency closure for the packaged app.
 *
 * The Electron main bundle externalizes `@earendil-works/pi-coding-agent`
 * (ESM-only, relies on import.meta.url) and loads it at runtime with a real
 * dynamic import. The Vite bundles are self-contained, but the externalized
 * SDK must resolve from real node_modules files inside app.asar, and
 * @electron/packager copies no node_modules here (workspace/hoisted layout).
 *
 * This script walks the production dependency closure of the SDK with real
 * Node module resolution (matching what the packaged main process will do)
 * and copies it into `resources/sdk/node_modules`. The forge
 * `packageAfterCopy` hook copies that directory into the app root before
 * asar packing.
 *
 * Workspace packages (`@earendil-works/pi-*`) are copied as `dist/` +
 * `package.json` only; external npm packages are copied whole.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDirectory, "..", "..");
const destinationDirectory = resolve(desktopDirectory, "resources", "sdk", "node_modules");
const sdkPackageName = "@earendil-works/pi-coding-agent";

/**
 * Excluded from the staged closure: optional native clipboard packages are
 * never touched by the SDK entry the GUI uses, and their absence is guarded
 * at runtime (loadClipboardNative catches load failures).
 */
const EXCLUDED_PACKAGES = new Set(["@mariozechner/clipboard", "@mariozechner/clipboard-darwin-arm64", "@mariozechner/clipboard-darwin-universal", "@mariozechner/clipboard-darwin-x64", "@mariozechner/clipboard-linux-arm64-gnu", "@mariozechner/clipboard-linux-arm64-musl", "@mariozechner/clipboard-linux-riscv64-gnu", "@mariozechner/clipboard-linux-x64-gnu", "@mariozechner/clipboard-linux-x64-musl", "@mariozechner/clipboard-win32-arm64-msvc", "@mariozechner/clipboard-win32-x64-msvc"]);

function isWorkspacePackage(name) {
	return name.startsWith("@earendil-works/pi-");
}

/**
 * Map workspace package names to their source directories by scanning the
 * monorepo's packages/ directory (npm ls resolved paths for workspace links
 * are relative to junction realpaths and are not worth parsing).
 */
function workspacePackageDirectory(name) {
	for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = join(repoRoot, "packages", entry.name, "package.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (manifest.name === name) {
				return join(repoRoot, "packages", entry.name);
			}
		} catch {
			// Skip unreadable manifests.
		}
	}
	return null;
}

function packageManifest(directory) {
	const manifestPath = join(directory, "package.json");
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Resolve a bare package specifier to its installed directory using real
 * Node ESM resolution from `fromDirectory` (mimics the packaged main
 * process). Returns null when the package is not installed.
 */
function resolvePackageDirectory(name, fromDirectory) {
	const referrer = pathToFileURL(join(fromDirectory, "package.json")).href;
	for (const specifier of [`${name}/package.json`, name]) {
		try {
			const resolved = import.meta.resolve(specifier, referrer);
			if (!resolved.startsWith("file:")) continue;
			let directory = dirname(fileURLToPath(resolved));
			for (let depth = 0; depth < 8; depth += 1) {
				const manifest = packageManifest(directory);
				if (manifest?.name === name) {
					return directory;
				}
				const parent = dirname(directory);
				if (parent === directory) break;
				directory = parent;
			}
		} catch {
			// Try the next specifier.
		}
	}
	return null;
}

/**
 * Walk the production dependency closure breadth-first. Returns a map from
 * package name to its installed directory.
 */
function computeClosure() {
	const closure = new Map();
	const missing = [];
	const queue = [{ name: sdkPackageName, from: repoRoot }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (closure.has(current.name) || EXCLUDED_PACKAGES.has(current.name)) continue;
		const directory = isWorkspacePackage(current.name)
			? workspacePackageDirectory(current.name)
			: resolvePackageDirectory(current.name, current.from);
		if (!directory) {
			missing.push(`${current.name} (required by ${current.from === repoRoot ? "desktop" : "the SDK closure"})`);
			continue;
		}
		closure.set(current.name, directory);
		const manifest = packageManifest(directory);
		if (!manifest) continue;
		const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
		for (const depName of Object.keys(dependencies)) {
			if (EXCLUDED_PACKAGES.has(depName) || closure.has(depName)) continue;
			queue.push({ name: depName, from: directory });
		}
	}
	return { closure, missing };
}

function copyWorkspacePackage(name, sourcePath) {
	const destination = join(destinationDirectory, ...name.split("/"));
	mkdirSync(destination, { recursive: true });
	if (!existsSync(join(sourcePath, "dist"))) {
		throw new Error(`Workspace package ${name} has no dist directory at ${sourcePath}; run its build first.`);
	}
	// The coding-agent dist carries the bun-compiled CLI binary next to the
	// SDK code. The GUI ships its own backend at resources/backend/pi.exe
	// and only ever loads the SDK entry (dist/index.js), so the duplicate
	// ~111 MB binary is skipped here; it would otherwise land in app.asar
	// and bloat the installer.
	const compiledCliBinaries =
		name === sdkPackageName
			? [join(sourcePath, "dist", "pi.exe"), join(sourcePath, "dist", "pi")]
			: [];
	cpSync(join(sourcePath, "dist"), join(destination, "dist"), {
		recursive: true,
		filter: (source) => !compiledCliBinaries.includes(source),
	});
	cpSync(join(sourcePath, "package.json"), join(destination, "package.json"));
	for (const asset of ["README.md", "CHANGELOG.md", "LICENSE", "LICENSE.md"]) {
		const assetPath = join(sourcePath, asset);
		if (existsSync(assetPath)) {
			cpSync(assetPath, join(destination, asset));
		}
	}
	return destination;
}

function copyExternalPackage(name, sourcePath) {
	const destination = join(destinationDirectory, ...name.split("/"));
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(sourcePath, destination, { recursive: true, dereference: true });
	return destination;
}

function dirSize(directory) {
	let total = 0;
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath);
			} else {
				total += statSync(entryPath).size;
			}
		}
	}
	walk(directory);
	return total;
}

function main() {
	const { closure, missing } = computeClosure();
	if (missing.length > 0) {
		throw new Error(`SDK closure is missing installed packages:\n  ${missing.join("\n  ")}`);
	}

	rmSync(destinationDirectory, { recursive: true, force: true });
	mkdirSync(destinationDirectory, { recursive: true });

	const copied = [];
	for (const [name, sourcePath] of closure) {
		let realPath;
		try {
			realPath = realpathSync(sourcePath);
		} catch {
			realPath = sourcePath;
		}
		const destination = isWorkspacePackage(name)
			? copyWorkspacePackage(name, realPath)
			: copyExternalPackage(name, realPath);
		copied.push(`${name} -> ${relative(repoRoot, destination)}`);
	}

	const sizeMb = (dirSize(destinationDirectory) / (1024 * 1024)).toFixed(1);
	console.log(`Staged SDK closure: ${copied.length} packages, ${sizeMb} MB`);
	for (const line of copied) {
		console.log(`  ${line}`);
	}
}

main();
