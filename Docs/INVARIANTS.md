# Adaptive MetaRuntime Invariants

This document carries forward Section 4 of the original `DESIGN.md` as the normative document for runtime semantics, durability, projection, and fault boundaries. No implementation or optimization may conflict with the invariants here; implementation status and test evidence are in `IMPLEMENTATION_STATUS.md` and `CONFORMANCE.md` respectively.

## 1. Non-violable system invariants

### 1.1 Harness invariant

- A Run spans from atomic acceptance of a prompt or exact-continuation intent to the terminal transaction.
- A turn is one assistant step plus the complete tool batch requested by that assistant message.
- At post-turn yield, the Run may still be open.
- Yield does not write a terminal result, nor does it write a durable pause marker.
- Crash restore only reads the current lane's `lane.config`, `lane.state`, `lane.leaf`, and the open operation's `op.meta`, `op.state`, then performs bounded hydration on the entries/registers directly named by those registers; it does not scan or fold history.
- `op.state` is the complete durable program counter of the open operation. The terminal transaction atomically deletes operation-owned registers, writes `lane.lastResult`, and clears `currentOperationId`; long-lived facts after completion can only come from immutable entries, usage rows, and explicit session-lived facts.
- A lane has at most one open operation at a time, and at most one driver.
- provider, tool, hook, and sleep do not occupy the lane mutation line.
- Parallel tool effects may run in parallel, but tool results must be finalized and persisted in source order.
- `adaptive.run_basis` and `adaptive.tool_batch` are model-invisible custom entries; without an explicit projector, they must not enter provider context, but they fork with the entry branch and are retained long-term.
- The current JSONL Adapter only promises process-crash/torn-tail recovery after acknowledged append; it does not promise power-loss or `fsync` durability; stronger guarantees must be provided as explicit storage capabilities.

### 1.2 LeafTurn invariant

- A single `execute()` starts at most one new assistant request.
- Before returning `turn`, the complete tool batch has been executed, finalized, and persisted.
- assistant entry, tool-result entries, and usage rows are durable before return.
- At return time, the next provider request has not yet started.
- `LeafTurnCursor` contains only durable `operationId`, `assistantEntryId`, and post-turn `leafId`, so it can be deduplicated and provide optimistic concurrency protection after crash/retry.
- Expected provider/tool failures are returned as typed outcomes; storage failure faults the entire Harness.

### 1.3 Candidate invariant

```text
CandidateNode
  = conversation checkpoint
  + workspace snapshot/lease
  + belief
  + cost
  + strategy
```

- Conversation and workspace must be forked, restored, and retired in pairs.
- A workspace lease belongs to at most one active candidate at a time.
- A candidate must save trajectory and diff metadata before being pruned.
- Before winner promotion, the foreground workspace must be re-verified to have no drift.
- Exact siblings must share the same conversation leaf, workspace snapshot, model-visible execution snapshot, PolicyBundle version, CandidateStateProjector version, and policy-state fingerprint.
- Exact siblings do not copy the source open Run's `op.*` registers; each child atomically accepts a new durable continuation Run and writes its own `adaptive.run_basis` entry.

### 1.4 ToolPolicy invariant

- ToolPolicy is owned by the Controller but executes quickly in-process through the tool-clearance Seam inside the Harness; it does not yield per call via `LeafTurnExecutor`.
- The provider-visible tool set is fixed as `read`, `write`, `edit`, `bash`. Dynamic permissions do not change the tool schemas of the next provider request.
- `allow` preserves validated arguments; `argument_guard` only performs equivalent path canonicalization, workspace escape checks, schema revalidation, and safe upper-bound checks.
- Any argument rewrite that would materially change the model's intent must `block`; it cannot be disguised as a guard.
- The Adaptive profile atomically writes an `adaptive.tool_batch` custom entry before any tool effect, storing source-ordered decisions and effective arguments under the same batch basis; open-state recovery directly references that entry and does not copy the same payload into `op.tool_args`. A block also produces an `isError: true` synthetic tool-result entry.
- ToolPolicy does not produce new coding tool calls. The Evaluator's Hard Verifier may run verification effects directly, but they must be recorded as evaluator evidence, not disguised as model calls.
- ToolPolicy faults are fail-closed before effect: tools are not executed, a clear policy-fault result is generated, and the Controller at the next checkpoint decides whether to continue, verify, branch, or stop.
- Tool execution crash/replay is handled by Harness v4 R4; ToolPolicy does not override the replay declaration and does not self-retry side-effecting tools.
- `adaptive.tool_batch` only proves that clearance and effect intent have been committed, not that the effect has occurred or completed. When the entry exists but the result entry is missing, the outcome is unknown: only when both captured and current replay declarations are `safe` are the effective args in the entry used to re-execute; otherwise, a synthetic `interrupted` result is written. Clearance is re-run only before the entry is written; after it is written, ToolPolicy decisions are not re-run.
- ToolPolicy decisions must be determined by the pinned PolicyBundle and the candidate state reconstructed by `CandidateStateProjector` from `adaptive.run_basis` and the durable entry branch. When re-clearing after a crash, TrajectoryStore or process-local counters must not be read.
- All phase-1 clearances for the same assistant tool batch read the same reconstructible `ToolBatchPolicyBasis`; its basis is the durable entry cursor at the start of the batch corresponding to that assistant entry. Earlier tool results within the batch do not change the clearance of subsequent calls, preventing sequential/parallel modes from producing different policy decisions.

