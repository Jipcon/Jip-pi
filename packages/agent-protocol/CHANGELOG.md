# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `AgentSessionBackend`: the session-scoped execution contract (messages,
  state, tools, abort, interactions, session-local model/thinking state).
- `AgentHostServices`: the app/workspace service contract (models, auth
  status, credentials, OAuth, handshake) with zero-backend availability.
- `AgentSessionAdmin`: the legacy process-level session administration
  capability (create/list/switch/rename), used by the RPC adapter only.

### Changed

- `AgentBackend` is now the legacy combined contract extending
  `AgentSessionBackend`, `AgentHostServices` and `AgentSessionAdmin`;
  `StartConfig` (executable launch config) remains RPC-specific and never
  leaks into the runtime-independent contracts.

### Removed

- Runtime-independent contracts no longer carry `executable`; session
  backends receive session identity (`SessionBackendConfig`), host services
  receive none.
