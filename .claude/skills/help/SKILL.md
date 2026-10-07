---
name: help
description: Quick guide to whippletree — every command to copy, what to say to an agent, and a glossary of the terms. Use when asked for "help", "how do I…", "what can you do", or what a role, term, or command is.
---

No topic → reply with everything between the two `---8<---` lines below, as is. Add nothing.
A topic (a term, a role, a command, "how do I …") → answer in 5 lines or fewer from the file the
glossary names for it, include the command if it has one, and end with that file's path.

---8<---

# WHIPPLETREE · help

## Commands (copy what you need)

```bash
# ── Start a project (once) ───────────────────────────────
pnpm install
pnpm stack:list                    # packs in this repo
pnpm stack:remove <pack>           # drop one (feature branch + draft PR)
bash scripts/bootstrap-repo.sh     # dev branch, rulesets, hooks (gh with admin; re-runnable)
pnpm hooks:install                 # git hooks only
pnpm check                         # green = ready for a first plan

# ── Every day ────────────────────────────────────────────
git fetch origin dev && git worktree add -b <branch> ../<repo>-<slug> origin/dev
pnpm check                         # everything fast; pre-push runs it
pnpm stack:check                   # exactly the CI pack step
pnpm typecheck
pnpm lint
pnpm boundaries
pnpm test
pnpm test:harness                  # harness script tests
pnpm knip

# ── Plans ────────────────────────────────────────────────
pnpm plans:check                   # lint every docs/plans phase table
pnpm plans:board                   # write plan-board.html

# ── Models and overrides ─────────────────────────────────
pnpm models                        # model per tier × lineage, resolved
pnpm models catalog                # every model id per vendor
pnpm overrides                     # team + personal overrides, resolved
pnpm overrides init                # create your agent-overrides.local.json

# ── Rival reviewer (ChatGPT via Codex) ───────────────────
npm i -g @openai/codex
codex login
pnpm rival doctor                  # names anything missing
pnpm rival scope                   # when the dynamite test and rival run
pnpm rival review                  # read-only adversarial review of this branch
pnpm rival chat "<question>"       # add --resume to continue

# ── Keep in step with whippletree ────────────────────────
pnpm harness:status
pnpm harness:pull
pnpm harness:push                  # PR your harness edits upstream
pnpm rules:sync                    # after editing .cursor/rules/
pnpm harness:eject                 # dry run; --apply on a publish branch

# ── Docs ─────────────────────────────────────────────────
pnpm docs:commands                 # every doc command is runnable or marked
pnpm docs:run                      # run them in a throwaway copy
```

Pack commands (only the packs you kept), each also inside `pnpm check`:

```bash
pnpm rust:lint && pnpm rust:test
pnpm py:lint && pnpm py:test
pnpm go:lint && pnpm go:test && pnpm go:gates
pnpm swift:lint && pnpm swift:test
pnpm kotlin:check && pnpm kotlin:gates
pnpm kotlin:device                 # Android tests on an emulator or device
pnpm cpp:build && pnpm cpp:lint && pnpm cpp:test
pnpm infra:validate && pnpm infra:lint
pnpm migrations:lint
```

## Say it to an agent

| Say | What happens |
|---|---|
| `setup` | Asks the setup questions, writes the config, runs the rest |
| `read docs/plans/<file>.md and do Phase N` | One phase, one draft PR |
| `showrun docs/plans/<file>.md` | Showrunner runs the whole plan with workers |
| `wrangle` | Rounds up open PRs and merges them with your OK |
| `farrier PR #N` | Code review and tests for a PR |
| `dynamite test PR #N` | Fresh eyes (and the rival) try to break it |
| `ship it` | `dev` → `main` → production |
| `compound` | After a merge: bank what was learned |
| `/planboard` | Every plan as one status board |
| `help <term>` | Short answer on one item below |

**Only you:** click Ready, merge, ship, delete data.

## Glossary

