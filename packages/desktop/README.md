# Jip-pi

Electron + React desktop GUI for Pi, built on a backend-neutral
`AgentBackend` protocol. This document is the development entry point for the
GUI, its protocol package and the Pi RPC adapter.

## Scope

The current GUI provides workspace selection, cross-workspace conversation
history, model and thinking-level selection, streamed Markdown/KaTeX output,
collapsible tool-call activity summaries, extension interaction dialogs,
session renaming and recoverable deletion through the system Trash.

The source of truth is split across three workspace packages:

| Package | Responsibility |
| --- | --- |
| `packages/desktop` | Electron main/preload processes, React renderer, IPC, settings, session catalog and packaging |
| `packages/agent-protocol` | Backend-neutral TypeScript types for commands, state, messages, events, tools and capabilities |
| `packages/pi-gui-adapter` | Pi-specific subprocess lifecycle, JSONL RPC transport, capability discovery and event normalization |

`packages/desktop/resources/backend` is a staged packaging input and
`packages/desktop/release` contains generated artifacts. Do not hand-edit
either directory; change the source packages and rebuild/restage instead.

## Architecture

```text
React components and AgentStore                     packages/desktop/src/renderer
        | constrained window.agent API
        v
contextBridge preload                               packages/desktop/src/preload
        | typed Electron IPC
        v
Electron main + BackendManager                      packages/desktop/src/main
        | AgentBackend
        v
PiBackend adapter                                   packages/pi-gui-adapter
        | JSONL over child stdin/stdout
        v
Pi --mode rpc                                       source checkout in development
                                                    bundled pi.exe when packaged
```

The dependencies point inward through the protocol types:

- The GUI does not import `packages/coding-agent` or `packages/agent`
  internals.
- The renderer has `contextIsolation: true` and `nodeIntegration: false`. It
  receives no Node builtins, `child_process` access or raw `ipcRenderer`.
- The preload exposes only the methods declared by `window.agent`.
- Backend stderr is kept separate from JSONL stdout and forwarded as
  diagnostics.
- Unknown Pi events remain available as protocol `custom` events. Unknown
  tools fall back to `GenericToolRenderer`.

### Runtime flow

1. A renderer hook calls a method on `window.agent`.
2. The preload invokes a fixed IPC channel and unwraps the shared
   `CommandResult` envelope.
3. The Electron main process validates the operation and delegates to
   `BackendManager`.
4. `BackendManager` starts or calls `PiBackend`; the adapter correlates JSONL
   requests and responses with request IDs.
5. Pi events are normalized to `AgentEvent`, forwarded through Electron IPC
   and reduced into the renderer's `AgentStore`.

The corresponding files are:

- `src/shared/ipc.ts`: shared channel names, backend status and session storage
  types
- `src/preload/preload.ts`: the complete renderer API surface
- `src/main/main.ts`: window lifecycle, IPC handlers and desktop settings
- `src/main/backend-manager.ts`: bounded pool of warm Pi backend processes,
  atomic workspace switching, status/event fan-out
- `src/main/agent-event-forwarder.ts`: tool_updated throttling before IPC
- `src/renderer/state/hooks.ts`: async bridge operations, streaming delta
  coalescing
- `src/renderer/state/store.ts`: pure renderer state transitions

## Development

### Prerequisites

- Node.js 22.19 or newer
- Dependencies installed from the repository root
- A provider configured for Pi if a real model response is required

From the repository root on Windows:

```powershell
npm.cmd run dev --workspace=@earendil-works/pi-desktop
```

The dev script runs the renderer Vite server on fixed port `5173` and watch
builds for the main/preload bundles via `concurrently`, then starts Electron
once the bundles exist. In development, the legacy backend mode launches the
current source checkout through `tsx`:

```text
node node_modules/tsx/dist/cli.mjs packages/coding-agent/src/cli.ts --mode rpc
```

The child process `cwd` is the selected user workspace, never the Pi source
tree. Development-only overrides are:

- `PI_REPO_ROOT=<path>`: use another Pi source checkout
- `PI_NODE_PATH=<path>`: use a specific Node executable
- `PI_DESKTOP_AUTOSTART_WORKSPACE=<path>`: skip the workspace picker
- `PI_DESKTOP_DEBUG_PORT=9333`: expose the Chrome DevTools protocol

The desktop settings file is stored at
`<Electron app.getPath("userData")>/desktop-settings.json`. It records session
storage configuration, recent workspaces and workspaces hidden from the
catalog. Removing a workspace through the sidebar is destructive: after an
in-app confirmation the workspace directory itself and every session file
that belongs to the workspace (including sessions stored outside the
directory, e.g. under the default session root) are moved to the system
Trash, and only then is the workspace dropped from the recent list. See the
sidebar's "Remove workspace?" dialog and the `CHANGELOG.md` entry that
introduced this behavior.

## Session lifecycle and storage

Session creation deliberately has three persistence states:

