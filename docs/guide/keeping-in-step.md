# Keeping in step

Your project started as a copy of whippletree. The copy drifts: the template improves, and you improve the rules in your project. Three commands move changes both ways.

## Harness files

Harness files are listed in `harness.json` (`docs` sync straight to `dev`; `code` needs a PR) and are meant to be identical in every project. The `upstream` field in `harness.json` says where the template lives.

<!-- doc-run: skip needs the network and a clone of upstream -->
```bash
pnpm harness:status   # what differs from upstream's dev, and which way it should flow
pnpm harness:pull     # take upstream's changes (three-way merge where both sides edited)
pnpm harness:push     # open a draft PR on upstream's dev with your project's own harness edits
```

- **`status`** lists each differing file with an arrow: upstream changed (pull it), edited here (push it), both changed (merge), or no base yet. Exits 1 when anything differs.
- **`pull`** writes upstream's changes, moves `base`, and re-syncs the generated rule copies. Where both sides edited a file it merges three ways and leaves conflict markers for you to resolve. Docs-only pulls are a commit on `dev` with `[skip ci]`; a pull that touches `code` paths goes on a feature branch with a draft PR.
- **`push`** needs permission to push a branch to upstream. If you do not have it, keep your improvement as a `.project.mdc` companion, or point `upstream` at your own fork.
- **`ref`** in `harness.json` is `dev`: "Use this template" copies upstream's default branch, `dev`, so that is the branch your copy matches. Upstream's `dev` only moves through PRs with green checks; `main` is upstream's own ship target. `--ref <branch>` compares with another branch once.
- **`base`** in `harness.project.json` is the upstream commit you last took. It is how the script tells "upstream moved" from "we edited it here". Bootstrap finds it (the upstream commit whose tree your first commit copied) and tells you to commit it; if it could not read upstream, it says so, and re-running bootstrap later fills it in.
- **`skip`** in `harness.project.json` lists harness files you opt out of, each with a reason (for example a per-edit check that is too slow for your project).
- **`HARNESS_TOKEN`** (a fine-grained token with `contents: read` on upstream) lets the weekly CI run read a private upstream.

### The weekly drift run

`.github/workflows/harness-drift.yml` runs `status` every Monday. Red means something differs. It is a reminder, not a merge gate.
If upstream is private and you did not set `HARNESS_TOKEN`, it says so in a notice and passes. See [troubleshooting](troubleshooting.md#the-drift-run-is-red).

When a rule improves in your project and is not specific to it, `pnpm harness:push` it the same day, while the reason is fresh.

## Project overrides: `.project.mdc`

Never write project facts into a harness rule; the next pull erases them. Put them in a companion beside it:

- `.cursor/rules/<rule>.project.mdc` — same frontmatter as the harness rule (same `globs`, same `agentsMd` number), so it loads at the same moment. It wins where the two differ.
- `agent-overrides.json` — which model runs each tier (`models`) and when the dynamite test runs (`dynamiteTest`); each person's gitignored `agent-overrides.local.json` wins over it ([overrides](overrides.md), `pnpm overrides`). It replaces `model-tiers.project.json` and `dynamite-test.project.json`, which are still read beneath it.
- `command-guard.project.json` — your own deny, ask, and exact-command exemptions for the guard.
- `harness.project.json` → `skip` — files you will not sync at all.

Not in `harness.json`, so merged by hand: `.claude/settings.json` (its hooks block is harness, its permissions are yours), `ci.yml`, and `scripts/lib/ci-change-scope.mjs` (their knobs are per project). Also your layer-path configs, which the packs seed and you edit (keep your own layer paths when you merge):
<!-- [stack:typescript] -->
- TypeScript: `.dependency-cruiser.cjs`.
<!-- [/stack:typescript] -->
<!-- [stack:go] -->
- Go: `.golangci.yml`.
<!-- [/stack:go] -->
<!-- [stack:swift] -->
- Swift: `swift-layers.json`.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->
- Kotlin: `build.gradle.kts` → `LAYERS`, and `config/detekt/detekt.yml`.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->
- C++: `CMakeLists.txt` (your targets), `cpp-layers.json` (your layer rows, `tidyOff`), and `.clang-tidy`.
<!-- [/stack:cpp] -->
<!-- [stack:sql-migrations] -->
- SQL migrations: `.squawk.toml` (skipped rules, `assume_in_transaction`, applied history in `excluded_paths`).
<!-- [/stack:sql-migrations] -->

After any rule change run `pnpm rules:sync`; `pnpm rules:check` fails when the generated copies drift.

## Shipping without whippletree

Develop with the harness, ship without it, for example as an open-source release. `pnpm harness:eject` removes the agent rules and skills, the hooks (command-guard, check-edited, pre-push), harness sync and drift, plans, human checks, and this guide. It keeps the product and the stack packs' gates, so `pnpm check` and CI still run lint, boundaries, and tests for outside contributors. Why that split: `docs/decisions/0006-harness-eject.md`.

<!-- doc-run: skip it deletes the harness from the working tree -->
```bash
pnpm harness:eject           # dry run: what it would delete and edit, and the leftovers it would report
git switch -c publish        # never on dev or main; it refuses those, and a dirty tree
pnpm harness:eject --apply   # delete and edit; exits 1 while leftovers remain
pnpm install && pnpm check
```

- **Leftovers** are lines that still name whippletree or hold an unfilled `{{…}}` (README, the changelogs, a seeded decision), and any package.json script that runs a removed file. Fix them by hand on the publish branch.
- **History still holds every harness file.** Publish the ejected tree with fresh history (`git checkout --orphan`), or push it to a mirror repo that only ever receives ejected trees. Keep developing on `dev` with the harness.
- **Rulesets on the public repo** are yours to set: the harness's (`Checks`, `Build`, and each pack's required checks) still match the kept CI job names.
- **A LICENSE** is the project's to add; the kept gate scripts ship in your repo under it.

## Stacks

A stack pack's harness files sync like any others, from its own `stacks/<name>/pack.json`, but only for packs installed in your project (`stacks/<name>/` exists).

- **A pack upstream ships that you do not have** is announced ("upstream ships pack X, not installed"), never pulled. New packs are opt-in.
- **A removed pack stays removed.** `pnpm stack:remove` records it in `harness.project.json` → `removedStacks`, so `pull` never brings it back.
- **Adopting a pack later:** `pnpm stack:add` is not built yet (`docs/deferred.md`). You can copy the pack's directory and files by hand from the template, then add its `requiredChecks` (if any) to both PR rulesets. Bootstrap only creates rulesets that do not exist, so it will not do that for you.

```bash
pnpm stack:list
```

```bash
node scripts/stack.mjs required-checks
```

The second command prints the CI check names your present packs require, to compare with Settings → Rules.
