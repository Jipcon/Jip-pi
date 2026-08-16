import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WorkspacePathEscapeError } from "./workspace-errors.ts";

/** Streams a file and returns its sha256 hex digest. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	const transform = new Transform({
		transform(chunk: Uint8Array, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	await pipeline(createReadStream(path), transform, sink);
	return hash.digest("hex");
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** lstat kind classification without following links. */
export async function lstatKind(path: string): Promise<"file" | "directory" | "link" | "other" | "absent"> {
	try {
		const stats = await lstat(path);
		return stats.isSymbolicLink() ? "link" : stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return "absent";
		throw error;
	}
}

/**
 * Joins a validated repo-relative manifest path onto a root, re-validating
 * that the physical result stays inside the root. Throws WorkspacePathEscape.
 */
export function joinUnderRoot(root: string, validatedRelativePath: string): string {
	const physical = resolve(root, ...validatedRelativePath.split("/"));
	const prefix = resolve(root);
	if (physical !== prefix && !physical.startsWith(`${prefix}\\`) && !physical.startsWith(`${prefix}/`)) {
		throw new WorkspacePathEscapeError(
			`path ${JSON.stringify(validatedRelativePath)} escapes root ${JSON.stringify(root)}`,
		);
	}
	return physical;
}

/** Same-volume temporary sibling + rename replacement for one file. */
export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.pi-adaptive-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
	try {
		await writeFile(temporary, bytes);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function isLockError(code: string | undefined): boolean {
	return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY" || code === "EACCES";
}

/**
 * Bounded rm retry for Windows EPERM/EBUSY/ENOTEMPTY/EACCES. Non-lock errors
 * propagate immediately. Returns false when the retry budget is exhausted by
 * locks (caller decides the orphan path); true on success.
 */
export interface RemoveRetryOptions {
	maxAttempts?: number;
	delayMs?: number;
}

export async function rmWithRetry(path: string, options: RemoveRetryOptions = {}): Promise<boolean> {
	const maxAttempts = options.maxAttempts ?? 5;
	const delayMs = options.delayMs ?? 250;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await rm(path, { recursive: true, force: true, maxRetries: 0 });
			return true;
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (!isLockError(code)) throw error;
			if (attempt >= maxAttempts) return false;
			await delay(delayMs);
		}
	}
	return false;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export interface PathHashing {
	kind: "file";
	hash: string;
}

export interface PathHashingAbsent {
	kind: "absent";
	hash: null;
}

export interface PathHashingLink {
	kind: "link";
	hash: null;
	target: string;
}

export type PathHash = PathHashing | PathHashingAbsent | PathHashingLink;

/** lstat + sha256 of a root-relative path (never follows links). */
export async function hashPathAt(root: string, path: string): Promise<PathHash> {
	const physical = joinUnderRoot(root, path);
	const kind = await lstatKind(physical);
	if (kind === "absent") return { kind: "absent", hash: null };
	if (kind === "link") {
		const target = await readlink(physical);
		return { kind: "link", hash: null, target: target.replaceAll("\\", "/") };
	}
	if (kind !== "file") {
		throw new WorkspacePathEscapeError(`path ${JSON.stringify(path)} is not a regular file`);
	}
	return { kind: "file", hash: await sha256File(physical) };
}

/** Lists entries of a directory (empty array when absent). */
export async function listDirEntries(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return [];
		throw error;
	}
}
