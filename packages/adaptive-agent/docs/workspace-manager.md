# WorkspaceManager Implementation Spec (Stage 7)

Status: frozen for Stage 7 implementation. Scope authority: `DESIGN.md` §7, §12.2 Stage 7, §13.5.
Stage 7 delivers workspace, promotion, and source-ownership primitives only. CandidateGraph,
winner selection, and adaptive search are Stage 8.

## 1. Verified Git facts (S7.0 spike, git 2.45.1.windows.1, Node 25.9, Windows NTFS)

These behaviors were verified against throwaway temp repositories and are load-bearing:

1. `git stash create` captures staged + unstaged tracked content into an unreferenced commit;
   it does not move HEAD, does not rewrite the index, and does not touch worktree files.
   Re-running it on unchanged state yields the same OID. Output is empty (exit 0) when there
   are no tracked changes; a clean repo falls back to HEAD.
2. `git update-ref <ref> <oid> 0000000000000000000000000000000000000000` implements
   create-only semantics and fails if the ref exists. `git update-ref -d <ref> <oid>` deletes
   only if the ref still points at `<oid>`.
3. `git worktree add --detach <path> <private-ref>` works for private refs, creates a detached
   HEAD at the ref commit, and multiple worktrees may share the same snapshot ref. It fails
   when the target directory already exists and is non-empty; an empty directory is accepted.
   Registration and per-worktree gitdir (`<common>/worktrees/<name>`) are created atomically
   enough for recovery: a failed `git worktree remove --force` may already have unregistered
   the worktree while the directory itself remains (observed with a held directory lock).
4. `git diff --binary --full-index <snapshot-ref> --` run inside a candidate includes the
   candidate's commits (detached HEAD moved), staged, and unstaged changes relative to the
   snapshot commit, with binary payloads. Exit code is 0 even when there are differences;
   emptiness is the only reliable no-diff signal.
5. `git ls-files --others --exclude-standard -z` enumerates untracked non-ignored files
   NUL-separated and never includes `.git`.
6. `git apply --binary <patch>` (without `--index`) applies to the working tree and DOES
   stage the affected paths when the index matches the patch preimage; when the index differs
   from the preimage it leaves the index untouched. A following `git read-tree <capturedIndexTree>`
   restores the exact capture-time index without touching the worktree or HEAD. `git apply`
   fails with "patch does not apply" when the worktree does not match the patch preimage
   (the CAS we rely on).
7. On Windows, a process whose CWD is inside a directory (or a handle opened without
   FILE_SHARE_DELETE, e.g. a running tool process) blocks `rm` of that directory with
   `EBUSY`/`EPERM`; `git worktree remove --force` then fails with "Permission denied".
   Bounded retry succeeds once the process exits. Node `fs.open` handles do NOT block
   deletion (share-delete is set), so tests must lock via a live child process CWD.
8. `git rev-parse --verify HEAD` exits 128 on an unborn branch. `git ls-files --unmerged` is
   non-empty during a conflicted merge. `git rev-parse --git-path MERGE_HEAD` resolves
   per-worktree (common dir for the main worktree, `<common>/worktrees/<name>/` for a
   worktree), so marker existence checks work uniformly from any worktree.
9. `git config --worktree --bool core.sparseCheckout` exits 1 with empty output when unset.
10. Windows NTFS case-variant writes collide in the filesystem itself; `lstat` reports both
    junctions and symlinks with `isSymbolicLink() === true`, so reparse points can be detected
    with `lstat` alone. Creating real symlinks requires Developer Mode; tests create junctions
    via `fs.symlink(target, path, "junction")`.
11. `git stash create`, `git worktree add`, `git diff`, `git ls-files`, `git update-ref`
    operate identically inside a candidate worktree (recursive capture works).
12. With `core.autocrlf=true` (default on Windows), worktree checkouts are CRLF while blobs
    are LF. Git diff/apply normalize line endings; the implementation never fingerprints
    or diffs raw worktree bytes of tracked files, so autocrlf does not affect correctness.

