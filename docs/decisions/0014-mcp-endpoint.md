# 0014. The MCP endpoint is a hand-written stdlib handler over the same use-cases, agent keys only

`accepted` · 2026-10-08 · from Phase 3b (`docs/plans/hussla-v1.md`)

## Context

- Agents (Claude Code, Claude Desktop, Cursor) should reach the tracker without hand-written curl. The plan asked for tools over the same use-cases and the same agent keys as the HTTP API, so permissions can't drift.
- MCP changed shape on 2026-07-28: stateless requests (version and capabilities in `_meta`, mirrored headers, no `initialize`, no session id, no GET stream). Clients on 2025-03-26 to 2025-11-25 still open with `initialize` and a GET stream, and Claude Code and Cursor are in that group today.
- A Go MCP library (the official `github.com/modelcontextprotocol/go-sdk`, v1.8.0) was an option. Hussla ships one static binary to a NAS, and the endpoint's whole risk is its door (auth, Origin, what a tool may reach).

## Decision

- **No MCP library.** `internal/mcpapi` is about 400 lines of stdlib: `initialize`, `server/discover`, `ping`, `tools/list`, `tools/call` over one `POST` endpoint with JSON answers. No new Go dependency. It serves both eras on one path, chosen per request by whether `params._meta` carries the modern protocol version.
- **The door is its own and is agent-only.** `mcpapi` has no `Peers` and reads no cookie: a tailnet identity or a `hussla open` session can't become a caller. Host and Origin are checked as for the HTTP API (a present, foreign `Origin` is `403`), `GET`/`DELETE` are `405`, and a missing, wrong or revoked key is `401` from the same `auth.Service.Agent`. A key is the agent even from the owner's own device.
- **A sibling layer, not a client of the API.** `internal/mcpapi` imports `internal/app` and `internal/domain` (its own depguard rule and gates entry, which also forbids importing `internal/httpapi`). `cmd/hussla` mounts it at `/mcp` ahead of the HTTP API's handler on both listeners.
- **Tools are the agent verbs only.** 17 tools: find/get/create/update job, add event, add contact, list/get/upsert company, add news, add review, draft job and company email, list outbox, list answers, ask for an answer, read the search config. No tool approves, sends, cancels, edits mail, deletes, changes settings, imports, exports, uploads or manages keys. A draft's `approve` argument is refused by name, and the mailbox actor is pinned to non-owner.
- **Results mirror the HTTP API's JSON** (lists wrapped in an object), and `TestToolsReturnWhatTheAPIReturns` compares each read tool with its route. `TestToolListMatchesTheHTTPAPI` fails when an HTTP route has neither a tool, an owner-only entry (proved `403` for an agent), nor a written reason, so a new route forces a decision about MCP.

## Consequences

- The shapes in `internal/mcpapi/encode.go` repeat `internal/httpapi/encode.go`; the comparison test is what keeps them equal. Moving the shared encoders into `internal/app/wire` would remove the copy but reshape the Phase 3 code; do it with the next change that touches both.
- We own MCP conformance (headers, error codes, versions). A spec revision that changes the wire again is an edit to `protocol.go` and `config/mcp.go`, not a dependency bump; the tests speak both eras so a break shows.
- No streaming, subscriptions, resources or prompts, and no OAuth: the endpoint answers `401` with `WWW-Authenticate: Bearer` and clients are given the key as a header. Revisit if a client we care about requires OAuth discovery, or if a tool needs progress or long-running results.
- Revisit the library choice if the spec grows enough surface (tasks, elicitation) that hand-rolling it costs more than the dependency tree.
