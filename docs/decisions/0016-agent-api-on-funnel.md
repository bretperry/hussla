# 0016 — The agent-key API may open on Tailscale Funnel; the site stays tailnet-only

`accepted` · 2026-10-09 · from the owner's call ("the open agent api ... yes"), PR `feat/funnel-agent-api`

## Context

- v1 is tailnet-only (`docs/plans/hussla-v1.md`, 0011): the owner is a `WhoIs` identity, so nothing can be served where `WhoIs` means nothing.
- The owner's scheduled job-search agent runs as a Claude routine in the cloud, which can't join the tailnet. The options were: run the search on the owner's Mac, join the cloud to the tailnet, or open the agent-key API on Funnel. On 2026-10-09 the owner chose Funnel.
- The prototype did exactly this: only the key-protected API on Funnel `:8443`, the site tailnet-only (`docs/install-lessons.md`).

## Decision

- **Opt-in.** `HUSSLA_AGENT_FUNNEL=1` (`config.AgentFunnelEnv`) makes the server also `ListenFunnel` on `:8443` (`config.AgentFunnelPort`) with `tsnet.FunnelOnly()`, after it joins the tailnet. Off by default; nothing else changes when it is off.
- **A separate door, agent keys only** (`httpapi.ListenerFunnel`). Its mux registers only the routes in `funnelRoutes`, an allowlist of the member routes agents use, so a route added later stays off the internet until someone adds it there; the owner and setup wrappers serve 404 on this door whatever the list says; a request without a valid agent key is 401 before any route. No `WhoIs`, no cookie, no passkey, step-up, setup or sign-in route, no `/healthz`, no `GET /api/export`, no web app. `/mcp` (agent keys only by construction, 0014) is mounted beside it. Host must be `<name>.<tailnet>.ts.net:8443`; the node-owner guard wraps it like the site.
- **The site stays tailnet-only.** `:443` is unchanged and tailnet devices can't use `:8443` (FunnelOnly).

## Consequences

- A cloud routine reaches Hussla at `https://hussla.<tailnet>.ts.net:8443` with `Authorization: Bearer <agent key>`, and can do what any agent can: read, write jobs and companies, draft (never send or approve) mail.
- **Internet-exposed API.** Anyone can reach the door and try keys. A key is 256 random bits stored as SHA-256, so guessing is not a practical attack and no rate limit guards it; a per-address limit on wrong keys (log noise, load) is in `docs/deferred.md`. A leaked key is now usable from anywhere, not only from the tailnet: revoke it in Settings. Agents can't approve mail or reach owner routes, here or on the tailnet.
- **The tailnet policy must grant the node the `funnel` node attribute** (`nodeAttrs`), and HTTPS certificates must be on; until then the server logs one hint and keeps retrying (no restart needed). Steps: `docs/install/nas.md` → "Let a cloud agent in".
- 0011's "Funnel is not supported" still holds for owner identity: no owner identity is ever taken from a Funnel connection.
- Revisit if the cloud can join the tailnet (a tagged device), which would let this door close again, or if a key leaks in practice.
- Tests: `internal/httpapi/funnel_test.go` (each refusal proved by removing its check).
