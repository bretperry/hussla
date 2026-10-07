---
name: wrangler
description: Round up open PRs and branches across every plan, get them merge-ready and green, and burst-merge them into dev with the user's OK. Use when asked to "wrangle", batch-merge, or "get what's left onto dev".
---

The canonical rule is `.cursor/rules/wrangler.mdc` (shared with Cursor). Read it in full and
follow it.
If `.cursor/rules/wrangler.project.mdc` exists, read it too: this project's additions, which win
where the two differ. Also read `.cursor/rules/branching.mdc` if it is not already in context.
`wrangler.mdc` cites a few `showrunner.mdc` sections by name; read those sections when you reach
them, not the whole file.
