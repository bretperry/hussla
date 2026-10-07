# {{PROJECT_NAME}} — agent guide

{{ONE_LINE_PITCH}}

## Communication style

Everyone has ADHD. Be concise. Prefer outline/bullet format over prose.

## Working style

- Work in a git worktree based off `dev` unless told otherwise.
- Open PRs as drafts; the user marks them ready when the batch is done enough for the expensive CI signal.
- A new execution plan in `docs/plans/` carries a phase table near the top — model suggestion and
  prerequisites (`After`) per phase — so the next session can start Phase N from that file alone
  (`plans.mdc`).
- A **docs-only** change is the exception: no branch, no PR, no CI — commit it on `dev` in the
  primary clone and push with `[skip ci]` (`branching.mdc` defines what counts).
- Prefer existing patterns; one concern per change.
- After behavior changes, run `pnpm check` locally — local runs are free, CI is not.
- The edit hook already typechecks, lints, and boundary-checks each file you touch; fix what it
  reports before moving on.

Context is a budget:

- Pick the model and effort at the start of a task, and don't add or remove MCP servers or
  plugins mid-task (either one throws away the prompt cache).
- Send noisy work (long test runs, log digging) to a subagent that returns a summary.
- `/compact` at natural breaks, not mid-step.

Machine-wide resources (a fixed dev/e2e port, a shared test database, a simulator) are not
isolated by worktrees:

- Anything that uses one takes a lock and exits 75 if another run holds it.
- Wait or skip and say so — never attach to another agent's server and never kill it.

## Commands

`pnpm check` runs everything fast — the harness's own checks (rule sync, plan tables, harness
tests, generated-file drift), then each stack pack's — and is what pre-push runs.
<!-- [stack:typescript] -->
TypeScript pack, singly: `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm test`, `pnpm knip`.
<!-- [/stack:typescript] -->
<!-- [stack:rust] -->
Rust pack, singly: `pnpm rust:fmt`, `pnpm rust:lint`, `pnpm rust:boundaries`, `pnpm rust:test`, `pnpm rust:deny`, `pnpm rust:advisories` (needs network; not in `check`).
Needs `cargo install cargo-nextest cargo-deny --locked` once.
<!-- [/stack:rust] -->
<!-- [stack:python] -->
Python pack, singly: `pnpm py:lint`, `pnpm py:types`, `pnpm py:boundaries`, `pnpm py:test`, `pnpm py:tooling` (stdlib only, no install), `pnpm py:selftest`. Needs `uv` and `python3` 3.11+.
<!-- [/stack:python] -->
<!-- [stack:go] -->
Go pack, singly: `pnpm go:lint` (lint, vet, boundaries), `pnpm go:gates`, `pnpm go:test`, `pnpm go:tidy`.
<!-- [/stack:go] -->
<!-- [stack:infra] -->
Infra pack, singly: `pnpm infra:fmt`, `pnpm infra:validate`, `pnpm infra:lint`, `pnpm infra:docker`; tools: `bash stacks/infra/install-tools.sh`.
<!-- [/stack:infra] -->
<!-- [stack:swift] -->
Swift pack, singly: `pnpm swift:boundaries` (no swift needed), `pnpm swift:lint`, `pnpm swift:gates`, `pnpm swift:test`.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
Kotlin pack, singly: `pnpm kotlin:check` (`./gradlew check`: compile, detekt, ktfmt, Android lint, layer map, tests), `pnpm kotlin:gates`, `pnpm kotlin:device` (instrumented tests on an emulator or device; takes a lock, exits 75 if held); `./gradlew ktfmtFormat` fixes formatting. Needs a JDK 21 and an Android SDK (`bash stacks/kotlin/android-sdk.sh`).
<!-- [/stack:kotlin] -->
<!-- [stack:sql-migrations] -->
SQL migrations pack, singly: `pnpm migrations:lint` (squawk plus the atomic-file check on every migration).
<!-- [/stack:sql-migrations] -->
<!-- [stack:cpp] -->
C++ pack, singly: `pnpm cpp:build` (asan + tsan trees, layers as built), `pnpm cpp:lint` (source rules, clang-format, clang-tidy), `pnpm cpp:test` (GoogleTest under the sanitizers), `pnpm cpp:gates`; tools: clang 18, cmake, ninja (`bash stacks/cpp/install-tools.sh` on Linux).
<!-- [/stack:cpp] -->
Harness sync with whippletree: `pnpm harness:status` / `harness:pull` / `harness:push`; `pnpm harness:eject` takes it out of a release (`docs/guide/keeping-in-step.md`).
Stack packs: `pnpm stack:list` / `stack:remove <name>`.

