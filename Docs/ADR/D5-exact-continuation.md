# D5 — Branch Continuation

- Status: **Accepted**
- Source: original `DESIGN.md` decision table

## Context

This decision is extracted from the original main design document to avoid duplicating the same conclusion across architecture sections, invariants, implementation status, and test matrices.

## Decision

Adopt context-exact continuation: no hidden re-prompt; each child atomically accepts a new durable continuation Run and writes `adaptive.run_basis`; does not copy source `op.*` registers; only differences within the sampling envelope are permitted.

## Scope

This ADR does not add new semantics beyond what was frozen in the original text. `Accepted` means the original text confirmed it; `Proposed` means the original text explicitly listed it as a recommended default for later confirmation.
