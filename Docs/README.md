# Jip-pi Adaptive MetaRuntime

Jip-pi is a Pi-based adaptive agent harness. It keeps Pi as the execution foundation and extends it with an Adaptive MetaRuntime that organizes and evaluates candidate trajectories, controls branching and verification, manages isolated candidate workspaces, and applies task-pinned adaptive policies around a frozen model.

At the architecture level, the relationship is:

```text
Jip-pi
└─ Pi / AgentHarness
   └─ Adaptive MetaRuntime
      ├─ CandidateGraph
      ├─ CandidateStateProjector
      ├─ Controller
      ├─ Evaluator
      ├─ WorkspaceManager
      ├─ PolicyRegistry
      ├─ TrajectoryStore
      └─ Optimizer
```

The Adaptive MetaRuntime is the main Jip-pi subsystem documented in this directory. Pi remains responsible for the underlying agent execution semantics, ordinary tools, provider interaction, session history, durability primitives, and Harness execution; the Adaptive MetaRuntime adds execution orchestration around those capabilities without modifying the frozen model itself.

## Documentation split

This directory is a loss-minimizing refactor of the supplied `DESIGN.md`:

- `DESIGN.md` — long-lived architecture and stable Module contracts
- `INVARIANTS.md` — normative runtime/durability/adaptation invariants
- `IMPLEMENTATION_STATUS.md` — Stage/R/S implementation history and status
- `CONFORMANCE.md` — semantic, crash/replay and workspace validation matrix
- `DECISIONS.md` + `ADR/` — D1-D19 decision records

The source file itself is not overwritten.