### 1.5 Adaptation invariant

A Task here refers to a top-level user goal and all its candidate trajectories, not a single Harness Run:

```text
Task
  ├─ candidate A -> Run A1 -> turns -> steps/tool effects
  ├─ candidate B -> Run B1 -> turns -> steps/tool effects
  └─ candidate C -> Run C1 -> turns -> steps/tool effects
```

Terminology follows Harness v4:

- **Task**: A user goal accepted by the Adaptive MetaRuntime, along with all candidates created for it; this is the lifecycle of adaptation.
- **Candidate**: An independently evolving conversation/workspace/control state. At fork, siblings start at the same point, then diverge with their respective entry branches, usage ledgers, and workspace states.
- **Run**: A durable operation from when the Harness atomically accepts a prompt or exact-continuation intent to the terminal transaction; a Task can contain multiple candidate Runs.
- **Turn**: One assistant step plus the complete tool batch requested by that assistant message.
- **Step**: A retryable unit of work within the Harness. Assistant, compaction, and branch summary can all be steps; each tool call that actually starts an effect is also a tool step. Thus "read/edit/bash is one step" holds, but "all steps are tool calls" does not.

`PolicyBundle` is not a loose configuration with only ToolPolicy parameters, but a canonical, immutable artifact: it binds at least Controller/ToolPolicy rules, deterministic Evaluator rules, evidence fusion version/config, an online learned evaluator profile/reference, `CandidateStateProjector` version, and related schema versions. It references immutable evaluator artifact/profile identity and does not embed learned evaluator model weights directly. What Task admission pins is:

```ts
interface PolicyBundleRef {
  version: string;
  fingerprint: string;
}
```

Both Task admission and each Run restore must re-resolve and validate the same artifact through PolicyRegistry; missing, fingerprint mismatch, or unsupported schema all fail-closed. Old versions must not be updated in place.

The MVP state relationship is:

```text
CandidatePolicyState(candidate, cursor)
  = Projector_v(
      pinned PolicyBundleRef,
      inherited state capsule from adaptive.run_basis,
      durable entry branch and usage through cursor,
      reconstructible workspace metadata
    )
```

All projection consumers share the same identity Interface; they cannot independently assemble cache keys:

```ts
interface ProjectionBasis {
  taskId: string;
  candidateId: string;
  sessionId: string;
  lane: string;
  operationId: string;
  cursor:
    | { kind: "task_origin" }
    | { kind: "post_turn"; cursor: LeafTurnCursor }
    | { kind: "tool_batch_start"; assistantEntryId: string };
  policyBundle: PolicyBundleRef;
  projectorVersion: string;
  inheritedStateFingerprint: string;
}

interface CandidatePolicyStateRef {
  basis: ProjectionBasis;
  fingerprint: string;
}
```

`fingerprint` is the projection result fingerprint for that basis, not a mutable state id. Capsule, ToolBatchPolicyBasis, CandidateNode, and projection cache all reference this Interface; Harness cursor resolution, version validation, and canonical hashing stay within the `CandidateStateProjector` Implementation to maintain Locality of recovery knowledge.

This means "updating state after step/turn" refers to obtaining a new projection after the immutable entry branch and usage ledger are extended, not submitting a mutable count to another authoritative database. Run admission solidifies the inherited capsule only once within the `adaptive.run_basis` entry; exact siblings share the same capsule and starting fingerprint, and after fork, their branches diverge, so their states evolve independently.

