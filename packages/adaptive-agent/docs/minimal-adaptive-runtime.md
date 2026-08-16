# Minimal Adaptive Runtime Contract (Stage 8)

Status: frozen for Stage 8 implementation. Scope authority: `DESIGN.md` §12.2 Stage 8 and the
Stage 8 task brief. Stage 8 delivers the minimal, explainable, process-crash-safe Adaptive
Runtime: CandidateGraph, AdaptiveTaskJournal, rule-based Controller, Hard Verifier with
belief fusion, task budget, exact branch, winner selection, strict promotion, and the
branch-origin full-surface barrier.

## 1. Authority split

| Authority | Owns |
|---|---|
| Harness entries/registers/usage | provider/tool execution, Run recovery |
| CandidateStateProjector | candidate policy state rebuilt from the Harness durable prefix |
| ContinuationJournal | exact group creation and child reattach |
| Workspace manifest/PromotionJournal | workspace, lease, promotion recovery |
| AdaptiveTaskJournal | CandidateGraph, Controller decisions, Hard Verifier evidence, task budget, winner/task terminal |
| TrajectoryStore | non-authoritative observations and training data |

The AdaptiveTaskJournal stores references, decision bases and task-level facts only. It never
copies assistant/tool history, effective args or mutable candidate state. There is no mutable
CandidatePolicyStateStore; the projector rebuilds state from the durable prefix.

## 2. Frozen constraints

- The model is frozen per task; provider-visible tools are exactly `read`, `write`, `edit`,
  `bash` in that order with stable names, schemas and descriptions.
- The Controller never generates a coding tool call and never invokes a second LLM.
- Only exact branch is supported; there is no `DIVERSIFY`.
- Candidate drives run strictly serially: `maxConcurrentCandidateDrives = 1`.
- TrajectoryStore failures never change any execution result.
- storage/projection/journal consistency faults fail closed; they are never downgraded to a
  prune.

## 3. CandidateGraph

`CandidateNode` (folded, durable identity only, no live objects):

```ts
interface CandidateNode {
  id: string;
  parentId?: string;
  depth: number;
  conversation: { sessionId: string; lane: string; operationId?: string; basisEntryId?: string;
                  cursor?: LeafTurnCursor; continuationGroupId?: string };
  workspace: { snapshotId: string; leaseId?: string; snapshotFingerprint?: string };
  policyState: CandidatePolicyStateRef;   // basis + fingerprint reference only
  belief: BeliefState;
  cost: CandidateCost;                    // { providerCalls, totalTokens }
  status: "provisioning" | "active" | "branching" | "branch_origin" | "verifying"
        | "verified" | "pruned" | "failed" | "winner" | "terminal";
  settlement?: "completed" | "failed" | "aborted";
  terminalReason?: string;
  released: boolean;
  lastEvidence?: TurnEvidence;
  pendingVerifier?: { attemptId: string; replay: "safe" | "never" };
  verifierResult?: { status: "pass" | "fail" | "interrupted"; coverage: number;
                     workspaceFingerprint: string;
                     mutation?: { kind: "tracked" | "untracked" | "both"; detail: string } };
}
```

State transitions:

```text
(root) task_planned -> provisioning
provisioning -> active            root_session_ready + root_workspace_ready + root_run_accepted
provisioning -> active            (child) candidate_provisioned
active -> branching               controller_decided { kind: "branch" }
branching -> branch_origin        branch_committed (permanent; never scheduled again)
active -> verifying               controller_decided { kind: "verify" }
verifying -> verified             verifier_settled pass + coverage >= threshold + debt 0 + no mutation
verifying -> failed               verifier_settled fail/interrupted (or mutation) on a completed run
active/verified/winner -> pruned|failed   candidate_terminal (winner demotion clears the winner slot)
winner -> failed                  candidate_terminal after a failed/rolled-back promotion
```

Rules:

- conversation and workspace always enter `active` as a pair.
- A `branch_origin` source is never scheduled again.
- Every transition carries a graph `revision` and a deterministic `actionId`
  (`sha256(canonical {taskId, revision, type, target})`).
- Replaying the same event (same key, same content without the wall-clock `at`) is a no-op;
  the same key with different content faults (`TaskGraphFault`).
- `candidate_turn_observed` and `controller_decided` repeat per candidate; their keys include
  the deterministic action id.

Reconciliation (fail-closed, before any new effect): every session id must exist in the
SessionRepo; every snapshot must exist in the WorkspaceManager with a matching fingerprint;
unreleased leases must not be `released`/`orphaned`; every continuation child's
session/workspace/run identities must match the ContinuationJournal events, and the group
must have `group_ready`.

## 4. AdaptiveTaskJournal

Append-only JSONL (or Memory, same conformance): canonical JSON, single writer, torn-tail
recovery (only an unterminated final line is dropped), a complete corrupt line faults
(`TaskJournalFault`).

