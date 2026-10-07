# 0006. A project can eject the harness for a release and keep the stack packs' gates

`accepted` · 2026-10-04 · from the "ship without whippletree" project thread (Bret chose "Keep gates")

## Context

- A project may want to develop with whippletree and ship without it, for example as an
  open-source product whose repo shows no agent rules, hooks, or harness sync.
- Deleting the harness by hand leaves the tree red: package.json scripts, the CI Checks job, the
  installed pre-push hook, and `scripts/stack.mjs` all call harness scripts.
- The stack packs are both: their runners (`stacks/<name>/run.mjs`, boundary checks, gates) are
  what make `pnpm check` meaningful for an outside contributor, but their rules and edit hooks
  only serve agents.
- Three shapes were weighed: drop everything (plain lint and tests only), drop only the
  whippletree name and sync (keep `AGENTS.md` and rules), or drop the harness and keep the gates.

## Decision

- **`pnpm harness:eject` removes the harness and keeps the gates.** Kept: the product, each pack's
  `checks` runners, `scripts/stack.mjs` (`check`, `drift`, `list`), the CI change-scope
  classifier, `ci.yml`, and the composite setup action. Removed: agent rules and skills, the hooks,
  harness sync and drift, plans, human checks, the guide, the PR template.
- **What goes is data.** `harness.json` itself, its `docs` + `code` minus `eject.keep`, plus
  `eject.remove` (directories end in `/`), plus each present pack's `docs` and `ejectRemove`.
  `eject.dropScripts` / `addScripts` edit package.json; a kept file's harness-only lines sit
  between `[harness]` and `[/harness]` markers (`rule-authoring.mdc`).
- **It never touches history, and never runs on `dev` or `main`.** Development goes on with the
  harness; a release ejects on a publish branch and is published with fresh history or to a mirror.
- **Leftovers are reported, not rewritten.** Lines naming whippletree, unfilled `{{…}}`
  placeholders, and package.json scripts that would run a removed file make `--apply` exit 1.

## Consequences

- An outside contributor gets the same layer and lint gates the project's agents work under,
  through `pnpm check` and CI, with no agent tooling in the repo.
- A new harness file must be listed in `harness.json` (as every harness file already is) or in
  `eject.remove`, or it ships. `scripts/harness-eject.test.mjs` ejects this repo and fails on a
  known harness path that survives, a leftover fence, or a broken script.
- A harness-only line in a kept file needs a fence; forgetting one shows up as a failing test or
  a broken import in the ejected tree, which the end-to-end test catches only for the paths it checks.
- Revisit if a project wants the third shape (keep `AGENTS.md` and rules): that is a second set of
  `keep` entries, not a new mechanism.
