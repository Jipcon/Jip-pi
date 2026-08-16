# D15 — Raw Outcome

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

## Decision

MVP has no Adaptive result shaping; after raw passes through Harness standard error conversion/normalization, it is semantically identical to the durable/model-visible result; in the future, raw is only provided to the executor, the Evaluator, and the TrajectoryStore under retention/redaction control.

## Scope

This ADR does not add new semantics beyond what was frozen in the original text. `Accepted` means the original text confirmed it; `Proposed` means the original text explicitly listed it as a recommended default for later confirmation.
