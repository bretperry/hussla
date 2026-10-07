# Repo map

What every file and folder is for, and who owns it. Owners: **harness** (listed in `harness.json`: identical in every project, synced), **hand-merged** (harness-shaped but holding your knobs, so not synced: compare with upstream and merge by hand, [keeping in step](keeping-in-step.md#project-overrides-projectmdc)), **project** (yours), **pack** (a stack pack's files), **generated** (never edit by hand). See [concepts](concepts.md#harness-vs-project-files).

Paths in a stack pack's table disappear with `pnpm stack:remove <pack>`.

| Path | Owner | What |
|---|---|---|
| `harness.json` | harness | The list of harness files (`docs` sync straight to `dev`; `code` needs a PR). |
| `harness.project.json` | project | The whippletree commit this project last took, and the harness files it skips, each with why. |
| `.cursor/rules/<rule>.project.mdc` | project | A project's additions to a harness rule. Same frontmatter, loads with it, wins where they differ (`rule-authoring.mdc`). |
| `scripts/harness-sync.mjs`, `.github/workflows/harness-drift.yml` | harness | `pnpm harness:status` / `pull` / `push`; a weekly red run when a project drifts. |
| `scripts/plans-status.mjs`, `scripts/plan-board.html`, `.claude/skills/plan-board/` | harness | `pnpm plans:check` lints every plan table, every Done-when `→ verify:`, every runbook scenario's check id, and every Human checks item (CI); `pnpm plans:board` / the `plan-board` skill renders them as one status board. |
| `scripts/lib/human-checks.mjs` | harness | Compiles every Human checks block (plans, runbooks, `docs/human-checks.md`) into one checklist, JSON or markdown; the wrangler runs it at ship time. |
| `stacks/<name>/pack.json`, `scripts/stack.mjs` | harness | Stack packs: every file a stack owns, in one manifest. `pnpm stack:list` / `stack:remove <name>`; `pnpm check` runs the core checks, then each pack's, then generated-file drift (`docs/decisions/0002-stack-packs.md`). |
| `scripts/bootstrap-repo.sh` | harness | One-time GitHub setup for a new project: `dev` and `main`, default branch, rulesets, hooks, harness base. |
| `AGENTS.md` | project, plus a generated block | Communication and working style, commands, rules index, stack, layout. The always-on rules (`core`, `architecture`, `branching`) are copied into its end by `pnpm rules:sync`, so every agent reads the same thing. |
| `CLAUDE.md`, `.gemini/settings.json` | harness | Point Claude Code and Gemini CLI at AGENTS.md (each reads its own file by default). Nothing else, so every tool reads the same guidance. |
| `.cursor/rules/architecture.mdc` | project | Layers, storage, knobs, and this project's do-nots. |
| `.cursor/rules/core.mdc` | harness | Before you write code, deleting data is a human action, guard rails, repo memory. |
| `.cursor/rules/branching.mdc` | harness | Branch flow, draft PRs, CI-minute discipline. |
| `.cursor/rules/branch-protection.mdc` | harness | What enforces the branch flow: pre-push hook, agent hooks, rulesets, required check names. Loads when you touch `.github/` or hook config. |
| `.cursor/rules/docs.mdc`, `docs-scripts.mdc`, `docs-infra.mdc` | harness | File-header and why-comment standard; line-by-line narration for scripts; schema, infra, YAML, and shell examples. |
| `.cursor/rules/plans.mdc` | harness | Execution-plan shape: phase table, model + thinking level, human checks. |
| `.cursor/rules/showrunner.mdc` | harness | Running a plan with parallel workers and QA. |
| `.cursor/rules/wrangler.mdc` | harness | Herding open PRs into `dev` and burst-merging with the user's OK. |
| `.cursor/rules/rule-authoring.mdc` | harness | How rules load in Cursor and Claude Code; edit the `.mdc`, never the generated `.md`. |
| `.cursor/rules/ship.mdc` | harness | "Ship it": the `dev` → `main` PR, freezing `dev`, merging on a green head. |
| `.cursor/rules/farrier.mdc` | harness | Code review and tests for a PR. Used by showrunner (QA stage 2) and wrangler. |
| `.cursor/rules/dynamite-test.mdc` | harness | A fresh subagent sees only the diff and tries to break the change. Used by showrunner and wrangler. |
| `.cursor/rules/compound.mdc` | harness | After a merge: turn what was learned into a check, rule line, learning, or decision. |
| `.cursor/rules/testing.mdc` | harness | What to test in any language: the four tiers, property tests, fakes of ports. |
| `.claude/skills/{showrunner,wrangler,ship,compound,farrier,dynamite-test}` | harness | Thin skills that load the matching `.mdc` on demand (Cursor reads `.claude/skills/` too). |
| `.claude/skills/setup/` | harness | `setup`: asks the setup questions, writes the override files, runs or prints the remaining steps. |
| `.claude/skills/help/` | harness | `help`: every command to copy, what to say to an agent, and a glossary of the terms. |
| `.claude/rules/*.md` | generated | Claude Code's copies of the scoped `.mdc` rules (it skips `.mdc`), from `scripts/sync-claude-rules.mjs`: `globs` become `paths`. Never edit; `pnpm rules:sync`. |
| `.cursor/hooks.json` | harness | Cursor's hooks: the guard and the edit check. |
| `.claude/settings.json` | hand-merged | Claude Code's hooks (guard + edit check: the harness part), Concise output style, each kept pack's language-server plugin, the Codex plugin for the rival, `.env` read-deny, safe-command allowlist (yours). |
| `scripts/command-guard.mjs` | harness | Refuses or asks about human-only commands (Ready, merge, push main, force, `--no-verify`, reruns, deletes). A pack can ship rules in `scripts/command-guard.d/*.json` (none does today); the guard loads them if present. |
| `scripts/command-guard-hook.mjs` | harness | The hooks' entry for the guard: blocks every command when the guard doesn't load or dies without answering, instead of letting it run. |
| `model-tiers.json`, `scripts/model-tiers.mjs` | harness | Whippletree's suggested model per tier and lineage, and `pnpm models`, which resolves this project's table. |
| `agent-overrides.json`, `scripts/agent-overrides.mjs` | project, harness | Optional. The team's overrides: `models` (a model id, `latest`, or `none` per cell) and `dynamiteTest` (`scope`, `rivalScope`). `pnpm overrides` shows each value and its file. Replaces `model-tiers.project.json` and `dynamite-test.project.json`, still read beneath it. |
| `agent-overrides.local.json` | personal (gitignored) | Optional. One person's overrides, same shape, wins over the team's; its `dynamiteTest.scope` may only be wider. `pnpm overrides init`. |
| `scripts/rival-review.mjs` | harness | `pnpm rival`: hands a branch to the rival model (Codex) for a dynamite test, and lets an agent argue a finding with it. Plugin runtime in Claude Code, `codex` CLI elsewhere. |
| `command-guard.project.json` | project | Optional. This project's guard rules: deny, ask, and exact-command exemptions. A file that doesn't load refuses every command (`branch-protection.mdc`). |
| `scripts/check-edited.mjs` | harness | After each agent edit: runs every pack's per-edit check that claims the file's extension; only failures go back to the agent. |
| `docs/ports-and-adapters.md`, `docs/decisions/0003-ports-and-adapters.md` | harness shape, project layer paths | The layer map for ports and adapters, and the language-neutral decision behind it. |
| `.github/workflows/guard-main-source.yml`, `.github/actions/setup-node-pnpm` | harness | Main-source guard; Node + pnpm setup with a `dev`-only store cache. |
| `.github/workflows/ci.yml`, `scripts/lib/ci-change-scope.mjs` | hand-merged | Cheap Checks always, heavy tier only when ready and relevant; which paths wake which jobs (your knobs). |
| `scripts/lib/wrangle-merge.mjs` | harness | The wrangler's burst-merge: waits until each PR is really green (heavy checks `pass`, not a stale draft run's `skipping`), pins its head, merges back-to-back. Reads ci.yml's `Build` and each pack's `heavyChecks`. |
| `.mcp.json`, `.cursor/mcp.json` | project | MCP servers (empty to start). |
| `.githooks/pre-push`, `scripts/install-git-hooks.sh` | harness | Refuses a `main` push whose tree didn't come from `dev`; runs `check` when code is pushed. Works from worktrees. |
| `.github/pull_request_template.md` | harness | What and why · Verification · Tested by · ship section. |
| `docs/deferred.md`, `docs/human-checks.md`, `docs/plans/_template.md`, `docs/decisions/`, `docs/learnings/` | harness shape, project content | Repo memory. |
| `docs/runbooks/_template.md`, `docs/runbooks/<area>.md` | harness shape, project content | Tier-3 tests: scenarios no test process can reach, each one a Human check id (`testing.mdc`). |
| `docs/human-checks.json` | project | Optional. The checklist's stations (which `where` values go to each) and gates; without it, `plans.mdc`'s defaults. |
| `CHANGELOG.md`, `CHANGELOG-TECHNICAL.md` | harness shape, project content | User-facing and what + why changelogs. |
| `README.md`, `docs/guide/` | project | The newcomer's path: what this is, getting started, concepts, agent setup, roles with start prompts, keeping in step, troubleshooting, this map. Rewrite or delete the guide once your project has its own. |
| `scripts/doc-commands.mjs` | project | `pnpm docs:commands` / `docs:run`: checks that every fenced `bash` block in the guide is on a safe list or marked `doc-run: skip <reason>`, and runs the safe ones in a fresh `git archive` copy. |

<!-- [stack:typescript] -->
**TypeScript pack** (`stacks/typescript/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/typescript.mdc`, `testing-ts.mdc` | pack | TypeScript conventions; Vitest + fast-check test tooling. |
| `tsconfig.base.json`, `.oxlintrc.json`, `stacks/typescript/check-edited.mjs` | pack (harness-synced) | TS 7 strict baseline, type-aware oxlint, the per-edit typecheck / lint / boundaries. |
| `tsconfig.json`, `knip.json`, `vitest.config.ts`, package.json scripts + devDependencies | pack (project-owned) | Project compiler settings, knip, Vitest. |
| `.dependency-cruiser.cjs` | pack, project layer paths | Import-boundary gate for ports and adapters. |
| `src/domain/result.ts` | pack seed | `Result` type for expected failures; its test is the property-test example. |
| `src/server/services/note-sync.ts`, `src/domain/note.ts`, `src/test/chaos/` | pack seed | Tier-2 example: a use-case that queues and delivers writes, a fault-scripted model server and outbox, one test per fault kind. |
<!-- [/stack:typescript] -->
<!-- [stack:swift] -->
**Swift pack** (`stacks/swift/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/swift.mdc`, `testing-swift.mdc` | pack | Swift conventions; Swift Testing and seeded-property test tooling. |
| `stacks/swift/*.mjs` | pack (harness-synced) | The per-edit check; the import-boundary scan; the gate script that plants a violation per rule; the test runner that fails on zero executed tests; the CI scope for the macOS job. |
| `Package.swift`, `swift-layers.json`, `.swift-format`, package.json `swift:*` scripts | pack (project-owned) | The layers as SwiftPM targets and what each may import (your layer names); the format config. |
| `Sources/`, `Tests/NoteSyncTests/` | pack seed | Tier-2 example: a use-case that queues and delivers writes, a fault-scripted model server and outbox, one test per fault kind; `Failures.swift` is the expected-failures-as-values example. |
<!-- [/stack:swift] -->
<!-- [stack:react] -->

**React pack** (`stacks/react/pack.json`, requires typescript): `.cursor/rules/react.mdc`, React conventions for `*.tsx`.
<!-- [/stack:react] -->
<!-- [stack:rust] -->

**Rust pack** (`stacks/rust/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/rust.mdc`, `testing-rust.mdc` | pack | Rust conventions; nextest + proptest + paused-time test tooling. |
| `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `stacks/rust/check-edited.mjs`, `stacks/rust/boundaries.mjs` | pack (harness-synced) | Toolchain pin, format and lint floor, the per-edit fmt / clippy / boundaries, the layer-map check. |
| `Cargo.toml`, `Cargo.lock`, `deny.toml`, package.json `rust:*` scripts | pack (project-owned) | Workspace, lint deny list, `[workspace.metadata.layers]` (who may use whom), cargo-deny policy. |
| `crates/domain`, `crates/app`, `crates/adapters` | pack seed | Tier-2 example: `note-sync`, a fault-scripted model server and outbox, one test per fault kind plus a proptest over random fault scripts. |
<!-- [/stack:rust] -->
<!-- [stack:python] -->

**Python pack** (`stacks/python/pack.json`): two profiles, one pack. Needs `uv` and `python3` 3.11+ (`uv sync` once).

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/python.mdc`, `testing-python.mdc` | pack | Python conventions; pytest + hypothesis, the virtual-time loop, unittest for tooling. |
| `stacks/python/check-edited.mjs`, `stacks/python/boundaries_test.py` | pack (harness-synced) | The per-edit ruff / pyright / import-linter check; proof that each boundary check fails on a violation. |
| `scripts/lib/run_unittests.py` (+ test) | pack (harness-synced) | Tooling profile: stdlib-only scripts and tests run on the system `python3`, no install; fails on 0 tests. |
| `pyproject.toml`, `uv.lock`, package.json `py:*` scripts | pack (project-owned) | Dev tools, ruff and pyright strictness, the import-linter `layers` contract. |
| `src/app/`, `tests/` | pack seed | `Result`, the note-sync tier-2 example (fault-scripted model server and outbox, one test per fault kind). Rename `app`. |
<!-- [/stack:python] -->
<!-- [stack:go] -->

**Go pack** (`stacks/go/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/go.mdc`, `testing-go.mdc` | pack | Go conventions; `go test -race`, rapid, synctest test tooling. |
| `stacks/go/check-edited.mjs`, `run.mjs`, `gates.mjs`, `gates.test.mjs` | pack (harness-synced) | The per-edit lint of the edited package; the tool runner behind `go:lint`/`go:test`/`go:tidy`; the gate script that plants a violation per boundary and lint rule and fails unless each is reported, and its test. |
| `.golangci.yml`, `stacks/go/gates.project.json`, `go.mod`, `go.sum`, package.json `go:*` scripts | pack (project-owned) | Lint floor and `depguard` layer boundaries (your layer paths); the module. |
| `internal/domain/`, `internal/config/`, `internal/app/notesync/`, `internal/testsupport/chaos/` | pack seed | Tier-2 example: a use-case that queues and delivers writes, a fault-scripted model server and outbox, one test per fault kind; `errors.go` is the expected-failures-as-values example. |
<!-- [/stack:go] -->
<!-- [stack:infra] -->

**Infra pack** (`stacks/infra/pack.json`, add-on, any language): cloud-neutral rules and checks, no provider modules.

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/infra.mdc`, `docs/runbooks/_deploy.md` | pack | Terraform layout, humans apply, OIDC deploys, Dockerfiles, staging teardown; a deploy and rollback runbook template. |
| `stacks/infra/check.mjs`, `check-edited.mjs`, `install-tools.sh` | pack (harness-synced) | `infra:fmt` / `validate` / `lint` / `docker`; per-edit fmt and hadolint; pinned terraform, tflint, hadolint. |
| `.tflint.hcl`, `.hadolint.yaml` | pack (project-owned) | tflint and hadolint policy (no `latest` base image). |
| `.dockerignore`, the Terraform lines in `.gitignore` | project | What a build never sends; state, plans, and tfvars never committed. Seeded with the pack, kept on `stack:remove infra` so no secret becomes committable. |
<!-- [/stack:infra] -->
<!-- [stack:kotlin] -->

**Kotlin pack** (`stacks/kotlin/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/kotlin.mdc`, `testing-kotlin.mdc` | pack | Kotlin conventions; JUnit 6, kotest-property, `runTest` virtual-time test tooling. |
| `stacks/kotlin/check-edited.mjs`, `run.mjs`, `gates.mjs`, `android-sdk.sh` | pack (harness-synced) | The per-edit compile / detekt / ktfmt of the edited source set; the `gradle check` and device-test runner (the device lock); the gate script that plants a violation per boundary and lint rule and fails unless each is reported; the Android SDK installer. |
| `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/` (catalog, wrapper), `gradlew*`, `config/detekt/detekt.yml`, package.json `kotlin:*` scripts | pack (project-owned) | Modules, `LAYERS` (who may use whom), versions, the pinned Gradle wrapper, the lint floor. |
| `app/` | pack seed | The Android app and composition root: `AppGraph`, the application class, one screen, its resources, a host test and an instrumented test. |
| `domain/`, `usecases/`, `data/` | pack seed | Tier-2 example: `NoteSync`, a fault-scripted model server and outbox (test fixtures), one test per fault kind plus a property over random scripts; `Outcome` is the expected-failures-as-values example. |
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->

**C++ pack** (`stacks/cpp/pack.json`):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/cpp.mdc`, `testing-cpp.mdc` | pack | C++20 conventions, the warning set and tidy floor, what the gates refuse; GoogleTest under ASan+UBSan and TSan, seeded properties, virtual-time fault tests. |
| `stacks/cpp/tool.mjs`, `sources.mjs`, `evaluated.mjs`, `run.mjs`, `gates.mjs`, `check-edited.mjs`, `install-tools.sh` | pack (harness-synced) | Tool floors and process-group timeouts; source rules; checks on the build as evaluated (File API, `ninja -t deps`, `nm`); the build / lint / test runner; the gate script that plants a violation per rule; the per-edit check; Linux sanitizer runtimes. |
| `CMakeLists.txt`, `CMakePresets.json`, `cpp-layers.json`, `.clang-tidy`, `.clang-format`, package.json `cpp:*` scripts | pack (project-owned) | Targets per layer and the warning set, the `asan` / `tsan` / `gcc` presets, who may link and call what (and what a nested `.clang-tidy` may turn off), the tidy floor and format. |
| `cpp/` | pack seed | Tier-2 example: `NoteSync`, a fault-scripted model server and outbox on a virtual clock (test fixtures), one test per fault kind plus a property over random scripts; `Outcome` is the expected-failures-as-values example. |
<!-- [/stack:cpp] -->
<!-- [stack:sql-migrations] -->

**SQL migrations pack** (`stacks/sql-migrations/pack.json`, add-on, any language; Postgres):

| Path | Owner | What |
|---|---|---|
| `.cursor/rules/migrations.mdc` | pack | Atomic migration files, live-table locks, backfills, who applies them; Prisma first, notes for sqlx, goose, Alembic. |
| `stacks/sql-migrations/lint.mjs`, package.json `migrations:lint` + `squawk-cli` | pack (harness-synced) | squawk plus an atomic-file check on every `*.sql` under `migrations/`, in `pnpm check`, CI, and the edit hook. |
| `.squawk.toml` | pack (project-owned) | Rules skipped (with why), whether the migration tool wraps each file, history to skip. |
| `stacks/sql-migrations/kill-partway.test.mjs`, `fixtures/` | pack seed | Tier-2 example: a migration killed partway on a throwaway loopback Postgres lands on the old schema or the new one. Needs Postgres server binaries; skips loudly without them, fails under CI. |
<!-- [/stack:sql-migrations] -->
