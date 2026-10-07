---
name: showrunner
description: Run a docs/plans execution plan by dispatching phases to worker agents, QA-ing their PRs, and stopping for the user only where needed. Use when asked to "showrun" or "proceed through" a plan.
---

The canonical rule is `.cursor/rules/showrunner.mdc` (shared with Cursor). Read it in full and
follow it.
If `.cursor/rules/showrunner.project.mdc` exists, read it too: this project's additions, which win
where the two differ. Also read `.cursor/rules/plans.mdc` and `.cursor/rules/branching.mdc` if they are
not already in context.
