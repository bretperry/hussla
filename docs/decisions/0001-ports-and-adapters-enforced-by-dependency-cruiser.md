# 0001. Ports and adapters, enforced by dependency-cruiser

`accepted` · 2026-09-29 · from whippletree (harness template), carried from habit

## Context

- Domain logic that imports a framework or a vendor can't move to a native client or survive a
  datastore swap. The dependency direction is the architecture.
- A rule an agent must remember is a rule an agent will eventually break. habit enforced its
  layering with per-layer `no-restricted-imports` blocks in ESLint.
- The template ships TypeScript 7, which has no JS API until 7.1, and oxlint for linting. ESLint
  and dependency-cruiser's TypeScript parser both need that API.

## Decision

- Layers and allowed directions as in `docs/ports-and-adapters.md`.
- `.dependency-cruiser.cjs` is the one gate. It uses the swc parser, so it works with TypeScript 7.
  It runs after every agent edit, in `pnpm check`, pre-push, and CI.
- Every rule's message states the fix, because agents read it right after the edit.
- Expected failures are `Result` values (`src/domain/result.ts`), not exceptions and not an effect
  system. That keeps domain signatures framework-free.

## Consequences

- Layering violations fail in about a second on the edit that caused them, whatever editor or agent.
- No in-editor squiggle for boundaries without the hook. A project on ESLint can add habit's
  `no-restricted-imports` blocks for that, as a second signal, not a replacement.
- Revisit the swc parser when dependency-cruiser supports TypeScript 7 (it prints a notice until then).
