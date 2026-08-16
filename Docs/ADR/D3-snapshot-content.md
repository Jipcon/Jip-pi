# D3 — Snapshot Content

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

## Decision

Capture tracked and untracked non-ignored files; ignored files, secrets, and large caches are excluded by default.

## Scope

This ADR does not add new semantics beyond what was frozen in the original text. `Accepted` means the original text confirmed it; `Proposed` means the original text explicitly listed it as a recommended default for later confirmation.
