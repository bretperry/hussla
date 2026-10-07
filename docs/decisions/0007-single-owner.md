# 0007 — One owner per install, no tenant id

## Context

`architecture.mdc` asks repositories to take the tenant (`userId`) first. Hussla runs on one
person's NAS and is reached only through their tailnet; agents act for that person with API keys.

## Decision

No tenant id. The signed-in owner is the Tailscale Serve login in `ALLOWED_USERS`; agents are
named, revocable keys. Repositories take no `userId`.

## Consequences

- Simpler storage and API; nothing to scope per row.
- A second person needs a second install. Sharing one install would need a tenant column on every
  table and a migration; that is a rewrite of storage, so revisit this before adding sharing.
