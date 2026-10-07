# Getting started

From "Use this template" to your first merged PR. About an hour, most of it installing toolchains.

Rather be asked? Open Claude Code in the new repo and say **setup**: the `setup` skill asks these questions, writes the config, and runs or prints each step below.

Commands in `bash` blocks here are checked by `pnpm docs:run` (see [Docs that run](#docs-that-run)).

## Prerequisites

Always:

- **git** 2.31 or newer (the hook installer uses `git rev-parse --path-format`).
- **Node 24 or newer.** `.nvmrc` says `24`; `package.json` → `engines` says `>=24`. Use `nvm use` or `fnm use`. Older Node still installs but pnpm warns (`Unsupported engine`), and CI runs 24, so don't trust a green run on 22.
- **pnpm 10.33.0**, pinned by `package.json` → `packageManager`. `corepack enable` picks the pinned version. Node 25 and newer no longer bundle corepack: if `corepack` is missing, install pnpm yourself with `npm i -g pnpm@10.33.0`.
- **gh** (GitHub CLI), logged in (`gh auth login`) as someone with **admin** on the new repo. Only `bootstrap-repo.sh` needs it, and only once.
- **A GitHub plan with rulesets** (public repo or paid plan). Without them, bootstrap says so and the pre-push hook plus a red check are your only stops.

```bash
node --version
pnpm --version
git --version
gh --version
```

<!-- doc-run: skip changes your global Node setup -->
```bash
corepack enable
```

Per stack (install only the ones you keep; [choose below](#2-choose-your-stacks)). A missing tool is never a silent pass.
A pack whose tool is missing either fails right away, naming what to install, or prints `SKIPPED ... This is not a pass` locally and fails under `CI=true` (so in GitHub Actions). The bullet for each pack says which.

<!-- [stack:typescript] -->
- **TypeScript / React:** nothing beyond Node and pnpm. `pnpm install` brings the compiler, oxlint, Vitest, knip, and dependency-cruiser.
<!-- [/stack:typescript] -->
<!-- [stack:rust] -->
- **Rust:** `rustup`. `rust-toolchain.toml` pins the `stable` channel with `clippy` and `rustfmt`, so the first `cargo` command installs them. Also `cargo-nextest` (the test runner) and `cargo-deny` (the dependency audit); for example `cargo install --locked cargo-nextest cargo-deny`.
<!-- [/stack:rust] -->
<!-- [stack:python] -->
- **Python:** `python3` 3.11 or newer on PATH, and [`uv`](https://docs.astral.sh/uv/). Then `uv sync` once to make `.venv`.
<!-- [/stack:python] -->
<!-- [stack:go] -->
- **Go:** Go 1.25 or newer (`go.mod`'s `go` line is the floor; an older Go downloads the right toolchain itself). `golangci-lint` v2 on PATH; CI pins v2.5.0, so match it. `gopls` only if you use Claude Code's `gopls-lsp` plugin.
<!-- [/stack:go] -->
<!-- [stack:swift] -->
- **Swift:** Swift 6.2 (`swift --version`). On a Mac that is Xcode 26. The `swift format` formatter ships in the toolchain. CI runs `swift test` on a macOS runner, which bills about ten times a Linux minute. Without the toolchain, the check prints `SKIPPED` locally and fails under `CI=true`.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
- **Kotlin:** a JDK 21 (`java` on PATH or `JAVA_HOME`), and an Android SDK for the app module: `bash stacks/kotlin/android-sdk.sh` installs one in `~/Android/Sdk`, then point `ANDROID_HOME` at it (no Android app? delete `app/`, its `include`, its `LAYERS` row, and the Android steps and job in `ci.yml`: `kotlin.mdc` lists them). Never a system Gradle: `./gradlew` downloads the pinned one on first use. An emulator or device only for `pnpm kotlin:device`.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
- **C++:** clang 18 or newer with `clang-tidy` and `clang-format`, cmake 3.28 or newer, and ninja; g++ 13 for the second-compiler tree CI adds. On Linux, `bash stacks/cpp/install-tools.sh` adds the sanitizer runtimes (apt's `libclang-rt-18-dev`) and lowers `vm.mmap_rnd_bits` for ThreadSanitizer (both need sudo). The first build downloads GoogleTest, pinned by sha256. A missing tool prints `SKIPPED` locally and fails under `CI=true`.
<!-- [/stack:cpp] -->
<!-- [stack:infra] -->
- **Infra (Terraform, Docker):** `bash stacks/infra/install-tools.sh` installs pinned, checksum-verified `terraform`, `tflint`, and `hadolint` into `~/.local/bin` (set `INFRA_TOOLS_DIR` to change it). Put that directory on PATH. Docker itself is only needed to build images. A missing tool prints `SKIPPED` locally and fails under `CI=true`.
<!-- [/stack:infra] -->
<!-- [stack:sql-migrations] -->
- **SQL migrations (Postgres, any language):** nothing beyond Node and pnpm. `squawk-cli` is a pinned devDependency (`package.json`), so `pnpm install` brings the linter and `pnpm exec squawk --version` checks it. The optional kill-partway test needs Postgres server binaries (`initdb`, `postgres`) and skips loudly without them; under `CI=true` it fails instead.
<!-- [/stack:sql-migrations] -->
<!-- [stack:infra] -->

<!-- doc-run: skip downloads binaries into your home directory -->
```bash
bash stacks/infra/install-tools.sh
```
<!-- [/stack:infra] -->
<!-- [stack:cpp] -->

<!-- doc-run: skip installs packages with sudo and changes a kernel setting (Linux) -->
```bash
bash stacks/cpp/install-tools.sh
```
<!-- [/stack:cpp] -->

Check what you have. A tool you do not need may say "absent"; that is fine.

<!-- [stack:rust] -->
```bash
rustc --version
cargo nextest --version
cargo deny --version
```
<!-- [/stack:rust] -->
<!-- [stack:python] -->
```bash
uv --version
python3 --version
```
<!-- [/stack:python] -->
<!-- [stack:go] -->
```bash
go version
golangci-lint --version
```
<!-- [/stack:go] -->
<!-- [stack:swift] -->
```bash
swift --version
```
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
```bash
java -version
```
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
```bash
clang++ --version
clang-tidy --version
clang-format --version
cmake --version
ninja --version
```
<!-- [/stack:cpp] -->
<!-- [stack:infra] -->
```bash
terraform version
tflint --version
hadolint --version
```
<!-- [/stack:infra] -->

## 1. Create the repo

1. On the template's GitHub page, click **Use this template** → **Create a new repository**. Private is fine. It copies the template's `dev` branch only; bootstrap creates `main` later.
2. Clone your new repo and `cd` into it.
3. Install dependencies, and the pre-push hook (so your first push already runs `pnpm check`):

```bash
pnpm install
```

```bash
pnpm hooks:install
```

<!-- [stack:sql-migrations] -->
SQL migrations pack: `pnpm install` brought the linter; check it.

<!-- doc-run: skip runs after pnpm install; the docs:run copy has no node_modules -->
```bash
pnpm exec squawk --version
```
<!-- [/stack:sql-migrations] -->

## 2. Choose your stacks

A stack pack is a directory `stacks/<name>/` with a `pack.json` listing every file it owns. Installed means the directory exists.

```bash
pnpm stack:list
```

Packs that ship: `typescript`, `react` (needs `typescript`), `rust`, `python`, `go`, `swift`, `kotlin`, `infra` (add-on, any language), `sql-migrations` (add-on, Postgres, any language).
<!-- [stack:cpp] -->
Also `cpp` (C++20 on CMake, with sanitizer test trees).
<!-- [/stack:cpp] -->
Do this **before bootstrap**: bootstrap makes every pack still present a required check on both PR rulesets, so a pack removed afterwards leaves a check nothing reports (Swift's `Swift tests`, say), and the removal PR itself waits on it. Keeping everything? Skip to [bootstrap](#3-bootstrap-github).

Removing a pack changes code and CI (`package.json`, `ci.yml`, the lockfile), so it is not docs-only: do it in a worktree off `dev` (the same flow as "Your first PR", below), one command per pack, then open a draft PR. Your primary clone stays on `dev`.

<!-- doc-run: skip needs a remote, and rewrites the working tree (covered by scripts/stack.test.mjs) -->
```bash
git fetch origin dev
git worktree add -b chore/choose-stacks ../my-project-stacks origin/dev
cd ../my-project-stacks
pnpm install
pnpm stack:remove react
pnpm stack:remove swift
```

- It removes the pack's rules, configs, scripts, dependencies, CI steps, and its fenced text in shared docs, and records the choice in `harness.project.json` so `harness:pull` never brings it back.
- Removing `typescript` also removes `react`. Node stays either way: the harness's hooks and scripts run on it.
- **Removing a pack after bootstrap:** if it added a required check (`node scripts/stack.mjs required-checks` lists them, so run it before you remove), `stack:remove` prints the ruleset edit. Drop it in both PR rulesets (GitHub → Settings → Rules), or every PR blocks on a check nothing reports.
- **Adopting a pack later** is not automatic yet (`stack:add` is in `docs/deferred.md`), and a new pack's `requiredChecks` must be added to both PR rulesets by hand: bootstrap only creates rulesets that do not exist.
- Some packs print leftovers (a virtualenv, caches) they cannot safely delete. Delete those yourself.

Then run everything once:

```bash
pnpm check
```

`pnpm check` runs the core checks (rules in sync, plan tables, harness tests), then each present pack's, then generated-file drift. It is what the pre-push hook and CI run. Local runs are free; CI minutes are not.

Still in that worktree, commit, push once, and open a **draft** PR into `dev`, as `stack:remove` itself says. Do not commit this on `dev`: once bootstrap has run a ruleset rejects direct pushes, and `[skip ci]` is for docs-only changes. A change that touches `package.json` or other code is a PR.

<!-- doc-run: skip needs a remote -->
```bash
git add -A
git commit -m "chore: choose stacks"
git push -u origin chore/choose-stacks
gh pr create --draft --base dev
```

Nothing is protected yet, so when `Checks` is green, mark it Ready and merge it yourself. Then leave the worktree: `cd` back to your primary clone, still on `dev`, and run bootstrap there. The rest of this guide's `dev` commits happen there.

## 3. Bootstrap GitHub

<!-- doc-run: skip needs a GitHub login and a repo you own -->
```bash
bash scripts/bootstrap-repo.sh
```

Run it in your primary clone after your stack choice is merged. What it does (safe to re-run; each step checks first):

- makes sure `dev` and `main` both exist (creates `main` from `dev`), makes `dev` the default branch, turns on delete-branch-on-merge
- checks out `dev`, fast-forwards it to GitHub's, and installs the git hooks (the pre-push guard)
- creates three rulesets: `main: production` (PR plus all checks, no bypass), `dev: no force-push or deletion`, `dev: PR and checks` (admin can bypass for docs-only pushes)
- records the whippletree commit you started from in `harness.project.json` → `base` (it looks the commit up in upstream's history, using your `gh` login). It prints the commit command: docs-only, so straight on `dev` with `[skip ci]`. If it could not read upstream, it says so and leaves `base` empty; re-run it when you can.

**Required checks** are `Checks` and `Build`, plus each present pack's `requiredChecks`. `main` also requires `Only dev merges to main`.
<!-- [stack:swift] -->
Today only the Swift pack adds one: `Swift tests`.
<!-- [/stack:swift] -->
This prints just the pack-added names, comma-separated (nothing when no present pack adds one):

```bash
node scripts/stack.mjs required-checks
```

A project whose CI job names differ passes its own: `REQUIRED_CHECKS="Checks,Build" bash scripts/bootstrap-repo.sh`.

### By hand (no `gh`, or no admin token)

The same setup in GitHub's web UI. It matches what `bootstrap-repo.sh` creates, so you can run the script later and it will find each piece already there. Rulesets need a public repo or a paid plan; without them, the pre-push hook and a red check are your only stops.

1. **Default branch.** Make sure both `dev` and `main` exist (branch picker → type the missing name → Create branch). Then **Settings → General → Default branch** → switch to `dev`. On the same page, tick **Automatically delete head branches**.
2. **Ruleset `main: production`.** **Settings → Rules → Rulesets → New ruleset → New branch ruleset.**
   - Name `main: production`, Enforcement status **Active**, bypass list **empty** (not even you: production only changes through a `dev` → `main` PR).
   - Targets: **Add target → Include by pattern** → `main`.
   - Tick **Restrict deletions** and **Block force pushes**.
   - Tick **Require a pull request before merging**, required approvals **0** (you work solo; 1 would block your own PRs).
   - Tick **Require status checks to pass** and add the required checks (below) plus `Only dev merges to main`.
   - **Create**.
3. **Ruleset `dev: no force-push or deletion`.** New branch ruleset, Active, bypass list empty, target `dev`. Tick **Restrict deletions** and **Block force pushes**. **Create**.
4. **Ruleset `dev: PR and checks`.** New branch ruleset, Active, target `dev`.
   - Bypass list: **Add bypass → Repository admin**, mode **Always**. That is what lets a docs-only commit go straight to `dev` ([concepts](concepts.md)); "for pull requests only" would block it.
   - Tick **Require a pull request before merging** (approvals **0**) and **Require status checks to pass** with the required checks below.
   - **Create**.

**Which checks to require:** `Checks` and `Build`, plus each kept pack's (`node scripts/stack.mjs required-checks` prints them; today only Swift adds `Swift tests`). Don't add `Swift tests (macOS)` (the `Swift tests` aggregator already covers it) or `Change scope` (`ci.yml` keeps it out of the gate). `Harness drift` never runs on PRs, so requiring it would block every PR. The status-check picker only lists names that have run once, so open a draft PR first if the list is empty.

## 4. Fill the placeholders

Find them (nothing checks for them, so `pnpm check` stays green while they are there):

```bash
grep -rnIE '[{][{][A-Z_]+[}][}]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=guide .
```

- `{{PROJECT_NAME}}` — `AGENTS.md` title, `CHANGELOG.md`, `CHANGELOG-TECHNICAL.md`
- `{{ONE_LINE_PITCH}}` — `AGENTS.md`, line 3
- `{{STACK}}` — `AGENTS.md` → Stack, e.g. `Rust · SQLite · Tokio`
- `{{REPO_SLUG}}` — `package.json` → `name`

Also replace this template's `README.md` with your own; its job (explaining the template) is done.

## 5. Git hooks on other clones

You installed the pre-push hook in step 1, and bootstrap installs it again for the clone it ran in. **`pnpm install` does not install hooks**, and
nothing sets `core.hooksPath`: the installer copies `.githooks/pre-push` into the repo's hooks directory
(shared by all worktrees of that clone). So on every other clone or machine, run once:

```bash
pnpm hooks:install
```

Re-run it after `.githooks/` changes, because copies do not follow the source. What the hook does: refuses a
`main` push whose tree did not come from `dev`, and runs `npm run check` once per push that touches more than docs.

## Models

Claude Code is the one AI tool you need. ChatGPT (the rival reviewer) and Grok (the wildcard) are optional. [Models](models.md) walks through installing and signing in to each, which model runs each plan tier, and how to find model ids. Then check your table:

```bash
pnpm models
```

## Overrides

Change how the agents work in [`agent-overrides.json`](overrides.md) (the team's, committed) and `agent-overrides.local.json` (yours, gitignored), never in a harness rule or script: the next `harness:pull` would erase that edit. Models and when the dynamite test runs live there. Everyone should make their own file, even an empty one, so a personal pick (a model you lack, a smaller ChatGPT budget) has a home that isn't the team's file:

<!-- doc-run: skip writes a file in your checkout -->
```bash
pnpm overrides init
```

```bash
pnpm overrides
```

## Your first plan

A plan is how you ask for more than one change. Copy the template and fill its phase table:

- `docs/plans/_template.md` → `docs/plans/<slug>.md`
- Each phase row has `What`, `After` (its prerequisites), and `Model` (a tier plus a thinking level, e.g. `workhorse (medium)`).
- Each phase section is the whole prompt for a worker: Goal, Applies, Files, Tests, and **Done when** with a `→ verify:` command for each line.
- Anything only a human can do gets a **Human check** id.

Check the table and every verify line:

```bash
pnpm plans:check
```

A new plan is docs-only: commit it on `dev` in the primary clone with `[skip ci]` in the message. Then start an agent session and say:

> read `docs/plans/<slug>.md` and showrun it (`showrunner.mdc`).

See [roles](roles.md) for every start prompt.

## Your first PR

By hand, or by asking an agent to do it. The flow is the same:

1. Start from a worktree off `dev`, not a checkout in your primary clone:

<!-- doc-run: skip needs a remote -->
```bash
git fetch origin dev
git worktree add -b feat/my-first-change ../my-project-first origin/dev
```

2. Make one change. In a worktree you need `pnpm install` once.
3. `pnpm check` until it is green.
4. Commit, then push once:

<!-- doc-run: skip needs a remote -->
```bash
git push -u origin feat/my-first-change
```

5. Open a **draft** PR into `dev`. The template has three sections: **What and why**, **Verification** (what you ran), **Tested by** (each behavior and the test, runbook scenario, or Human check that covers it; `none: no behavior change` for docs).

<!-- doc-run: skip needs a remote -->
```bash
gh pr create --draft --base dev
```

6. Cheap CI (`Checks`) runs on the draft. When you want the expensive signal, **you** mark it Ready. Merge when green. The branch deletes itself.
7. Shipping to production is later: say "ship it" and see [roles](roles.md#ship).

## Docs that run

Every fenced `bash` block in this guide is either run or marked. `pnpm docs:commands` checks that each block is marked or on a safe list. `pnpm docs:run` runs the safe ones in a fresh `git archive` copy of `HEAD`. A block above which you see `doc-run: skip <reason>` is not run (needs the network, a login, a remote, or rewrites the tree).
