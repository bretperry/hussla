# Concepts

The ideas behind the rules. Read this once; [repo-map](repo-map.md) is the lookup table.

## Harness vs project files

Every file is one of four kinds:

- **Harness** — listed in `harness.json`. The same bytes in every project, refreshed by `pnpm harness:pull`. Rules, skills, the guards, the sync script, CI helpers. Never put project facts in one; the next pull erases them.
- **Project** — yours. `AGENTS.md` (mostly), `architecture.mdc`, `docs/` content, `src/`, `harness.project.json`, optional `command-guard.project.json` and `agent-overrides.json` (the team's [overrides](overrides.md)). Each person's `agent-overrides.local.json` is gitignored and wins over it.
- **Pack** — a stack's files, in `stacks/<name>/pack.json`. Some are harness-synced (`code`, `docs`), some are yours once seeded (`owns`: configs and the example code).
- **Generated** — written by a script, never edited by hand (below).

Your additions to a harness rule go in a companion, `<rule>.project.mdc`, beside it. Same frontmatter, loads with it, wins where they differ. Details: [keeping-in-step](keeping-in-step.md).

## Generated files

- `.claude/rules/*.md` — Claude Code cannot read `.mdc`, so each scoped rule is copied here (`globs` become `paths`).
- The always-on block at the end of `AGENTS.md` — copies of `core`, `architecture`, and `branching`, so every agent reads the same text.

Edit the `.mdc`, then `pnpm rules:sync`. `pnpm rules:check` (inside `pnpm check`, the pre-push hook, and CI) fails if a copy has drifted. When an agent edits a `.mdc`, the edit hook regenerates the copies for you.

## One rule, many tools

Canonical rules live in `.cursor/rules/`. Cursor reads and scopes them natively. Everything else reads `AGENTS.md`. Skills in `.claude/skills/` are thin pointers that load a session-mode rule on demand. [agents](agents.md) says what each tool reads.

## The branch flow

- **Feature branch → PR → `dev` → PR → `main`.** `main` is production. Only `dev` merges into `main`, and a pre-push hook plus a ruleset enforce it.
- **Worktrees.** Agents work in a git worktree off `dev`, not in your primary clone, so the primary clone stays on `dev` and ship commands have a clean tree.
- **Draft PRs.** Every PR opens as a draft. Cheap CI (`Checks`) runs on every push; the expensive tier (`Build`, plus any heavy job a pack adds) skips while the PR is a draft and reports as skipped, which counts as passing.
- **Docs-only is the exception.** Prose-only changes (`docs/**`, root `*.md`, `.cursor/rules/**`, `.claude/skills/**`, `harness*.json`) skip the PR: commit on `dev` in the primary clone with `[skip ci]`. One code file in the diff makes the whole change a PR. Never put `[skip ci]` on a branch with an open PR; the required checks would never report.
- **CI minutes are a resource.** Run `pnpm check` locally (free), push once per working chunk, rerun only failed jobs, never re-run a green commit.

## Who clicks what

Humans own the irreversible. Agents prepare; you decide.

| Action | Who | Why |
|---|---|---|
| Open a draft PR, push a feature branch | Agent | Reversible. |
| Mark a PR Ready | You | Starts the expensive CI. A Ready PR is never flipped back to draft. |
| Merge into `dev` | You (or the wrangler with your OK) | Lands code for everyone. |
| "Ship it" (`dev` → `main`) | You | Merging to `main` deploys production. |
| Apply infrastructure (`terraform apply`) | You | Real resources. |
| Delete data, a database, a backup, or an encryption key | You | No test can undo it. An agent writes the migration or script and hands you the exact command. |
| Run a manual workflow, `--no-verify`, force-push `dev`/`main` | You | Spends CI, skips checks, or rewrites history. |

[command-guard](roles.md#command-guard) turns the worst of these into a refusal, so it does not depend on an agent remembering.

## Repo memory

A fresh session knows only what is in the repo. These files are the memory:

- `docs/plans/` — phase-by-phase execution plans. The table near the top (phase, what, after, model, state) lets a session start any phase from the file alone.
- `docs/decisions/` — one numbered file per choice that constrains later work, with the reason, so nobody undoes it by accident.
- `docs/learnings/` — a mistake that would happen again, plus the check that catches it. Prefer a real check; a learning that becomes a check is deleted.
- `docs/deferred.md` — work knowingly left undone, each with why and what changes if you do it. The file is the open set; delete an entry when done.
- `docs/human-checks.md` and `docs/runbooks/` — things only a person can verify, each with a stable id. The wrangler compiles every id into one checklist.
- `CHANGELOG.md` (user-facing) and `CHANGELOG-TECHNICAL.md` (what and why, internal).

## Four test tiers

Every behavior lives in exactly one tier; "untested" is not one.

1. **Unit and property** — deterministic, every PR.
2. **Fault injection** — a model of the far side (server, store, clock) driven by a seeded fault script. Each fault the code handles has a test that goes red when the handler is removed. Each language pack ships a worked example.
3. **Runbook** — scenarios no test process can reach, in `docs/runbooks/`, each with one Human check id.
4. **Human check** — judgment calls and real-device checks.

A PR that adds behavior names its tier in the **Tested by** line, or it fails review.

## Layers

Code is split into config, domain (pure), use-cases behind ports, and adapters, and each pack enforces the import direction with its own tool. The map and the fix for each rule is `docs/ports-and-adapters.md`. Rename the layers to yours; do not loosen the rule to make an import compile.
