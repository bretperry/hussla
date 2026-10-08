# 0008 — Go server, TypeScript UI

## Context

Hussla runs on a home NAS and must be easy for a non-technical person to install and keep
running. Bret chose Go for the server on 2026-10-07.

## Decision

The server is Go: one static binary (no cgo), standard-library HTTP, TLS, crypto and HTTP
clients, a pure-Go SQLite driver. The UI stays React + TypeScript, built to static files that the
binary serves. The API contract is the one source of truth for shapes; the UI's TypeScript
types are generated from it.

## Consequences

- Small image (distroless or alpine plus one binary), fast start, nothing to compile per NAS chip.
- Server and UI cannot share code; shared rules (status lists, pacing knobs the UI shows) come
  from the API, not a shared module.
- Two toolchains in CI (Go and Node), both already supported by the harness packs.
