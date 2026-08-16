# D11 — PolicyBundle Promotion

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

Stage 9 freezes the PolicyBundle publication lifecycle. The Optimizer may automatically produce candidate PolicyBundles; a candidate may be automatically promoted only after passing a strict offline evaluation gate, and promotion only affects future Tasks.

## Decision

The publication lifecycle is frozen as:

```text
Optimizer
        ↓
candidate PolicyBundle
        ↓
offline evaluation
        ↓
promotion gate
        ↓
publish immutable version
        ↓
switch future-active reference
```

A candidate PolicyBundle must carry at least:

```text
parentPolicyBundle
optimizer identity/version
dataset identity/fingerprint
evaluation identity/result
creation timestamp/provenance
canonical content fingerprint
```

The promotion gate requires at least:

- correctness baseline does not regress;
- hard-verifier regression = 0;
- invariant/safety regression = 0;
- success metric satisfies the promotion threshold;
- compute cost has no unallowed significant regression;
- the evaluation dataset and candidate provenance are complete;
- the evaluation itself is reproducible and locatable.

Specific percentage thresholds are promotion policy/configuration, not architecture invariants, and are not fixed here.

Rollback is defined as switching the future-active reference:

```text
futureActivePolicy: v18 → v17
```

not as:

```text
modifying v18 content
```

A running Task does not switch PolicyBundle: already-admitted Tasks continue using their original pinned PolicyBundle.

## Scope

D11 freezes the publication lifecycle, candidate provenance, promotion gate, and reference-switch rollback. Threshold values belong to promotion policy/configuration, not to this ADR.
