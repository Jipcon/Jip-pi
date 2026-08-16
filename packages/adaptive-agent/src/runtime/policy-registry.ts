import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness-v4";
import {
	canonicalJson,
	fingerprintPolicyBundle,
	isSha256Fingerprint,
	type PolicyBundle,
	type PolicyBundleRef,
	sha256Hex,
	validatePolicyBundle,
} from "./policy-bundle.ts";

export type PolicyRegistryErrorCode = "missing" | "corrupt" | "conflict" | "invalid_bundle" | "storage" | "closed";

export class PolicyRegistryError extends Error {
	readonly code: PolicyRegistryErrorCode;

	constructor(code: PolicyRegistryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "PolicyRegistryError";
		this.code = code;
	}
}

/**
 * Immutable policy content authority. publish/resolve always validate the
 * canonical SHA-256 fingerprint; a version can never be overwritten with
 * different content. Content is immutable: once published, the same
 * version+fingerprint always resolves to the same canonical bundle.
 */
export interface PolicyRegistry {
	publish(bundle: PolicyBundle): Promise<PolicyBundleRef>;
	resolve(ref: PolicyBundleRef): Promise<PolicyBundle>;
	list(): Promise<PolicyBundleRef[]>;
	close(): Promise<void>;
}

export class InMemoryPolicyRegistry implements PolicyRegistry {
	private readonly bundles = new Map<string, { content: PolicyBundle; fingerprint: string }>();
	private closed = false;

	async publish(bundle: PolicyBundle): Promise<PolicyBundleRef> {
		this.ensureOpen();
		const invalid = validatePolicyBundle(bundle);
		if (invalid !== undefined) throw new PolicyRegistryError("invalid_bundle", invalid);
		const fingerprint = fingerprintPolicyBundle(bundle);
		const existing = this.bundles.get(bundle.version);
		if (existing !== undefined && existing.fingerprint !== fingerprint) {
			throw new PolicyRegistryError(
				"conflict",
				`PolicyBundle ${bundle.version} already exists with different content (${existing.fingerprint})`,
			);
		}
		this.bundles.set(bundle.version, { content: structuredClone(bundle), fingerprint });
		return { version: bundle.version, fingerprint };
	}

	async resolve(ref: PolicyBundleRef): Promise<PolicyBundle> {
		this.ensureOpen();
		this.validateRef(ref);
		const stored = this.bundles.get(ref.version);
		if (stored === undefined) {
			throw new PolicyRegistryError("missing", `PolicyBundle ${ref.version} is not published`);
		}
		if (stored.fingerprint !== ref.fingerprint) {
			throw new PolicyRegistryError(
				"corrupt",
				`PolicyBundle ${ref.version} fingerprint ${ref.fingerprint} does not match stored content`,
			);
		}
		return structuredClone(stored.content);
	}

	async list(): Promise<PolicyBundleRef[]> {
		this.ensureOpen();
		return [...this.bundles.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([version, { fingerprint }]) => ({ version, fingerprint }));
	}

	async close(): Promise<void> {
		this.closed = true;
		this.bundles.clear();
	}

	private ensureOpen(): void {
		if (this.closed) throw new PolicyRegistryError("closed", "PolicyRegistry is closed");
	}

	private validateRef(ref: PolicyBundleRef): void {
		if (typeof ref !== "object" || ref === null)
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref must be an object");
		if (typeof ref.version !== "string" || ref.version.length === 0) {
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref version must be a non-empty string");
		}
		if (!isSha256Fingerprint(ref.fingerprint)) {
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref fingerprint must be a canonical sha256");
		}
	}
}

/** Local durable registry: one canonical JSON file per published version, atomic publication. */
export class JsonlPolicyRegistry implements PolicyRegistry {
	private readonly directory: string;
	private closed = false;

	constructor(options: { directory: string }) {
		this.directory = options.directory;
	}

