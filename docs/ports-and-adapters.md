# Ports and adapters

The layer map, which way imports may point, and how it's enforced. Each language pack's boundary
check holds the rules; this file is the *why* behind them and what to do when one fires. The
decision: `docs/decisions/0003-ports-and-adapters.md`.

Why it pays here: Hussla's whole point is swapping what's behind a port. Every email provider
(iCloud, Gmail, Outlook, Resend, Postmark …) is one `MailSender` adapter, the secret store can
move from a key file to the NAS's own vault, and storage can grow past SQLite, each without
touching a use-case. In Hussla the server layers are Go (`internal/`), and the TypeScript layers
hold only the React UI (`docs/decisions/0008-go-server.md`).
<!-- [stack:typescript] -->
TypeScript pack: the rules live in `.dependency-cruiser.cjs` (`docs/decisions/0001-ports-and-adapters-enforced-by-dependency-cruiser.md`).
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
Go pack: the rules are `depguard` entries in `.golangci.yml`, one per layer (`internal/domain`, `internal/config`, `internal/app`). A `files` glob that matches no path passes silently, so `pnpm go:gates` fails an `internal/` directory no rule covers and plants a violation in each layer on a scratch copy, failing unless depguard reports it. Fixing a finding: move the import behind a port in `internal/app/<use-case>/ports.go` and wire the adapter in the composition root.
<!-- [/stack:go] -->

<!-- Per project: say what future justifies ports here (a native client, a second datastore,
     a vendor you expect to swap). Nothing in this doc is architecture for its own sake. -->

## Layers

```
src/config/             # product knobs: named constants; imports nothing from the app
src/domain/             # pure domain: types + functions; no framework, no I/O, no packages
src/server/ports/       # interfaces the use-cases depend on (+ input schemas)
src/server/services/    # use-cases: factories that take ports as arguments
src/server/adapters/    # one vendor or device per file, implementing a port
src/server/container.ts # composition root: the only place adapters are constructed and wired
src/features/           # UI + validation schemas per feature; reaches the server via the API
src/shared/             # UI primitives, hooks, lib; a leaf under features
```

```
features ──API──▶ container ──wires──▶ services ──▶ ports ◀── adapters
    │                                      │           │
    └──────────────▶ shared                └────▶ domain ◀────┘
                                                   │
                     every layer ─────────────▶ config
```

Arrows are "may import". Anything not drawn is refused. Tests are exempt: a test may wire an adapter
or a fake directly, which is how the ports get exercised.

## What each rule stops, and the fix

| Rule | Stops | Fix |
|---|---|---|
| `domain-is-pure` | domain importing server, features, or shared UI | Move I/O into a use-case behind a port; move React into a feature |
| `domain-imports-no-packages` | any npm package or node builtin in domain | Keep domain plain TS. A genuinely pure package goes in `DOMAIN_ALLOWED_PACKAGES` with a why-comment |
| `ports-are-contracts` / `ports-import-no-io-packages` | a port importing an implementation or a vendor | Implementation → services/adapters; wire in `container.ts` |
| `adapters-only-via-composition-root` | anyone but the container importing an adapter | Add the port to the use-case factory's arguments; wire the adapter in `container.ts` |
| `use-cases-dont-reach-for-the-container` | a use-case pulling its own dependencies | Receive the port as an argument |
| `adapters-dont-call-up` | an adapter orchestrating use-cases | Orchestration belongs in a use-case |
| `features-reach-the-server-through-the-api` | server code shipped to the client | Call the API; port *types* are fine |
| `shared-is-a-leaf`, `config-is-a-leaf` | cycles through the bottom layers | Move the code into the layer that owns it |
| `no-circular`, `not-to-unresolvable`, `no-non-package-json`, `not-to-dev-dep`, `production-code-imports-no-tests` | load-order bugs, typos, hoisting accidents, test code in production | As the message says |

## Where it runs

- **After every agent edit.** `scripts/check-edited.mjs`, via the Claude Code and Cursor hooks. The
  violation and its fix land in the agent's context on the edit that caused it.
- **`pnpm check`**, through the pack's checks.
<!-- [stack:typescript] -->
- **`pnpm boundaries`** on its own (TypeScript pack).
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
- **`pnpm go:lint`** on its own (Go pack), and **`pnpm go:gates`** to prove the rules still bite.
<!-- [/stack:go] -->
- **Pre-push**, as part of `npm run check` when code changed (`.githooks/pre-push`).
- **CI "Checks"**, the "Stack pack checks" step.

## Adding a port

1. Declare the interface in `src/server/ports/<name>.ts`, using domain types and input schemas only.
2. Implement it in `src/server/adapters/<vendor>-<name>.ts`. Map vendor rows to domain types there,
   so no use-case ever sees a row.
3. Add the port to the use-case factory's arguments in `src/server/services/`.
4. Construct the adapter and pass it in `src/server/container.ts`.
5. Test the use-case with an in-memory fake of the port (`src/test/`), and the adapter against the
   real thing in its own tier.

## Carve-outs

Some code shouldn't pay the abstraction, like a bulk data clone that a repository would obscure.
Keep the hole the size of the imports it excuses:

<!-- [stack:typescript] -->
- Prefer `npx depcruise-baseline` to record that exact violation in
  `.dependency-cruiser-known-violations.json`, and add `--ignore-known` to the `boundaries` script.
  Every other import in that file still fails.
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
- Go: `//nolint:depguard // <why>` on that one import line (`nolintlint` rejects it without a reason; never list `nolintlint` in the directive, `pnpm go:gates` fails that). Never add the package to a layer's `allow` list to make one file pass.
<!-- [/stack:go] -->
- Never widen a rule's `pathNot` to a whole directory to make one file pass. The rule's letter is
  kept and its point is lost.
- Record the carve-out and its why in a decision (`docs/decisions/`).

## Deliberately not building

<!-- Per project: the hexagonal machinery considered and rejected, each with why (event sourcing,
     a CRDT engine, abstracting the auth library, a BFF per client …). This list is what stops a
     future session "finishing" the architecture. -->

- **A message bus or event sourcing for the activity log.** One owner and a handful of agents
  write a few hundred rows a day; an `events` table written in the same transaction is enough.
- **Abstracting Tailscale identity.** It is two request headers trusted from loopback; a port for
  it would hide the one security check that matters behind indirection.
- **An effect system (Effect-TS) in the domain.** It makes every domain signature an Effect, which
  puts a framework in the layer this whole file exists to keep framework-free. Expected failures
  are plain `Result` values (each language pack ships its own).
