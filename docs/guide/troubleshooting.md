# Troubleshooting

Find your symptom. Each entry says what happened, what to do, and what not to.

## A command was refused or the agent asked you to confirm one

That is the [command guard](roles.md#command-guard) working. Its message names the rule and the file that holds it.

- **Denied** — no session may run it (force-push `dev` or `main`, `--no-verify`, flipping a ready PR to draft, deleting data). If you really want it, run it yourself in your own terminal.
- **Asked** — fine with your OK in the moment (mark Ready, merge, push `main`, a manual workflow run). Read the command, then approve or not.
- **Never route around a refusal:** another tool, a script, a different spelling. Tell the agent what you need and why; a half-finished task is recoverable, a deleted database is not.
- **"over the guard's 65536-character budget"** (the message gives your command's length) — the command line was huge, so it was not read and asks instead. A big file belongs in a file write, not a heredoc.
- **"took longer than the guard's 250 ms budget"** or **"within its 3000 ms watchdog"** — the guard stopped reading and asks, so a guard bug never becomes a silent allow. If it repeats on ordinary commands, something in a rule file is slow (usually a pattern that backtracks); simplify the pattern.
- **Every command is refused, naming a file** — a rule file (`command-guard.project.json`, or a pack's under `scripts/command-guard.d/` if a pack ships one) is present but does not load: bad JSON, an unknown key, a missing reason, a duplicate key, or a pattern that does not compile. A broken file read as "no rules" would quietly allow everything, so it blocks everything instead. Fix the file (the message gives the error).
  - **Escape hatch, for exactly this case:** if the broken file now blocks the agent from helping you repair it, repair it yourself, or start the agent from a shell with `WHIPPLETREE_GUARD=off`, fix the file, and turn it back on. It is not a way around a refusal, and nobody (human or agent) should leave it set; with it off, nothing stops a force-push or a delete.


### Is the guard even running?

Pipe a command the guard must stop into it. This only asks the guard for a verdict; it runs nothing:

<!-- doc-run: skip uses a pipe; only asks the guard for a verdict -->
```bash
echo '{"tool_input":{"command":"gh pr ready 1"}}' | node scripts/command-guard.mjs claude
```

Expect JSON with `"permissionDecision":"ask"`. No output means the guard had no opinion about that command. Separately, in the agent itself, ask it to run a command the guard refuses and watch for the refusal. If the script answers but the agent never sees a refusal, the host is not running the hook: check `.claude/settings.json` (or `.cursor/hooks.json`) is loaded, and note that some cloud or sandboxed sessions do not run project hooks at all. In that case the pre-push hook and the GitHub rulesets are what stop you.

## The rival reviewer doesn't run

- **`pnpm rival doctor`** names what is missing and the fix for each.
- **"missing or signed out"** — `codex login status` failed: install the CLI or run `codex login` yourself. A signed-out CLI retries quietly instead of erroring, so the script checks first.
- **Plugin "not installed" in Claude Code** — accept the `openai-codex` marketplace, or `/plugin install codex@openai-codex`. Without it reviews still run through the CLI, just without the plugin's job tracking. If you installed it somewhere unusual, point `CODEX_COMPANION` at its `scripts/codex-companion.mjs`.
- **`dynamiteTest.scope must be one of …` / `rivalScope must be one of …`** — the file the message names holds a value the rule doesn't define. Fix it; a typo never silently changes who tests.
- **`rivalScope … is wider than scope`** — the rival only runs inside a dynamite test, so it can't cover more. Narrow `rivalScope` or widen `scope`.
- **`… is narrower than the team's`** — your `agent-overrides.local.json` asks for less testing than `agent-overrides.json`. Yours may only test more; narrow `rivalScope` to save rival tokens instead ([overrides](overrides.md)).
- **`pnpm rival scope` says `rival: off`** — no rival is picked for `deep`: `pnpm models` shows `—` there (the suggestion is empty, or an override says `none`; `pnpm overrides` names the file).
- **A model id Codex doesn't know** — the id came from `model-tiers.json` or an override (`pnpm overrides`). `pnpm rival doctor` lists the ids this Codex knows (`codex debug models`); set yours in an override file ([models](models.md#4-find-the-model-ids)).

## The edit check timed out, or reports something odd

`scripts/check-edited.mjs` typechecks, lints, and boundary-checks each file an agent edits, and hands back only failures.

- **Budget:** the hook allows 90 seconds. Each pack's check gets 80 seconds, packs run in parallel. A check that crashes, times out, or dies on a signal is **reported**, never read as clean.
- **Cold caches are the usual cause.** A first compile, a first dependency download, or a first type-aware lint can run long. Run the pack's own check once in your terminal to warm it; the next edit check is fast. Rule of thumb, not a guarantee.
<!-- [stack:typescript] -->
- **Warm TypeScript:** `pnpm typecheck`
<!-- [/stack:typescript] -->
- **"unchecked" or `SKIPPED` messages** mean the pack's tool is missing. It is never a pass. Install the tool ([prerequisites](getting-started.md#prerequisites)).
- **Still too slow for your project?** List `scripts/check-edited.mjs` in `harness.project.json` → `skip` with a reason (so `pull` stops overwriting it), then change your copy. The checks still run in `pnpm check`, pre-push, and CI.
<!-- [stack:typescript] -->
- **A tool crashed but the hook said nothing** — a known gap for the TypeScript pack (`docs/deferred.md`). `pnpm check` is the truth.
<!-- [/stack:typescript] -->

## The drift run is red

The weekly `Harness drift` workflow found files that differ from upstream. It is a reminder, not a merge gate.

1. Run `pnpm harness:status` locally. Each file has an arrow.
2. `↓ upstream changed` → `pnpm harness:pull`. `↑ edited here` → `pnpm harness:push` or move the change to a `.project.mdc` companion. `↕ both` → pull, resolve the conflict markers, push.
3. A docs-only pull is a commit on `dev` with `[skip ci]`; a pull that touches code is a feature branch and a draft PR.
4. **Every harness file shows `? no base yet`**: bootstrap could not read upstream when it ran, so `base` in `harness.project.json` is empty. Re-run `bash scripts/bootstrap-repo.sh` once `gh` can read upstream; its other steps find their work done and only the base changes.
5. **Green with a notice** ("Upstream is private and HARNESS_TOKEN is not set") means it could not read upstream, not that you are in step. Add a `HARNESS_TOKEN` secret.

See [keeping in step](keeping-in-step.md).

<!-- [stack:typescript] -->
## TypeScript 7 and the language server

TypeScript 7 ships no `tsserver`, so Claude Code's `typescript-lsp` plugin needs TypeScript 6 globally (`npm i -g typescript-language-server typescript@6`; see [agents](agents.md#claude-code)). This only affects in-editor intelligence. `pnpm typecheck` uses the project's TypeScript 7 and is unaffected. If the plugin errors on start, that global install is the first thing to check.
<!-- [/stack:typescript] -->

## The pre-push hook does not run

- **`pnpm install` does not install it.** Nothing sets `core.hooksPath` either; the installer copies the hook into the repo's hooks directory. Bootstrap does it for the clone it ran in. On any other clone or machine run `pnpm hooks:install` (it works from any worktree and covers all of that clone's worktrees).
- **Check:** the file `pre-push` should exist in the directory `git rev-parse --git-path hooks` prints, and be executable.
- **Re-run it after `.githooks/` changes**, because copies do not follow the source.
- **Rejected `main` push:** the hook refuses a `main` push whose tree is not identical to `dev`'s. Merge `dev` into `main` through the PR; do not commit to `main` or merge a feature branch into it.
- **`pnpm check` failed in the hook:** it runs the same checks you can run yourself. Fix them, commit, push again. Skipping with `WHIPPLETREE_SKIP_CHECKS=1` or `--no-verify` is yours to decide in your own terminal, never an agent's.

## Node says "Unsupported engine"

`package.json` → `engines` wants Node 24 or newer. pnpm only warns, and many checks pass on older Node, but CI runs the version in `.nvmrc`, so a green local run on old Node does not predict CI. `nvm use` or `fnm use` and reinstall.

## A PR is blocked and no check is running

- **A required check never reports.** Required checks match by name. Renaming a CI job, adding a pack whose job is required, or removing a pack without dropping its check leaves a name nothing reports, and every PR waits forever. Compare `node scripts/stack.mjs required-checks` with Settings → Rules, and edit both PR rulesets.
- **`[skip ci]` on a PR branch** skips the whole workflow, so no check reports. Never put it on a branch with an open PR; push an ordinary commit to unstick it. It is only for docs-only commits straight on `dev`.
- **No rulesets available** (private repo on a free plan): bootstrap said so. The hook and the red check are your stops.
- **The removal PR for a pack waits on that pack's check** (`Swift tests`, say): the pack was removed after bootstrap made its check required. Drop the check from both PR rulesets first; next project, [choose stacks before bootstrap](getting-started.md#2-choose-your-stacks).

## `pnpm check` fails on generated files or plans

- **`rules:check` says copies drifted:** you edited a `.mdc` (or `.claude/rules/*.md` by mistake). Run `pnpm rules:sync` and commit both. Edit only the `.mdc`.
- **`plans:check` fails:** a plan's phase table header, an `After` cell, a Done-when line without `→ verify:`, or a Human check without an id. The message names the line. The table shape is in `.cursor/rules/plans.mdc`.
- **A removed pack left something behind:** `stack:remove` prints leftovers it will not delete (a virtualenv, caches). Delete them yourself.
- **Placeholders (`{{…}}`) are not checked.** `pnpm check` stays green with them in place; find them with the command in [getting started](getting-started.md#4-fill-the-placeholders).

## Doc commands: `pnpm docs:run` shows FAILED

`pnpm docs:run` runs the guide's safe commands in a fresh copy of `HEAD`, so commit your doc change first. `absent` lines are tools you do not have, not failures. `pnpm docs:commands` (no run) fails when a bash block has a command that is neither on the safe list nor marked `doc-run: skip <reason>`.
