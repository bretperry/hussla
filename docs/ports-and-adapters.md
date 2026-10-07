# Ports and adapters

The layer map, which way imports may point, and how it's enforced. Each language pack's boundary
check holds the rules; this file is the *why* behind them and what to do when one fires. The
decision: `docs/decisions/0003-ports-and-adapters.md`.
<!-- [stack:typescript] -->
TypeScript pack: the rules live in `.dependency-cruiser.cjs` (`docs/decisions/0001-ports-and-adapters-enforced-by-dependency-cruiser.md`).
<!-- [/stack:typescript] -->
<!-- [stack:rust] -->
Rust pack: the layers are the `domain`, `app`, and `adapters` crates, and `[workspace.metadata.layers]` in `Cargo.toml` holds who may use whom. A finding means either the code or the row is wrong: invert the dependency behind a port in `app` rather than widening the row.
<!-- [/stack:rust] -->
<!-- [stack:python] -->
Python pack: the rules live in the `[tool.importlinter]` contract and ruff's `TID251` ban list, both in `pyproject.toml` (`python.mdc`).
<!-- [/stack:python] -->
<!-- [stack:go] -->
Go pack: the rules are `depguard` entries in `.golangci.yml`, one per layer (`internal/domain`, `internal/config`, `internal/app`). A `files` glob that matches no path passes silently, so `pnpm go:gates` fails an `internal/` directory no rule covers and plants a violation in each layer on a scratch copy, failing unless depguard reports it. Fixing a finding: move the import behind a port in `internal/app/<use-case>/ports.go` and wire the adapter in the composition root.
<!-- [/stack:go] -->
<!-- [stack:swift] -->
Swift pack: layers are SwiftPM targets (`Config` → `Domain` → `UseCases` → `Adapters`), and `swift-layers.json` lists what each may import. SwiftPM puts every built module in one directory, so a target can import a module it never declared if that module built first and the build stays green; `pnpm swift:boundaries` therefore reads the source, and `pnpm swift:gates` plants a violation per rule (every import a layer doesn't allow, an unlisted target, a `default:` in `Domain`) and fails unless each is reported. Fixing a finding: move the import behind a port in `Sources/UseCases/Ports.swift` and wire the adapter in the composition root.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
Kotlin pack: each layer is a Gradle module (`:domain` ← `:usecases` ← `:data` ← `:app`, the Android app and composition root), so the compiler refuses an import from a module that isn't a dependency, and only `:app` is an Android module, so an Android API doesn't compile in the layers below it. `LAYERS` in `build.gradle.kts` says which modules and libraries each may depend on, and fails the build on a dependency off its row, a module with no row, or a row naming no module. detekt's `ForbiddenImport` keeps the JDK's I/O out of `domain/src/main`. `pnpm kotlin:gates` plants a violation of each in a scratch copy and fails unless the build reports it. Fixing a finding: move the dependency behind a port in `:usecases` and wire the adapter in the composition root.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
C++ pack: each layer is a CMake target (`domain` ← `usecases` ← `adapters`) whose public include directory is `cpp/<layer>/include`, so a layer can only include what it links. Text can lie about a build, so the checks read the build itself: `cpp-layers.json` says which layers each may link and which system families (I/O, clock, env, process, thread, random, net, dynamic loading) the inner layers may not call; `pnpm cpp:build` checks the configured targets (CMake File API: links, include paths, warning flags, sanitizers), every header each unit really included (`ninja -t deps`), and every symbol each layer's archive leaves undefined (`nm`). `pnpm cpp:gates` plants a violation of each in a scratch copy and fails unless it is reported. Fixing a finding: move the call behind a port in `cpp/usecases/include/usecases/<use-case>/ports.hpp` and implement it in `adapters`.
<!-- [/stack:cpp] -->

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
<!-- [stack:rust] -->
- **`pnpm rust:boundaries`** on its own (Rust pack).
<!-- [/stack:rust] -->
<!-- [stack:python] -->
- **`pnpm py:boundaries`** on its own (Python pack); `pnpm py:selftest` proves it still fails on a violation.
<!-- [/stack:python] -->
<!-- [stack:go] -->
- **`pnpm go:lint`** on its own (Go pack), and **`pnpm go:gates`** to prove the rules still bite.
<!-- [/stack:go] -->
<!-- [stack:swift] -->
- **`pnpm swift:boundaries`** on its own (Swift pack; needs no swift), and **`pnpm swift:gates`** to prove the rules still bite.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
- **`pnpm kotlin:check`** (any `./gradlew` run checks `LAYERS`; Kotlin pack), and **`pnpm kotlin:gates`** to prove the rules still bite.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
- **`pnpm cpp:build`** (C++ pack; the layer checks run on the built trees), and **`pnpm cpp:gates`** to prove the rules still bite.
<!-- [/stack:cpp] -->
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
<!-- [stack:swift] -->
- Swift: there is no per-line escape. Keep the import in a layer whose row in `swift-layers.json` allows it, or add the module to that one row with a decision recording why. Never add a module to every row to make one file pass.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
- Kotlin: a forbidden import is `@file:Suppress("ForbiddenImport")` on that one file with a why-comment. A module dependency has no per-file hole: move the code, or change the module's `LAYERS` row on purpose.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
- C++: there is no per-line escape; the checks read the build, not comments. Move the code to a layer whose row in `cpp-layers.json` allows it, or change that one row on purpose with a decision recording why.
<!-- [/stack:cpp] -->
- Never widen a rule's `pathNot` to a whole directory to make one file pass. The rule's letter is
  kept and its point is lost.
- Record the carve-out and its why in a decision (`docs/decisions/`).

## Deliberately not building

<!-- Per project: the hexagonal machinery considered and rejected, each with why (event sourcing,
     a CRDT engine, abstracting the auth library, a BFF per client …). This list is what stops a
     future session "finishing" the architecture. -->

- **An effect system (Effect-TS) in the domain.** It makes every domain signature an Effect, which
  puts a framework in the layer this whole file exists to keep framework-free. Expected failures
  are plain `Result` values (each language pack ships its own).
