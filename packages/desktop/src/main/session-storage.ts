import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_SESSION_STORAGE, type SessionStorageConfig } from "../shared/ipc.ts";

/** Match Jip-pi's default cwd encoding while allowing the parent directory to change. */
export function encodeWorkspaceDirectory(workspace: string): string {
	const resolvedWorkspace = resolve(workspace);
	return `--${resolvedWorkspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function normalizeSessionStorageConfig(value: unknown): SessionStorageConfig {
	if (typeof value !== "object" || value === null || !("mode" in value)) {
		throw new Error("Invalid session storage setting");
	}

	const mode = (value as { mode?: unknown }).mode;
	if (mode === "default" || mode === "workspace") {
		return { mode };
	}
	if (mode !== "custom") {
		throw new Error("Unknown session storage mode");
	}

	const customRoot = (value as { customRoot?: unknown }).customRoot;
	if (typeof customRoot !== "string" || customRoot.trim().length === 0) {
		throw new Error("Choose a custom session root directory");
	}
	const trimmedRoot = customRoot.trim();
	if (!isAbsolute(trimmedRoot)) {
		throw new Error("The custom session root must be an absolute path");
	}
	return { mode, customRoot: resolve(trimmedRoot) };
}

/** Return the exact --session-dir value for a workspace, or undefined for Jip-pi's default. */
export function resolveSessionDirectory(
	workspace: string,
	config: SessionStorageConfig = DEFAULT_SESSION_STORAGE,
): string | undefined {
	if (config.mode === "default") {
		return undefined;
	}
	if (config.mode === "workspace") {
		return join(resolve(workspace), ".pi", "sessions");
	}
	if (!config.customRoot) {
		throw new Error("Custom session storage requires a root directory");
	}
	return join(config.customRoot, encodeWorkspaceDirectory(workspace));
}