- PolicyBundle is locked at Task admission; no weight hot-update for any Run or candidate of that Task.
- Each candidate has an independent `CandidatePolicyState`, but the MVP does not build a second correctness-critical Store for it. It is a deterministic projection of the pinned PolicyBundle, `adaptive.run_basis`, durable entry branch, usage rows, and reconstructible workspace metadata.
- After a tool-result entry is durable, the extended prefix logically updates fast facts: file/context freshness, recent action signatures, failure fingerprints, durable error metadata, and cost; no additional authoritative state mutation is submitted.
- After a turn is fully durable, `CandidateStateProjector` aggregates task phase, progress, verification debt, belief, and budget posture with the structured `LeafTurnCursor`.
- Before the next provider request, the next tool batch, or exact branch admission, the state fingerprint must be successfully reconstructed and validated from the target durable cursor.
- Process-local or persisted projection caches are disposable performance optimizations; cache miss, crash, or cache corruption recover by replaying entry branches and usage rows and cannot change decision semantics.
- State that affects future policy decisions can only be derived from immutable entries/usage rows up to the specified projection cursor, pinned PolicyBundle/projector version, and reconstructible workspace metadata. Open `op.*` registers can only assist recovery and consistency checks; they cannot become history that must be read after terminal. Raw-only evidence can enter the non-authoritative TrajectoryStore but cannot change CandidatePolicyState without being persisted.
- Learned Evaluator output may directly drive the current Task only under the D20 durability contract: durable-before-control, stable identity/version/input fingerprint, replay-safe recovery, and pinned evidence fusion. Until that contract is satisfied for a given evaluator, its output can only be used for offline analysis and optimization after the Task ends.
- After the Task ends, the TaskEvaluator provides ground truth; only then can the Optimizer produce candidate PolicyBundles for future Tasks.
- Online adaptation is "immutable rules + evolving candidate state", not in-session gradient updates or Controller weight hot updates.

### 1.6 Persistence and recovery invariant

This document strictly distinguishes Harness durable state from process-local observations:

- **entry**: Immutable history in the session tree; messages, compaction, branch summaries, and application-defined custom entries all belong to this layer.
- **register**: Current mutable state. `lane.*` and `fact.*` are session-lived; `op.*` exists only while the operation is open and is deleted by the terminal transaction.
- **usage row**: Append-only cost ledger; not deleted when an operation terminates.
- **event**: Live UI/telemetry notification; events are not persisted, not replayed, and cannot serve as a fact source for recovery or `CandidatePolicyState`.
- **raw outcome**: Temporary result seen by the executor before finalize; unless it first enters an entry, register, usage row, or other explicit durable authority, it can be lost after a crash.

`fact.custom` is a session-global, mutable, latest-wins register, suitable only for storing current session-level fast facts; it is not branch history. Candidate-level, Run-level, or tool-batch provenance must be written to the corresponding immutable custom entry, not into `fact.custom`; otherwise, history views cannot be reconstructed by cursor after fork.

The MVP persistence topology is fixed as:

```text
Task admission
  -> pin immutable PolicyBundleRef in PolicyRegistry
  -> every adaptive Run atomically appends adaptive.run_basis
  -> Harness entries + usage are completed-history authority
  -> current lane/op registers are open-operation authority
  -> CandidateStateProjector derives CandidatePolicyState
       -> optional projection cache stays inside its Implementation
  -> TrajectoryStore asynchronously copies research data
```

Task-level metadata cannot replace Run provenance. Every adaptive Run's acceptance transaction must submit the `adaptive.run_basis` custom entry together with `op.meta`, initial `op.state`, lane updates, and prompt entries (if any). That entry carries at least `taskId`, `candidateId`, `PolicyBundleRef`, projector version, and the inherited policy-state capsule; `op.meta` only references it, and the entry persists after terminal. Otherwise, when the Task spans Runs, forks, or independent recovery, it cannot prove the same policy basis was used. In PolicyRegistry, the same version always resolves to the same canonical content; modifying a policy requires publishing a new version.

The authoritative state machine for Adaptive tool batches is:

```text
assistant entry                              # proposed args already durable
  -> source-ordered schema validation + ToolPolicy clearance for whole batch
  -> TX[ append adaptive.tool_batch {
           schemaVersion: 1,
           policy-state fingerprint,
           decisions[{sourceIndex, toolCallId, toolName,
                      decision, effectiveArgs, replay}]
         } as child of assistant entry,
         move lane.leaf to that custom entry,
         update op.state to reference it and reserve result ids ]
  -> allowed effects                        # parallel or sequential
  -> source-ordered tool-result entries     # complete durable outcomes
```

