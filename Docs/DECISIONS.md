# Adaptive MetaRuntime Decisions

This document carries forward D1-D19 from the original `DESIGN.md`, plus D20 added by the Stage 9 contract freeze. Accepted decisions are frozen scope; Proposed ones are still deferred recommended defaults and must not be treated as final contract before the corresponding functionality enters implementation.

## 1. Decision index

| ID | Decision | Status | ADR | Conclusion |
|---|---|---|---|---|
| D1 | First milestone | Accepted | [`D1-milestone-safety-gate.md`](./ADR/D1-milestone-safety-gate.md) | R4 delivers a controlled functional demo; only after R6, R4 replay conformance, and the process-crash matrix of at least one durable backend have all passed, is the Adaptive Runtime allowed to operate on real projects |
| D2 | Windows workspace scope | Accepted | [`D2-windows-workspace-scope.md`](./ADR/D2-windows-workspace-scope.md) | Initial version only supports Git worktree; non-Git workspaces explicitly return `UnsupportedWorkspace` |
| D3 | Snapshot content | Accepted | [`D3-snapshot-content.md`](./ADR/D3-snapshot-content.md) | Capture tracked and untracked non-ignored files; ignored files, secrets, and large caches are excluded by default |
| D4 | Winner promotion | Accepted | [`D4-winner-promotion.md`](./ADR/D4-winner-promotion.md) | Use strict fingerprint and PromotionJournal; on foreground drift, stop without automatic merge |
| D5 | Branch continuation | Accepted | [`D5-exact-continuation.md`](./ADR/D5-exact-continuation.md) | Adopt context-exact continuation: no hidden re-prompt; each child atomically accepts a new durable continuation Run and writes `adaptive.run_basis`; does not copy source `op.*` registers; only differences within the sampling envelope are permitted |
| D6 | Sandbox boundary | Accepted | [`D6-sandbox-boundary.md`](./ADR/D6-sandbox-boundary.md) | WorkspaceManager only provides file-state isolation; process/network security for real deployments is provided by a separate sandbox Adapter |
| D7 | Candidate worker layout | Accepted | [`D7-candidate-worker-layout.md`](./ADR/D7-candidate-worker-layout.md) | Initial version uses one hidden Harness session and one workspace lease per candidate |
| D13 | ToolPolicy MVP | Accepted | [`D13-toolpolicy-mvp.md`](./ADR/D13-toolpolicy-mvp.md) | Only supports `allow`, `block`, and semantics-preserving `argument_guard`; does not support result shaping, defer, arbitrary reorder, or material rewrite |
| D14 | Adaptation scope | Accepted | [`D14-adaptation-scope.md`](./ADR/D14-adaptation-scope.md) | PolicyBundle is immutable throughout the entire Task; per-candidate state updates fast facts after each step and aggregates after each turn; only after the Task ends can the Optimizer publish a future version |
| D15 | Raw outcome | Accepted | [`D15-raw-outcome.md`](./ADR/D15-raw-outcome.md) | MVP has no Adaptive result shaping; after raw passes through Harness standard error conversion/normalization, it is semantically identical to the durable/model-visible result; in the future, raw is only provided to the executor, the Evaluator, and the TrajectoryStore under retention/redaction control |
| D16 | Provider-visible tools | Accepted | [`D16-fixed-tool-surface.md`](./ADR/D16-fixed-tool-surface.md) | Fixed as `read`, `write`, `edit`, `bash`; name, schema, description, and order do not change within a Task |
| D17 | ToolPolicy faults | Accepted | [`D17-toolpolicy-faults.md`](./ADR/D17-toolpolicy-faults.md) | Uniformly fail-closed before effect; Harness durable storage faults must fault the Harness; projection cache failures recover through recomputation and must not be disguised as ordinary blocks |
| D18 | Durability authority split | Accepted | [`D18-durability-authority.md`](./ADR/D18-durability-authority.md) | Immutable entries/usage are the completed-history authority, current registers are the open-operation authority; `adaptive.run_basis`/`adaptive.tool_batch` store provenance needed across terminal; PolicyRegistry is the immutable policy content authority; CandidateStateProjector produces a reconstructible view; research data enters the non-authoritative TrajectoryStore |
| D19 | Physical durability | Accepted | [`D19-physical-durability.md`](./ADR/D19-physical-durability.md) | MVP only promises process-crash/torn-tail recovery, not power-loss durability; stronger guarantees are added later as explicit storage capabilities |
| D9 | Evaluator | Accepted | [`D9-evaluator-roadmap.md`](./ADR/D9-evaluator-roadmap.md) | Hard Verifier and deterministic calibrated rules are retained; the Stage 9 learned evaluator may produce durable evidence that affects the current Task's `BeliefState`/Controller under the D20 durability contract |
| D10 | Trajectory retention/privacy | Accepted | [`D10-trajectory-privacy.md`](./ADR/D10-trajectory-privacy.md) | Trajectories are local-first and long-lived by default, governed by a configurable disk quota; once quota is reached, reference-aware value + age eviction applies; redaction is required before external export |
| D11 | PolicyBundle promotion | Accepted | [`D11-policy-promotion.md`](./ADR/D11-policy-promotion.md) | Optimizer candidate PolicyBundles may be automatically promoted after a strict offline gate; versions are immutable with full lineage, and instant rollback is supported via the future-active reference; promotion only affects new Tasks |
| D20 | Learned evaluator authority | Accepted | [`D20-learned-evaluator-authority.md`](./ADR/D20-learned-evaluator-authority.md) | Online learned evaluator evidence must be durable-before-control with stable identity/version/input fingerprint, replay-safe recovery, and pinned evidence fusion; TrajectoryStore is not its authority |
| D8 | Branch concurrency/budget | Proposed | [`D8-branch-budget.md`](./ADR/D8-branch-budget.md) | Fix a small upper limit first; record three budget types: token/call/time |
| D12 | Non-Git Adapter | Proposed | [`D12-non-git-adapter.md`](./ADR/D12-non-git-adapter.md) | Implement safe full-copy after a real need arises; do not use hardlink |

## 2. Status semantics

- `Accepted`: The original `DESIGN.md` explicitly recorded it as confirmed.
- `Proposed`: The original `DESIGN.md` explicitly deferred it, retaining only recommended defaults; it still needs to be frozen before the corresponding functionality enters implementation.
- The specific decision context is governed by the respective ADR and the related contracts in `DESIGN.md`/`INVARIANTS.md`.