| Trigger | Result |
| --- | --- |
| Start a workspace | Create a transient runtime session and session ID; do not create a JSONL file |
| Click **New conversation** | Run `new_session`, then explicitly run `persist_session` so the blank session survives switching |
| Send a normal prompt | Preserve Pi's lazy behavior; the complete session is flushed when the first assistant message is appended |

Do not use `persist_session` as a capability probe during startup: it is a
mutating command and would reintroduce empty sessions on every launch.

The configurable storage modes are:

| Mode | Session directory |
| --- | --- |
| Default | Pi default: `~/.pi/agent/sessions/<encoded-workspace>` |
| Workspace | `<workspace>/.pi/sessions` |
| Custom | `<custom-root>/<encoded-workspace>` |

Changing the storage mode while a workspace is running restarts its backend;
it is rejected while the agent is streaming. The global catalog discovers
known session roots and deduplicates sessions by ID. The active session cannot
be deleted, and all other deletions use Electron's `shell.trashItem` rather
than permanent removal — this includes workspace removal, which additionally
moves the workspace directory itself to the Trash (see the Development
section). Deletion is confirmed through an in-app dialog, not
`window.confirm`: Electron's synchronous native confirm can leave the window's
input/focus state wedged after closing (symptom: menus stop opening, the
composer keeps focus but accepts no typing).

### Editing a past user message (in-file branch)