`adaptive.tool_batch` is the sole durable payload location for effective arguments: the Adaptive profile's `op.state` only references that entry and retains reserved result ids needed for settlement in its own typed state; it does not copy the effective-args payload into `op.tool_args`. The custom entry's `parentId` already links to the assistant; the data does not redundantly store assistant/result entry ids. This simultaneously satisfies v4's single-payload invariant, opaque-payload constraint, pre-effect durability, and post-terminal projection. Non-Adaptive Harness runs can still use v4's native `op.tool_args`.

The MVP does not add an independent `PolicyDecisionStore`, `tool_policy_decision` record, or `tool_finished` record:

- When `adaptive.tool_batch` has not yet been committed, recovery re-runs clearance from the same pinned PolicyBundle and batch-start basis.
- When the entry has been committed, recovery only uses the source-ordered decisions/effective args in it; ToolPolicy is not re-run; the model-visible outcome of a block is still a synthetic tool-result entry.
- Decision kind, reason codes, features, and alternatives are copied to TrajectoryStore; their loss does not change resume correctness.
- If a decision field will affect recovery in the future, it must be incorporated into the `adaptive.tool_batch` schema, not by adding a shallow parallel log.

`adaptive.tool_batch` only proves that intent is durable, not that the effect has not yet occurred, has occurred, or has completed. A crash after it is an unknown-effect state: only when both the captured replay declaration and the current tool declaration are `safe` can the Harness re-execute using the effective args in the entry; otherwise, it writes a provisioned synthetic `interrupted` result and must not self-retry side-effecting tools. Tool Adapters that require external exactly-once must provide their own idempotency/reconciliation mechanism; ToolPolicy does not replace it.

Post-turn `turn_end` is a process-local event, not a durable checkpoint marker. The Adapter must return the structured `LeafTurnCursor` only after entries and usage rows are queryable; projection cache uses the canonical `ProjectionBasis` and stores re-verifiable result fingerprints. Cache miss, corruption, or deletion can only affect performance.

The "durable" of Harness storage is defined by the backend contract. The current JSONL contract is that after the append promise resolves, it can withstand process crashes and torn tails; it does not include `fsync` or power-loss guarantees; if power-loss recovery is required, it must be handled as an independent storage capability and validation matrix, not inferred from the word "append-only".

### 1.7 Learned Evaluator invariant

- Online learned evidence must be durable-before-control: the Controller must not use learned evidence that exists only in process memory.
- TrajectoryStore is never an authoritative evidence source for the current Task's Controller.
- The same durable evaluator evidence prefix must produce the same fused `BeliefState`.
- Evaluator identity, version, and canonical input fingerprint must be stable and bound to each invocation.
- Settled evidence is not re-sampled; on restore it is reused, not overwritten by a new evaluator result.
- A crash must not change an already-committed Controller basis due to evaluator stochasticity.
- Unsupported replay or unknown-effect states must produce a typed outcome (`unavailable`/`interrupted`), never a blind re-invocation.
- Learned evaluator failure is separated from Hard Verifier failure and must not be disguised as such.
- The evidence fusion algorithm/version is pinned by the PolicyBundle or an equivalent immutable policy artifact.
- Exact siblings must share the same committed evaluator evidence prefix at the branch start.
- After branching, siblings may independently produce new evaluator evidence.
- PolicyBundle promotion does not affect already-admitted Tasks.

### 1.8 Trajectory retention invariant

- Retention/eviction must not delete any correctness authority.
- Eviction must not change any active or recoverable Task.
- Retention is reference-aware: data still referenced by a dataset manifest, PolicyBundle evaluation provenance, or other retained artifact must not be deleted.
- TrajectoryStore loss does not change execution correctness.
- Dataset export must record the source dataset identity/fingerprint.
- A redacted/exported dataset carries an identity distinct from its raw trajectory source.

### 1.9 Policy promotion invariant

- Published PolicyBundles are immutable; old versions are never modified in place.
- Promotion only changes the future-active reference; it does not update any running Task.
- Active and recoverable Tasks keep their pinned PolicyBundle unchanged.
- Rollback only switches the active reference back to a prior version; it does not mutate history.
- Candidate provenance and evaluation provenance must be retained until the retention contract allows their deletion.
