# D20 — Online Learned Evaluator Evidence Authority

- Status: **Accepted**
- Source: Stage 9 contract freeze; incremental extension of D18

## Context

D18 fixes the durability authority split as follows:

- immutable entries / usage are the **completed-history authority**;
- current registers are the **open-operation authority**;
- TrajectoryStore is **non-authoritative research data**.

That split is sufficient for deterministic evidence reconstructed from durable facts. It is **not** sufficient to carry a non-deterministic learned evaluator result that may change the current Task's Controller decisions. The authority split cannot be bypassed by letting the Controller read the TrajectoryStore: research data has no durability contract strong enough to be a correctness-critical basis.

Because a learned evaluator output can now influence the current Task (D9), it must be given a correctness-critical durability contract. This ADR defines that authority as an incremental extension of D18, without rewriting D18's original decision.

## Decision

Introduce a durable evaluator evidence authority, modeled as:

```text
EvaluatorInvocation
  invocationId
  taskId
  candidateId
  cursor / candidate revision
  evaluator identity
  evaluator version
  input fingerprint
  policyBundle fingerprint
        ↓
durable intent
        ↓
learned evaluator effect
        ↓
EvaluatorEvidence
  invocationId
  output fingerprint
  structured evidence
  confidence / uncertainty
  provenance
        ↓
durable settlement
        ↓
Belief fusion
        ↓
Controller
```

The following invariants are frozen:

1. The Controller must not use learned evidence that exists only in process memory.
2. Before the Controller uses learned evidence, that evidence must be durable.
3. On restore, if the corresponding evidence is already durable, it must be **reused**; the evaluator must not be re-invoked to produce a new result that overwrites the old one.
4. An invocation must be bound to: evaluator implementation/model identity, version, canonical input fingerprint, candidate/cursor identity, and PolicyBundle identity.
5. On identity/version/input drift, old evidence must not be silently reused.
6. A crash in the window where the evaluator effect has started but the result is not yet durable must have explicit recovery semantics.
7. Remote evaluator invocation must not be assumed exactly-once.
8. If an evaluator Adapter cannot prove replay-safety, an unknown-effect state must not be blindly re-invoked; it must produce a typed `unavailable`/`interrupted` evidence, and the Controller proceeds on remaining deterministic evidence or takes `verify`/`stop`.
9. A learned evaluator failure must not be disguised as a Hard Verifier failure.
10. TrajectoryStore may copy evaluator evidence for research, but is not its authoritative source.
11. The evidence fusion algorithm/version must be pinned by the PolicyBundle or an equivalent immutable policy artifact.
12. After crash/reopen, the same durable evidence prefix must produce the same Controller-visible fused state.

## Scope

D20 defines only the runtime evidence authority for the learned evaluator. It does **not** freeze: PRM model architecture, the number of models in a semantic ensemble, provider, training framework, loss function, or any specific calibration algorithm.