## Rules

Canonical constraints live in `.cursor/rules/` (do not duplicate them here):

Always on, for every agent (copied to the end of this file):

- `core.mdc` — before you write code, claims need evidence, response shape, deleting data is a human action, guard rails, repo memory
- `architecture.mdc` — this project's layers, storage, knobs, and do-nots
- `branching.mdc` — `dev` → `main` only; "ship it"; worktrees off `dev`; draft PRs first; CI minutes are a resource

When you touch matching files (Cursor and Claude load these; any other tool, read the matching one first):

- `testing.mdc` — what to test in any language: the four tiers, property tests, fakes of ports
<!-- [stack:typescript] -->
- `typescript.mdc` / `testing-ts.mdc` — TypeScript and its test tooling (TypeScript pack)
<!-- [/stack:typescript] -->
<!-- [stack:rust] -->
- `rust.mdc` / `testing-rust.mdc` — Rust and its test tooling (Rust pack)
<!-- [/stack:rust] -->
<!-- [stack:python] -->
- `python.mdc` / `testing-python.mdc` — Python (app and stdlib-only tooling profiles) and its test tooling (Python pack)
<!-- [/stack:python] -->
<!-- [stack:go] -->
- `go.mdc` / `testing-go.mdc` — Go and its test tooling (Go pack)
<!-- [/stack:go] -->
<!-- [stack:swift] -->
- `swift.mdc` / `testing-swift.mdc` — Swift and its test tooling (Swift pack)
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
- `kotlin.mdc` / `testing-kotlin.mdc` — Kotlin and its test tooling (Kotlin pack)
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
- `cpp.mdc` / `testing-cpp.mdc` — C++ and its test tooling (C++ pack)
<!-- [/stack:cpp] -->
<!-- [stack:react] -->
- `react.mdc` — React conventions for `*.tsx` (React pack)
<!-- [/stack:react] -->
<!-- [stack:infra] -->
- `infra.mdc` — Terraform layout, humans apply, OIDC deploys, Dockerfiles, staging teardown, infra checks (infra pack)
<!-- [/stack:infra] -->
<!-- [stack:sql-migrations] -->
- `migrations.mdc` — SQL migrations in any language: atomic files, live-table locks, backfills, who applies them (`pnpm migrations:lint`; SQL migrations pack)
<!-- [/stack:sql-migrations] -->
- `docs.mdc` / `docs-scripts.mdc` / `docs-infra.mdc` — file-header and why-comment standard; line-by-line narration for scripts; non-TS examples
- `plans.mdc` — `docs/plans/` shape: phase table with After + Model near the top so a fresh session can start a phase from the file alone
- `branch-protection.mdc` — pre-push hook, agent hooks, rulesets, required check names (when you touch `.github/` or hooks)
- `rule-authoring.mdc` — how the rules load in each tool, and how to add or edit one (when you touch a rule or skill)

On demand (skills):

- `showrunner.mdc` — running a `docs/plans/` file: parallel workers at each phase's model, showrunner does QA, user merges
- `wrangler.mdc` — one session herding open PRs across plans into `dev`: combine, fix conflicts, triage CI, burst-merge with the user's OK
- `ship.mdc` — "ship it": `dev` → `main` PR, freeze `dev` pushes, merge on a green head
- `farrier.mdc` — code review and tests for a PR: `/code-review`, named tests, UI evidence, migrations
- `dynamite-test.mdc` — a fresh subagent sees only the diff and tries to break it
- `compound.mdc` — after a merge: turn what was learned into a check, a rule line, a learning, or a decision
- `help` skill — every command to copy, what to say to an agent, and a glossary of the terms

<!-- Add project-specific rules here as they become established (auth.mdc, e2e.mdc, marketing.mdc …). -->

When a convention becomes established, update the matching file in `.cursor/rules/`. Files listed
in `harness.json` are shared with every project: put this project's additions in a
`<rule>.project.mdc` companion, never in the harness file (`rule-authoring.mdc`).

## Stack

{{STACK}} <!-- e.g. Next.js · React · TypeScript · Tailwind · Prisma/Postgres -->

