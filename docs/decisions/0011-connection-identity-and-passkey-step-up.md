# 0011 — Identity from the connection, a setup code to claim, a passkey tap per owner action

`accepted` · 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 3

## Context

- The plan's security model fixes the outline: the owner is the Tailscale user who owns the node, identified by embedded Tailscale (`tsnet` `WhoIs`), never by a header; owner-only actions need a passkey tap; agents are named, revocable keys that are never upgraded to owner. Decision 0007 (one owner) holds.
- An agent on the owner's own laptop reaches the owner's tailnet identity. So identity alone can't authorize an approve, a delete or a key, and a "sudo window" after one tap would let that agent ride on it.
- A laptop owner may run without Tailscale, so there is a second door (`http://localhost`) that needs its own proof; loopback alone proves nothing.
- The plan leaves the wire details open: how a tagged node gets an owner, how a step-up travels, how the local door signs in, and what replaces the contract's earlier `X-Hussla` CSRF header.

## Decision

- **Two listeners, one proof each.** Tailnet HTTPS: identity from `WhoIs` on the connection; cookies are ignored. Local `127.0.0.1`: identity from the `hussla_session` cookie (HttpOnly, SameSite=Strict, 30 days, stored hashed), started by the one-time link `hussla open` prints from a 0600 token file in the data directory (single use, 2 minutes). Neither reads an identity header.
- **A bearer key decides alone.** With an `Authorization` header present, the caller is that agent or 401: never the connection's owner. Keys are `hussla_` + 256 random bits, stored as SHA-256.
- **The owner record** (settings `auth.owner`): adopted from the node's owning user on first start; a tagged node has none, so the first person to enter the **setup code** from the server log (12 Crockford base32 characters, 5 tries then a new code, single use) on an untagged device claims it. A first sign-in on the local door records a local owner, and the setup code later binds a tailnet user to it.
- **The first passkey on each address needs the setup code.** A passkey works on one RP ID (the ts.net name, or `localhost`), so the setup screen issues a code when its address has none; claiming it grants the one step-up that `register/begin` needs. Afterwards, adding a passkey needs a tap with an existing one.
- **Step-up per action.** `POST /api/stepup/begin {method, path}` → WebAuthn assertion → `{token}`, sent as `X-Hussla-Step-Up` on exactly that method and path, within 2 minutes, once. The token is bound to the caller (tailnet user or session), and one offered for the wrong action is spent anyway.
- **Origin, not a custom header, is the CSRF guard.** A foreign `Origin` is refused on every request; an owner write must carry the server's own `Origin` (browsers always send it on a write; scripts use an agent key). `Host` must be the listener's own name (421 otherwise), which also closes DNS rebinding.
- **Until an owner is enrolled**, only `/healthz`, `/api/setup` and `/api/setup/claim` answer.
- Challenges, step-up tokens and the setup code live in memory: a restart costs one more tap.

## Consequences

- No route trusts a proxy's identity headers, so Tailscale Serve or a reverse proxy in front of Hussla gives no owner identity (by design; Funnel is not supported).
- The UI (Phase 5) runs a passkey prompt before each owner-only action and handles 403 `passkey-required` and `setup-required`.
- A laptop owner who uses both doors registers two passkeys. Passkey delete, rename, and recovery after losing every passkey for an address are deferred (`docs/deferred.md`); until then, register a second device.
- `internal/httpapi/auth_matrix_test.go` holds a test per refusal, each proved by removing its check; a change here starts there.
- Revisit if a client can't send `Origin` on writes, or if per-action taps prove too heavy for bulk work (a bulk-approve route taking one tap for a named set would be the fix, not a time window).
