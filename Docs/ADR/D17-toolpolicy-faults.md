# D17 — ToolPolicy Faults

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

## Decision

Uniformly fail-closed before effect; Harness durable storage faults must fault the Harness; projection cache failures recover through recomputation and must not be disguised as ordinary blocks.

## Scope

This ADR does not add new semantics beyond what was frozen in the original text. `Accepted` means the original text confirmed it; `Proposed` means the original text explicitly listed it as a recommended default for later confirmation.
