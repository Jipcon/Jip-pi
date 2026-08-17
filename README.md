<h1 align="center">Jip-pi</h1>

<p align="center">
  <strong>Pi-based Adaptive Agent Harness</strong>
</p>

<p align="center">
  Frozen-model capability amplification through adaptive control, evaluation,
  search, and runtime policy optimization.
</p>

<p align="center">
  <a href="LICENSE">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  </a>
  <a href="https://pi.dev">
    <img alt="Based on Pi" src="https://img.shields.io/badge/based%20on-Pi-5865F2?style=flat-square" />
  </a>
</p>

# Jip-pi

**Jip-pi** is a Pi-based adaptive agent harness for coding agents.

It builds on the Pi agent runtime, provider integrations, tool system, session
model, and coding-agent infrastructure, while introducing an adaptive harness
layer for controlling how a frozen language model executes a task.

The long-term goal is **frozen-model capability amplification**: improving
agent-level task success without fine-tuning or modifying the underlying model
weights.

Jip-pi focuses on execution-time mechanisms such as:

* adaptive runtime control
* task and candidate evaluation
* bounded branching and candidate search
* verification and recovery
* resource and budget allocation
* model-specific runtime adaptation
* reusable execution-policy optimization

> **Project status:** Jip-pi is under active development. The Pi-derived
> execution runtime, CLI, provider layer, tools, sessions, and desktop
> application are functional foundations. Some adaptive-harness components
> described below are experimental or are not yet enabled in the default
> execution path.

---

## Motivation

A language model's agent performance depends on more than the model itself.

The surrounding harness determines how the model interacts with tools, how much
context it receives, when it retries, whether alternative trajectories are
explored, how results are verified, when execution stops, and how limited
compute is allocated.

A fixed harness applies approximately the same execution policy to every task
and every model.

Jip-pi explores a **model-adaptive harness** that can observe execution and
adjust these decisions dynamically.

The intended optimization target is task-level success:

```text
Frozen Model
     +
Adaptive Harness
     ↓
Higher effective agent capability
```

The model remains frozen. Adaptation happens around the model at execution
time.

---

## Architecture

At a high level, Jip-pi separates the adaptive harness from the underlying
agent execution substrate:

```text
                         User / Task
                             │
                             ▼
                 ┌───────────────────────┐
                 │        Jip-pi         │
                 │   Adaptive Harness    │
                 │                       │
                 │  Controller           │
                 │  Evaluator            │
                 │  Optimizer / Policy   │
                 │  Candidate Search     │
                 │  Budget Management    │
                 └───────────┬───────────┘
                             │
                             ▼
                 ┌───────────────────────┐
                 │    Agent Runtime      │
                 │                       │
                 │  Runs / Turns / Steps │
                 │  Sessions             │
                 │  Tools                │
                 │  State / Context      │
                 │  Provider Integration │
                 └───────────┬───────────┘
                             │
                             ▼
                 ┌───────────────────────┐
                 │ Frozen Language Model │
                 └───────────────────────┘
```

The adaptive layer controls how execution proceeds while keeping the language
model itself unchanged.

---

## Adaptive Harness

The adaptive architecture is organized around several cooperating components.

### Controller

The Controller decides what the harness should do next.

At a completed control boundary, possible decisions can include:

```text
advance  → continue the current candidate
branch   → create alternative candidate trajectories
prune    → terminate an unpromising candidate
stop     → accept the current result
```

Future policies may also trigger verification, recovery, retry, compaction, or
other execution strategies where appropriate.

The Controller operates under explicit task budgets and cannot branch or retry
without bound.

### Evaluator

The Evaluator estimates the state and quality of an ongoing candidate.

Evaluation may incorporate signals such as:

* task progress
* evidence of completion
* test or verification results
* tool failures
* repeated actions
* uncertainty
* unresolved verification debt
* candidate consistency
* execution cost
* failure fingerprints

The Evaluator provides feedback to the Controller rather than directly driving
the agent runtime.

### Optimizer

The Optimizer is responsible for longer-term adaptation.

Its role is to learn from completed task trajectories and update reusable
execution-policy parameters for future tasks.

Conceptually:

```text
Task execution
      │
      ▼
Trajectory + evaluation signals
      │
      ▼
Optimizer
      │
      ▼
Updated reusable policy
```

The intended design keeps task-local execution state separate from reusable
model- or policy-level adaptation.

### Candidate Search

