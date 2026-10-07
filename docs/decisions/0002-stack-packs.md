# 0002. Each stack is a removable pack, listed in its own stacks/<name>/pack.json

`accepted` · 2026-10-01 · from the go-public plan, Phase 1

## Context

- The harness shipped TypeScript woven through a dozen files: package.json, CI, the edit hook,
  the boundary and dead-code configs, the compiler configs, three rules, and the `Result` seed.
  A Rust or Swift project had to find and cut each one by hand (README step 7), and whatever it
  missed failed CI on a tool that was no longer installed.
- Several languages in one repo is normal (habit: TypeScript, Swift, Rust/Tauri, Python scripts),
  so nothing can assume one stack.
- Harness files are byte-identical in every project. A pack's manifest can't live in
  `harness.json`: removing a pack would then edit a harness file, and `harness:status` would
  report it as drift forever.
- The harness's own tests ran under the TypeScript pack's test runner, so removing the pack
  would have removed the tests of the hooks and guards that every project keeps.

## Decision

- **A pack is a directory, `stacks/<name>/`, with a `pack.json`.** `harness.json` → `stacks`
  names the packs upstream ships; the files a pack owns are listed only in its manifest:
  - `docs` / `code`: harness-synced files (same split as `harness.json`; `pack.json` itself syncs as code).
  - `owns`: project-owned files the pack created (configs, the seed, a decision on its own tooling
    such as the TypeScript pack's boundary tool). The language-neutral architecture lives in a
    decision no pack owns (`0003-ports-and-adapters.md`).
  - `checks`: package.json scripts `pnpm check` runs, in order. `editCheck`: extensions (plus
    optional basename regexes, `names`, for files like `Dockerfile.prod`, and optional exact
    `files`, for a config whose extension is too common to claim) + a script the edit hook runs.
    `requiredChecks`: CI job names the rulesets must require while the pack is present
    (`bootstrap-repo.sh` adds them; `stack:remove` says to drop them). `ciHeavy`: path regexes that wake the heavy CI tier. `heavyChecks`: `{ name, scope }` per CI job of the pack's that skips on a draft or an unrelated change, where `scope` exports `classify(paths)`; `scripts/lib/wrangle-merge.mjs` requires that job to `pass` (not `skipping`) before it merges a PR whose paths it claims. `generated`:
    `{ script, files }` the core regenerates and drift-checks.
  - `packageJson` / `claudeSettings`: the scripts, dependencies, permissions, and plugins it added.
  - `kind`: `language` or `add-on`; `requires`: packs an add-on needs (React requires typescript).
- **Installed means on disk.** A pack is present when `stacks/<name>/` exists; nothing else
  records it. New upstream packs are opt-in: `harness:pull` / `status` compare only present packs
  and print "upstream ships pack <x>, not installed" for the rest, so no project ever gets a
  half-installed pack.
- **Adoption, for projects that predate packs.** A project with no `stacks/` dir and no
  `removedStacks` that already holds any of a pack's harness files (habit's `typescript.mdc`,
  its compiler baseline) has that pack installed in all but name: `harness:pull` treats it as
  installed, writes its `pack.json`, and keeps its files in sync ("adopted pack <x>: its files were
  already here"; `harness:status` says "would adopt"). A pack whose files are absent stays
  available. Once `stacks/` exists, disk alone decides.
- **`pnpm stack:remove <name>`** removes the pack and every pack that requires it: deletes the
  listed files minus any a kept pack also claims (same for scripts, dependencies, permissions),
  then `stacks/<name>/`; strips `[stack:<name>]` … `[/stack:<name>]` marker-line regions from
  every file git tracks or would track; edits package.json and `.claude/settings.json` line by
  line; refreshes the lockfile; re-syncs the rules; and adds the name to `harness.project.json` →
  `removedStacks`, so `stack:list` tells removed from available.
- **Manifest paths are validated before anything is deleted**: repo-relative, plain segments,
  inside the repo, files only. The one recursive delete is `stacks/<name>/` itself.
- **Fences only in project-owned files** (`ci.yml` toolchain setup, `AGENTS.md`, `README.md`,
  `docs/`, `architecture.mdc`). Harness files name no stack's tools, so they stay byte-identical
  after any removal.
- **The core dispatches; packs do the work.** `scripts/check-edited.mjs` runs every pack whose
  `editCheck.extensions` or `editCheck.names` claims the edited file (several may, in parallel); a check that crashes
  or times out is reported, not read as clean. `pnpm check` (`scripts/stack.mjs check`) runs the
  core checks, then each present pack's, then generated-file drift. CI runs the core steps, then
  one "Stack pack checks" step (`stack.mjs check --packs`) reading the same `checks` lists, so CI
  and local can't disagree. `ci-change-scope.mjs` adds each pack's `ciHeavy`.
- **Generated files are pack-agnostic.** A pack declares `generated: [{ script, files }]`; the core
  runs the script and fails when a file is missing, gitignored, or changed or untracked as `git`
  sees it, and when git itself fails (`pnpm stack:drift`, in `pnpm check` and CI). This is habit's `git diff --exit-code` token check, made general.
- **Harness tests run on `node:test` + `node:assert`** (`pnpm test:harness`: `scripts/**` and
  `stacks/**` test files), not on any pack's runner, so they survive every removal and need no
  install. A pack's own harness tests live in its directory and go with it.
- **The seed is per pack.** Each language pack lists its `Result` seed in `owns` (the TypeScript
  pack's is in `src/domain/`), so it leaves with the pack and another pack brings its own.
- **Node is a harness requirement, and we say so.** The hooks, rule sync, harness sync, plan
  board, and pack runner are Node scripts using builtins only. A Rust- or Go-only project needs
  Node (`.nvmrc`) on PATH, and nothing installed from npm. Rewriting the harness per language
  would multiply it by every language it supports; one runtime that every agent host already has
  is the cheaper constraint.

## Consequences

- Removing a stack is one command and leaves a harness whose CI still runs rule sync, plan
  tables, harness tests, and drift; `scripts/stack.test.mjs` proves it on a copy of the repo.
- A new language pack is a directory (plus a fenced CI setup step if it needs a toolchain); the
  core needs no change.
- A fence typo can't eat a file: unbalanced markers stop the removal before anything changes.
- Text about a stack in a project-owned file must be fenced or it outlives the pack; a stray
  mention is caught only by review, not a check.
- New packs are opt-in. A project that predates packs keeps syncing the packs whose files it
  already has (adoption) and is offered the rest. Adding or re-adding a pack by hand is manual
  for now (`docs/deferred.md`).
- Revisit if a non-Node host for the hooks becomes common enough to justify a second runtime.