All Git subprocesses run with `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM` unset (user config respected), `windowsHide: true`, no shell
interpolation. The spike used no network and did not touch the `D:\pi` foreground.

## 2. Public contract

```ts
interface WorkspaceSnapshotRef {
  id: string;                    // sha256-shaped, stable across reopens
  sourceRoot: string;            // canonical absolute path captured from
  backend: "git-worktree" | "temp-copy";
  fingerprint: string;           // sha256 of the capture content basis
  logicalWorkspace: LogicalWorkspaceIdentity;
}

interface WorkspaceLease {
  id: string;                    // deterministic sha256(`${snapshotId}:${candidateId}`)
  snapshotId: string;
  candidateId: string;
  root: string;                  // physical worktree root (never model-visible)
  environment: ExecutionEnvironment;
  release(): Promise<void>;
}

interface WorkspaceCaptureInput {
  sourceRoot: string;
  logicalRoot: string;
  policy?: WorkspacePolicy;
}

interface WorkspacePatch {
  snapshotId: string;
  leaseId: string;
  trackedPatchPath: string;      // manager-owned file ("" when no tracked diff)
  untrackedManifestPath: string; // manager-owned JSON mutation plan
  summary: WorkspaceDiffSummary;
}

interface PromotionInput {
  lease: WorkspaceLease;
  /** Runs with cwd = lease root before any foreground write. */
  verifier?: WorkspaceVerifier;
  /** Runs with cwd = foreground after all paths applied. */
  finalVerifier?: WorkspaceVerifier;
}

type WorkspaceVerifier = (context: { cwd: string }) => Promise<void> | void;

interface WorkspaceManager {
  capture(input: WorkspaceCaptureInput): Promise<WorkspaceSnapshotRef>;
  fork(snapshot: WorkspaceSnapshotRef, candidateId: string): Promise<WorkspaceLease>;
  /** Re-capture the current state of a lease root into a new snapshot. */
  snapshot(lease: WorkspaceLease): Promise<WorkspaceSnapshotRef>;
  diff(lease: WorkspaceLease): Promise<WorkspacePatch>;
  promote(input: PromotionInput): Promise<PromotionResult>;
  release(lease: WorkspaceLease): Promise<void>;
  /** Load a snapshot ref by id after reopen (workspaceSnapshotId is durable). */
  findSnapshot(snapshotId: string): Promise<WorkspaceSnapshotRef>;
  /** Explicitly drop a snapshot: ref + unique content blobs. Faults while leases exist. */
  releaseSnapshot(snapshot: WorkspaceSnapshotRef): Promise<void>;
  recover(): Promise<WorkspaceRecoveryReport>;
}
```

Deviations from the suggested contract in `DESIGN.md` §7.2, all additive and justified:

- `WorkspaceSnapshotRef.logicalWorkspace` and `fingerprint` are part of the durable identity
  that `ContinuationCheckpoint` records; a fingerprintless ref would be forgeable.
- `findSnapshot` is required for crash reattach: after reopen the controller only holds
  `workspaceSnapshotId` strings from the journal.
- `releaseSnapshot` closes the lifecycle: `release()` removes worktrees, but a captured
  foreground snapshot that was never forked (or a checkpoint abandoned before any fork)
  must be releasable explicitly. `release()` deletes the ref only when the last lease that
  referenced it is gone, and never deletes refs that other lease records still reference.
- Lease ids are deterministic so the journal event can re-verify them on reattach.

`WorkspaceLease` carries no physical path into the model; the `ExecutionEnvironment`
projection and `logicalWorkspace` are the only provider-visible facts.

## 3. Typed errors

All have `name` equal to the bullet name (drop `Error` suffix):

- `UnsupportedWorkspace` — not a Git repo, bare repo, submodule, sparse checkout, unsupported
  reparse point, source root deleted or unreadable.
- `UnsupportedRepositoryState` — unborn HEAD, unmerged index, merge/rebase/cherry-pick/
  revert/bisect/sequencer in progress, path-length or policy violation at capture.
