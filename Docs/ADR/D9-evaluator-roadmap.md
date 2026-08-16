# D9 — Evaluator

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

Stage 9 extends the Evaluator from hard verifier + calibrated rules into a three-layer evidence model. The original text already warned that a non-deterministic judge may not directly drive the current Task until a durable authority, identity/version, input/output fingerprint, and restore/replay contract exist. This ADR adopts that path: Stage 9 formally allows a learned evaluator to enter the current Task's control loop, with D20 defining the correctness-critical durability contract that gates that online use.

## Decision

The Evaluator evidence model becomes:

```text
hard evidence
+deterministic process evidence
+learned semantic/process evidence
        ↓
versioned evidence fusion
        ↓
BeliefState
```

1. The **Hard Verifier** remains the highest-confidence executable evidence source. It is not replaced by the learned evaluator.

2. **Calibrated deterministic rules** remain the replayable base Evaluator.

3. Stage 9 introduces a **learned evaluator** as an additional evidence source.

4. The learned evaluator **may affect the current Task's `BeliefState`**, provided its evidence satisfies the D20 online authority contract.

5. The Controller may, based on the fused evidence, execute `continue`, `branch`, `prune`, `verify`, or `stop`.

6. The learned evaluator does **not** directly call coding tools.

7. The learned evaluator does **not** directly modify the workspace.

8. The learned evaluator is **not** a provider-visible tool.

9. Online use of the learned evaluator is preconditioned on the D20 durability contract.

10. An experimental evaluator that does not satisfy the D20 durability contract may only be used for offline analysis.

```text
Hard Verifier ≠ replaced by learned evaluator
```

## Scope

D9 defines the evidence-model roadmap and the online-usage gate. The correctness-critical durability contract for online learned evaluator evidence — durable-before-control, identity/version/input fingerprint, restore/replay, deduplication, and fusion versioning — is defined incrementally in D20, which extends the D18 authority split without rewriting it.
