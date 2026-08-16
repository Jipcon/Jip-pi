# Adaptive MetaRuntime Conformance

This document carries forward the validation matrix from the original `DESIGN.md`. It defines behaviors that should be proven by shared semantic tests, durable conformance, process-crash tests, and WorkspaceManager conformance. Which tests have been run for a specific Stage and their results are recorded in `IMPLEMENTATION_STATUS.md`.

Principles:

- Shared semantic characterization validates model-visible single-turn semantics;
- Harness-only conformance validates durable identity, restore/replay, and automatic/manual parity;
- The storage/workspace process-crash matrix validates recovery at real subprocess termination boundaries;
- TrajectoryStore/telemetry failures must not affect execution correctness.

## 1. Validation matrix

### 1.1 LeafTurn contract

Shared semantic characterization (Legacy and Harness):

- no-tool assistant response;
- one tool;
- sequential and parallel batch;
- unknown, invalid, blocked tool;
- truncated `length` tool calls are not executed;
- provider error, tool error, abort during stream/tool;
- no second provider request after turn returns;
- the complete tool batch finishes before return, tool results preserve source order.

Harness-only durable conformance:

- assistant/tool/custom entries and usage rows are durable before return;
- `operationId`, entry ids, usage row ids, and the structured `LeafTurnCursor` remain stable after close/reopen;
- cursor mismatch and concurrent driver rejection;
- `turn_end` arrives first but entries/usage are not yet queryable — must not return early;
- automatic/manual final durable state is byte-equivalent.

### 1.2 Harness v4 crash recovery

- close/reopen/resume after each durable action;
- four crash positions for generation/tool: before intent, after intent but not dispatched, during effect, after settlement;
- restore only performs five-register point lookup and bounded hydration, with zero provider/tool/hook/timer effects;
- when `adaptive.tool_batch` does not exist, rebuild clearance; when it already exists, only read persisted decisions/effective args;
- replay captured/current both `safe`, either unsafe, declaration changed;
- parallel batch for each source-order prefix;
- recovery executed twice is still idempotent;
- terminal transaction deletes all operation-owned registers, preserves entries/usage, writes `lane.lastResult`;
- crash notifications allow at-least-once delivery but are deduplicated by `LeafTurnCursor`;
- JSONL process-crash/torn-tail guarantee and optional power-loss durability capability are tested separately; when `fsync` capability is not declared, power-loss safety is not claimed.

### 1.3 ToolPolicy and adaptation

- provider-visible tools are always `read`, `write`, `edit`, `bash` in fixed order; schemas do not drift within a Task;
- the permissive Adapter and the legacy execution baseline produce the same model-visible result, tool source order, and failure semantics for the same input; Harness durable state is validated separately per 13.1 and 13.2;
- `allow` preserves validated args, `argument_guard` only produces semantics-preserving args and must re-pass schema validation;
- material rewrite, workspace escape, and illegal args all block; effect count stays zero;
- block decisions enter `adaptive.tool_batch`, write a durable synthetic error result; effect count stays zero;
- allow/guard writes effective args to the batch's sole `adaptive.tool_batch` entry before effect; Adaptive open state only references that entry;
- MVP does not add an independent `PolicyDecisionStore`, `tool_policy_decision`/`tool_finished` record; decision telemetry loss does not change recovery; the tool-result entry is the complete model-visible outcome;
- policy throw, timeout, illegal decision, and missing bundle/state all fail-closed;
- Harness durable write failure faults the Harness, not converted to a policy block; projection cache failure only triggers discard and recomputation;
- the task-origin capsule of the initial adaptive prompt Run can be repeatedly constructed; when the same candidate accepts a new Run, the state at the previous post-turn cursor serves as the `adaptive.run_basis` inherited capsule durably;
- `adaptive.run_basis` and run acceptance are in the same transaction; on any failure, custom entry, prompt entries, op/lane registers do not exist;
- the same canonical `ProjectionBasis` must reconstruct the same `ToolBatchPolicyBasis`; even if earlier results in this batch are already durable, the state fingerprint at the batch start is still projected;
- before `adaptive.tool_batch` commit, crash rebuilds clearance from the same pinned bundle and batch basis; after commit, ToolPolicy is not re-run, only the persisted effective args in the entry are used;
- all clearances for the same batch read the same policy-state fingerprint; results in this batch are only visible to the next batch/turn projection;
- the source order, parallel effect, and R4 replay invariant of sequential/parallel batches are not changed by ToolPolicy;
- in the MVP, raw outcome only passes through Harness standard error conversion/normalization; durable and provider-visible results are semantically identical, with no Adaptive result shaping;
- after deleting all projection caches, the CandidatePolicyState and fingerprint reconstructed from `adaptive.run_basis`, entry branch, usage rows, and workspace metadata remain unchanged; there is no second state-commit crash window;
- when the same basis reconstructs an inconsistent fingerprint, return `StateProjectionMismatch` and block provider request, tool effect, and exact branch; non-persisted raw-only evidence does not change CandidatePolicyState;
- step updates freshness/action/failure/cost; turn aggregates phase/progress/verification debt; exact branch copies the same CandidatePolicyState;
- TrajectoryStore pause, duplicate delivery, or loss of non-authoritative records does not change Harness execution; duplicate records are deduplicated by stable identity;
- the Controller does not generate additional coding tool calls; Hard Verifier effects are recorded separately as evaluator evidence.

