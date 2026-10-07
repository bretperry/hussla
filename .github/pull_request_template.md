<!-- Feature PRs go into `dev`. Only `dev` merges into `main` — that one ships to production.
     Open as a draft (`gh pr create --draft`); mark ready when the expensive CI signal is wanted. -->

## What and why

<!-- The problem, not just the change. -->

## Verification

<!-- What you actually ran or observed. "CI is green" is fine if that is genuinely the whole story. -->

**Tested by:** <!-- each behavior this adds, and its one tier (testing.mdc): a test path, a runbook
scenario (docs/runbooks/<area>.md#n), or a Human check id. "none: no behavior change" for docs or
refactors. A PR that adds behavior with no line here fails review. -->

---

<!-- Delete this section unless this is a `dev` → `main` ship PR. -->
## Shipping to production

- **Contents:** <!-- every user-visible change in this deploy, not just the newest one -->
- **Migrations:** <!-- yes (and whether they are reversible) / none -->
- **Rollback:** <!-- the exact command -->
- **Post-deploy:** <!-- what to watch, and the prod- human checks this ship adds -->
