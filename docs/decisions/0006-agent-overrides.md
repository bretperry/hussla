# 0006. One override file for the team, one for each person

`proposed` · 2026-10-04 · from the "agent override config" project thread

## Context

- Agent settings were spreading one file per feature: `model-tiers.project.json` (0005), `dynamite-test.project.json` (0004). Each new knob meant a new file to discover.
- Some choices are the team's (which model runs `deep`, when the dynamite test runs). Others are one person's: a model they have no account for, a smaller ChatGPT budget. A committed file forced the second kind into a team PR, or into nobody's file at all.

## Decision

- `agent-overrides.json` (project, committed, optional) holds the team's agent settings: `models` (tier → lineage → id, `latest`, `none`) and `dynamiteTest` (`scope`, `rivalScope`). New agent knobs go here as new keys, not new files.
- `agent-overrides.local.json` (gitignored, optional) has the same shape and wins key by key. Its `dynamiteTest.scope` may only be the team's or wider: skipping a test is a team call. `rivalScope` may narrow freely within `scope`.
- `scripts/agent-overrides.mjs` reads the layers (`pnpm overrides` shows each value and its file; `init` makes the personal file and the ignore line). Unknown keys fail loudly, naming the file.
- The two older files are still read, beneath `agent-overrides.json`.
- Not folded in: `command-guard.project.json` (safety; no personal file may loosen it), `harness.project.json` (sync bookkeeping), pack layer configs (code shape), `<rule>.project.mdc` (prose).

## Consequences

- One place to point people to; a personal pick no longer needs a team PR.
- Two people can run different models on the same plan. `pnpm models` marks `**` cells so a surprising result is traceable.
- The legacy files cost a little reading code until projects move; dropping them is in `docs/deferred.md`.
- Revisit if a setting needs a third layer (per-plan or per-branch).