	async publish(bundle: PolicyBundle): Promise<PolicyBundleRef> {
		this.ensureOpen();
		const invalid = validatePolicyBundle(bundle);
		if (invalid !== undefined) throw new PolicyRegistryError("invalid_bundle", invalid);
		const fingerprint = fingerprintPolicyBundle(bundle);
		const target = this.pathFor(bundle.version);
		try {
			const existing = await readFile(target, "utf8");
			const parsed = JSON.parse(existing) as PolicyBundle;
			if (fingerprintPolicyBundle(parsed) !== fingerprint) {
				throw new PolicyRegistryError(
					"conflict",
					`PolicyBundle ${bundle.version} already exists with different content`,
				);
			}
			return { version: bundle.version, fingerprint };
		} catch (error) {
			if (error instanceof PolicyRegistryError) throw error;
			if (!isMissingFile(error)) {
				throw new PolicyRegistryError("storage", `Failed to read PolicyBundle ${bundle.version}`, toError(error));
			}
		}
		const content = `${canonicalJson(bundle as unknown as JsonValue)}\n`;
		const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
		try {
			await mkdir(this.directory, { recursive: true });
			await writeFile(temporary, content, "utf8");
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw new PolicyRegistryError("storage", `Failed to publish PolicyBundle ${bundle.version}`, toError(error));
		}
		return { version: bundle.version, fingerprint };
	}

	async resolve(ref: PolicyBundleRef): Promise<PolicyBundle> {
		this.ensureOpen();
		this.validateRef(ref);
		let bundle: PolicyBundle;
		try {
			bundle = JSON.parse(await readFile(this.pathFor(ref.version), "utf8")) as PolicyBundle;
		} catch (error) {
			if (isMissingFile(error)) {
				throw new PolicyRegistryError("missing", `PolicyBundle ${ref.version} is not published`);
			}
			throw new PolicyRegistryError("corrupt", `PolicyBundle ${ref.version} is not valid JSON`, toError(error));
		}
		const fingerprint = fingerprintPolicyBundle(bundle);
		if (fingerprint !== ref.fingerprint) {
			throw new PolicyRegistryError(
				"corrupt",
				`PolicyBundle ${ref.version} fingerprint ${ref.fingerprint} does not match stored content (${fingerprint})`,
			);
		}
		const invalid = validatePolicyBundle(bundle);
		if (invalid !== undefined) {
			throw new PolicyRegistryError("corrupt", `PolicyBundle ${ref.version} is invalid: ${invalid}`);
		}
		return bundle;
	}

	async list(): Promise<PolicyBundleRef[]> {
		this.ensureOpen();
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if (isMissingFile(error)) return [];
			throw new PolicyRegistryError("storage", "Failed to list the PolicyRegistry directory", toError(error));
		}
		const refs: PolicyBundleRef[] = [];
		for (const name of names.sort()) {
			if (!name.startsWith("bundle-") || !name.endsWith(".json")) continue;
			try {
				const bundle = JSON.parse(await readFile(join(this.directory, name), "utf8")) as PolicyBundle;
				refs.push({ version: bundle.version, fingerprint: fingerprintPolicyBundle(bundle) });
			} catch {
				throw new PolicyRegistryError("corrupt", `PolicyBundle file ${name} is corrupt`);
			}
		}
		return refs.sort((left, right) => left.version.localeCompare(right.version));
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private ensureOpen(): void {
		if (this.closed) throw new PolicyRegistryError("closed", "PolicyRegistry is closed");
	}

	private validateRef(ref: PolicyBundleRef): void {
		if (typeof ref !== "object" || ref === null)
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref must be an object");
		if (typeof ref.version !== "string" || ref.version.length === 0) {
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref version must be a non-empty string");
		}
		if (!isSha256Fingerprint(ref.fingerprint)) {
			throw new PolicyRegistryError("invalid_bundle", "policy bundle ref fingerprint must be a canonical sha256");
		}
	}

	private pathFor(version: string): string {
		// Filenames never splice the raw version: path traversal and reserved
		// names are impossible; the version stays inside the file content.
		return join(this.directory, `bundle-${sha256Hex(version).slice(0, 24)}.json`);
	}
}

function isMissingFile(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