### 1.4 Exact continuation

- session fork copies the immutable entry/fact/lane snapshot specified by v4; does not copy `op.*`, operation-owned `pending.entry`, `lane.lastResult`, or usage ledger; child lane is idle;
- before the child's first request, only append model-invisible `adaptive.run_basis`; do not append hidden user/control entries;
- child acceptance transaction persists the same inherited policy-state capsule; recovery does not depend on the source session's open-operation registers;
- all siblings share the same committed leaf, workspace snapshot, context fingerprint, PolicyBundle version, CandidateStateProjector version, policy-state fingerprint, and fixed-tool-catalog fingerprint;
- canonical request fingerprint is the same; only the seed/sample identity in durable provenance differs;
- when temperature, tools, system prompt, or hook version drift, it fails before provider dispatch;
- physical cwd is projected through `ExecutionEnvironment` to the same logical workspace identity; if it cannot be safely projected, it is rejected;
- source candidate is frozen after branching; all active paths go through the same continuation admission;
- child crash recovery after the acceptance transaction does not re-append prompt, repeat basis entry, or repeat admission;
- retrying the same continuation group reattaches from `ContinuationJournal`; does not create twin session/workspace/run;
- on group half-creation or storage fault, no sibling can dispatch before reconciliation completes;
- parent session, open Run, and workspace are not modified by child execution;
- no-tool settled leaf, pending queue/write, unresolved tool, deferred handle, and missing identity are rejected;
- when the provider has no seed capability, it still records isomorphic request and capability but cannot claim deterministic replay;
- `BRANCH` and `DIVERSIFY` trajectory tags and training data are strictly separated.

### 1.5 WorkspaceManager

- clean, dirty, staged, deleted, renamed, binary tracked file;
- untracked create/modify/delete;
- candidate can still produce a complete diff after committing internally;
- two candidates modifying the same path do not interfere with each other;
- capture/fork/promote do not change the foreground branch or index;
- on foreground fingerprint drift, zero writes;
- Windows locked file cleanup, orphan recovery;
- path traversal, junction/symlink escape, case collision;
- private ref and worktree metadata have no leakage;
- run final verifier after promotion.

## 2. Stage 9 validation matrix

### 2.1 Learned evaluator semantic tests

- deterministic evaluator-only baseline reproduces identical `BeliefState` as before;
- learned evidence successful settlement becomes Controller-visible;
- learned + Hard Verifier evidence fusion produces the pinned fused `BeliefState`;
- learned evaluator unavailable;
- learned evaluator timeout;
- malformed learned evaluator result;
- evaluator version mismatch;
- input fingerprint mismatch;
- evidence fusion version mismatch.

### 2.2 Learned evaluator crash matrix

Cover at least:

```text
before evaluator intent
after intent / before dispatch
effect in flight
effect returned / before durable settlement
after evidence settlement
after fusion / before Controller action
after Controller decision durability
```

Verify:

- settled result is not re-sampled after reopen;
- reopen yields the same durable evidence;
- duplicate invocation is deduplicated;
- unsafe unknown-effect state is not blindly replayed;
- the Controller basis is not changed by a crash.

### 2.3 Trajectory retention tests

- under quota, no eviction;
- quota exceeded triggers eviction;
- value + age eviction prioritizes high-value failure/rare failure/verified success/branch comparison;
- referenced trajectory is not deleted;
- high-value failure retention;
- export redaction;
- raw and exported dataset identities differ;
- TrajectoryStore loss does not change runtime correctness.

### 2.4 Policy promotion tests

- candidate publication;
- canonical fingerprint;
- lineage provenance;
- offline gate pass;
- offline gate fail;
- regression gate fail;
- automatic promotion;
- future Task uses the new version;
- existing Task still uses the old version;
- rollback;
- after rollback, future Task uses the prior active version;
- old immutable version content is unchanged;
- crash during publication/promotion;
- retry promotion is idempotent;
- invalid or incomplete provenance rejects promotion.
