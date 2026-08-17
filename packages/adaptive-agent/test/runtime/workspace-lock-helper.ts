import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";

export interface WorktreeLock {
	/** Clear the lock so the manager can remove the directory (idempotent). */
	release(): void;
}

/**
 * Hold a worktree directory so the workspace manager cannot remove it,
 * exercising the orphan path (WorkspaceOrphanedError + recover()).
 *
 * On Windows a child process whose cwd is the worktree pins the directory:
 * rmdir fails while a live cwd is inside it. On POSIX a cwd does not pin a
 * directory, so instead remove write permission from the directory itself:
 * unlinking its children requires write access, so `rm -rf` fails with EACCES
 * (treated as a lock error by rmWithRetry). `release()` kills the holder /
 * restores the mode so recover() can finish.
 */
export function holdWorktree(dir: string): WorktreeLock {
	if (process.platform === "win32") {
		const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
			cwd: dir,
			stdio: "ignore",
			windowsHide: true,
		});
		return {
			release() {
				holder.kill();
			},
		};
	}
	let released = false;
	chmodSync(dir, 0o555);
	return {
		release() {
			if (released) return;
			released = true;
			try {
				chmodSync(dir, 0o755);
			} catch {
				// The directory may already have been removed by recover().
			}
		},
	};
}
