---
name: dynamite-test
description: Dynamite test of a PR or batch by a fresh subagent that sees only the diff and tries to break it. Use when asked for a dynamite test, to "try to break" a change, or when the showrunner or wrangler calls for one.
---

The canonical rule is `.cursor/rules/dynamite-test.mdc` (shared with Cursor). Read it in full and
follow it.
If `.cursor/rules/dynamite-test.project.mdc` exists, read it too: this project's additions, which win
where the two differ.
