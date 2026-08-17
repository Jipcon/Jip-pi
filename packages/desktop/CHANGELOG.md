# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Custom provider management: Settings → Providers now has a "Custom
  providers" section to add, edit, and delete custom model providers
  persisted to `~/.pi/agent/models.json` (baseUrl, API type, headers, model
  list). Saving reloads the backend catalog so new providers are selectable
  without an app restart; a "Reload models" button re-reads models.json after
  external edits. API keys are still stored through the existing API-key
  dialog (auth.json), so secrets never land in models.json via the GUI.
  Exposes `reloadModels`, `listCustomProviders`, `saveCustomProvider`, and
  `deleteCustomProvider` on the `window.agent` bridge and adds the
  `models:reload` / `customProviders:list|save|delete` IPC channels.

- Custom provider model discovery: the provider form has a "Fetch models"
  button that queries the provider's model-list endpoint from the main
  process (renderer fetches would hit CORS) and renders a checkbox list to
  pick which models to add. Endpoint candidates follow the cc-switch
  strategy — `{base}/v1/models`, `{base}/models` when the base URL already
  ends in an OpenAI-style `/v{N}` version segment, plus stripped-path
  fallbacks for known Anthropic-protocol compat suffixes — tried in order
  with fall-through on 404/405. Auth headers follow the API type
  (`x-api-key` for anthropic-messages, `x-goog-api-key` for
  google-generative-ai, Bearer otherwise); error bodies are redacted and
  truncated. Google endpoints contribute context/output token limits to the
  fetched rows. An optional API-key field powers the fetch and is stored
  through the credential API (auth.json) on save — models.json still never
  contains keys. Adds the `customProviders:fetchModels` IPC channel and
  `fetchCustomProviderModels` bridge method.

- Custom provider metadata pre-fill: after fetching a provider's model list,
  the GUI matches each fetched id against the full built-in catalog
  (credential-independent, via a new `listModelsByIds` host service and a
  `match_models_metadata` RPC command for the legacy path) and shows the
  catalog context window / max tokens / reasoning / thinking-level summary
  in the checklist. "Add selected" pre-fills the matched values into the
  model rows; conflicting catalog hits are left blank for manual entry.
  Model rows gain a seven-level thinking editor (default / hide / custom
  provider value) so `thinkingLevelMap` can be set manually when there is no
  match, and the store now round-trips `thinkingLevelMap` through models.json.
  Adds the `customProviders:matchModels` IPC channel and the
  `matchCustomProviderModels` bridge method.

- Custom listbox (`Select.tsx`) replaces the native `<select>` popups in the
  top bar (OS-rendered popups cannot be styled): surface-overlay panel with
  strong border and shadow, accent indicator bar + check on the selected
  option, 120ms open animation, full keyboard navigation (arrows, Home/End,
  Enter, Escape, typeahead) and listbox ARIA. Provider options carry the
  billing description as a second line, model options show the context
  window size, and the thinking panel always shows the full seven-level
  matrix with a strength meter — levels the current model cannot reach stay
  visible but disabled with the cap named in the tooltip.

- Multi-session concurrency (SDK mode, default): the Electron main process
  embeds the Pi coding-agent SDK directly (no extra `pi.exe`), and a
  two-level backend pool (workspace → session) runs any number of sessions
  concurrently. Switching the UI focus never tears a session down; A can keep
  streaming in the background while B prompts, streams and runs tools.
- Zero-backend host services: model picker, auth status, API keys and OAuth
  all work before any session exists; the catalog-backend sentinel pattern
  is gone from the SDK path.
