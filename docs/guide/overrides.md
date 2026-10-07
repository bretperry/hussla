# Overrides: one file for the team, one for you

How the agents work here is set in two files at the repo root. Use them instead of editing a harness rule or script: the next `pnpm harness:pull` would erase that.

- **`agent-overrides.json`** — the team's choices. Committed, reviewed in a PR like any change.
- **`agent-overrides.local.json`** — yours. Gitignored, this machine only: your own models, a smaller token budget for the rival.

Both are optional; a key you leave out keeps whippletree's default. Yours wins over the team's, key by key, with one floor: you may test more than the team asked, never less.

```bash
pnpm overrides
```

Prints every value set and the file it came from. To start your own file (it also makes sure git ignores it):

<!-- doc-run: skip writes a file in your checkout -->
```bash
pnpm overrides init
```

## What goes in it

```json
{
  "models": {
    "deep": { "rival": "latest" },
    "quick": { "wildcard": "none" }
  },
  "dynamiteTest": {
    "scope": "high-risk",
    "rivalScope": "major-release"
  }
}
```

- **`models`** — which model runs each tier, per lineage. A value is a model id (pinned), `latest`, or `none` (no pick; `deep` → `rival` set to `none` turns the rival review off). Tiers, lineages, and ids: [models](models.md). Check with `pnpm models`: `*` marks the team's pick, `**` yours.
- **`dynamiteTest.scope`** — when the dynamite test runs: `all`, `high-risk` (default), or `major-release` ([dynamite-test.mdc](../../.cursor/rules/dynamite-test.mdc) → When it runs).
- **`dynamiteTest.rivalScope`** — the same values for the rival (ChatGPT) alone. Follows `scope`; may be the same or narrower.

A key or value the scripts don't know fails loudly, naming the file. A typo never quietly changes who runs or what gets tested.

## Who sets what

| Want | File |
|---|---|
| The team runs a different model for a tier | `agent-overrides.json` → `models` |
| You run a different model, or have no Codex account | yours → `models` (`deep` → `rival`: `none`) |
| The team tests every PR, or only major ships | `agent-overrides.json` → `dynamiteTest.scope` |
| You test more than the team asks | yours → `dynamiteTest.scope` (wider only) |
| Your ChatGPT budget is small | yours → `dynamiteTest.rivalScope`: `major-release` |

Your file can't narrow `scope` below the team's: the dynamite test is how the team catches what a PR hides, so skipping it is a team decision. Narrow `rivalScope` instead; it only changes whose tokens are spent.

## What is not in it

- **Prose rules** — a project's additions to a harness rule go in `<rule>.project.mdc` beside it ([keeping in step](keeping-in-step.md#project-overrides-projectmdc)).
- **The command guard** — `command-guard.project.json`. It decides which commands an agent may run, so it is the team's alone and no personal file may loosen it.
- **Harness sync** — `harness.project.json` (the upstream base, skipped files). Bookkeeping for `pnpm harness:pull`, not a preference.
- **Stack layer paths** — each pack's own config, listed in [keeping in step](keeping-in-step.md). They describe the code's shape.

## The files it replaces

`model-tiers.project.json` (`tiers`) and `dynamite-test.project.json` are still read, below `agent-overrides.json`. `pnpm overrides` names any it finds. To move: put `tiers` under `models` and the dynamite test keys under `dynamiteTest`, delete the old file, and run `pnpm overrides` to check nothing changed.
