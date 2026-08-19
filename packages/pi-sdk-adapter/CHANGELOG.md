# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `SdkSessionBackend`: an in-process `AgentSessionBackend` implementation over
  the Pi coding-agent SDK. One instance owns exactly one `AgentSession`;
  concurrent instances run fully independent sessions (streaming, tools,
  abort, interactions) in one process.
- `SdkHostServices`: an `AgentHostServices` implementation over a shared
  `ModelRuntime`. Models, auth status, API keys and OAuth work with zero
  session backends; credential changes update the shared runtime state once
  (no per-backend fan-out).
- Auth transaction coordination: concurrent OAuth logins for the same
  provider join one in-flight transaction, and auth prompt answers are routed
  by `authRequestId`.
- `resolveFreshSessionDefaults`: predicts the model and thinking level a
  fresh (message-less) session will materialize with — the settings
  `defaultThinkingLevel` (or the SDK built-in default) clamped to the model
  that `findInitialModel` would pick, or to an explicitly pending model.
- Editable user messages & in-place editing: `SdkSessionBackend.editableUserMessages`
  reports the live leaf path's user messages; `readEditableUserMessages`
  reads them from a persisted JSONL file without a live backend (current
  leaf only, so abandoned branches never appear);
  `SdkSessionBackend.editAndResend` edits a past user message in place —
  `AgentSession.navigateTree` moves the leaf before the edited message (an
  in-file branch; the old continuation stays in the file but leaves the
  active context) and the edited text is queued as a new prompt, with a
  best-effort leaf restore when the prompt is rejected before anything was
  appended. `session_before_tree` / `session_tree` extension events fire,
  and extensions can cancel the edit.

### Notes

- This package is `private`: it is an internal adapter for the Pi Desktop
  application and is not published to npm.
