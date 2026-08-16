import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_SESSION_STORAGE, type SessionStorageConfig } from "../shared/ipc.ts";
import { workspacePathKey, workspacePathsEqual } from "../shared/workspace-path.ts";
import { normalizeSessionStorageConfig } from "./session-storage.ts";

export interface DesktopSettings {
	sessionStorage: SessionStorageConfig;
	recentWorkspaces: string[];
	hiddenWorkspaces: string[];
}

const MAX_RECENT_WORKSPACES = 50;

function normalizeWorkspaceList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const workspaces = new Map<string, string>();
	for (const item of value) {
		if (typeof item !== "string" || item.trim().length === 0) continue;
		const workspace = resolve(item.trim());
		const key = workspacePathKey(workspace);
		if (!workspaces.has(key)) {
			workspaces.set(key, workspace);
		}
		if (workspaces.size === MAX_RECENT_WORKSPACES) break;
	}
	return [...workspaces.values()];
}

export function rememberDesktopWorkspace(settings: DesktopSettings, workspace: string): DesktopSettings {
	const trimmedWorkspace = workspace.trim();
	if (!trimmedWorkspace) {
		throw new Error("Workspace path cannot be empty");
	}
	const resolvedWorkspace = resolve(trimmedWorkspace);
	const alreadyRemembered = settings.recentWorkspaces.some((entry) => workspacePathsEqual(entry, resolvedWorkspace));
	const hiddenWorkspaces = settings.hiddenWorkspaces.filter((entry) => !workspacePathsEqual(entry, resolvedWorkspace));
	if (alreadyRemembered && hiddenWorkspaces.length === settings.hiddenWorkspaces.length) {
		return settings;
	}
	return {
		...settings,
		recentWorkspaces: alreadyRemembered
			? settings.recentWorkspaces
			: [...settings.recentWorkspaces, resolvedWorkspace].slice(-MAX_RECENT_WORKSPACES),
		hiddenWorkspaces,
	};
}

export function removeDesktopWorkspace(settings: DesktopSettings, workspace: string): DesktopSettings {
	const trimmedWorkspace = workspace.trim();
	if (!trimmedWorkspace) {
		throw new Error("Workspace path cannot be empty");
	}
	const resolvedWorkspace = resolve(trimmedWorkspace);
	const recentWorkspaces = settings.recentWorkspaces.filter((entry) => !workspacePathsEqual(entry, resolvedWorkspace));
	const hiddenWithoutWorkspace = settings.hiddenWorkspaces.filter(
		(entry) => !workspacePathsEqual(entry, resolvedWorkspace),
	);
	const hiddenWorkspaces = [...hiddenWithoutWorkspace, resolvedWorkspace].slice(-MAX_RECENT_WORKSPACES);
	if (
		recentWorkspaces.length === settings.recentWorkspaces.length &&
		hiddenWorkspaces.length === settings.hiddenWorkspaces.length &&
		hiddenWorkspaces.every((entry, index) => entry === settings.hiddenWorkspaces[index])
	) {
		return settings;
	}
	return { ...settings, recentWorkspaces, hiddenWorkspaces };
}

export function removeDesktopWorkspaceIfEmpty(
	settings: DesktopSettings,
	workspace: string,
	remainingSessionWorkspaces: readonly (string | undefined)[],
): DesktopSettings {
	if (
		remainingSessionWorkspaces.some(
			(sessionWorkspace) => sessionWorkspace && workspacePathsEqual(sessionWorkspace, workspace),
		)
	) {
		return settings;
	}
	return removeDesktopWorkspace(settings, workspace);
}

export function loadDesktopSettings(filePath: string): DesktopSettings {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			sessionStorage?: unknown;
			recentWorkspaces?: unknown;
			hiddenWorkspaces?: unknown;
		};
		return {
			sessionStorage:
				parsed.sessionStorage === undefined
					? { ...DEFAULT_SESSION_STORAGE }
					: normalizeSessionStorageConfig(parsed.sessionStorage),
			recentWorkspaces: normalizeWorkspaceList(parsed.recentWorkspaces),
			hiddenWorkspaces: normalizeWorkspaceList(parsed.hiddenWorkspaces),
		};
	} catch {
		return { sessionStorage: { ...DEFAULT_SESSION_STORAGE }, recentWorkspaces: [], hiddenWorkspaces: [] };
	}
}

export function saveDesktopSettings(filePath: string, settings: DesktopSettings): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
