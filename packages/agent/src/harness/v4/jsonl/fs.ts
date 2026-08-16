import { mkdirSync, readdirSync } from "node:fs";
import { appendFile, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonlFileSystem } from "./types.ts";

/** Default adapter over the real filesystem. All methods resolve on completion. */
export class NodeJsonlFileSystem implements JsonlFileSystem {
	ensureDirectory(path: string): void {
		mkdirSync(path, { recursive: true });
	}

	async listFiles(directory: string): Promise<string[]> {
		const names = await readdirSync(directory, { withFileTypes: true });
		return names.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
	}

	readTextFile(path: string): Promise<string> {
		return readFile(path, "utf8");
	}

	async readHead(path: string, maxBytes: number): Promise<string> {
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			return buffer.toString("utf8", 0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	writeFile(path: string, data: string): Promise<void> {
		return writeFile(path, data, "utf8");
	}

	appendFile(path: string, data: string): Promise<void> {
		return appendFile(path, data, "utf8");
	}

	rename(source: string, destination: string): Promise<void> {
		return rename(source, destination);
	}

	remove(path: string): Promise<void> {
		return rm(path, { force: true });
	}

	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return false;
			throw error;
		}
	}
}
