# <Area> runbook

The manual half of <the plan phase or area this covers>. Everything that can be made deterministic
is a test (tier 1 or 2, `testing.mdc`) and runs on every PR: <where those tests live>. This file is
what is left: the scenarios no test process can reach (two real devices, a real radio, an OS
setting, a real filesystem running out of space).

**When to run it.** <Before which release, and after which kinds of change. Not a per-PR gate:
the deterministic suite is.>

**What you need.** <Devices, accounts, a dev server, about how long.>

```bash
<the one command that starts what the scenarios run against>
```

---

## Why these are not tests

Each scenario names the thing a test cannot reach. If a scenario stops having one (a seam appears
that makes it deterministic), it leaves this file and becomes a test, because a runbook step only
gets run when it is on the checklist.

Every scenario carries exactly one Human check id (`plans.mdc` → Human checks), so the wrangler's
compiled checklist asks for it. `pnpm plans:check` fails a scenario without one. Ids are
`<area>-rb-<scenario>`; never reuse or rename one, because ticks are keyed on it.

---

## 1. <Scenario title>

**Human checks**
- `<area>-rb-<scenario>` · <where> · <time> · <gate> — <Short title.> Run scenario 1 of `docs/runbooks/<area>.md`: <the pass condition, in one line>.

**Not testable because:** <the real thing a test process can't drive, and which test covers the
deterministic half of it>.

1. <Step.>
2. <Step.>

**Expected:** <what you see when it works>.

**If it fails:** <where to look first>.

---

## Recording what you find

A failure in our code gets fixed and gets a test. A failure on the far side gets an entry in
`docs/deferred.md` with its reasoning. A scenario that turns out to be deterministic after all is
deleted from here and added to the test suite, and its check id is retired (left ticked, never reused).
