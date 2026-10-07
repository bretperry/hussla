---
name: setup
description: Guided setup for a whippletree project — asks the setup questions (project name, stacks, which model runs each tier, rival and wildcard, dynamite-test scope, GitHub bootstrap), writes the config, and runs or prints the rest. Use when asked to "set up", "setup", configure models, or onboard a new project or a new teammate.
---

Setup by conversation instead of by hand. Everything here is also in `docs/guide/getting-started.md`,
`models.md`, and `overrides.md`; this skill asks, writes the files, and checks them. Safe to re-run:
it only asks about what isn't done yet.

You may write files in the repo and run the repo's own `pnpm` scripts. Anything outside the repo
(installing a CLI, signing in, changing GitHub) you print for the user, or run only after they say
yes to that command. Never paste or store an API key or token.

## 1. Look before you ask

Run these and keep the answers; don't show the raw output.

- `grep -nE '[{][{][A-Z_]+[}][}]' AGENTS.md CHANGELOG.md CHANGELOG-TECHNICAL.md package.json`
  — placeholders left (none → the project is named).
- `pnpm stack:list` — packs present and removed.
- `pnpm overrides` and `pnpm models` — the team's and this person's picks, and where each came from.
- `pnpm rival scope` — when the dynamite test and the rival run.
- `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` — `dev` means bootstrap ran.
  No `gh` or not signed in → unknown; ask.
- `git rev-parse --git-path hooks/pre-push` exists → hooks installed in this clone.
- `command -v claude codex grok gh` — which CLIs are here.

Then pick the mode:

- **New project** — placeholders left, or the default branch isn't `dev`. Ask sections A–E.
- **Joining** — the project is set up. Ask only D (your own picks) and do E's per-person steps.

Show one short checklist of what's done and what's left before the first question.

## 2. Ask

One message per section, numbered questions, each with its default marked and a one-word answer
possible. "Defaults" accepts every default in that section. Skip a question whose answer step 1
already found.

**A. Project** (new project only)
1. Project name → the `PROJECT_NAME` placeholder (`AGENTS.md` title, `CHANGELOG.md`, `CHANGELOG-TECHNICAL.md`).
2. One-line pitch → the `ONE_LINE_PITCH` placeholder (`AGENTS.md` line 3).
3. Stack line, e.g. `Rust · SQLite · Tokio` → the `STACK` placeholder (`AGENTS.md` → Stack).
4. Package name → the `REPO_SLUG` placeholder (`package.json` → `name`). Default: the repo's name.

**B. Stacks** (new project only) — list the present packs from `pnpm stack:list` and ask which to
keep. Default: keep all. Say first which removed packs add a required check
(`node scripts/stack.mjs required-checks`), since that check must also leave the rulesets.

**C. Team models and testing** → `agent-overrides.json` (committed; the whole team runs these)
1. Models: show the `pnpm models` table. Per tier, keep the suggestion (default), `latest`, or a
   model id. Offer `pnpm models catalog <vendor>` for ids; never invent one.
2. Rival (ChatGPT via Codex): on (default) or off. Off → `models.deep.rival: "none"`.
3. Wildcard (Grok): keep the suggestion (default) or off (`"none"` on each tier that has one).
4. Dynamite test `scope`: `all`, `high-risk` (default), or `major-release`.
5. Rival `rivalScope`: same as scope (default), or narrower.

**D. Your own picks** → `agent-overrides.local.json` (gitignored, this machine only)
1. No Codex or ChatGPT account? → `models.deep.rival: "none"` here, not in the team file.
2. Small ChatGPT budget? → `dynamiteTest.rivalScope: "major-release"`.
3. A model the team picked that you can't run → that cell here.
4. Want more testing than the team? `dynamiteTest.scope` here may only be **wider** than the team's;
   say so if they ask for narrower, and offer `rivalScope` instead.

**E. GitHub and tools**
1. Bootstrap GitHub now (needs `gh` signed in as repo admin): run `bash scripts/bootstrap-repo.sh`
   (default, if `gh` works), or print the by-hand steps (getting-started → By hand). New project only.
2. Install and sign in to the CLIs the picks need: Codex if a rival is on, Grok if a wildcard is.
   Print the commands from `docs/guide/models.md` §2–3 and let the user run them (in Claude Code,
   `! codex login` runs it in this session). Sign-ins are always the user's.

## 3. Write

Write only what differs from the defaults; a key left out keeps whippletree's suggestion.

- **Placeholders and stacks** change code (`package.json`, `ci.yml`), so they are a PR, never a
  commit on `dev`: one worktree off `dev` (`branching.mdc`), `pnpm install`, replace each
  placeholder, `pnpm stack:remove <name>` per dropped pack, then `agent-overrides.json` below in the
  same branch.
- **`agent-overrides.json`** — edit or create it with only the keys chosen in C:

  ```json
  {
    "models": { "deep": { "rival": "none" } },
    "dynamiteTest": { "scope": "high-risk", "rivalScope": "major-release" }
  }
  ```

  In a joined project it is a team change: a PR, after the user confirms the team wants it.
- **`agent-overrides.local.json`** — `pnpm overrides init` (creates it and makes sure git ignores
  it), then fill in the keys from D. No commit.

Then check, and fix anything they name before going on:

- `pnpm overrides` — each value and its file; unknown keys fail loudly.
- `pnpm models` — `*` marks the team's picks, `**` yours.
- `pnpm rival scope` — `test:` and `rival:` lines match what was chosen.

## 4. Run what's yours, print what isn't

- **Bootstrap** (if chosen): `bash scripts/bootstrap-repo.sh`, then commit the
  `harness.project.json` it writes on `dev` with `[skip ci]`, as it says (docs-only).
- **Hooks**: `pnpm hooks:install` on any clone where step 1 found none.
- **Rival on and Codex signed in**: `pnpm rival doctor` until it exits 0.
- **`pnpm check`** in the setup worktree, until green; then commit, push once, and open a
  **draft** PR into `dev`. The user clicks Ready and merges.

## 5. Finish

One short card: what was written (file → keys), what was committed or opened (PR link), what is
left for the user (each a command or a settings page, one per line), and `help` for the daily flow.
