# D18 — Durability Authority Split

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

## Decision

Immutable entries/usage are the completed-history authority, current registers are the open-operation authority; `adaptive.run_basis`/`adaptive.tool_batch` store provenance needed across terminal; PolicyRegistry is the immutable policy content authority; CandidateStateProjector produces a reconstructible view; research data enters the non-authoritative TrajectoryStore.

## Scope

This ADR does not add new semantics beyond what was frozen in the original text. `Accepted` means the original text confirmed it; `Proposed` means the original text explicitly listed it as a recommended default for later confirmation.