Jip-pi can treat an agent trajectory as one candidate solution to a task.

When branching is worthwhile, multiple candidate runs can explore different
continuations:

```text
Task
 │
 ├── Candidate A
 │    ├── Turn
 │    ├── Turn
 │    └── ...
 │
 ├── Candidate B
 │    ├── Turn
 │    └── ...
 │
 └── Candidate C
      └── ...
```

Candidates remain bounded by explicit fanout, depth, active-candidate, total
candidate, token, provider-call, and wall-clock budgets.

The objective is selective search rather than unconditional best-of-N
sampling.

### Budget Management

Adaptive execution consumes additional resources, so every task operates under
explicit limits.

Typical budget dimensions include:

* provider calls
* total tokens
* wall-clock time
* branch fanout
* active candidates
* total candidates
* branch depth

Budget state is observable by the Controller and forms part of every execution
decision.

---

## Execution Model

Jip-pi preserves Pi's durable execution semantics while adding finer-grained
control points around completed agent turns.

Conceptually:

```text
Task
 │
 └── Candidate Run
      │
      ├── Turn
      │    ├── assistant step
      │    ├── tool call(s)
      │    ├── tool effect(s)
      │    └── turn boundary
      │
      ├── Turn
      │    └── ...
      │
      └── ...
```

A **Task** represents one user objective and owns the lifetime of adaptation
for that objective.

A **Run** is a durable execution trajectory for one candidate.

A **Turn** is a complete model interaction boundary, including the assistant
message and all tool effects requested by that message.

A **Step** represents finer-grained execution activity inside a turn.

The adaptive harness observes stable boundaries between turns so that branching,
evaluation, or pruning does not interrupt partially committed tool execution.

---

## Adaptive Policy State

The intended policy model separates task-level configuration from
candidate-specific runtime state.

```text
PolicyBundle
    │
    ├── fixed for one Task
    │
    ├── CandidatePolicyState
    │       ├── step-level updates
    │       └── turn-level aggregation
    │
    └── Optimizer
            └── reusable policy updates for future Tasks
```

This distinction prevents one candidate's local execution state from silently
leaking into another candidate while still allowing the system to learn across
completed tasks.

Jip-pi is designed to support model-specific adaptation so that different
language models can operate under the same overall agent system without being
forced to use identical execution strategies.

---

## Stable Tool Surface

Adaptive behavior should not require continuously changing the tool contract
presented to the model.

The current coding-agent foundation exposes a deliberately small tool surface:

```text
read
write
edit
bash
```

Harness-level policy can decide whether and how a tool is allowed without
necessarily changing the provider-visible tool name, description, schema, or
ordering.

This keeps adaptation in the harness while reducing avoidable prompt and tool
distribution changes.

---

## Relationship to Pi

