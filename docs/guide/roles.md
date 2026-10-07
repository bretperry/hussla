# Roles

A role is a named way of working, written once in `.cursor/rules/<role>.mdc` and loaded on demand (Claude Code skill; in other tools, "read that file first"). Say the name, or paste the start prompt.

| Role | In one line | You say |
|---|---|---|
| [showrunner](#showrunner) | Runs a plan with parallel workers and does QA | "showrun the plan" |
| [wrangler](#wrangler) | Rounds up open PRs and burst-merges them with your OK | "wrangle the open PRs" |
| [farrier](#farrier) | Code review and tests for one PR | "farrier #N" |
| [dynamite-test](#dynamite-test) | A fresh agent tries to break the diff | "dynamite test of #N" |
| [command-guard](#command-guard) | Refuses commands only a human may run | (automatic) |
| [ship](#ship) | `dev` → `main` → production | "ship it" |
| [compound](#compound) | After a merge, bank what was learned | "compound #N" |

Also: `setup` (asks the setup questions and writes the config), `plan-board` (every plan as one status board), and `help` (a one-screen card).

Replace `<file>`, `#N`, and so on with yours. Every prompt works in a fresh session, because state lives in the repo (plans, PRs, branches), not in the conversation.

## showrunner

- **What:** runs a `docs/plans/` file. Reads the phase table, starts every phase whose prerequisites have landed (at most three workers at once, none overlapping on files), then QA-checks each worker's draft PR in two stages: does it match the plan (each **Done when** line, by running its verify step), then is it good code (the farrier pass). The workers build; the showrunner does not.
- **When:** you have a plan with a phase table and want it executed, not just a single change.
- **You still:** click Ready, and merge. A phase is `QA passed (#N)` until you do, `landed (#N)` after.
- **Model:** the `deep` tier at high effort (`plans.mdc` → Model tiers).

Start prompt:

> read `docs/plans/<file>.md` and showrun it (`showrunner.mdc`).

## wrangler

- **What:** the one session that herds every open PR across all plans into `dev`: inventories them, combines what belongs together, fixes conflicts, triages CI failures, and burst-merges when you say so. It compiles the Human checks into one checklist at ship time. It never touches a showrunner's branches or a plan file.
- **When:** several PRs are open and you want them on `dev` with the fewest CI runs.
- **One at a time.** Two wranglers merging into `dev` race each other.
- **You still:** say "go" before any merge, and say you have read a PR before the wrangler marks it Ready.

Start prompt:

> wrangle the open PRs (`wrangler.mdc`).

## farrier

- **What:** the "is it good code?" pass for one PR. Reads the whole diff itself, runs `/code-review`, runs the tests the PR names and `pnpm check`, wants a screenshot for UI changes, checks migrations and commit-point order, and fails a PR that adds behavior with no **Tested by** line.
- **When:** before anyone rides a change: you ask for a review, or the showrunner or wrangler calls it.
- **Output:** findings back to the PR's owner, or fixes if the branch is its own.

Start prompt:

> farrier #N (`farrier.mdc`).

## dynamite-test

- **What:** a fresh subagent sees only the diff (not the author's summary or reasoning) and tries to break it: silent failures, ordering, permission holes, races, inputs the tests skip. Every finding is fixed or answered in the PR.
- **When:** set by `dynamiteTest.scope` in `agent-overrides.json` (a personal `agent-overrides.local.json` may only widen it; [overrides](overrides.md)): `all` (every PR), `high-risk` (default: risky phases, migrations, auth, hooks, CI, batches, major ships), or `major-release` (only a major ship). Always on request. It costs tokens, not CI minutes, and runs while the PR is still a draft.
- **Partner:** farrier asks "is it good"; this asks "how does it break".
- **Rival:** when a `rival` model is listed, ChatGPT (Codex) reviews too, on the changes `rivalScope` picks (default: same as `scope`; set it narrower to save rival tokens), and the agent argues disagreements out with it before deciding. Setup: [models](models.md#2-chatgpt-through-codex-rival-optional).

Start prompt:

> dynamite test of #N (`dynamite-test.mdc`).

## command-guard

- **What:** not a session you start. A hook (`scripts/command-guard.mjs`) reads every shell command an agent is about to run (Claude Code, Cursor) and answers **deny** (never, e.g. flipping a ready PR to draft, force-pushing `dev` or `main`, deleting data), **ask** (you decide in the moment: marking Ready, merging, pushing `main`, a manual workflow run), or nothing (it runs).
- **It reads commands the way a shell would:** it splits chains and `bash -c`, so `grep "terraform destroy" docs` is not a delete but `echo ok && terraform destroy` is.
- **It fails closed to ask, never to allow.** A crash, a command line over 64k characters, an evaluation over 250 ms, or a 3 s watchdog all give an **ask** that names the reason.
- **A rule file that does not load refuses every command,** naming the file. A broken file read as "no rules" would quietly allow everything.
- **Your rules:** `command-guard.project.json` at the repo root (deny, ask, and exact-command exemptions). A pack can ship its own in `scripts/command-guard.d/<pack>.json` (none does today). The agent does not edit these to get past a refusal.
- **Escape hatch:** `WHIPPLETREE_GUARD=off`, set by you in the shell that starts the agent, turns it off. It exists for one case, a rule file you broke that now blocks every command, so you can repair it. It is not a way around a refusal: if the guard stopped a command, the command is the thing to reconsider. Turn it back on right after.

Start prompt (to add a rule of your own, as a PR you review):

> add a command-guard rule for this project that denies `make deploy`; follow `branch-protection.mdc` → Project guard rules, add a test, and open a draft PR.

To see it work, see [troubleshooting](troubleshooting.md#is-the-guard-even-running).

## ship

- **What:** lands `dev` on `main` (production). Freezes `dev` pushes for every session, opens the `dev` → `main` PR, makes sure the head commit does not carry the skip-ci marker (that would leave the required checks unreported), waits for a green head, and merges with `--match-head-commit` and the full 40-character SHA only on your "ship it".
- **When:** you want what is on `dev` live.
- **You still:** say "ship it", and tick the post-deploy Human checks. The PR's **Shipping to production** section names contents, migrations, the exact rollback command, and what to watch.

Start prompt:

> ship it (`ship.mdc`).

## compound

- **What:** after a PR merges (or a hard bug is fixed), asks in order: will an agent make this mistake again (prefer a new check, then a rule line, then a learning), did we learn something non-obvious (a learning), did we make a choice that constrains later work (a decision), did we leave something undone on purpose (`docs/deferred.md`). Most PRs produce nothing, and "nothing to compound" is a fine answer.
- **When:** right after a merge, or when you ask "what did we learn".
- **Output:** one line per item added. Prose-only results are docs-only commits on `dev`; a new check is code and goes through a PR.

Start prompt:

> compound #N (`compound.mdc`).

## plan-board

- **What:** renders every plan as one board (a lane per plan, phases colored landed, in progress, unblocked, blocked) and what can start next.
- **Local copy:** `pnpm plans:board` writes `plan-board.html` (ignored by git). It uses `gh` to cross-check each `#N` in a State cell against GitHub.

Start prompt:

> show the plan board (`plan-board` skill; `/planboard` works too).

## setup

- **What:** asks the setup questions (project name, stacks, which model runs each tier, rival and wildcard, dynamite-test scope, GitHub bootstrap), writes `agent-overrides.json` and your `agent-overrides.local.json`, and runs or prints the rest. Re-runnable: it asks only about what isn't done. A teammate joining a set-up project gets only their own picks and per-person steps.
- **Never does:** sign-ins, installs outside the repo, or GitHub changes without your yes on that command.

Start prompt:

> setup

## help

One phone-screen card: how to start, the daily flow, the roles, the commands. Ask "help", or "how do I …" for a five-line answer that names the file to read.

Start prompt:

> help
