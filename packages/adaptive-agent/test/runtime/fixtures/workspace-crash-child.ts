/**
 * Real-process crash driver for the Stage 7 workspace crash matrix. The
 * parent vitest process spawns this file with process.execPath, drives it
 * over IPC to exact durable boundaries, and force-terminates it there.
 * Nothing in here is production API.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	GitWorktreeWorkspaceManager,
	JsonlManifestStore,
	type WorkspaceLease,
	type WorkspaceSnapshotRef,
	workspaceLeaseId,
} from "../../../src/index.ts";

type ChildCommand =
	| { c: "capture"; root: string; stateRoot: string }
	| { c: "fork-create"; root: string; stateRoot: string; snapshotId: string; candidateId: string }
	| { c: "fork-creating"; root: string; stateRoot: string; snapshotId: string; candidateId: string }
	| { c: "promote-applied"; root: string; stateRoot: string; snapshotId: string; candidateId: string }
	| { c: "release-releasing"; root: string; stateRoot: string; snapshotId: string; candidateId: string };

type ChildReply =
	| { t: "held"; snapshotId?: string; leaseId?: string; leaseRoot?: string; promotionId?: string }
	| { t: "error"; message: string };

let manager: GitWorktreeWorkspaceManager | undefined;
let snapshot: WorkspaceSnapshotRef | undefined;
let lease: WorkspaceLease | undefined;

function reply(message: ChildReply): void {
	process.send?.(message);
}

function hold(message: ChildReply): Promise<void> {
	reply(message);
	// Park forever; the parent force-kills the process.
	return new Promise<void>(() => {});
}

process.on("message", (raw: ChildCommand) => {
	void handle(raw);
});

async function handle(command: ChildCommand): Promise<void> {
	try {
		switch (command.c) {
			case "capture": {
				manager = new GitWorktreeWorkspaceManager({ stateRoot: command.stateRoot });
				snapshot = await manager.capture({ sourceRoot: command.root, logicalRoot: "/w" });
				await hold({ t: "held", snapshotId: snapshot.id });
				return;
			}
			case "fork-create": {
				manager = new GitWorktreeWorkspaceManager({ stateRoot: command.stateRoot });
				snapshot = await manager.findSnapshot(command.snapshotId);
				lease = await manager.fork(snapshot, command.candidateId);
				await hold({ t: "held", snapshotId: snapshot.id, leaseId: lease.id, leaseRoot: lease.root });
				return;
			}
			case "fork-creating": {
				manager = new GitWorktreeWorkspaceManager({ stateRoot: command.stateRoot });
				snapshot = await manager.findSnapshot(command.snapshotId);
				const leaseId = workspaceLeaseId(snapshot.id, command.candidateId);
				const manifest = new JsonlManifestStore({ filePath: join(command.stateRoot, "manifest.jsonl") });
				const recordedRoot = join(command.stateRoot, "worktrees", "crash", command.candidateId);
				await manifest.append({
					type: "lease",
					leaseId,
					snapshotId: snapshot.id,
					candidateId: command.candidateId,
					root: recordedRoot,
					gitDir: "",
					worktreeName: "",
					status: "creating",
					createdAt: Date.now(),
				});
				await manifest.close();
				await hold({ t: "held", snapshotId: snapshot.id, leaseId, leaseRoot: recordedRoot });
				return;
			}
			case "promote-applied": {
				manager = new GitWorktreeWorkspaceManager({ stateRoot: command.stateRoot });
				snapshot = await manager.findSnapshot(command.snapshotId);
				lease = await manager.fork(snapshot, command.candidateId);
				await writeFile(join(lease.root, "u.txt"), "u candidate\n");
				void manager.promote({
					lease,
					finalVerifier: async () => {
						// All paths are applied and journaled at this point.
						await hold({ t: "held", leaseId: lease!.id, leaseRoot: lease!.root });
					},
				});
				return;
			}
			case "release-releasing": {
				manager = new GitWorktreeWorkspaceManager({ stateRoot: command.stateRoot });
				snapshot = await manager.findSnapshot(command.snapshotId);
				lease = await manager.fork(snapshot, command.candidateId);
				const manifest = new JsonlManifestStore({ filePath: join(command.stateRoot, "manifest.jsonl") });
				const folded = await manifest.fold();
				const record = folded.leases.get(lease.id)!;
				await manifest.append({ ...record, status: "releasing" });
				await manifest.close();
				await hold({ t: "held", leaseId: lease.id, leaseRoot: lease.root });
				return;
			}
		}
	} catch (error) {
		reply({ t: "error", message: error instanceof Error ? error.message : String(error) });
	}
}