Jip-pi is built on the open-source [Pi](https://pi.dev) agent project.

Pi provides much of the execution substrate used by Jip-pi, including:

* multi-provider language-model access
* tool calling
* agent state management
* session persistence
* coding-agent infrastructure
* terminal UI infrastructure
* RPC execution
* provider integrations
* model metadata
* telemetry foundations

Jip-pi adds an adaptive harness layer around that execution substrate.

Conceptually:

```text
Jip-pi
┌──────────────────────────────────┐
│ Adaptive Harness                 │
│                                  │
│ Controller                       │
│ Evaluator                        │
│ Optimizer / Policy               │
│ Candidate / Branch Management    │
│ Budget / Execution Control       │
├──────────────────────────────────┤
│ Pi-derived Execution Substrate   │
│                                  │
│ Sessions                         │
│ Tools                            │
│ Agent Runtime                    │
│ Provider Integration             │
│ Model Execution                  │
└──────────────────────────────────┘
```

Where practical, Pi-compatible execution semantics and interfaces are retained
so that the adaptive layer can evolve independently from the lower-level
runtime.

Pi remains the primary upstream project. Jip-pi-specific adaptive behavior,
desktop integration, architecture, and product identity live in this
repository.

For upstream Pi documentation, see:

* [pi.dev](https://pi.dev)
* [Pi documentation](https://pi.dev/docs/latest)

---

## Jip-pi Desktop

Jip-pi includes an Electron + React desktop application.

The desktop frontend is intentionally separated from coding-agent internals
through a backend-neutral `AgentBackend` protocol.

The current desktop application provides:

* workspace selection
* cross-workspace conversation history
* model selection
* thinking-level selection
* streamed Markdown output
* KaTeX rendering
* tool-call activity visualization
* extension interaction dialogs
* session renaming
* recoverable deletion through the system Trash
* configurable session storage
* backend process management
* Windows packaging

The high-level desktop path is:

```text
React components + AgentStore
        │
        │ constrained window.agent API
        ▼
contextBridge preload
        │
        │ typed Electron IPC
        ▼
Electron main + BackendManager
        │
        │ AgentBackend
        ▼
Pi-compatible backend adapter
        │
        │ JSONL RPC
        ▼
Jip-pi / Pi-derived agent runtime
```

See [`packages/desktop`](packages/desktop) for desktop-specific architecture,
session lifecycle, performance, development, and packaging documentation.

---

## Packages

Jip-pi currently retains much of Pi's monorepo package structure.

| Package                                                      | Description                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **[@earendil-works/pi-adaptive-agent](packages/adaptive-agent)** | Jip-pi adaptive runtime interfaces and adapters                                                     |
| **[@earendil-works/pi-telemetry](packages/telemetry)**       | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas          |
| **[@earendil-works/pi-ai](packages/ai)**                     | Unified multi-provider LLM API for OpenAI, Anthropic, Google, and other providers                    |
| **[@earendil-works/pi-agent-core](packages/agent)**          | Core agent runtime with tool calling and state management                                            |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Pi-derived coding-agent runtime and interactive CLI                                                  |
| **[@earendil-works/pi-tui](packages/tui)**                   | Terminal UI library with differential rendering                                                      |
| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Node SQLite session persistence backend                          |
| **[@earendil-works/pi-evals](packages/evals)**               | Benchmarking and evaluation harness                                                                  |
| **[desktop](packages/desktop)**                              | Jip-pi Electron + React desktop application                                                          |
| **[agent-protocol](packages/agent-protocol)**                | Backend-neutral protocol for commands, state, messages, events, tools, and capabilities              |
| **[pi-gui-adapter](packages/pi-gui-adapter)**                | Pi-specific subprocess lifecycle, JSONL RPC transport, capability discovery, and event normalization |
| **[pi-sdk-adapter](packages/pi-sdk-adapter)**                | In-process adapter between the AgentBackend protocol and the coding-agent SDK                        |

Additional packages or internal modules may be introduced as the adaptive
Controller, Evaluator, Optimizer, candidate-management, and policy
architectures mature.

---

## Permissions & Containerization

Jip-pi currently inherits Pi's process-level permission model.

There is no built-in security boundary restricting filesystem, process,
network, or credential access. By default, the agent runs with the permissions
of the user and process that launched it.

If stronger isolation is required, run the agent inside an appropriate
container or sandbox.

The Pi-derived coding-agent documentation currently describes three isolation
patterns:

* **Gondolin extension** — keep the agent and provider authentication on the
  host while routing built-in tools and shell commands into a local Linux
  micro-VM.
* **Plain Docker** — run the entire agent process inside a local container.
* **OpenShell** — run the entire agent process inside a policy-controlled
  sandbox.

See
[`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md)
for the current implementation details.

---

## Development

### Prerequisites

The repository currently uses the same monorepo development foundation as its
Pi upstream.

Install dependencies from the repository root:

```bash
npm install --ignore-scripts
```

Build all packages:

```bash
npm run build
```

Rebuild using existing provider model data without refreshing it from the
network:

```bash
npm run build:offline
```

Run linting, formatting, type checking, and repository consistency checks:

```bash
npm run check
```

Run the test suite:

```bash
npm test
```

Run the coding agent directly from source:

```bash
npx tsx packages/coding-agent/src/cli.ts
```

LLM-dependent tests are skipped when the corresponding provider credentials are
not available.

---

## Desktop Development

From the repository root on Windows:

```powershell
npm.cmd run dev --workspace=@earendil-works/pi-desktop
```

The desktop application starts the current source checkout through the
Pi-compatible RPC interface during development.

Detailed desktop development documentation is available under:

```text
packages/desktop
```

---

## Desktop Packaging

Build the current backend, stage its runtime assets, and package the Windows
application:

```powershell
npm.cmd run package --workspace=@earendil-works/pi-desktop
```

Build the Windows installer:

```powershell
npm.cmd run make --workspace=@earendil-works/pi-desktop
```

When an up-to-date standalone backend already exists, it can be staged
separately:

```powershell
npm.cmd run stage:backend --workspace=@earendil-works/pi-desktop
```

Current Windows artifacts are written under:

```text
packages/desktop/release/jippi-win32-x64/
packages/desktop/release/make/squirrel.windows/x64/jippi Setup.exe
```

Packaged desktop builds include the backend executable and do not require a
separate user-installed Pi, Node.js installation, or repository checkout.

---

## Supply-chain Hardening

Dependency changes are treated as reviewed code changes.

Current protections inherited from and maintained alongside the Pi-derived
build system include:

* Direct external dependencies are pinned to exact versions.
* Internal workspace packages remain version-ranged.
* `.npmrc` sets `save-exact=true`.
* `.npmrc` uses a minimum dependency release age to reduce exposure to
  same-day package releases.
* `package-lock.json` is the dependency ground truth.
* `npm run check` verifies dependency consistency and generated package state.
* The coding-agent package ships a generated shrinkwrap derived from the root
  lockfile.
* Lifecycle scripts are disabled where supported during sensitive installation
  paths.
* CI installs dependencies using reproducible lockfile-based installation.
* Dependency lifecycle scripts are controlled through an explicit allowlist.

The repository configuration and build scripts are the authoritative source for
the exact enforcement rules.

---

## Design Principles

Jip-pi follows several principles while evolving beyond the upstream runtime.

### Keep models frozen

Adaptive behavior should primarily live in the harness.

The core research question is how much additional effective capability can be
obtained from an existing model through better execution strategy.

### Preserve observable execution semantics

Runs, turns, tool effects, budgets, candidate state, and evaluation signals
should remain observable and reproducible.

Adaptive behavior should not become an opaque source of hidden state changes.

### Bound search

Branching, retries, and candidate generation must consume explicit budgets.

More search is useful only when its expected value justifies its cost.

### Separate task state from reusable adaptation

Fast candidate-level state and longer-term learned policy serve different
purposes and should have separate lifetimes.

### Keep backend and UI boundaries narrow

Desktop UI code communicates through backend-neutral protocols rather than
depending directly on agent-runtime internals.

This allows the harness and runtime to change without coupling those changes to
the renderer.

### Measure capability amplification

Adaptive mechanisms should be evaluated against reproducible tasks and
benchmarks.

A mechanism should not be considered useful solely because it makes an
individual trajectory appear more sophisticated.

The relevant question is whether it improves task success, reliability,
efficiency, or another explicitly defined objective.

---

## Project Status and Roadmap

Jip-pi is currently an experimental project built on a mature Pi-derived
execution foundation.

The existing runtime already provides the infrastructure required for model
execution, tools, sessions, provider access, telemetry, CLI interaction, and
desktop integration.

The adaptive harness is being developed incrementally on top of this
foundation.

Current areas of work include:

1. **Durable execution control**

   * stable run and turn semantics
   * explicit post-turn control boundaries
   * observable execution state

2. **Adaptive Controller**

   * advance / branch / prune / stop decisions
   * budget-aware execution control
   * model- and task-sensitive policies

3. **Evaluator**

   * task completion assessment
   * verification signals
   * uncertainty and failure detection
   * candidate comparison

4. **Candidate Search**

   * bounded branching
   * candidate lifecycle management
   * selective exploration
   * pruning and recovery

5. **Optimizer**

   * reusable policy updates
   * model-specific adaptation
   * task-to-task learning without modifying model weights

6. **Benchmarking**

   * measuring agent-level success
   * separating model capability from harness effects
   * evaluating capability amplification under controlled budgets

7. **Desktop Integration**

   * exposing adaptive execution state without overwhelming the user
   * maintaining low-latency streaming and interaction
   * keeping adaptive behavior largely transparent during normal use

---

## Contributing

When modifying Jip-pi-specific adaptive functionality:

* preserve existing execution semantics unless the task explicitly requires a
  semantic change
* keep provider-visible interfaces stable where possible
* avoid coupling desktop code directly to agent-runtime internals
* add tests at the boundary where behavior changes
* keep adaptive search explicitly budgeted
* distinguish experimental behavior from production execution paths
* do not hide failures by weakening validation or tests

---

## Upstream

Jip-pi is based on the open-source **Pi agent harness** and retains substantial
Pi-derived infrastructure.

Upstream project:

* [Pi](https://pi.dev)
* [Pi documentation](https://pi.dev/docs/latest)

Jip-pi intentionally preserves attribution to Pi while developing a separate
adaptive-harness architecture and product identity.

---

## License

MIT
