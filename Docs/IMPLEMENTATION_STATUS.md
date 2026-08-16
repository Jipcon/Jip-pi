# Adaptive MetaRuntime Implementation Status

This document carries forward the implementation path, Stage status, and recorded delivery summaries from the original `DESIGN.md`. It is an implementation/status record and does not redefine the architecture contract.

The source document header records `Last updated: 2026-08-14`, while the Stage 7 entry records `completed (2026-08-15)`; this split preserves both original records without self-correction.

## 1. Current summary

- Stage 0, M0, Stage 1-8: The source document records them as completed/passed the corresponding acceptance.
- Stage 9 — Learned Evaluation + Optimizer: planned / contract frozen; not implemented.
- R7 deferred polling, compaction, navigation, and Stage 10 surface completion: continue to be deferred.
- Harness v4 baseline: upstream commit `9795d6023`.

## 2. Minimal implementation path

### 2.1 Current Harness v4 status snapshot

With the upstream commit `9795d6023` obtained on 2026-08-13 as the fixed baseline:

- `packages/agent/docs/harness.md` provides the full v4 specification and build order.
- The upstream `packages/agent/src/harness/agent-harness.ts` is still the old scaffold; `prompt()`, `resume()`, manual drive, watch, and v4 restore have not been implemented. v4 is currently a target contract, not a directly callable production runtime.
- The v4 build order starts from behavior-free **Slice 1 Types**, **Slice 2 Session/Memory/conformance**; storage Track S can run in parallel, and runtime Track R proceeds in R1-R12 order.
- Migration batch M0 has preserved `LegacyAgentLeafAdapter` and shared 9-item single-turn semantic characterization, and changed the durable `LeafTurnExecutor` to an Adaptive-owned type.
- Slice 1 has landed a complete shared type surface in the `@earendil-works/pi-agent-core/harness-v4` subpath, freezing the Adaptive run-intent reference, versioned custom-entry payload, and post-turn/usage query shapes.
- Slice 2 has landed the Session/Memory foundation in the same subpath: atomic transaction, lane/fact/query/context/fork, runtime codec, UUIDv7, usage stats, and repository lifecycle; shared backend conformance and instrumented storage are exported from `harness-v4/testing`. It still does not execute provider, tool, or durable operation state machines.
- R1 has landed the Runtime shell: restore reads only `lane.config`, `lane.state`, `lane.leaf` and the open operation's `op.meta`, `op.state` per lane, then performs exact-id/key bounded hydration; it also provides total-state validation, register-seq/settings-revision conditional transitions, lane/settings mutation lines, runtime snapshots, manual effect gate, `Effects` decorator, hooks/events, dispatch-time identity report, and fault/close admission barrier. Public run/tool paths still explicitly return not implemented, with zero provider/tool effects.
- R2 has landed the Minimal no-tool Run: prompt/skill/template expansion, `before_run` and request/payload/response hooks, atomic acceptance including `adaptive.run_basis` and captured next-run placement, provider intent/effect/response+usage settlement, terminal cleanup/`lane.lastResult`, and the no-tool `HarnessV4LeafTurnAdapter`'s durable cursor, usage query, automatic/manual drive, concurrent-driver guard, and close/reopen conformance. Generation recovery/retry landed in R3, durable tools landed in R4, inbox/config/writes landed in R5, and abort/close/failure reconciliation landed in R6.
- R3 has landed Generation recovery and retry: the pure function `nextAction(state, PlannerInputs)` exhaustively traverses run checkpoint/assistant/deferred/failure-drain states and produces `transition / dispatch / await_effect / settle / wait / suspend / finish` actions; `GenerationRunDriver` executes these actions with a loop interpreter; `DriveState.running` is the sole process-local live-effect authority. The checkpoint atomically captures configuration, stream options, and normalized retry policy; each real attempt re-runs `before_request` but always synthesizes from captured base options; effect intent is durable before provider dispatch; restored `effect_pending` below cap never replays the original attempt or materializes old reserved IDs; when the cap is reached, it writes a synthetic interrupted error with zero usage under the original reserved ID and enters `failure_drain`. Settlement uses a first-match classifier to atomically write the response entry, usage row, `latestAssistantEntryId`, and the succeeding total state (completed/may_finish, deferred suspension, retry_wait, failure_drain); `retry_wait`'s notBefore and normalized policy are all durable; before the deadline, it auto-sleeps/exposes a stable wait action in manual mode; after the deadline, it enters the next attempt's ready. The public `resume()` reads the current open operation and drives it, not creating a second operation; idle returns `NothingToResume`, ready missing identity returns `MissingIdentities` without burning an attempt, identity disappearing after effect intent becomes an in-band error, and synthetic cap recovery does not require identity. Invalid provider aborted (no Harness-owned cancellation) is classified as an ordinary error; tool-bearing responses continue to fail-closed. Opening a session only recovers and reports suspended; reopening does not auto-replay provider effects.
- R4 has landed Durable tools: `tool-execution.ts` extracts the prepare/execute/finalize three-phase from agent-loop (agent-loop's 23 tests remain compatible); generation settlement encountering tool calls/toolUse atomically commits the assistant entry, usage, ToolBatch (turnId = generation stepId, follower UUIDv7 reserved result IDs) and enters the tools phase; genuine `length` with tools generates all synthetic truncated results without executing effects. The standard Run's effective args are stored only in `op.tool_args/{opId}:{turnId}:{index}` (prepareArguments + schema validation + before_tool replacement, then re-validate, and the last result commit deletes that batch prefix in the same transaction); `planned → effect_pending(replay) → completed(terminate)` are all durable; `SettlementResult.dispatch` guarantees durable intent before effect. Restored `effect_pending` only replays under the original reserved ID when both captured and current declarations are `safe`; safe→never, never→safe, or declaration disappearing all write synthetic interrupted results; recovery events carry the original turnId and `recovery:true`. Adaptive Run uses a batch-level clearance Seam (core defines `AdaptiveToolBatchClearance`, adaptive provides `PermissiveToolPolicyAdapter` and `FakeRuleToolPolicyAdapter`, no reverse dependency): clearance results are written once to the sole `adaptive.tool_batch` custom entry (child of assistant, lane leaf moved to that entry, authority migrated to `adaptive_tool_batch_entry`), never writing `op.tool_args`; crash before entry commit re-runs clearance, after commit only reads persisted decisions; ToolPolicy faults and missing adapters all fail-closed as blocked. Sequential/parallel, unknown tools, invalid arguments, blocked, result normalization, and tool usage all have deterministic semantics in the same transaction; terminated_tools uses `runCompletion: "terminated_tools"` with no final assistant terminal state. Adaptive LeafTurn returns immediately after the complete tool batch via process-local `DriveSelector(post_turn)` (yield is not durable state); `promptAdaptiveTurn`/`resumeAdaptiveTurn` does not produce a next provider request; the open Run cursor is only visible after the batch is fully committed.
- The old Harness scaffold is temporarily retained only for existing repo consumers; it is not part of v4 and does not form a compatibility promise; it must be removed or switched as the default export once Slice 2/R1 provides a replacement foundation; two durable contracts must not coexist long-term.
- This project advances on its own fork/branch per the fixed contract and does not use the deleted v2 reservation process. If contributing upstream is chosen in the future, it will be re-packaged per the official contribution and ownership rules at that time.
- There is currently no Adaptive v2 durable runtime or production session data, so no storage data migration is needed; M0 is a contract/document migration.

### 2.2 Stage plan

#### Stage 0 — Characterization

- Define the shared single-turn semantic characterization and Harness-only durable conformance suite.
- Use legacy `shouldStopAfterTurn` to build `LegacyAgentLeafAdapter`.
- Lock down turn event, tool source order, stop/abort, and "cannot start a second provider request early" behavior.
- Status: completed, 9 focused tests passed.

#### M0 — Harness v4 contract migration

- Fix the v4 spec commit; change execution authority to entries/registers/usage.
- Define the single-payload/atomicity contract for `adaptive.run_basis` and `adaptive.tool_batch`.
- `LeafTurnExecutor` uses Adaptive-owned result, suspension, rejection, abort, and structured `LeafTurnCursor`; returns `usageRowIds`.
- Preserve the Legacy Adapter and shared semantic tests; do not modify the official Harness source.
- Status: closed after this batch completes.

#### Stage 1 — v4 Types and Session foundation

Implemented per the v4 build order:

```text
Slice 1 Types [completed]
  -> Slice 2 Session + Memory + conformance + instrumented storage
```

Slice 1 must simultaneously freeze the `AdaptiveRunIntent` reference shape, versioned custom-entry schemas, and the queries needed by `LeafTurnCursor` as required by this design; it cannot first implement the old prompt-only type surface and then have the Adapter smuggle in extensions. Slice 2 only provides general immutable storage for Adaptive custom entries and does not understand policy semantics.

Slice 1-2 status: completed. The in-memory Session/storage foundation has been taken over by the R1 Runtime shell for recovery and scheduling shell; there are still no provider/tool effects or a complete durable operation interpreter.

#### Stage 2 — Runtime shell and no-tool Run

```text
R1 Runtime shell
  -> R2 Minimal no-tool run
```

- R1 provides five-register restore, bounded hydration, manual gate, hooks/events, lane mutation line, fault/close plumbing.
- R2 acceptance transaction atomically writes `adaptive.run_basis`, optional prompt entries, `op.meta`, initial total `op.state`, and lane registers.
- After R2, implement the no-tool `HarnessV4LeafTurnAdapter`, validating `LeafTurnCursor`, usage rows, entry-before-return, and automatic/manual parity.

R1-R2 status: completed. R1 acceptance covers five-register/no-history restore, idle-lane validation, seq/settings token settlement, manual gate nesting, parallel scheduler start order, hook aggregation, event buffering, parked zero effects, fault/close, and operation/action variant exhaustiveness; R2 acceptance covers atomic adaptive acceptance, captured next-run placement, prompt expansion, single provider generation, invalid caller/provider/hook isolation, exact transaction/event order, usage/terminal durability, manual close prefix, and `HarnessV4LeafTurnAdapter`'s cursor/reopen/concurrent-driver behavior.

R3 status: completed (2026-08-14). Acceptance covers: pure planner exhaustively traversing all R3 state/action branches; retry disabled/zero-delay/multi-failure-then-success/exhausted/non-retryable/backoff-saturated; each real attempt exactly one `before_request` with captured options unaffected by global setters; `ready`, live/restored `effect_pending` (before/after cap), `retry_wait` before/after deadline, `failure_drain`, `deferred` close/reopen recovery with zero effect on reopen; ready missing identity does not burn an attempt, identity disappearing after effect intent becomes in-band error, synthetic cap recovery does not require identity; stop/length/retryable error/terminal error/invalid aborted/deferred/tool fail-closed classification; settlement transaction simultaneously persists response entry, usage row, `latestAssistantEntryId`, and succeeding state, cap recovery uses original reserved ID with zero usage, terminal cleanup deletes all op.* and updates `lane.lastResult`; message/retry/entry/usage/run/turn event order with no duplicates; automatic/manual drive produces identical durable results; public `resume()`'s idle/concurrent/LaneBusy/`run_resume` behavior and `HarnessV4LeafTurnAdapter`'s open Run advance, reopen recovery, deferred suspension, missing-identity mapping. Next step is R4; live tools, tool replay, and `adaptive.tool_batch` are still intentionally not implemented.

R3 actual recovery/retry boundary: `checkpoint.need_assistant` atomically captures current configuration, stream options, normalized retry policy (maxAttempts = enabled ? maxRetries+1 : 1, backoff baseDelay×2^(attempt-1) arithmetic saturating to `Number.MAX_SAFE_INTEGER`); `assistant.ready` checks captured identity then runs this attempt's `before_request`, reserves response/usage IDs, and commits `effect_pending` before dispatch; live `effect_pending` waits for the original effect via process-local running key then atomically settles; restored `effect_pending` below cap uses captured context to enter a higher-numbered attempt (no materialization of old reserved IDs, no replay); at cap, writes synthetic interrupted error with zero usage under the original reserved ID and enters `failure_drain`; `retry_wait` before deadline auto-sleeps (manual mode exposes stable `sleep`/`until` actions), after deadline enters the next attempt's ready; provider `stop` settles as completed; genuine `length` is handled as normal completion (R9 overflow inference explicitly not implemented); retryable error with remaining quota atomically writes failure response, usage, and `retry_wait`; non-retryable/exhausted atomically enters `failure_drain` then terminates with failure; valid `deferred` writes response/usage, keeps operation open, and returns suspended (no poll before R7); provider `aborted` without Harness-owned cancellation is converted to ordinary error as invalid provider output; tool-bearing responses fail-closed (`tools_not_implemented`); R4 enters the tools phase.

#### Stage 3 — Generation recovery and durable tools

```text
R3 Generation recovery/retry
  -> R4 Tools
```

- R3 covers generation intent before/after, effect uncertain window, settlement, and retry cap; completed.
- R4 atomically appends `adaptive.tool_batch` under the Adaptive profile, letting tool state reference that entry; the standard profile retains v4 `op.tool_args`; completed.
- R4 acceptance covers: three-phase extraction with agent-loop compatibility (23/23); ToolBatch and follower result IDs; unknown/invalid/blocked/truncated/argument replacement/revalidation; standard `op.tool_args` full lifecycle; Adaptive single-entry authority with zero duplicate registers; crash before entry commit re-runs clearance, after commit no re-run; sequential/parallel effect order with source-ordered finalize; safe/safe replay and all unsafe combinations; declaration disappearing or changed; terminate all and mixed terminate; invalid result normalization; tool usage and entry atomicity; recovery events with original turnId; manual/automatic durable equivalence; parked state zero effects; Adaptive post-turn produces no second provider request; open Run cursor and `advance()`; `terminated_tools` terminal state; terminal cleanup leaves no `op.tool_args`.
- R4 completes source-ordered preparation/finalization, parallel effects, safe/unsafe replay, and synthetic interrupted results.
- After R4, a functional and tool-crash-safe LeafTurn is achieved, but it is still only suitable for controlled Memory-backend experiments.

#### Stage 4 — Minimum safe path for real projects

```text
R5 Inbox/config/writes [completed]
  -> R6 Abort/close/failure drain [completed]

S1 JSONL durable backend + backend conformance
  + process-crash matrix [completed]
```

R5 status: completed (2026-08-14). External inputs arriving during runtime all enter a durable, recoverable, and competitively verifiable serialization path: `nextRun`/`steer`/`followUp`/`cancelQueued` atomically write `pending.entry` and queue IDs via the lane mutation line (cancel also deletes the owning list and pending register, stably triaging cancelled/already_consumed/not_found); queue payload is stored only in the pending register, lists store only entry IDs, restore validates each ID has a matching register with no cross-duplicates, codec tightens message/custom pending payload; the checkpoint pure planner (`inbox.ts`) selects `all`/`one-at-a-time` eligible items per captured `steeringMode`/`followUpMode`, drain completes source-ordered insertion, pending deletion, lane.leaf move, and continuation/trigger/`skipInboxOnce` update in a single transaction (projected input switches to fresh need_assistant + skipInboxOnce; crash between drain and generation does not double-consume; unprojected custom write retains original continuation); failure_drain reuses the same inbox planner, projecting input recovers as need_assistant, otherwise terminates per the original error; `before_run_end` only executes outside the mutation line when normal may_finish + inbox is empty, hook follow-up born placed and need_assistant in the same transaction, queue changes during hooks cause results to be discarded as stale and replanned, crash back to the same finish boundary allows re-execution; assistant/tool settlement changes to verify effect/batch identity against the latest `op.state` then only merge self-owned fields (concurrently accepted queue/tree writes are preserved as-is), ordinary transition and intent CAS failures change to bounded restore + replan instead of throwing; lane config setters overwrite the entire register, defensive clone, update process-local snapshot and send `config_update` with previous/value after commit, captured generation/tool batches are unaffected by subsequent config changes; `recordUsage` writes append-only `UsageRow(adjustment:true)`, does not build operation state, sends `usage` event after commit and returns latest totals; lane-bound `LaneSessionTree` delegates `appendMessage`/`appendCustomEntry` to the Harness (idle immediately same-transaction entry+leaf, open/suspended Run reserves IDs writing pending.entry+inbox.writes, returns reserved IDs after durable acceptance, still applicable after reopen), message writes and custom writes registering a projector trigger the next generation, unregistered custom only moves the leaf; terminal cleanup does not delete lane-owned `pendingNextRun`; events `queue_update`/`write_pending`/`entry_added`/`config_update`/`usage` are only sent from durable ID dereference after commit, reopen does not replay; Adaptive post-turn drive yields first when there are pending inputs or before_run_end hooks at the succeeding boundary, a single `promptAdaptiveTurn`/`resumeAdaptiveTurn` does not start a second provider request due to new queues. Acceptance covers all R1-R4 regressions and the R5 matrix: queue competition order, cancel/consumption... [truncated]

R6 status: completed (2026-08-14). Abort is orthogonal control, not a phase: the first `abort()` submits `cancel_requested` in a single transaction on the lane mutation line and atomically moves the current `inbox.steer`/`inbox.followUp` into the drained list (pending register retained until terminal deletion, `inbox.writes` untouched), itself only waits for the marker to be durable then returns; repeated aborts are zero-write, zero-duplicate signal/event and return the first saved drained payload, already-terminal returns `NoActiveOperation`. Added pure-function cancellation-first planner (`cancellation.ts`) before the identity gate/retry/normal phase planner: checkpoint/failure_drain only continues draining writes, does not consume steer/followUp, does not run `before_run_end`, after writes are cleared directly enters aborted terminal; assistant ready/retry_wait terminates directly without starting provider/retry; assistant effect_pending live waits for real outcome (abort committed before `after_response` starts skips hook) and normalizes raw response to `stopReason: "aborted"`, retains reserved response ID and live usage, not-started/restored writes synthetic aborted response with zero usage under original reserved ID then enters cancellation checkpoint; tools do not prepare/clearance/`before_tool`/effect, planned writes synthetic aborted result per source order (zero usage/effect), restored effect_pending never replays and writes synthetic interrupted result, completed preserved as-is, live waits for real outcome and skips `after_tool` if not started, `terminate` forces zero; deferred identifies the latest persisted handle then at most one process-local best-effort `cancel_deferred` (captured provider/model/handle identity, close-only signal, failure only telemetry, terminal waits for this attempt, reopen allows retry); structural scaffold (compaction/navigation) directly aborted terminal. Process-local per-operation signal registry is separated from the close/fault controller, before effect execution re-enters the lane mutation line for linearized start-check (abort committed first must be not_started, effect registered first as started then settled per live outcome), manual gate's parked action carries operation identity and abort only cancels that operation's un-released actions (effect → not_started, hook → skip, never disguising as HarnessClosed). Settlement always re-reads the latest control: cancelled control can only write aborted response/aborted-interrupted tool result, running control rejects persisting aborted provider response; aborted terminal single-transaction deletes `op.meta`/`op.state`/`op.tool_args`/`op.preparation`/inbox and drained pending entries, preserves lane config and `pendingNextRun`, writes `lane.lastResult(outcome: "aborted")` and clears `currentOperat... [truncated]

R6 and S1 together deliver Controller prune/cancel, close race, failure reconciliation, and process-crash durability boundaries, satisfying the infrastructure safety threshold for the Adaptive Runtime to operate on real projects. This does not mean the adaptive loop is implemented: the next step is still Stage 5 single-candidate adaptive tool loop. The initial version disables the deferred provider, so R7 deferred polling remains deferred; R8-R12 proceed per compaction, navigation, migration, and complete surface requirements.

S1 status: completed (2026-08-14). JSONL was chosen over SQLite: zero new dependencies, single-file auditable, isomorphic to the v4 Transaction model. `packages/agent/src/harness/v4/jsonl/` lands the frozen JSONL v1 format: one UTF-8/LF file per session, first line `{kind:"header",format:"pi-harness-v4-jsonl",version:1,storageVersion:1,id,createdAt,cwd?,parentSessionId?}`, remaining lines each exactly one `{kind:"transaction",version:1,firstSeq,timestamp,writes[]}` record; the durable seq of `writes[i]` is fixed to `firstSeq+i`, usage/register does not store a second set of seqs, entry write saves the final `Entry.timestamp` for fork to precisely preserve source time, one transaction, one encoding, one `appendFile`. `codec.ts` strictly validates header/kind/version/seq continuity and all payloads (payload reuses `SessionCodec`, draft rules are rebuilt per-transaction during validation); unknown format/version returns `storage_version`, complete but illegal record returns `corruption` and is never discarded as torn tail. `storage.ts` reconstructs entries/usage/registers/stats and query indexes from the complete transaction prefix, reopen does not depend on the previous process memory; commit order is validate → isolated draft → single-line encoding → append resolve → publish draft, append failure faults/seals and requires reopen. `repo.ts` uses id-encoded filenames (path does not concatenate unencoded cwd/id), create/fork first writes a complete sibling `.tmp` then atomic rename to publish, `.tmp` is not listed, failure does best-effort cleanup without deleting the old target first; fork copies immutable entries, lane placement/config, and facts, does not copy usage/`op.*`/pending/`lane.lastResult`. Torn-tail contract: complete record missing LF atomically appends LF; last line with incomplete JSON is discarded and the legal prefix atomically published; last line complete but illegal reports corruption without truncation; malformed interior reports corruption, bytes unchanged; repair write/rename failure causes open to fail, original file unchanged, tmp cleaned; header missing or torn fails directly without tail repair. The Session layer did a pure mechanical backend-neutral seam (`StorageSession` + `Storage.snapshot()` + `buildForkWrites`), Memory behavior unchanged.

S1 validation: JSONL and Memory pass the same `createSessionBackendConformance()`; `v4-jsonl-codec` (exact-byte golden + strict validation), `v4-jsonl-storage` (full torn-tail matrix, append-fault seal, create/fork publication) all green. The process-crash matrix (`v4-jsonl-process-crash.test.ts` + `fixtures/v4-jsonl-crash-child.ts`) is launched by the parent Vitest process using `process.execPath` to start a real subprocess, Windows forced termination/other platforms SIGKILL, covering create/fork publication, operation acceptance, provider intent, standard/adaptive tool intent, assistant/tool settlement, inbox drain, abort marker, terminal cleanup, and torn append: each transaction first records a no-crash baseline, and the canonical snapshot after recovery is exactly equal to the baseline's transaction N or N+1, never mixed. Cross-process effect semantics re-verification: the same assistantEffectKey is not replayed (restored effect_pending only enters an explicitly higher attempt); after assistant settlement is durable, resume does not call the provider again; tool only replays under the original reserved result ID when both captured/current are safe, with only one durable tool-result entry in the end, when either side is unsafe or declaration disappears/changes, effect count is zero and a synthetic interrupted result is written; pending writes, abort drained entries, `lane.lastResult` are all cross-process verified. Generation/tool/inbox/abort/close recovery and `HarnessV4LeafTurnAdapter`'s post-turn cursor, tool batch, abort/reopen are all re-run on JSONL through the backend factory (same assertions not duplicated). Acceptance commands all green, `npm run check` has no error/warning/info, no new dependencies or lockfile changes.

S1 guarantee boundary: only promises that under process crash, after acknowledged append, the old prefix or complete new transaction is recovered; does not promise power-loss recovery, does not call or claim `fsync` durability; does not handle random bit corruption parseable as legal JSON; no deferred polling, migration, log compaction, or multi-process concurrent writers (single-process active writer, must close/fault before reopen). Next step enters Stage 5; R7 deferred polling remains deferred.

#### Stage 5 — Single-candidate Adaptive Tool Loop

Before enabling branching, complete the minimal quantifiable closed loop first:

```text
frozen model
+ fixed read/write/edit/bash schemas
+ minimal immutable PolicyRegistry resolver
+ PermissiveToolPolicyAdapter baseline
+ AdaptiveToolPolicyAdapter
+ allow/block/semantics-preserving argument_guard
+ CandidatePolicyState
+ CandidateStateProjector + reconstructible ToolBatchPolicyBasis
+ Step/Turn/Task Evaluator
+ TrajectoryStore capture
```

Constraints:

- Single candidate; no CandidateGraph search, subagent, or additional planner introduced.
- No support for result shaping, defer, arbitrary reorder, material argument rewrite, or Controller-generated coding tool calls.
- PolicyBundle uses interpretable fixed rules; the minimal PolicyRegistry only needs publish/resolve `PolicyBundleRef`, validate canonical fingerprint, and retain versions referenced by Runs. The Optimizer does not learn yet; it only records sufficient trajectory data.
- Compare permissive baseline and adaptive policy on success, tool error, redundancy, latency, tokens, and verification coverage.

Functional experiments depend on R4; permission to execute on real projects depends on the complete safety threshold of Stage 4.

Stage 5 status: completed (2026-08-14). Landed in `packages/adaptive-agent/src/runtime/`: `PolicyBundle` (versioned, canonical SHA-256 fingerprint, guard rules only allow equivalent path canonicalization, material rewrite not expressible) and `InMemoryPolicyRegistry`/`JsonlPolicyRegistry` (publish/resolve validates canonical fingerprint, same version with different content rejected from overwriting, corrupt/missing fail-closed); concrete, bounded, canonicalizable `CandidatePolicyState` (phase, allow/guard/block/success/failure/duplicate counts, recent action/failure fingerprints, file freshness/mutation summary, token/tool/turn budget, verification evidence/coverage/debt, workspace node separately fingerprinted and not participating in state fingerprint); `CandidateStateProjector` (task_origin/tool_batch_start/post_turn three cursors, reconstructs only from `adaptive.run_basis`, target branch prefix, usage rows, and pinned bundle/projector version, tool_batch_start stops at the assistant entry excluding all results in this batch, replay cross-validates the persisted policyStateFingerprint for each `adaptive.tool_batch`, throws `StateProjectionMismatch` on inconsistency, cache deletable and verifiable); Step/Turn share pure deterministic reducers, TaskEvaluator without verifier does not treat ordinary final answer as success; clearance seam minimally extended to carry `sessionId/lane/operationId/basisEntryId`, Core only passes durable identity; `AdaptiveToolPolicyAdapter` (projects once per batch, all decisions same fingerprint, schema-invalid/workspace escape/budget exhausted/rule conflict block, catalog drift/bundle missing/projection mismatch/timeout/illegal decision fail-closed before effect, replay does not exceed the tool's own declaration), `PermissiveToolPolicyAdapter` uses the same Registry/Projector without a fixed fake fingerprint, `FakeRuleToolPolicyAdapter` has been deleted; `SingleCandidateAdaptiveToolLoop` (admission validates frozen model/fixed tool catalog/bundle/origin capsule, iterates `advance(afterCursor)`, each post-turn completes projection/evaluation before the next provider request, settlement/suspension/abort/budget exhaustion all typed outcomes, new Run's `adaptive.run_basis` persists the previous post-turn capsule); non-authoritative `TrajectoryStore` (stable identity, at-least-once, query deduplication, only stores structured metrics/hash/length/redacted summaries, write pause/failure/duplicate/loss does not change execution); permissive/adaptive comparison runner (verified success, tool error/block/redundancy, latency, tokens, verification coverage, only allows disposable temp workspace). Acceptance covers: model/tool drif... [truncated]

#### Stage 6 — Exact Continuation Admission

Complete before CandidateGraph branching:

- Adaptive basis-entry reference for v4 `Operation.intent` and zero-prompt continuation acceptance; its type/transaction primitive was frozen in R2, and Stage 6 opens it to BranchContinuation.
- branchable `LeafTurnCursor` query and immutable `ContinuationCheckpoint`;
- exact-compatible hook/resource policy;
- context/canonical request fingerprint gate;
- stable logical workspace projection through `ExecutionEnvironment`;
- `BranchContinuation` Interface, ContinuationJournal, and crash conformance.

Functional version depends on R4; the version allowed for real projects depends on Stage 4. The initial version disables the deferred provider, so it does not depend on R7.

#### Stage 7 — Windows/Git WorkspaceManager

- First implement `GitWorktreeWorkspaceAdapter` and a temp-directory test Adapter.
- Complete dirty foreground capture, candidate fork, binary diff, strict promotion, Windows cleanup/recovery.
- Bind the hidden worker's cwd and tools to `WorkspaceLease.root`.

Stage 7 status: completed (2026-08-15). The implementation contract is frozen in `packages/adaptive-agent/docs/workspace-manager.md`; landed in `packages/adaptive-agent/src/runtime/`:

- `workspace-manager.ts`: small and stable `WorkspaceManager` contract (capture/fork/snapshot/diff/promote/release/findSnapshot/releaseSnapshot/recover), deterministic `workspaceLeaseId = sha256(snapshotId:candidateId)`, `WorkspaceManagerContinuationAdapter` bridges Stage 6 `WorkspaceContinuationPort` (snapshot ignores caller-forgeable `WorkspaceMetadata`, all reconstructed from real capture).
- `workspace-errors.ts`: `UnsupportedWorkspace`/`UnsupportedRepositoryState`/`SourceWorkspaceChanged`/`WorkspaceSnapshotNotFound`/`WorkspaceSnapshotMismatch`/`WorkspaceLeaseConflict`/`WorkspacePathEscape`/`WorkspaceCaseCollision`/`ForegroundChanged`/`PromotionConflict`/`PromotionNeedsAttention`/`WorkspaceOrphaned`/`BranchOriginFrozen`; Git/fs/manifest/journal write failures are `WorkspaceManagerFault`, not disguised as business rejections.
- `git-worktree-workspace-adapter.ts`: capture uses `git stash create` to capture staged+unstaged tracked (does not change branch/index/files), falls back to HEAD with no tracked changes; private ref `refs/pi-adaptive/snapshots/<repoId>/<snapshotId>`; untracked via `ls-files --others --exclude-standard -z` + `--directory` pass (junction/symlink does not traverse, pointing outside root rejected, escape junction invisible to git zero capture); untracked original bytes enter manager-owned content store; fingerprint = HEAD OID + index tree + tracked tree + untracked manifest hash + policy hash; two-pass drift re-check → `SourceWorkspaceChanged`. Rejects bare/submodule/sparse/unmerged index/merge-rebase-sequencer/unborn HEAD. Fork to manager-owned directory, detached HEAD, `creating -> ready` durable, same `snapshotId+candidateId` deterministic reattach, content conflict fault. Diff uses `git diff --binary --full-index --no-renames <ref> --` file-by-file segmentation (including candidate commit), untracked create/modify/delete separate manifest, tracked new file overwriting untracked preimage first removes then applies (`preExistingUntracked`), same path is never both patch-added and plan-deleted.
- `workspace-promotion.ts` + `promotion-journal`: strict optimistic promotion — winner workspace first runs verifier (failure zero writes) → foreground fingerprint re-check (drift `ForegroundChanged` zero writes) → per-path preimage/target/recovery copy durable then per-path apply (`git apply --binary` per segment + untracked same-volume temp+rename, after completion `git read-tree <capturedIndexTree>` restores index, no commit no stage) → foreground final verifier → close journal; on failure, auto-rollback only when path still equals post-apply hash, user concurrent modification → `PromotionNeedsAttention` retains recovery copies; no automatic three-way merge. Recover uses same CAS for open journal: zero applied discarded, identical postHash rolled back, drift needs-attention.
- release: `creating -> ready -> releasing -> released/orphaned`; first `git worktree remove --force` then fs.rm (absolute paths limited to manager-owned root), Windows EPERM/EBUSY/ENOTEMPTY bounded retry, exhaustion marks orphaned without falsely reporting released; private ref deleted only after worktree deletion succeeds (not deleted if still referenced by other leases); blob/worktree metadata cleaned by `recover()` reconciliation. `recover()` is idempotent, only processes `refs/pi-adaptive/**` and manager-owned root, only promises process-crash recovery.
- `runtime-manifest.ts`: append-only JSONL (torn-tail tolerant, corrupt interior fault), snapshot/lease/promotion records folded by stable key.
- `workspace-bound-worker.ts`: each candidate exclusively holds hidden Harness + lease + `ExecutionEnv`; `NodeExecutionEnv.cwd == lease.root`, `WorkspacePathAdapter` does logical/physical bidirectional mapping and escape rejection; `releaseBoundWorker` fixes close → env.cleanup → lease.release order; system prompt only contains logical root (`createCodingAgentHarness` adds `logicalCwd` seam).
- `branch-origin.ts`: `SessionRegisterBranchOriginRegistry` uses `fact.custom` register to persist freeze marker (same file as session, close/reopen recovery); `BranchContinuation` freezes after `group_planned`, permanently read-only origin after `group_ready`, safely unfreezes on typed failure with no dispatch; `HarnessV4LeafTurnAdapter.originGuard`/`SingleCandidateAdaptiveToolLoop.originGuard` fail-closed before start/advance. `child_workspace_ready` journal records and re-checks `leaseId`+`snapshotId`; `ContinuationCheckpoint` carries real `workspaceFingerprint`; forkExact failure path releases already-built sibling leases (fixes Stage 6 worktree leak).
- `temp-directory-workspace-adapter.ts`: test-only full-copy backend (real byte copy, no hardlink), shares manifest/content-store/promotion/recovery with the Git backend, runs the same conformance suite.

Validation: `workspace-manager-conformance.ts` applies the same assertions to both backends (clean/dirty/staged/deleted/renamed/binary, untracked create/modify/delete, drift after capture, ignore/deny/oversize and policy fingerprint, candidate commit complete diff, two candidates same path, parent re-capture/fork, foreground branch/index/files unchanged, deterministic reattach no twin, drift zero writes, no commit no stage, verifier/apply/final-verifier/concurrent modification each failure stage, locked file/orphan dir/ref/half-created worktree, traversal/junction/case collision/Windows dangerous paths, no ref/blob/worktree metadata leak, hidden worker four tools only modify lease root, prompt has no physical root, freeze/unfreeze/permanent origin/reopen, process-crash at each durable boundary, `recover()` double-run idempotent); `workspace-process-crash.test.ts` uses real subprocesses killed after capture, after creating record, after fork completes, after all paths applied, after releasing record, and verifies recovery; Stage 5/6/Legacy all regressions pass; `npm run check` zero error/warning/info.

Stage 7 remaining boundary (explicitly belongs to Stage 8, Stage 7 intentionally does not do): CandidateGraph, winner selection, branch budget, and Controller search; promotion primitive is callable but winner determination is executed by Stage 8 caller injecting verifier; `originGuard` integration for the full v4 surface (prompt/queue/write/config lane mutation paths) is completed by Stage 8 Controller; group terminal snapshot `releaseSnapshot`/journal re-check semantics are defined together with Stage 8's group terminal; does not implement automatic merge, process/network sandbox, power-loss durability, or real provider.

#### Stage 8 — Minimal Adaptive Runtime

- CandidateGraph;
- exact `BranchContinuation`;
- TurnPolicy and rule-based Controller;
- reuse Stage 5's verified ToolPolicy and hierarchical Evaluator;
- Hard Verifier + simple belief fusion;
- bounded branch count and compute budget;
- foreground winner promotion.

First validate the system closed loop with interpretable policy, then introduce learned evaluator/controller.

#### Stage 9 — Learned Evaluation + Optimizer

Stage 9 status: planned / contract frozen. D9/D10/D11 are accepted and D20 defines the online learned evaluator evidence authority; no Stage 9 runtime, learned evaluator, Optimizer, or PolicyRegistry promotion functionality is implemented yet.

```text
S9.1  D9/D10/D11/D20 contract freeze
S9.2  Learned Evaluator Interface + durable evidence authority
S9.3  evaluator crash/replay + evidence fusion
S9.4  TrajectoryStore query/index/quota/retention/dataset export
S9.5  evaluator calibration + learned evaluator integration
S9.6  current-Task Controller integration
S9.7  offline Controller optimization
S9.8  PolicyBundle candidate evaluation/promotion
S9.9  automatic promotion + rollback
S9.10 Stage 9 conformance
```

#### Stage 10 — v4 surface completion

- Complete R7 deferred, R8-R9 compaction, R10 navigation, R11 migrations, and R12 surface/backend parity as needed.
- Each state-machine schema change carries a total migration; cannot depend on old `op.*` history because terminal operations do not retain these registers.
- Replace scripted/fake clients with real Harness bindings, complete the backend race/crash matrix.

`HarnessV4LeafTurnAdapter` is located at:

```text
packages/adaptive-agent/src/runtime/harness-leaf-turn-adapter.ts
```

## 3. Next steps recorded in the original text

1. R1-R6, S1 JSONL durable backend/process-crash matrix, Stage 5 single-candidate adaptive tool loop, and Stage 6 exact continuation admission are completed; Stage 5 delivered the minimal immutable PolicyRegistry (Memory + JSONL), CandidateStateProjector, AdaptiveToolPolicyAdapter, concrete CandidatePolicyState, Step/Turn/Task Evaluator, TrajectoryStore, single-candidate loop, and permissive/adaptive comparison runner, all validation matrices passed and permissive baseline's model-visible semantics consistent with legacy; Stage 6 delivered branchable `ContinuationCheckpoint` narrow capture seam, canonical context/request fingerprint with pre-dispatch double gate, entries-only session fork supporting source lane, zero-prompt `exact_continuation` Run admission, sampling provenance, `ExecutionEnvironment` narrow workspace port, and ContinuationJournal (Memory + JSONL) crash matrix; `NotBranchableCheckpoint`, `SourceCheckpointChanged`, `WorkspaceSnapshotMismatch`, `MissingIdentities`, `NonDeterministicRequestPolicy`, `StateProjectionMismatch`, `RequestFingerprintMismatch`, `UnsupportedSamplingControl` all typed fail-closed, faux-provider provider-call count precise, crash retry produces no twin session/workspace/run; no more functionality added to v2 scaffold, S2 SQLite and R7 deferred polling remain deferred.
2. Stage 7 Windows/Git WorkspaceManager is completed: `GitWorktreeWorkspaceAdapter` and temp-directory test Adapter cover dirty foreground capture, candidate fork, binary diff, strict promotion, Windows cleanup/recovery, and hidden worker's cwd and tools bound to `WorkspaceLease.root`.
3. Stage 8 Minimal Adaptive Runtime is completed (including S8 promotion-lineage acceptance): delivered append-only `AdaptiveTaskJournal` (Memory + JSONL), fold-style `CandidateGraph` (revision + deterministic action id, replay no-op, conflict fault, four-authority reconciliation), reusable `CandidateTurnRunner` (Stage 5 `SingleCandidateAdaptiveToolLoop` remains as its single-candidate wrapper, original tests continue to pass; child `adaptive.run_basis.candidateId` uses childId, inherited capsule retains source fingerprint, model-invisible), candidate-cwd `HardVerifier` (`verifier_planned` durable before effect; after crash only replay-safe re-run, otherwise typed `interrupted`; workspace mutation makes candidate ineligible as winner) and integer basis-points belief fusion, rule-based Controller (fault → stop → verify → branch(2) → budget prune → failed/suspended prune → continue), task budget (calls/tokens/time/fanout/active/total/depth, caps frozen, call/time reaching limit zero new provider request, token allows single overshoot), root four-phase recoverable provisioning, exact branch and branch-origin full-surface barrier, winner eligibility consistency re-check, strict promotion and completion receipt (same-attempt retry returns original durable result, successful closed journal not deleted not re-run), continuation group terminal/release receipt and idempotent snapshot cleanup; beyond typed outcomes (promoted/no_verified_candidate/budget_exhausted/suspended/foreground_changed/promotion_needs_attention), storage/journal/authority mismatch fault runtime; all validation uses faux provider and temp workspace, real APIs prohibited. S8 promotion lineage acceptance: derived snapshots separate `forkBase` (S1: exact child and continuation verification) and `promotionOrigin` (S0: drift gate, complete S0→winner patch, original index recovery), lineage enters manifest/`promotionOriginSnapshotId`/`promotionOriginFingerprint`, receipt and reference-aware retention (origin retained while live derived snapshots exist), Temp/Git backends both have source-modified-branch-then-promotion, drift zero writes and reopen replay regressions; `inherited capsule provenance-only` (cross-session) is retained as Stage 8's explicit boundary, its internal snapshot/fingerprint still has consistency validation.
4. Entering Stage 9: continue using the frozen model, fixed `read`/`write`/`edit`/`bash` schema; next step implements R7 deferred polling, compaction/navigation surface, PolicyBundle promotion, and learned Evaluator/Controller as needed; does not introduce backtrack, diversify, or additional planners.
