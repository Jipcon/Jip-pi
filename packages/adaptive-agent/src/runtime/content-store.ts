import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SourceWorkspaceChangedError, WorkspaceManagerFault } from "./workspace-errors.ts";
import { sha256File } from "./workspace-fs.ts";

/**
 * Manager-owned content-addressed byte store for untracked snapshot content.
 * Bytes are copied here at capture time (no hardlinks) and are the only
 * restoration source for forks and promotion recovery copies.
 */
export class ContentStore {
	private readonly root: string;

	constructor(options: { root: string }) {
		this.root = options.root;
	}

	private blobPath(hash: string): string {
		return join(this.root, hash);
	}

	async has(hash: string): Promise<boolean> {
		try {
			await readFile(this.blobPath(hash));
			return true;
		} catch {
			return false;
		}
	}

	/** Copies a source file into the store, verifying the expected hash. */
	async putFile(sourcePath: string, expectedHash: string): Promise<void> {
		const blobPath = this.blobPath(expectedHash);
		await mkdir(this.root, { recursive: true });
		if (await this.has(expectedHash)) return;
		const temporary = `${blobPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
		try {
			await copyFile(sourcePath, temporary);
			const actual = await sha256File(temporary);
			if (actual !== expectedHash) {
				// The source bytes changed while the snapshot was being
				// captured: a source-drift signal, not a store fault.
				throw new SourceWorkspaceChangedError(`${sourcePath} changed while its content was being captured`);
			}
			await copyFile(temporary, blobPath, 1);
			await rm(temporary, { force: true });
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			if (error instanceof SourceWorkspaceChangedError) throw error;
			if ((error as { code?: string }).code === "EEXIST") return;
			throw new WorkspaceManagerFault(
				`Failed to copy ${sourcePath} into the content store`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/** Puts bytes already in memory (small payloads only). */
	async putBytes(bytes: Uint8Array): Promise<string> {
		const hash = createHash("sha256").update(bytes).digest("hex");
		const blobPath = this.blobPath(hash);
		await mkdir(this.root, { recursive: true });
		if (!(await this.has(hash))) {
			const temporary = `${blobPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
			try {
				await writeFile(temporary, bytes);
				await copyFile(temporary, blobPath, 1);
				await rm(temporary, { force: true });
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw new WorkspaceManagerFault(
					"Failed to write bytes into the content store",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return hash;
	}

	/** Byte-copies a stored blob to a destination path (no hardlinks) and verifies. */
	async copyTo(hash: string, destinationPath: string): Promise<void> {
		try {
			await copyFile(this.blobPath(hash), destinationPath);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") {
				throw new WorkspaceManagerFault(`Content store blob ${hash} is missing`);
			}
			throw new WorkspaceManagerFault(
				`Failed to materialize content store blob ${hash}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		const actual = await sha256File(destinationPath);
		if (actual !== hash) {
			await rm(destinationPath, { force: true }).catch(() => undefined);
			throw new WorkspaceManagerFault(`Materialized blob ${hash} failed integrity verification`);
		}
	}

	async read(hash: string): Promise<Uint8Array> {
		try {
			const bytes = await readFile(this.blobPath(hash));
			const actual = createHash("sha256").update(bytes).digest("hex");
			if (actual !== hash) throw new WorkspaceManagerFault(`Content store blob ${hash} is corrupt`);
			return bytes;
		} catch (error) {
			if (error instanceof WorkspaceManagerFault) throw error;
			if ((error as { code?: string }).code === "ENOENT") {
				throw new WorkspaceManagerFault(`Content store blob ${hash} is missing`);
			}
			throw new WorkspaceManagerFault(
				`Failed to read content store blob ${hash}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	async remove(hash: string): Promise<void> {
		await rm(this.blobPath(hash), { force: true });
	}

	get rootPath(): string {
		return this.root;
	}
}