Hovering a past user message reveals an edit action (pencil). Clicking it
replaces the bubble with an **inline editor** prefilled with the message's
text — nothing is sent to the backend at this point. **Cancel** (button or
`Esc`) restores the original conversation byte-for-byte: cancelling is pure
frontend state. **Send** (button or `Enter`) commits the edit in the **same
session file**: the session tree branches *before* the edited message (the
SDK's `AgentSession.navigateTree`), the edited text is resent as a new
prompt, and everything after the branch point leaves the active context.

Guards and semantics:

- The action is capability-gated (`messageEdit`); the legacy RPC backend
  reports it as unavailable and the GUI hides the button.
- The action is hidden while the session is streaming, and for messages
  without a session entry id yet (a turn that has not completed). While the
  inline editor is open the composer is disabled — a parallel prompt would
  be truncated by the edit otherwise.
- The renderer truncates the history optimistically on Send; if the backend
  rejects the edit or an extension vetoes it (`session_before_tree`), the
  previous leaf is restored and the authoritative snapshot puts the original
  conversation back.
- Editing runs on the live session: a not-yet-materialized session is
  materialized on demand (an explicit user action — history browsing never
  materializes). An unpersisted session (no JSONL file) rejects the edit
  with an explicit error — wait for the first assistant response.
- The old continuation stays in the session file as an abandoned branch.
  There is no branch-switching UI; after Send it is not reachable from the
  GUI (deleting the session removes it with the file).
- `session_before_tree` / `session_tree` extension events fire on Send, and
  extensions can cancel the edit.

v1 limits: only text is resent (image attachments are shown read-only and
not carried back).

## Workspace switching and the warm backend pool

`BackendManager` keeps the two most recently used workspaces resident instead
of stopping the previous backend on every switch:

- Switching to a warm workspace is an in-process activation (tens of
  milliseconds) instead of a cold 400-500 ms spawn.
- A switch to a cold workspace launches the new backend in the background;
  the previous workspace stays active and fully usable until the new backend
  is ready, and stays usable if the launch fails.
- Only the active backend's events and stderr reach the renderer. Events from
  warm cached backends are dropped, so stale streams cannot leak across
  workspaces.
- A crashed backend is evicted from the pool and relaunched on next visit.
- Concurrent switch requests are guarded by a monotonically increasing switch
  generation; an older launch never activates over a newer request.
- If the active agent is still streaming when switching away, the backend is
  stopped rather than cached (the agent run is aborted, matching the
  pre-pool behavior).

Because status push events only fire on transitions, a renderer that reloads
while a backend is already running restores the phase from a `getStatus()`
snapshot guarded by a status revision, instead of staying stuck on the
no-workspace screen.

## Streaming performance

Long generations and high-frequency tool output must not saturate the
renderer main thread. The pipeline is:

```text
Pi message_delta
  → renderer pending buffer
  → one store update per animation frame
  → one subscriber notification
  → only the streaming turn re-renders
```

Concretely:

- `message_delta` events are coalesced in `hooks.ts` and applied as a single
  `message-delta-batch` store action per animation frame. `message_completed`
  (authoritative) drops buffered deltas; `agent_stopped` flushes them; session
  or workspace switches clear them.
- The store no longer accumulates per-tool argument buffers
  (`toolcallBuffers` was dead state with O(n^2) string concatenation).
  Toolcall deltas only maintain structural placeholders; the completed message
  is authoritative.
- `ensureBlock` is immutable (lazy copy), `dispatch` bails out on identity
  equality, and streaming updates locate the message by index instead of
  mapping the whole history.
- `tool_updated` events are throttled latest-wins per tool id at ~25 Hz
  (`TOOL_UPDATE_INTERVAL_MS` in `agent-event-forwarder.ts`), while
  `tool_started`/`tool_completed`/`error`/`interaction_requested`/
  `message_completed` and agent lifecycle events are always immediate.
  `tool_completed` supersedes any unsent update for the same tool.
- Message components are memoized against the exact data they reference
  (message identity plus the tool records they use), and turn objects for
  unchanged messages keep stable references, so a streaming delta re-renders
  only the last turn. Tool state is a lifecycle independent from message
  completion, so a turn always re-renders when a tool record it references
  changes, even after its message is complete.
- Long conversations are rendered progressively: the most recent 50 messages
  mount first, older history is appended in batches while idle, and the
  viewport stays anchored on the last message (history insertion pauses while
  the user is scrolled away from the bottom).
- Tool activity sections are collapsed by default; the toggle label carries
  the live status (Running / Error / Completed).

## Extending the GUI/backend bridge

For a new backend-neutral operation:

1. Add or update types in `packages/agent-protocol`.
2. Implement the operation in `packages/pi-gui-adapter` without leaking Pi
   types through the protocol.
3. Add the channel and shared payload type to `src/shared/ipc.ts`.
4. Add the constrained preload method in `src/preload/preload.ts`.
5. Register and validate the handler in `src/main/main.ts` or delegate it
   through `BackendManager`.
6. Call it from `src/renderer/state/hooks.ts` and keep state transitions in
   `store.ts` pure.
7. Update preload-surface, adapter and renderer tests.

For new Pi event variants, normalize known data in
`packages/pi-gui-adapter/src/event-normalizer.ts`. Leave unknown variants on
the `custom` event path so newer backends do not break older GUI builds.

## Tests and checks

Run package tests and type checking from the repository root:

```powershell
npm.cmd run test --workspace=@earendil-works/pi-gui-adapter
npm.cmd run test --workspace=@earendil-works/pi-desktop
npm.cmd run typecheck --workspace=@earendil-works/pi-desktop
npm.cmd run check
```

Test coverage is divided by boundary:

- Adapter tests cover JSONL framing, request correlation, process lifecycle,
  capability compatibility, event normalization and integration against a
  stub RPC backend (including a deterministic hold/release mode that
  reproduces stale streaming `get_state` responses after `agent_settled`).
- Desktop tests cover main-process helpers, the warm backend pool
  (cache hits, LRU eviction, event isolation, crash eviction, failed-switch
  fallback), tool_updated throttling, session discovery/storage, preload API
  constraints, renderer hooks/store (delta batching, reducer immutability,
  dispatch bailout), components and styles.
- Coding-agent SessionManager tests own the persistence contract shared by the
  TUI, RPC mode and GUI.

When changing a test file, run that file directly while iterating. After code
changes, `npm.cmd run check` is the required repository-wide validation. The
root check does not replace the package tests.

## Packaging

```powershell
# Build the current backend, stage all runtime assets and package the app.
# The standalone backend build requires Bun 1.3.14 or newer.
npm.cmd run package --workspace=@earendil-works/pi-desktop

# Perform the same backend preparation and build the Windows installer.
npm.cmd run make --workspace=@earendil-works/pi-desktop
```

Use `npm.cmd run stage:backend --workspace=@earendil-works/pi-desktop` only
when a current `packages/coding-agent/dist/pi.exe` already exists. The
staging and packaging steps fail if the staged backend or SDK closure is
missing.

Packaging is electron-builder with an assisted NSIS installer: per-user
install (no admin rights), an install directory page, generated uninstaller
and Desktop / Start Menu shortcuts. The staged app directory is assembled by
`scripts/stage-app.mjs` at `release/staging` (vite bundles, externalized SDK
closure, window icon assets).

Artifacts are written to:

```text
packages/desktop/release/win-unpacked/            # unpacked app
packages/desktop/release/Jip-pi Setup <version>.exe
```

Packaged apps launch `resources/backend/pi.exe --mode rpc` in legacy backend
mode and do not depend on a user-installed Pi, Node.js or repository clone.

## Troubleshooting

- **Port 5173 is already in use:** stop the conflicting process; the renderer
  dev server uses `strictPort` and will not select another port.
- **Backend fails to start in development:** verify the root dependencies,
  `PI_REPO_ROOT` and `PI_NODE_PATH`; backend stderr appears in the GUI logs.
- **KaTeX formula font warning in DevTools:** `katex.min.css` embeds its fonts
  as `data:` URLs; the CSP now allows them via `font-src 'self' data:` in
  `index.html`. If the warning reappears, re-check that `font-src` is still
  present in the CSP meta tag.
- **A prompt produces no reply after switching the model:** the selected
  model/provider combination may not support the backend's active protocol
  (e.g. a `responses`-only model against a provider that rejects it). The
  agent run fails without producing a message; check the model/provider
  compatibility before assuming a GUI bug.
- **Packaged app reports a missing backend:** run the `package` or `make`
  workspace script, or build `packages/coding-agent/dist/pi.exe` before
  running `stage:backend`.
- **A conversation is absent after changing storage mode:** check the previous
  storage root. Changing mode selects where new sessions are written; it does
  not migrate existing JSONL files.
- **A new RPC command works in source development but not in a packaged app:**
  rebuild and restage the backend before packaging.