- **Add-on pack**: a pack that rides along with a language (infra, SQL migrations). → `stacks/<pack>/`
- **Bootstrap**: one-time repo setup: `dev`, rulesets, hooks. `bash scripts/bootstrap-repo.sh` → `getting-started.md`
- **check-edited**: hook that typechecks, lints and boundary-checks each file an agent edits. → `branch-protection.mdc`
- **command-guard**: hook that refuses or asks about human-only commands (merge, force-push, delete data). → `branch-protection.mdc`
- **Compound**: after a merge, turn a lesson into a check, rule line, learning, or decision. → `compound.mdc`
- **Decision**: a choice later sessions must not undo. One file each. → `docs/decisions/`
- **Deferred**: work left undone on purpose, with why. → `docs/deferred.md`
- **dev / main**: work merges into `dev`; only `dev` merges into `main` (production). → `branching.mdc`
- **Docs-only**: prose-only change. Commit on `dev` with `[skip ci]`, no PR. → `branching.mdc`
- **Draft PR**: every PR starts as a draft; heavy CI waits for your Ready click. → `branching.mdc`
- **Dynamite test**: a fresh agent sees only the diff and tries to break it. Scope: `all`, `high-risk`, `major-release`. → `dynamite-test.mdc`
- **Eject**: strip the harness so a project ships without whippletree; keeps the gates. `pnpm harness:eject` → `docs/decisions/0006-harness-eject.md`
- **Farrier**: code review and tests for one PR. → `farrier.mdc`
- **Harness**: the shared files (rules, skills, hooks, scripts) synced from whippletree. Listed in `harness.json`.
- **Human check**: a step only you can do, with an id like `public-p4-repos`. → `plans.mdc`
- **Knob**: a named constant the product retunes, kept in `src/config/`. → `architecture.mdc`
- **Learning**: a mistake that would happen again, and the check that catches it. → `docs/learnings/`
- **Lineage**: who runs a tier: `home` (Claude Code), `rival` (ChatGPT via Codex), `wildcard` (Grok). `pnpm models` → `models.md`
- **Overrides**: `agent-overrides.json` (team) and `agent-overrides.local.json` (you) change models and dynamite-test scope. `pnpm overrides` → `overrides.md`
- **Pack**: one language's checks, rules and CI step, removable. `pnpm stack:list` → `docs/decisions/0002-stack-packs.md`
- **Phase table**: the table at the top of a plan: phase, After, Model, State. `pnpm plans:check` → `plans.mdc`
- **Plan**: a phase-by-phase execution file. → `docs/plans/`, `plans.mdc`
- **Plan board**: all plans as one board. `pnpm plans:board` or `/planboard` → `plan-board/SKILL.md`
- **Ready**: your click that takes a PR out of draft and starts the full CI. → `branching.mdc`
- **Rival**: a second vendor's model (ChatGPT) that reviews for the dynamite test. `pnpm rival review` → `models.md`
- **Rules**: canonical agent rules in `.cursor/rules/*.mdc`; a project adds `<rule>.project.mdc`, never edits the harness file. → `rule-authoring.mdc`
- **Ship**: merge `dev` → `main`; `dev` is frozen while it runs. Say `ship it`. → `ship.mdc`
- **Showrunner**: runs a plan with parallel workers, QAs each PR, stops only where you're needed. → `showrunner.mdc`
- **`[skip ci]`**: skips CI on a docs-only commit to `dev`. Never on a branch with a PR. → `branching.mdc`
- **`[stack:x]` fence**: marks pack-owned text so `stack:remove` strips it. → `docs/decisions/0002-stack-packs.md`
- **Tier**: how hard a phase is: `quick`, `workhorse`, `deep`, `frontier`. Each tier names a model. `pnpm models` → `plans.mdc`
- **Wildcard**: a third vendor's model (Grok), optional. → `models.md`
- **Worktree**: a separate checkout per branch, off `dev`, so the main clone stays on `dev`. → `branching.mdc`
- **Wrangler**: rounds up open PRs across plans, fixes conflicts, merges with your OK. → `wrangler.mdc`

More: `docs/guide/` · `AGENTS.md` · `.cursor/rules/`

---8<---

Where a short path above lives: `*.mdc` → `.cursor/rules/`; `*.md` guide pages → `docs/guide/`;
`plan-board/SKILL.md` → `.claude/skills/`. A role's start prompts are in `docs/guide/roles.md`.
