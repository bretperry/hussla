# Human checks outside any plan

What to verify on prod right after a ship (`prod-`), and repo-wide calls (`ci-`). Same block
format as a plan phase (`plans.mdc` → Human checks). Never reuse or rename an id: ticks are keyed on it.
The stations and gates a check may name are in `docs/human-checks.json`; the wrangler compiles
these, every plan's, and every runbook's into one checklist (`wrangler.mdc` → Human checks).

Per ship: add the `prod-` checks that ship needs and leave last ship's in place.

<!-- ## Ship YYYY-MM-DD (dev → main)

**Human checks**
- `prod-still-signed-in` · prod · 2 min · deploy — After deploy, phone and web are still signed in. -->
