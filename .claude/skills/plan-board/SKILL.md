---
name: plan-board
description: Render every plan in docs/plans as one board (a lane per plan, phases colored landed / in progress / unblocked / blocked, a completion line, and what to start next) and publish it to the project's board artifact. Use when asked for the plan board (also "planboard"), plan status, "where are my plans", "what can start next", or after a State change when the project has a board.
---

The table spec is `.cursor/rules/plans.mdc`; the parser is `scripts/plans-status.mjs`. If
`.cursor/rules/plans.project.mdc` exists, read it: it names this project's board artifact.

1. **Lint.** `node scripts/plans-status.mjs check`. Problems don't stop the board (they show
   in its "Needs attention" box), but tell the user about them. Fix a table only if you own
   that plan (no showrunner running it, `showrunner.mdc`) or the user asked.
2. **Render.** `node scripts/plans-status.mjs board --gh --out <scratchpad>/plan-board.html`.
   `--gh` needs `gh` signed in; drop it if that fails, and say the stale-PR check was skipped.
3. **Publish** with the Artifact tool:
   - The companion names a board URL → `read` it once (the tool requires it), then publish the
     new file to that `url`. Omit `icon`.
   - No URL yet → publish without `url`, icon `chart`, then add the URL to
     `plans.project.mdc` (create it beside `plans.mdc` with the same frontmatter if missing).
4. **Report** in a few lines: the link, plans in flight, what can start next (plan · phase ·
   model), anything stale or blocked. Don't restate the whole board.

Only the tables in `docs/plans/` feed the board; never edit the published page by hand. It is
regenerated whole every time.