Stack packs (`stacks/<name>/pack.json`, `pnpm stack:list`) own each stack's rules, configs, checks,
and CI steps; `pnpm stack:remove <name>` takes one out whole (`docs/decisions/0002-stack-packs.md`).

Package manager: **pnpm** only. Node: `.nvmrc` — the harness's hooks and scripts need Node even
when no pack is a Node stack.

## Layout

```
src/config/       # product knobs — named constants anything retunes (architecture.mdc → Knobs)
src/domain/       # pure domain logic — no framework, no I/O, no feature imports
src/features/     # UI + validation schemas per feature
src/server/       # I/O: services (use-cases), ports, adapters, composition root
src/shared/       # ui primitives, hooks, lib
scripts/          # agent hooks (command-guard, check-edited), CI helpers in scripts/lib/
stacks/           # stack packs: one pack.json per language or add-on, listing every file it owns
docs/             # standing reference (deploy, security, knobs, deferred, ports-and-adapters …)
docs/guide/       # newcomer path: getting started, concepts, agents, roles, troubleshooting (bash blocks checked by pnpm docs:commands)
docs/decisions/   # decisions taken, one numbered file each (why a future session must not undo them)
docs/learnings/   # mistakes that would happen again, and the check that catches each
docs/plans/       # in-progress, phase-by-phase execution plans — not standing reference.
                  # Phase table (After + Model) near the top is how an agent starts a phase (plans.mdc)
docs/runbooks/    # tier-3 tests: scenarios no test process reaches, each a Human check id (testing.mdc)
```
<!-- Replace with the real tree once it exists. One line per dir: what lives there and why. -->

## Repo memory

Deferred work, decisions, and learnings: Core → Repo memory, below.
`docs/ports-and-adapters.md` is the layer map and the fix for each import-boundary rule.

Changelogs: `CHANGELOG.md` is user-facing; `CHANGELOG-TECHNICAL.md` is the internal what + why
record (same versions). Add a bullet under `[Unreleased — dev only]` for notable technical work.

<!-- BEGIN always-on rules: generated by scripts/sync-claude-rules.mjs from .cursor/rules/{core,architecture,branching}.mdc; edit those, then run `pnpm rules:sync`. -->

## Core

<!-- Harness-owned: refreshed from whippletree. Project architecture and project do-nots live in
     architecture.mdc. -->

### Before you write code

Stop at the first step that holds:

1. **Does it need to exist?** Is it asked for, or required by what was asked?
2. **Does the codebase already do it?** Reuse or extend it.
3. **Does the language, the platform, or an installed dependency do it?**
4. **Only then write the smallest thing that works.** Never cut validation, security, accessibility,
   or data-loss handling to get there.

Every changed line traces to the request: no drive-by refactors, renames, or reformatting, and
remove only what your own change orphaned. A cleanup worth doing is its own change or a
`docs/deferred.md` entry. Why: small diffs get real review, and unasked-for code is where bugs hide.

Beyond the asks other rules already require, ask the user when a wrong guess is expensive to
undo: an API or schema shape, or a user-visible behavior the request or plan doesn't settle. A
filename, a helper's name, a test's layout: choose, and say what you chose. A worker dispatched by
another session takes the question to that session instead. Why: a question costs the user a turn;
a wrong guess at a one-way door costs a rewrite.

### Claims need evidence

For what you report as done (a reply, a PR body, a plan's State), not every sentence.

- **A check passed only when its own exit code says so.** A pipeline exits with its last command's
  status, so `build | tail` reads green on a red build. Capture instead:
  `cmd > "$log" 2>&1; echo "exit=$?"; tail -50 "$log"`, or `set -o pipefail` first. Where a tool's
  exit code doesn't track its outcome, make it: `gh run watch --exit-status`, `--max-warnings 0`.
- **Measured or inferred.** Measured: you ran it, got the response, or read a CI check's own
  conclusion for the exact head SHA. Inferred: a log line, a dashboard summary, an earlier note,
  another agent's report. Reading a config measures the file, not what it does at runtime. Mark
  inferred state *inferred* and name its source; a worker's "it passes" stays inferred until you
  rerun it or read the diff.
- **Diagnose before you fix.** Name the root cause in a sentence with its evidence (a log, a
  payload, a row, a failing test). If you can't confirm it, say so, name what would, and make the
  change that adds that evidence. A compiler or lint error is its own diagnosis.

### Response shape

For a substantive answer (a design, a fix, a recommendation, a plan, a root cause), end with the
sections below that have something in them, a few bullets each, in this order. Leave an empty one
out. A one-line answer stays one line. Why: the reader sees the conclusion, not the picture behind
it, and these are where that picture is most often wrong.

- **Assumptions** — what you took for granted that, if wrong, changes the answer.
- **Failure modes** — where it breaks: the input, the scale, the edge case.
- **How to verify** — one quick check the reader can run to confirm it rather than trust you.
- **Not checked** — what you skipped or couldn't reach (no access, a test you didn't run).
- **One-way doors** — any step that can't be undone, and what it would take with it.
- **Alternatives** — the option you rejected, and why, in a line.
- **What would change my mind** — the one fact that would flip the recommendation.
- **Needs you** — a decision only the user can make. Lead with it instead when the work waits on it.