- `SourceWorkspaceChanged` — tracked tree or untracked manifest drifted during capture;
  the capture is abandoned and nothing is published.
- `WorkspaceSnapshotNotFound` — snapshot id has no manifest record or its ref is gone.
- `WorkspaceSnapshotMismatch` — the snapshot record does not match the ref on disk
  (internal consistency; recoverable only via `recover()`).
- `WorkspaceLeaseConflict` — same `snapshotId + candidateId` already exists with different
  identity (repo, ref, root) or the lease is in a conflicting state (orphaned/releasing).
- `WorkspacePathEscape` — a manifest path escapes the workspace root, or a deletion/rename
  target is outside the manager-owned root.
- `WorkspaceCaseCollision` — two paths differ only by case on a case-insensitive volume.
- `ForegroundChanged` — foreground fingerprint differs from the capture fingerprint at
  promotion time; zero foreground writes.
- `PromotionConflict` — an open promotion journal already exists for this lease, the
  foreground repository identity changed, or a touched path has an unexpected preimage.
- `PromotionNeedsAttention` — a touched path drifted after apply; automatic recovery
  stopped, recovery copies retained, journal stays open.
- `WorkspaceOrphaned` — operating on a lease whose worktree is orphaned (locked cleanup).
- `BranchOriginFrozen` — an advance/resume attempt on a source lane that is a durable
  frozen branch origin.

Git, filesystem, manifest, or journal unrecoverable write failures are NOT mapped to these
business errors; they propagate as manager faults (`WorkspaceManagerFault`) or plain system
errors. Only caller/state conflicts get typed errors.

## 4. Runtime manifest schema

`<stateRoot>/manifest.jsonl`, one canonical JSON record per line, append-only,
torn-tail-tolerant (same rules as `ContinuationJournal`). Single active writer process.

```ts
type ManifestRecord =
  | { type: "snapshot"; seq: number; snapshotId: string; repoId: string;
      sourceRoot: string; repoRoot: string; commonDir: string; backend: "git-worktree";
      ref: string; commitOid: string; headOid: string; indexTree: string;
      trackedTree: string; untrackedManifestHash: string; policyHash: string;
      fingerprint: string; logicalRoot: string; createdAt: number;
      untracked: UntrackedEntry[];
      untrackedExcluded: Array<{ path: string; reason: string }> }
  | { type: "snapshot.released"; seq: number; snapshotId: string }
  | { type: "lease"; seq: number; leaseId: string; snapshotId: string; candidateId: string;
      root: string; gitDir: string; worktreeName: string; status: LeaseStatus; createdAt: number }
  | { type: "promotion"; seq: number; promotionId: string; leaseId: string;
      status: "open" | "closed" };
```

Folding rule on read: latest `seq` per record key wins (`snapshotId`, `leaseId`, `promotionId`).
Status transitions re-append the full lease record with the new `status` (the latest
record is authoritative). Append + fsync-free (process-crash durability only; same
guarantee boundary as Harness S1).

### Untracked entry

```ts
interface UntrackedEntry {
  path: string;              // repo-relative, forward slashes, validated
  kind: "file" | "link";
  mode: number;              // st_mode
  size: number;              // file bytes (0 for links)
  hash: string;              // sha256 of original bytes ("" for links)
  target?: string;           // link target, validated repo-relative
}
```

The untracked content hash is sha256 over `canonicalJson(sorted(entries))`. Bytes live in the
manager-owned content store `<stateRoot>/content/<hash>`; the manifest never relies on the
source path for restoration.

## 5. WorkspacePolicy

```ts
interface WorkspacePolicy {
  /** Case-insensitive deny patterns (gitignore syntax) checked before ignore rules. */
  denyPatterns?: string[];
  maxUntrackedFileBytes?: number;    // default 16 MiB
  maxTotalUntrackedBytes?: number;   // default 256 MiB
  maxUntrackedFiles?: number;        // default 4096
  maxRelativePathLength?: number;    // default 180 chars
  allowLinks?: boolean;              // default true (recreate; reject escapes)
}
```