Event types: `task_planned`, `root_session_ready`, `root_workspace_ready`,
`root_run_accepted`, `candidate_turn_observed`, `controller_decided`, `branch_committed`,
`candidate_provisioned`, `verifier_planned`, `verifier_settled`, `candidate_terminal`,
`candidate_release_started`, `candidate_released`, `winner_selected`, `promotion_started`,
`promotion_settled`, `snapshot_released`, `task_terminal`.

Every event carries `taskId`, `revision`, `actionId`, `at`. Identity details:

- Root identity is deterministic: `rootCandidateId = sha256(taskId:candidate:root)`,
  `rootSessionId = sha256(taskId:session:root)`; retries reattach, never create twins.
- `branch_committed` stores the group id, the lease-derived snapshot id/fingerprint, cursor,
  context/request/policy-state fingerprints (references), variants and the deterministic
  child ids.
- `verifier_planned` is durable before the verifier effect; `verifier_settled` stores
  bounded evidence (status, coverage, duration, hash/length/prefix summary, workspace
  fingerprint binding, optional mutation).
- `winner_selected`/`promotion_started`/`promotion_settled` ride the deterministic
  promotion attempt id `sha256(leaseId:snapshotId)`.

## 5. Rule-based Controller

Pure function; decision basis = graph revision + candidate id + LeafTurnCursor +
policy-state fingerprint + belief fingerprint + task-budget fingerprint + PolicyBundleRef,
plus the bounded facts below. Rule precedence (first match wins):

1. storage/projection/fingerprint fault -> fault the task, zero new effect;
2. an eligible verified candidate exists and continuing value <= 0 -> `stop`;
3. completed candidate without a final verifier -> `verify`;
4. open post-turn with verifier fail / repeated failure / redundancy >= threshold, and
   branch slots are available -> exact `branch` (two deterministic variants);
5. task budget exhausted -> `prune` (tagged with `calls` | `tokens` | `time` | `candidates`);
6. failed/aborted/suspended non-recoverable candidate -> `prune`, or typed task suspension;
7. otherwise `continue`.

Deterministic scheduling: pending verification > verifying > branching > branch_origin with
unprovisioned children > provisioning > verified/winner > active; ties by depth, then by
the group's ordered variant index (v1 before v2, independent of the random child id
ordering), then lexicographic candidate id.

Deterministic winner tie-break: verified, higher evidence coverage, lower verification
debt, fewer failures/redundant calls, lower token then call cost, lexicographically
smaller candidate id.

## 6. Budget semantics

```ts
interface AdaptiveTaskBudget {
  maxProviderCalls: number; maxTotalTokens: number; maxWallClockMs: number;
  maxBranchFanout: number; maxActiveCandidates: number;
  maxTotalCandidates: number; maxBranchDepth: number;
}
```

Frozen caps: `maxConcurrentCandidateDrives = 1`, `maxBranchFanout = 2`,
`maxActiveCandidates = 4`, `maxTotalCandidates = 7`, `maxBranchDepth = 2`. Provider
call/token/time limits have no defaults and must be provided by the caller.

- Provider calls: per candidate session, count usage rows associated with an assistant
  entry (`scanCandidateUsage`).
- Tokens: sum all unique usage rows across candidate sessions. Forked child sessions carry
  no source rows, so the source cost is never double-billed by entry fork.
- The deadline is fixed at task admission; the wall-clock fact never enters the budget
  fingerprint (time-dependent decisions are explicitly not replay-deterministic).
- No new provider request starts once calls/time are exhausted; tokens allow the current
  serial request one unpredictable overshoot, then stop.
- Branch slots are reserved atomically by the `branch_committed` event itself (fold counts
  `total + 2 <= maxTotalCandidates` and `active + 2 <= maxActiveCandidates` before it).

## 7. Hard Verifier and belief fusion

```ts
interface HardVerifier {
  readonly id: string;
  readonly version: string;
  readonly replay: "safe" | "never";
  verify(input: { taskId: string; candidateId: string; cwd: string; signal: AbortSignal })
    : Promise<HardVerifierResult>;
}
```

- The verifier never runs through the frozen model.
- `verifier_planned` is durable before the effect. After a crash, `replay: "safe"` verifiers
  re-run; `replay: "never"` verifiers settle as `interrupted` — never a fabricated pass or
  fail.
- Authoritative evidence: exit/result, coverage, duration, hash, length and a bounded
  prefix summary; full shell output never enters the journal or belief.
- The runtime diffs the workspace before/after the effect; any change to tracked or
  included untracked content (the trackedPatchHash/untrackedManifestHash pair) yields
  `VerifierWorkspaceMutation` and the candidate can never become a winner. Ignored build
  caches never enter either hash.
- `BeliefState` uses integer basis points (0..10000). Fusion is a pure deterministic
  reducer: identical state + evidence produce the identical fingerprint; verifier failure
  never raises success belief; a verifier pass never lowers coverage; debt, repeated calls
  and failures only lower path value; a verifier pass clears the verification debt
  (whole-workspace coverage); `verified` is impossible without a real verifier pass.