- Session catalog `createSession` (persisted session identity created through
  the SDK `SessionManager`, materialized lazily on first use) and
  `readFullHistory` (full message history parsed by Pi's own session parser).
- Historical session usage: token/cost totals and context usage are aggregated
  directly from the persisted JSONL file (`readSessionUsage` in
  `pi-sdk-adapter`), so the usage bar shows for sessions that were never
  materialized (no live backend), not just for the active session.
- Credential changes update one shared host-level runtime state (single
  catalog invalidation, no per-backend fan-out). Concurrent OAuth logins for
  the same provider join one in-flight transaction; auth prompt answers route
  by `authRequestId` on a host-level channel.
- Session-routed IPC: session requests carry `{ workspaceId, sessionId }`,
  events arrive in a `RoutedAgentEvent` envelope, and interaction responses
  route to the owning session backend.
- Per-session renderer store (`sessionStateById`), per-session interactions,
  and sidebar indicators for background sessions (running / needs-attention).
- Target-session rename/delete semantics: renaming or deleting an idle
  session works while another session runs; deleting the active idle session
  falls back to another session; deleting a running session is rejected.
- Idle background session backends are LRU-evicted per workspace
  (`MAX_IDLE_SESSION_BACKENDS_PER_WORKSPACE = 4`); running, interaction-pending
  and UI-active sessions are pinned.
- Async shutdown: `before-quit` waits for backend disposal and auth
  transaction cleanup before quitting.
- Packaged SDK support: `scripts/stage-sdk.mjs` stages the coding-agent SDK
  dependency closure into `resources/sdk/node_modules`, and the
  electron-builder staged app directory ships it inside `app.asar` so the
  externalized ESM-only SDK resolves at runtime in packaged builds.

### Changed

- Windows packaging moved from Electron Forge (maker-squirrel) to
  electron-builder with an assisted NSIS installer: per-user install with
  an install directory page (`oneClick: false`,
  `allowToChangeInstallationDirectory: true`), generated uninstaller and
  Desktop / Start Menu shortcuts. `scripts/stage-app.mjs` assembles the
  electron-builder app directory at `release/staging` from the vite
  bundles, the staged SDK closure and the window icon assets, replacing
  the forge `packageAfterCopy` hook.
- The dev flow no longer runs through Electron Forge: `npm run dev` starts
  the renderer Vite server plus main/preload watch builds with
  `concurrently` and launches Electron directly.
- The staged SDK closure no longer carries the coding-agent CLI binary
  (`dist/pi.exe`): the GUI ships its own backend at
  `resources/backend/pi.exe` and only loads the SDK entry, so the
  duplicate ~111 MB binary no longer bloats the installer.

- Default backend management is the in-process SDK implementation; the legacy
  RPC path (`PI_DESKTOP_LEGACY_BACKEND=1`) keeps the original one-workspace /
  one-active-session behavior for regression comparison.
- The renderer no longer blocks session switching while streaming.
- Chat layout: the conversation column is capped at 720px and centered; the
  "Jip-pi is working" status is a capsule that also carries the live tool
  count; the usage strip is a full-width status bar with a context-remaining
  chip (green / warning / danger); sidebar session rows show a relative
  timestamp and the active session gets a 3px accent indicator bar; the
  sidebar collapses to a 64px icon rail (manual toggle persisted in local
  storage, forced below 900px); layout metrics moved into design tokens
  (`--chat-column-width`, `--sidebar-width(-collapsed)`, `--statusbar-height`).
- Top bar typography and color: select values now use primary text color
  (the model name one size/weight up), control labels are quieter, select
  surfaces lift on hover and show the accent focus ring, and a small amber
  dot marks any thinking level above "off".
- Top bar alignment: the runtime selectors moved into a center container
  that mirrors the chat column geometry, so the Provider select starts
  exactly above the message content; the brand stays above the sidebar
  (centered in the rail when collapsed). Session rows no longer show the
  relative timestamp.
- Sidebar visual tuning: rows sit on the darker canvas background, unselected
  titles drop to muted text (selected keeps full contrast), hover lifts one
  surface step, and project groups breathe wider while rows pack tighter.
- "Remove workspace" (sidebar workspace context menu) now moves the workspace
  directory itself to the system Trash, together with every session file that
  belongs to the workspace (including sessions stored outside the directory,
  e.g. under the default session root), before dropping the workspace from the
  recent list. Previously it only hid the workspace while leaving everything on
  disk. The currently active workspace may be removed as well; the runtime
  resets to no-workspace afterward so the UI returns to the home screen. A
  confirmation dialog shows the session count and warns the action cannot be
  undone.

### Removed

- `forge.config.js`, the `@electron-forge/*` devDependencies and the
  `electron-squirrel-startup` dependency (Squirrel.Windows install events
  no longer apply to the NSIS installer).

- The manual "Collapse" footer bar at the bottom of the expanded sidebar.
  The collapsed rail keeps its expand button (recovery path), and the
  below-900px auto-collapse is unaffected.

### Fixed

- Assistant markdown code blocks tagged `powershell` (or `ps1`) now get
  syntax highlighting. `rehype-highlight` ships only highlight.js's 37 common
  languages and PowerShell is not among them; the renderer now registers the
  PowerShell grammar from `lowlight`'s `all` set alongside `common` (same
  highlight.js version lowlight uses internally, so no cross-version
  `LanguageFn`). `lowlight` is now a direct desktop dependency.

### Fixed

- `assets/icon.ico` re-encoded from PNG-compressed entries to classic
  uncompressed BMP entries (same artwork, 16–256 px). The PNG-compressed
  variant crashed the previous Squirrel installer's WPF progress window
  (`FileFormatException` decoding `setupIcon.ico`) and aborted the install.

- New (not-yet-materialized) sessions now display their actual default
  thinking level in the top bar instead of the select's first option
  ("off"): the predicted level is the settings default clamped to the model
  the session will materialize with.

- Code block copy button: anchored outside the horizontally scrolling
  `<pre>` so it no longer scrolls away with long lines; the block's top
  padding reserves a header band holding the button (top-right) and a
  decorative `</>` marker (top-left), so neither covers the first code line.