Defaults: deny `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`,
`*credentials*`, `*secret*`, `.netrc`, `.htpasswd`. Ignored files (gitignore) are excluded
because `ls-files --exclude-standard` never yields them; deny rules apply first. Exclusions
are recorded with a reason in `untrackedExcluded`. The policy hash
enters the fingerprint, so any policy change produces a different snapshot.

## 6. Capture (Git backend)

Preconditions: source root exists, is inside a Git worktree, not bare, not a submodule
(`git rev-parse --show-superproject-working-tree` empty), no sparse checkout
(`git config --worktree --bool core.sparseCheckout` must be unset/false), no unmerged index
(`git ls-files --unmerged` empty), no in-progress operation markers
(`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `rebase-merge/`,
`rebase-apply/`, `sequencer/` via `git rev-parse --git-path` + lstat), HEAD exists.

Steps (each reads only; no ref/index/worktree mutation):

1. Canonicalize `sourceRoot = realpath(input.sourceRoot)`, `repoRoot = toplevel`,
   `commonDir = git rev-parse --path-format=absolute --git-common-dir` (absolute form;
   the main worktree's `--git-common-dir` alone can be the relative `.git`),
   `repoId = sha256(realpath(repoRoot))`.
2. Read `HEAD`, `indexTree = git write-tree`.
3. `tracked = git stash create`. Empty → `commitOid = HEAD`, `trackedTree = HEAD^{tree}`.
   Otherwise `commitOid = tracked`, `trackedTree = tracked^{tree}`.
4. Publish ref: `git update-ref refs/pi-adaptive/snapshots/<repoId>/<snapshotId> <commitOid> 0000...`
   (`snapshotId` = sha256 of random UUIDv7 bytes — sha256-shaped, unique).
5. Enumerate untracked via `ls-files --others --exclude-standard -z` (buffer + NUL split)
   plus a `--directory` pass that surfaces untracked directories. Per entry: validate
   path (no `..`, no absolute, no control chars, Windows reserved names per segment
   case-insensitively, no trailing dot/space, length ≤ policy, case-collision check
   against tracked + untracked set), `lstat`:
   - reparse point (`isSymbolicLink()`): resolve target; reject absolute targets or
     targets escaping the repo root (`WorkspacePathEscape`); otherwise record
     `kind:"link"` with the relative target. Never recurse through. Files that git
     reports under such a link directory are excluded (`under-link`), so content is
     never captured through a reparse point. Junctions git refuses to enumerate at
     all (out-of-root targets) are invisible to capture and to forks — nothing is
     ever copied through them.
   - file: size ≤ policy, stream-sha256, copy bytes to content store (idempotent by
     hash). A mid-copy byte mismatch is `SourceWorkspaceChanged`, not a store fault.
   - directory/other: exclude with reason.
   Deny patterns and oversize files → `untrackedExcluded` with reason.
6. `policyHash = sha256(canonicalJson(policyDefaults + input.policy))`.
7. `fingerprint = sha256(canonicalJson({ headOid, indexTree, trackedTree,
   untrackedManifestHash, policyHash }))`.
8. Drift double-check: re-read HEAD, re-run `git stash create` (compare `trackedTree`), and
   re-enumerate + re-hash untracked files. Any difference → `SourceWorkspaceChanged`; delete
   the just-created ref (best effort) and return without publishing.
9. Append the `snapshot` manifest record, then return the ref.

Postconditions: foreground branch, index, files, and stash list unchanged; one private ref
and one manifest record exist; untracked bytes exist in the content store.

## 7. Fork

- Worktree root: `<stateRoot>/worktrees/<repoIdShort>/<candidateId>` (manager-owned; never
  inside the foreground repo). `leaseId = sha256(snapshotId + ":" + candidateId)`.
- If a lease record with the same `leaseId` exists:
  - status `ready`: verify root/gitDir/worktreeName/repoId/ref/snapshotId match the manifest
    and `git worktree list`; match → reattach the same lease (no twin); mismatch →
    `WorkspaceLeaseConflict`.
  - status `releasing`/`orphaned`: `WorkspaceLeaseConflict` (recovery must settle it first).
  - status `released`: the snapshot ref was possibly deleted → `WorkspaceSnapshotNotFound`
    or `WorkspaceLeaseConflict`; never re-materialize silently.
- Fresh fork: append `lease` (status `creating`) → `mkdir` parents →
  `git worktree add --detach <root> <ref>` → copy untracked bytes from the content store
  (no hardlinks; per-file hash verification; recreate links with `fs.symlink`) → verify →
  append `lease.status` `ready`. Only a `ready` root is ever handed to a worker.
- The creating→ready gap is crash-recoverable: `recover()` completes a `creating` lease by
  re-running the same deterministic steps (the snapshot ref and content store are immutable).

## 8. Diff

- Tracked: `git -C <root> diff --binary --full-index --no-renames <ref> --`, split per file
  at `diff --git ` boundaries (binary patches included), written to
  `<stateRoot>/patches/<leaseId>-<sha256(patch)>.patch`. Empty diff → `trackedPatchPath: ""`.
- Untracked: enumerate the lease root the same way as capture; compare against the snapshot
  manifest → create/modify/delete plan (`<stateRoot>/patches/<leaseId>-<manifestHash>.json`)
  with per-path kind/size/hash and a canonical manifest hash.
- Identity coordination: a path touched by the tracked patch wins; its untracked create/
  modify/delete op is dropped and recorded as `absorbed_by_tracked_patch` in the summary.
  When a tracked "new file" patch covers a path that exists as an untracked foreground
  file at snapshot time, the mutation carries `preExistingUntracked` and the apply
  removes the (already journaled) untracked preimage before `git apply` creates the file;
  rollback restores it. A path can never be both added by the patch and deleted by the plan.
- All paths in the patch/plan are validated repo-relative paths. Summary carries canonical
  hashes of both artifacts; `promote()` re-verifies them before any foreground write.

## 9. Strict promotion

`promote({lease, verifier, finalVerifier})`:

1. Lease must be `ready`. An open promotion journal for this lease → `PromotionConflict`.
2. `verifier` runs with `cwd = lease.root`. Failure → `{status:"verifier_failed"}`; zero
   foreground writes.
3. Recompute the foreground fingerprint from the snapshot record's `repoRoot`. Mismatch with
   the capture fingerprint → `ForegroundChanged`; zero writes.
4. Regenerate tracked patch + untracked plan (as in Diff) and verify their canonical hashes
   against the summary recorded at diff time (or compute fresh); the foreground fingerprint
   is re-checked, and every touched path's preimage is recorded (hash or `absent`).
5. Open `PromotionJournal` `<stateRoot>/promotions/<promotionId>.jsonl`
   (`promotionId = sha256(leaseId + ":" + snapshotId + ":" + patchHash)`), durable before
   any foreground write.
6. Apply per path (tracked first, one `git apply --binary` per file section, then untracked
   ops sorted by path): recovery copy of the preimage is written to the journal directory
   first; new content is written to a same-volume temp file then renamed over the target
   (deletes via `rm`); after each path a durable journal record
   `{path, op, preimageHash, targetHash, recoveryCopy, status:"applied", postHash}` is
   appended. After all tracked applies, `git read-tree <capturedIndexTree>` restores the
   capture-time index (worktree and HEAD untouched). No commit, no stage, no branch move.
7. `finalVerifier` runs with `cwd = foreground`. Success → journal `close` record +
   `{status:"promoted"}`; recovery copies deleted.
8. Failure or fault: for every applied path whose current hash still equals the journaled
   `postHash`, restore the preimage from the recovery copy (same temp+rename path). A path
   whose hash matches neither preimage nor postHash stops automatic recovery →
   `PromotionNeedsAttention` with recovery copies retained and the journal left open.
   Otherwise → `{status:"rolled_back", reason}` and the journal is closed.
9. No automatic three-way merge, ever.

Promotion recovery (`recover()`): an open journal with zero `applied` records is discarded.
An open journal whose applied paths all match their `postHash` and whose untouched paths
match the snapshot basis → automatic rollback to preimage (the promotion never became
authoritative). Any drift → `PromotionNeedsAttention`; never guess over user files.

## 10. Release and crash recovery

Lease states: `creating → ready → releasing → released`, and `releasing/ready →
orphaned` when cleanup exhausts retries.

Release order: caller stops the worker (harness close → `ExecutionEnv.cleanup()`) →
`manager.release(lease)`:
1. `lease.status` → `releasing` (durable).
2. `git worktree remove --force <root>`; if the directory still exists (partial removal —
   observed when a process CWD holds it), `fs.rm(root, {recursive, force})`.
3. Absolute-path check: both steps only ever touch paths resolved inside the manager-owned
   root (`realpath` prefix check) or the registered gitDir/worktreeName under the recorded
   common dir. Any escape → `WorkspacePathEscape`, never a wider delete.
4. Bounded retry (default 5 × 250 ms) on `EPERM`/`EBUSY`/`ENOTEMPTY`/`EACCES`. Exhausted →
   `lease.status` `orphaned` (never a false `released`), `WorkspaceOrphaned` is reported.
5. `lease.status` → `released`. Then, and only then, if no other lease record references the
   snapshot, delete the private ref (`git update-ref -d <ref> <commitOid>`) and the content
   blobs unique to this snapshot; append `snapshot.released`.

`recover()` reconciles, in order, only manager-owned state:
1. Fold the manifest. Unmanifested `refs/pi-adaptive/**` → delete (single-writer assumption;
   a ref nobody knows about cannot be referenced).
2. `creating` leases → complete or keep `creating` (report).
3. `ready` leases → verify dir + registration; missing dir → `orphaned` + report (external
   deletion is never silently re-materialized).
4. `releasing`/`orphaned` leases → retry removal; success → `released`.
5. `released` leases → remove any leftover dir/metadata.
6. Content blobs not referenced by any non-released snapshot → delete; patch artifacts not
   referenced by an open journal → delete; promotion journals → §9 rules.
7. Worktree directories under the manager root without a lease record → attempt removal
   (bounded); stale `<common>/worktrees/<name>` not in `git worktree list --porcelain`
   (for known common dirs) → remove the metadata dir only.
8. `recover()` is idempotent: running it twice yields the same state and report.

Only process-crash recovery is promised (same boundary as Harness S1); no fsync/power-loss
durability claims. Ref deletion never precedes worktree deletion. Per-worktree metadata
deletion only after `git worktree remove` succeeded or the worktree is unregistered.

## 11. Hidden worker binding

- One hidden harness + one `WorkspaceLease` + one `ExecutionEnv` per candidate.
- `NodeExecutionEnv.cwd === lease.root`; `ExecutionEnv.cleanup()` stops child processes
  before `lease.release()`.
- `WorkspacePathAdapter` maps logical (model-visible) paths to the lease root and back for
  tool inputs, structured results, and error paths. No string replacement on arbitrary
  shell stdout. WorkspaceManager is file-state isolation only, never a process/network
  sandbox; the four fixed tools resolve relative paths against the bound env cwd.
- System prompt and canonical requests carry the unified logical root; sibling physical
  paths never appear. `createCodingAgentHarness` gains an explicit `logicalCwd` seam so the
  prompt builder and the tool env can use different roots.
- Durable binding: `ContinuationJournal.child_workspace_ready` records `leaseId` and
  `snapshotId`; reattach verifies them. Harness-create failure closes writer, environment,
  and lease — no worktree leak.

## 12. Branch-origin freeze

- `BranchOriginRegistry.freeze({session, lane, operationId, groupId})` writes a durable
  marker as a `fact.custom` register (`pi.adaptive.branch_origin:<lane>`) via
  `session.commit` — same file/authority as the session, so crash/reopen restores it with
  the session. Idempotent per lane: re-freezing the same group is a no-op; a different
  group faults.
- `assertAvailable({session, lane})` throws `BranchOriginFrozen` while a marker exists.
  `HarnessV4LeafTurnAdapter` gains an optional `originGuard` invoked before any start/
  advance dispatch; `SingleCandidateAdaptiveToolLoop` forwards it. Wiring prompt/queue/
  write/config gates across the whole v4 surface is Stage 8; Stage 7 delivers the primitive
  and contract tests.
- `BranchContinuation.forkExact`: journal `group_planned` → freeze → fork children →
  `group_ready` keeps the freeze permanent. On typed failure with no child dispatch, the
  freeze is durably removed before `group_failed`. A crash between freeze and failure leaves
  a re-freezable marker (same group id) — never a lost or double origin. The freeze marker
  is written through the caller-supplied open `sourceSession` handle (the source harness's
  durable session); BranchContinuation never opens a second writer.
- After `group_ready` the source is a read-only branch origin: advance/resume of the source
  open Run faults with `BranchOriginFrozen`; the marker is never silently deleted.

## 13. TempDirectory adapter (test-only)

Same `WorkspaceManager` interface, same promotion journal and recovery code paths:

- `capture`: recursive `lstat` walk of the source root (no reparse traversal; escape
  rejection), byte-copy into the content store (no hardlinks), fingerprint over
  `sorted(path/kind/mode/size/hash) + policyHash`; drift double-check.
- `fork`: materialize a full byte copy under
  `<stateRoot>/worktrees/<repoIdShort>/<candidateId>` with hash verification; same lease
  states and deterministic reattach.
- `diff`: tree comparison produces the same mutation-plan shape (trackedPatchPath is "" —
  there is no tracked/untracked split, all paths flow through the untracked plan).
- `promote`: identical journal/rollback semantics with plain file copies.
- Conformance: both backends run the exact same `WorkspaceManagerConformance` suite.

## 14. Compatibility surface (Stage 6 seams)

- `WorkspaceLease.id` becomes required (`MemoryWorkspaceAdapter` uses the same deterministic
  id scheme). `WorkspaceContinuationPort` is unchanged; a new
  `WorkspaceManagerContinuationAdapter` bridges it to a real `WorkspaceManager`: its
  `snapshot(metadata, logicalRoot)` ignores the caller-supplied `WorkspaceMetadata` and
  derives everything from a real capture; `fork` delegates and reattaches.
- `ContinuationCheckpoint` records the real capture identity
  (`workspaceSnapshotId`, `logicalWorkspace.contentFingerprint` = real fingerprint,
  `workspaceFingerprint`). The checkpoint capture input no longer fabricates production
  metadata.
- `child_workspace_ready` journal event gains `leaseId` + `snapshotId` and reattach verifies
  both.
- `BranchContinuation.forkExact` releases already-created sibling leases on group failure
  (fixes the Stage 6 worktree leak) and integrates the freeze.
- `createCodingAgentHarness` gains `logicalCwd?: string`; tools keep `env.cwd`, the system
  prompt uses the logical root.

## 15. Test matrix mapping

`test/runtime/workspace-manager-conformance.ts` runs against both adapters:
clean/dirty/staged/deleted/renamed/binary; untracked create/modify/delete + post-capture
source drift; deny/ignore/oversize exclusions and policy fingerprint; post-commit full diff;
two candidates on one path; parent re-capture/fork; capture/fork/diff leave foreground
branch/index/files untouched; deterministic reattach without twins; promotion drift →
zero writes; no commit/stage; verifier/apply/final-verifier failure points; concurrent
user edit → `PromotionNeedsAttention`; locked file/orphan dir/ref/half-created worktree
recovery; traversal/junction escape/case collision/dangerous Windows paths; no leaked
refs/blobs/worktree metadata; hidden worker four tools bound to lease root; no physical
root in prompt/request; source freeze/failure-unfreeze/permanent origin/reopen; per-step
process crash; `recover()` twice idempotent. Stage 5/6/Legacy suites keep passing.
