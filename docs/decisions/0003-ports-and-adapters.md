# 0003. Ports and adapters, in every language, enforced by each language pack

`accepted` · 2026-10-01 · from the go-public plan, Phase 1 (split out of 0001)

## Context

- 0001 decided ports and adapters together with the TypeScript tool that enforces them. Once stacks
  became removable packs (0002), 0001 became the TypeScript pack's record and leaves with it; the
  architecture itself must outlive any one language.
- Domain logic that imports a framework or a vendor can't move to a native client or survive a
  datastore swap. The dependency direction is the architecture, whatever the language.
- A rule an agent must remember is a rule an agent will eventually break, so the direction has to
  be checked by a tool, not by review.

## Decision

- **Layers:** domain (pure logic over domain types) → use-cases and the ports they declare →
  adapters that implement ports against one vendor or device → one composition root that wires
  adapters into use-cases. The map and the fix for each violation: `docs/ports-and-adapters.md`.
- **Direction:** imports point inward only. The domain imports nothing from the app, no framework,
  and no I/O. A port names domain types and input schemas, never a vendor. Only the composition
  root imports adapters; a use-case takes its ports as arguments. UI reaches the server through
  the API layer, never a use-case or adapter directly.
- **Storage behind ports:** repositories take the tenant (`userId`) first and accept no raw query;
  row ↔ domain mapping stays in the adapter, so a use-case never sees a row; a write and what it
  implies go in one unit of work.
- **Expected failures are values** (a `Result`), not exceptions; each language pack ships its own.
- **Each language pack enforces the direction with its own tool**, run after every agent edit, in
  `pnpm check`, and in CI: compiler-gated modules, crates, or targets where the language has them,
  otherwise a dependency lint whose every message states the fix.
<!-- [stack:typescript] -->
  TypeScript pack: a dependency-cruiser config, recorded in 0001.
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
  Go pack: `depguard` rules in `.golangci.yml`; a gate script plants a violation per layer so a misspelled path can't pass silently (`go.mdc`).
<!-- [/stack:go] -->

## Consequences

- The architecture survives removing any pack; only the enforcing tool goes with it.
- A new language pack isn't done until it ships a boundary check for these layers.
- A project with a language whose pack has no boundary check yet relies on review for direction
  until one exists; say so in that project's `architecture.mdc`.
