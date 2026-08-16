# D10 — Trajectory Retention/Privacy

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

Stage 9 freezes the TrajectoryStore retention/privacy policy. The TrajectoryStore remains non-authoritative research data; its loss must not change execution correctness. Retention governs when that research data may be discarded, not the authority of runtime recovery.

## Decision

The TrajectoryStore retention policy is frozen as:

```text
local-first
long-lived by default
configurable disk quota
value + age eviction
redaction before external export
```

- Trajectories are stored **local-first** and **long-lived by default**.
- Fixed-N-day automatic deletion is **not** the primary retention policy.
- A **configurable disk quota** bounds total storage.
- While under quota, data is retained normally.
- When quota is reached, data is evicted by a combined **trajectory value + age** policy, which prioritizes retaining high-value failures, rare failures, verified successes, and branch comparisons.
- Local Optimizer / calibration / training datasets may consume the retained data directly.
- Any **external export** or entry into an external training pipeline requires **redaction** first.

Three data states are distinguished:

```text
runtime durable authority trajectory
research data
exported/redacted dataset
```

Invariants of retention:

- TrajectoryStore is **not** a runtime recovery authority; eviction never changes execution correctness.
- Quota eviction must **not** change any active Task.
- Data still referenced by a dataset manifest, PolicyBundle evaluation provenance, or other retained artifact must **not** be deleted.
- The retention implementation must be **reference-aware**.
- Dataset export must record the **source dataset identity / fingerprint**.
- Redacted data must carry a **different dataset identity** from the raw trajectory it was derived from.

Specific quota values are configuration, not an architecture invariant, and are not fixed here.

## Scope

D10 freezes the retention/privacy policy and the three data states. Quota sizing belongs to configuration/policy, not to this ADR.