### Deleting data is a human action

An agent never deletes user data, and never deletes the thing that could bring it back. Write the
migration, the script, the query, the runbook — then **stop and hand the exact command to the user**,
the same way a PR stays draft until they click Ready. This is not about trust; it is that the blast
radius of a delete is invisible from the diff that contains it, and no test run afterwards can undo it.

**Agents do not run, and do not ask CI to run:**

- `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` on anything holding user rows, or a `DELETE` / clearing
  `UPDATE` against any database that is not loopback or a throwaway (staging, prod, demo, any
  branch of either). Writing the migration file is the agent's job; applying it to a real
  environment is not.
- Deleting or resetting a database, database branch, or project — including one taken as a recovery point.
- Deleting backups, snapshots, restore points, or object-storage buckets holding user data.
- Disabling, deleting, or scheduling deletion of an encryption key. Crypto-shredding is deletion with
  a different verb: the rows survive and become unreadable, which is worse than a `DELETE` because
  nothing reports it.
- Running an operator script that clears a column against a non-loopback database. A backfill that
  nulls the source column is a delete wearing a backfill's name — give it a `--yes`.

**Agents do:** write it, test it against localhost / the e2e database / an ephemeral branch, put the
exact command and its preconditions in the plan or the PR, say what is irreversible about it, and say
what has to be true first. A destructive step in a plan gets a **Human check** id like any other
(`plans.mdc`), and the phase is not done until the user ticks it.

**If a delete is the only way forward and the user is not around:** stop and say so. A half-finished
task is recoverable; this is not.

### Guard rails that run by themselves

Hooks enforce the worst of these rules for Claude Code (`.claude/settings.json`) and Cursor
(`.cursor/hooks.json`):

- `scripts/command-guard.mjs` refuses, or asks the user about, commands only a human may run: Ready
  clicks, merges, pushing `main`, force-pushing or deleting `main`/`dev`, `--no-verify`, full CI
  reruns, manual workflow runs, `[skip ci]` off `dev`, and deleting data.
- `scripts/check-edited.mjs`, where the hook config wires it, typechecks, lints, and
  boundary-checks each file an agent edits and hands back only the failures. Where it isn't
  wired, run the typecheck and lint yourself before pushing.

A refused command is an answer, not an obstacle. Never route around it (another tool, a script, a
different spelling). Tell the user what you need and why.

### Repo memory

- **Deferred work** lives in `docs/deferred.md` — decisions we knowingly left undone, each with why, where, and what changes if we take it. When you leave something undone on purpose, add an entry there; a "come back to that" in a PR thread is gone the moment it merges. Delete an entry when it is done rather than marking it closed, so the file stays the open set.
- **Decisions taken** live in `docs/decisions/` (one short numbered file each: context, decision, consequences). Deferred work is what we chose not to do yet; decisions are what we chose. Write one when a choice constrains future work or reverses an earlier one, so a later session doesn't undo it unknowingly.
- **Learnings** live in `docs/learnings/`: a mistake that would happen again, and the check that catches it. After a PR merges, run `compound` (`compound.mdc`), which prefers a real check over a written warning.

### Do not

- Commit secrets (`.env`); use `.env.example` patterns
- Delete user data, or anything that could restore it, on the user's behalf — see "Deleting data is a human action" above

## Architecture

<!-- Project-specific architecture bullets go first: where domain logic lives, where I/O lives,
     how the API layer reaches it, the date/time convention, auth principal shape. Keep each
     bullet dense and end it with the doc that holds the "why". The bullets below are the
     standing philosophy every project starts with. -->