- The inherited-capsule check is provenance-only for exact-continuation children: the fork
  renumbers entry seqs and never copies the usage ledger, so the seq/usage-derived capsule
  content cannot be replayed from the child session. The capsule was fully reconstructed
  against its own session at checkpoint capture; the child verifies the operation/seed
  provenance and that the capsule cursor equals the run's exact_continuation source. The
  projector accepts an `inheritedUsageSource` session (and the ToolPolicy adapter a
  `usageSourceResolver`) for the usage rows of an inherited prefix.

## 8. Root provisioning, exact branch, origin barrier

Recoverable phases: `task_planned -> root_session_ready -> root_workspace_ready ->
root_run_accepted -> task_running`. Deterministic identities make every retry a reattach.

Branching:

1. `WorkspaceManager.snapshot(lease)` — never a foreground re-capture. A lease-derived
   snapshot separates two baselines (durable in the manifest as
   `promotionOriginSnapshotId`/`promotionOriginFingerprint`, chained across derivations):
   - `forkBase` = the snapshot's own content (S1): exact child creation and continuation
     validation;
   - `promotionOrigin` = the ORIGINAL foreground snapshot (S0): the foreground drift
     gate, the full S0->winner patch (the source's own mutations included), and the
     original index restore;
2. checkpoint capture under the source lane mutation lease; deterministic group id;
3. `group_planned` + durable origin freeze, then `BranchContinuation.forkExact` children;
4. no child dispatches before `group_ready`; children enter the CandidateGraph
   (`candidate_provisioned`) before their first provider request;
5. the source is a permanent `branch_origin`; siblings schedule in the ordered
   variant sequence (v1 before v2).

After the freeze, every public mutation surface fails with `BranchOriginFrozen` with zero
writes and zero effects: prompt, adaptive prompt, resume, advance, abort, steer, followUp,
nextRun, cancelQueued, append message/custom entry, recordUsage, model/thinking/tools
configuration mutation, manual executeAction/runToCompletion, compaction/navigation.
Getters, watch and close keep working. The runtime exposes only guarded handles for a frozen
origin — never the raw source Session. Freeze vs advance/abort/queue/config races: the
barrier re-checks the durable marker immediately before the mutation, so exactly one side
succeeds.

Child run basis (model-invisible): `adaptive.run_basis.candidateId = childId`, and
`inheritedPolicyState` is the unchanged source policy capsule. Sibling request fingerprints
do not change.

## 9. Winner eligibility, promotion, cleanup

Winner eligibility:

- Harness Run settled;
- final Hard Verifier pass with coverage >= the task coverage threshold (default 100);
- verification debt zero;
- verifier evidence bound to the current workspace fingerprint (diff-hash pair equality);
- session/workspace/policy-state consistency re-check: the stored policy-state ref must
  still be the deterministic projection of the durable prefix.

Promotion flow: winner workspace verifier re-run -> foreground drift gate against the
promotion origin fingerprint -> strict journaled apply of the full origin-to-winner patch
-> foreground final verifier -> durable promotion receipt -> `promotion_settled` ->
`task_terminal` -> close/release all workers and leases -> group terminal and
snapshot/ref/content release.

Promotion receipt (`PromotionReceipt`): attempt/promotion id, lease/snapshot id,
promotion-origin snapshot id + fingerprint (the lineage), status, touched paths,
post-fingerprint (and reason for rollbacks). `promote()` crash/retry on a completed
attempt returns the original durable result; a successful closed journal is never deleted
and the promotion is never re-executed. Memory and Git/temp backends share the same
semantics. An open promotion journal from a crashed attempt is settled by `recover()`
(rollback or discard) before one retry; `needs_attention` stops immediately with the
recovery copies. Release retention is reference-aware: a snapshot that is still the
promotion origin of a live derived snapshot is retained until the derived snapshots are
released first.

Result mapping:

- `promoted`: successful terminal state;
- winner verifier failed: zero foreground writes, try the next verified candidate;
- `ForegroundChanged`: stop, zero writes;
- rolled back: try the next winner (MVP policy);
- `PromotionNeedsAttention`: stop immediately, return manual-attention info, no further
  promotion.

ContinuationJournal group terminal/release receipts (`group_terminal`, `group_released`)
make the snapshot cleanup re-runs idempotent.

## 10. Typed outcomes and fault boundary

```ts
type AdaptiveTaskOutcome =
  | { kind: "promoted"; winnerId: string; touchedPaths: string[] }
  | { kind: "no_verified_candidate"; reason: string }
  | { kind: "budget_exhausted"; budget: "calls" | "tokens" | "time" | "candidates" }
  | { kind: "suspended"; reason: string }
  | { kind: "foreground_changed"; message: string }
  | { kind: "promotion_needs_attention"; promotionId: string; recoveryCopies: string[] };
```

Storage/journal corruption, authority mismatch and unreconstructable graph/state are NOT
ordinary outcomes: they throw `AdaptiveRuntimeFault` (with `TaskJournalFault` /
`TaskGraphFault` / `WorkspaceManagerFault` from the underlying authorities). With no
verified candidate the foreground is byte-identical to the capture.
