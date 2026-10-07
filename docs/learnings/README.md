# Learnings

What an agent (or a person) got wrong here once and would get wrong again, and how to avoid it.
Written by the `compound` step after a PR merges (`.cursor/rules/compound.mdc`). Plans grep this
folder for the area a phase touches and cite what applies.

**A learning earns a file when** you can name the check that would have caught it: a command, a
test, a place to look. "Be careful with X" is not a learning yet.

**Prefer enforcement.** If a lint rule, a boundary rule, a test, or a hook can stop the mistake,
add that instead (it's code, so a PR). A learning that has become enforcement is deleted: the check
is the memory now.

**Shape:** `docs/learnings/<area>-<slug>.md`, one learning per file, under ~20 lines. Search first
(`grep -ril <topic> docs/learnings/`) and update an existing file rather than adding a near-duplicate.

```markdown
# <What goes wrong, as a statement>

`YYYY-MM-DD` · from <PR / incident / thread> · area: <dir or subsystem>

**Symptom:** what you see when it happens.
**Cause:** why it happens (the non-obvious part).
**Do instead:** the move that avoids it.
**Check:** the command, test, or place that tells you it's right.
```
