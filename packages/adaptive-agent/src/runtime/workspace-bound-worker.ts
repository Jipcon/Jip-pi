import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ExecutionEnvironment, LogicalWorkspaceIdentity } from "./execution-environment.ts";
import { WorkspacePathEscapeError } from "./workspace-errors.ts";
import { joinUnderRoot, lstatKind } from "./workspace-fs.ts";
import type { WorkspaceLease } from "./workspace-manager.ts";

/**
 * Hidden worker binding (DESIGN §11, S7.6): one candidate = one hidden
 * harness + one WorkspaceLease + one ExecutionEnv. The physical cwd is the
 * lease root; only the logical root is ever model-visible. WorkspaceManager
 * provides file-state isolation, never a process/network sandbox.
 */

export type PhysicalToLogicalMapper = (physicalPath: string) => string;

/** Typed logical/physical path mapping for tool inputs, results, and errors. */
export class WorkspacePathAdapter {
	private readonly logical: LogicalWorkspaceIdentity;
	private readonly physicalRoot: string;

	constructor(options: { logicalWorkspace: LogicalWorkspaceIdentity; physicalRoot: string }) {
		this.logical = options.logicalWorkspace;
		this.physicalRoot = options.physicalRoot;
	}

	/** Projects a logical (model-visible) path onto the physical lease root. */
	toPhysicalPath(logicalPath: string): string {
		return projectLogicalToPhysical(logicalPath, this.logical.root, this.physicalRoot);
	}

	/** Projects a physical lease-root path back into the logical namespace. */
	toLogicalPath(physicalPath: string): string {
		return projectPhysicalToLogical(physicalPath, this.logical, this.physicalRoot);
	}

	/**
	 * Validates that a logical path does not escape the workspace namespace
	 * when projected. Absolute, `..`-escaping, and sibling-root paths throw.
	 */
	assertInside(logicalPath: string): string {
		return this.toPhysicalPath(logicalPath);
	}

	get logicalRoot(): string {
		return this.logical.root;
	}

	get physicalRootPath(): string {
		return this.physicalRoot;
	}
}

export function projectLogicalToPhysical(logicalPath: string, logicalRoot: string, physicalRoot: string): string {
	const normalized = logicalPath.replaceAll("\\", "/");
	const root = logicalRoot.replace(/\/+$/, "");
	if (normalized === root) return physicalRoot;
	if (normalized.startsWith(`${root}/`)) {
		return joinUnderRoot(physicalRoot, normalized.slice(root.length + 1));
	}
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		throw new WorkspacePathEscapeError(
			`absolute path ${JSON.stringify(logicalPath)} is outside the logical workspace`,
		);
	}
	if (normalized.split("/").includes("..")) {
		throw new WorkspacePathEscapeError(`path ${JSON.stringify(logicalPath)} escapes the logical workspace`);
	}
	// Unknown relative paths are joined against the physical root directly.
	return joinUnderRoot(physicalRoot, normalized);
}

export function projectPhysicalToLogical(
	physicalPath: string,
	logical: LogicalWorkspaceIdentity,
	physicalRoot: string,
): string {
	const prefix = physicalRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalized = physicalPath.replaceAll("\\", "/");
	if (normalized === prefix) return logical.root;
	if (!normalized.startsWith(`${prefix}/`)) {
		// A path outside the lease root has no safe logical projection.
		throw new WorkspacePathEscapeError(`physical path ${JSON.stringify(physicalPath)} is outside the lease root`);
	}
	return `${logical.root}/${normalized.slice(prefix.length + 1)}`;
}

/**
 * ExecutionEnv bound to one lease root. File and shell effects resolve
 * against the physical root; cleanup() stops child processes before the
 * lease is released.
 */
export class BoundWorkspaceExecutionEnv extends NodeExecutionEnv {
	readonly leaseId: string;
	private cleaned = false;

	constructor(options: { lease: WorkspaceLease; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		super({ cwd: options.lease.root, shellPath: options.shellPath, shellEnv: options.shellEnv });
		this.leaseId = options.lease.id;
	}

	override async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		await super.cleanup();
	}
}

/** Environment projection handed to harness construction for one candidate. */
export function boundExecutionEnvironment(lease: WorkspaceLease): ExecutionEnvironment {
	return lease.environment;
}

/** Release order for a hidden worker: env processes stop, then the lease. */
export async function releaseBoundWorker(input: {
	env?: ExecutionEnv | undefined;
	closeHarness: () => Promise<void>;
	lease: WorkspaceLease;
}): Promise<void> {
	let firstError: unknown;
	try {
		await input.closeHarness();
	} catch (error) {
		firstError = error;
	}
	try {
		await input.env?.cleanup();
	} catch (error) {
		firstError ??= error;
	}
	try {
		await input.lease.release();
	} catch (error) {
		firstError ??= error;
	}
	if (firstError !== undefined) throw firstError;
}

/** Physical-kind check used by tests to assert a path stays in the lease root. */
export async function physicalKindAt(root: string, relativePath: string): Promise<string> {
	return lstatKind(joinUnderRoot(root, relativePath));
}