- **Layering.** Pure domain logic lives in the domain layer — free of framework, I/O, and feature imports (each pack's path is in `docs/ports-and-adapters.md`). Feature modules own UI + validation schemas. Server I/O lives in services behind ports; the API layer validates input, then calls a use-case port, never a service or the ORM directly. Enforced by each language pack's boundary check, not memory (`docs/decisions/0003-ports-and-adapters.md`); the map, and the fix for each rule, is `docs/ports-and-adapters.md`. Why: ports and a composition root keep native clients and a second datastore possible without a rewrite.
<!-- [stack:typescript] -->
  TypeScript pack: the check is `.dependency-cruiser.cjs` (`pnpm boundaries`; `docs/decisions/0001-ports-and-adapters-enforced-by-dependency-cruiser.md`).
<!-- [/stack:typescript] -->
<!-- [stack:rust] -->
  Rust pack: the layers are crates (`domain` → `app` → `adapters`, so cargo refuses an inward dependency), and `pnpm rust:boundaries` checks `[workspace.metadata.layers]` in `Cargo.toml`.
<!-- [/stack:rust] -->
<!-- [stack:python] -->
  Python pack: one import-linter `layers` contract in `pyproject.toml` (`pnpm py:boundaries`; rules in `python.mdc`).
<!-- [/stack:python] -->
<!-- [stack:go] -->
  Go pack: the check is the `depguard` rules in `.golangci.yml` (`pnpm go:lint`), proved by planted violations in `pnpm go:gates`.
<!-- [/stack:go] -->
<!-- [stack:swift] -->
  Swift pack: layers are SwiftPM targets; the check is `swift-layers.json` read by `pnpm swift:boundaries`, proved by planted violations in `pnpm swift:gates`.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
  Kotlin pack: the layers are Gradle modules, checked by `LAYERS` in `build.gradle.kts` on every build (`pnpm kotlin:check`), proved by planted violations in `pnpm kotlin:gates`.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
  C++ pack: the layers are CMake targets (`domain` ← `usecases` ← `adapters`), so linking is the gate; `cpp-layers.json` is checked against the configured build (File API), the compiler's include record, and each layer's undefined symbols (`pnpm cpp:build`), proved by planted violations in `pnpm cpp:gates`.
<!-- [/stack:cpp] -->
- **Storage behind ports.** Repositories take the tenant (`userId`) first and take no raw `where`; tenant scoping is structural, not remembered. ORM ↔ domain mapping lives in the adapter, so a use-case never sees a row. A write and whatever it implies go in one unit of work.
- **Writes are patches, not replacements.** A write names what it speaks for and leaves the rest alone, so a client cannot delete what it never rendered. Retries must be no-ops.
- **Product rename:** customer-facing copy only, from one product-config file in the config layer (display name, description, tagline). None ships with the template: create it with the first customer-facing copy and name it here. Leave slugs, package names, Docker, and infra. Do **not** rename files or folders.
- **Knobs:** we love named constants for anything the product retunes (timing, limits, scoring, visual tokens, page catalogs). Prefer the config layer (each pack's path is in `docs/ports-and-adapters.md`); a named constant next to the domain is fine. UI + server that share a bound import the same export. Keep a knob even if one caller inlines the rule. CI/infra knobs live in `scripts/lib/`, not the config layer — they are not product and must not ship in the build.
- **UI primitives** (once there is a UI) live in one shared folder; name it here. Compose, don't add a UI library.
- **Client state:** only minimal UI state in the client store. Server data is fetched, not mirrored.

### Do not

- Add UI libraries, heavyweight client frameworks, or animation libraries without asking
- Put domain logic only in UI components
- Rename files or folders, Docker volumes, or other non-customer-facing identifiers as part of a product name change
<!-- Add project do-nots here. -->

## Branching & shipping

- Agents work in a **git worktree based off `dev`**, not in the primary clone and not off
  `main`, unless the user says otherwise. "Add this to the open PR" means stay on that
  PR's branch (in its worktree). The primary clone stays on `dev` so ship commands have
  a clean tree.
  `git fetch origin dev && git worktree add -b <branch> <path> origin/dev`
  Put the worktree next to the clone (`../<repo>-<slug>`) or under the tool's worktree
  dir. Do not `git checkout` a feature branch in the primary clone.
- Work happens on a **feature branch**, then a PR into `dev`. Do not commit directly on `dev`
  (a ruleset rejects it). The one exception is the docs-only rule below.
- **Docs-only changes skip the PR and skip CI.** Commit them on `dev` in the primary clone and
  push, with `[skip ci]` in the commit message. Docs-only means prose and nothing else:
  `docs/**`, root `*.md` (README, AGENTS, CHANGELOG), `.cursor/rules/**`, `.claude/rules/**`
  (generated; run `pnpm rules:sync` first), `.claude/skills/**`, `harness.json`,
  `harness.project.json`. A project adds its own prose paths in `branching.project.mdc`.
  Anything under `src/`, `scripts/`, `.github/`, or config is **not** docs-only. A mixed diff
  is a PR — one code file makes the whole change a PR, prose included.
  Why: a prose PR buys a review round trip plus CI minutes to gate a change that cannot break
  the build.

  `[skip ci]` is safe **only** on this path. Never put it on a branch with a PR open: a
  workflow that never ran reports nothing, the required checks stay pending, and the PR is
  stuck forever.
- Open every PR **as a draft** (`gh pr create --draft`). The user marks it ready when the change is
  done enough for the expensive CI signal (heavy jobs skip while draft). The draft exists so
  more can land on it before that signal; do not pile unrelated concerns onto it just because
  it is still draft. Never convert a ready PR back to draft: someone marked it ready on
  purpose, and flipping it skips the expensive CI jobs that merging depends on.
- **PR descriptions are short.** Fill the PR template's sections only, in bullets, no prose
  paragraphs. Aim for ~3 bullets each in What/why and Verification (commands run + result). More is
  fine when each extra bullet carries something the reviewer needs — a migration, a
  behavior change, a risk; padding is not a reason. No
  file-by-file change lists, no restating the diff, no test-plan checklists, no attribution
  footer. A ship PR's production block is the one exception.
- Merge feature work into **`dev`** first.
- **Only `dev` may merge into `main`.** Never merge a feature branch (or other branch) directly into `main`.
- When the user says **ship it** (or equivalent): land ready work on `dev` if needed, then merge **`dev` → `main`** and push unless they say otherwise. After shipping, **checkout `dev`** so day-to-day work stays off `main`. Steps: `ship.mdc` (the `ship` skill).
- After a successful ship, say so out loud — brief, hyped, human. Encouraged vibes: "this shit is goin live", "we're live", "shipped". Don't be stiff about it.

### CI minutes are a resource: every run must be intentional

Every action that starts CI must have a purpose you can name: a new commit that needs
checking, a failure that needs a real retry, or a merge the user asked for. Anything else is
waste. macOS runners bill ~10× Linux.

- **Never re-run the same checks on the same commit.** If a head SHA already has a green run,
  nothing that only re-triggers CI on that SHA is allowed. That includes draft ↔ ready toggles,
  close/reopen, changing the base, empty commits, and full-workflow reruns.
- **Don't touch a PR's draft/ready state.** The one exception: the wrangler marks a PR ready when
  the user says they have read that PR and asks for it (`wrangler.mdc`). Each flip back to ready re-runs
  the full suite on the same code.
- **Rerun only the failed jobs** (`gh run rerun <id> --failed`), and only after reading the
  failure and finding a flake or infra cause. Never rerun the whole workflow. Never rerun a run
  that a newer push has already replaced.
- **Push once per working chunk, not once per commit.** Run typecheck / lint / test locally
  first, because local runs are free. Don't merge `dev` into a branch just to keep it current.
  Do it only when there's a conflict, or when the branch needs something that has landed since.
- **Bundle: one draft per plan phase or theme.** Before opening a PR, look for an open draft
  on the same phase or theme and push to it; open a new PR only for a new concern. Why: every PR
  pays a Checks run per push, a ready run, and a run when it merges, and a draft is barely cheaper
  than a ready PR (only Build and the macOS job wait for ready).
- **No `workflow_dispatch` "just to check"**, and no touching the CI workflow or its path
  classifier outside a CI-focused change. Either one runs everything.
- **Before starting CI, say what will run and why.** If you can't name the purpose, don't do it.
  Ask the user instead.

What enforces this (pre-push hook, agent hooks, rulesets, required check names): `branch-protection.mdc`,
which loads when you touch `.github/`, `.githooks/`, or the hook config.

<!-- END always-on rules -->
