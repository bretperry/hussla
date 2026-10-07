# Deploy and rollback runbook

<!-- Template (infra pack). Copy to docs/runbooks/deploy.md, fill every <…>, and delete this comment.
     A `_` file is never linted or compiled into the checklist; the copy is, by `pnpm plans:check`.
     Keep the ids: they are already in the `deploy-rb-<scenario>` shape, and ticks are keyed on them. -->

The manual half of shipping <app> to <cloud / platform>. Everything that can be made deterministic
is a check and runs on every PR: `terraform fmt` / `validate` / `tflint` and `hadolint`
(`pnpm check`, the infra pack), the image build (<CI job>), and <smoke test script>. This file is
what is left: the steps that act on real infrastructure, which only a person runs (`infra.mdc`,
`core.mdc` → Deleting data is a human action), and the checks that need the live environment.

**When to run it.** Scenario 1 on every infrastructure change, before its PR merges. Scenarios 2
and 3 on the first deploy and after any change to the deploy workflow, the Dockerfile, or the
runtime config. Scenario 4 after any change to staging or its teardown. Scenario 5 once a quarter.
Not a per-PR gate: the deterministic suite is.

**What you need.** Cloud console access for <account / project>, the repo's Actions tab, <the
production URL and its health endpoint>, and about 30 minutes for the whole file.

```bash
# The read-only view every scenario starts from: what Terraform would change right now.
cd <infra dir> && terraform init && terraform plan
```

---

## Why these are not tests

Each scenario names the thing a test cannot reach. If a scenario stops having one (a seam appears
that makes it deterministic), it leaves this file and becomes a test, because a runbook step only
gets run when it is on the checklist.

Every scenario carries exactly one Human check id (`plans.mdc` → Human checks), so the wrangler's
compiled checklist asks for it. `pnpm plans:check` fails a scenario without one. Never reuse or
rename an id, because ticks are keyed on it.

---

## 1. Apply an infrastructure change

**Human checks**
- `deploy-rb-apply` · decision · 15 min · deploy — Apply the reviewed infra change. Run scenario 1 of `docs/runbooks/deploy.md`: the apply changes exactly what the PR's plan showed, and nothing is destroyed that the PR didn't name.

**Not testable because:** `terraform apply` acts on the real account, and the guard refuses it to
agents. `terraform validate` and `tflint` in CI cover the configuration; this covers the account.

1. Read the plan in the PR: every `destroy` or `must be replaced` line is named and explained there.
2. On the PR's merge commit, run `terraform plan -out=tfplan` in `<infra dir>` and compare it with
   the PR's plan. Different resources, or a new destroy: stop and ask the author.
3. `terraform apply tfplan`. Applying the saved plan means you apply what you just read.
4. Run `terraform plan` again: "No changes."

**Expected:** the apply lists the same adds, changes, and destroys as the plan; the second plan is empty.

**If it fails:** a partial apply leaves real resources half-changed. Don't re-run blindly: read the
error, run `terraform plan` to see where it stopped, and fix forward in a PR. Never `state rm` to
get past an error; that orphans the resource (it keeps running and billing, untracked).

---

## 2. Forward deploy

**Human checks**
- `deploy-rb-forward` · prod · 10 min · deploy — Deploy and watch it serve. Run scenario 2 of `docs/runbooks/deploy.md`: the health endpoint reports the new commit and the smoke test is green.

**Not testable because:** it needs the real platform, the real DNS and TLS, and the real secrets.
The image build and <smoke test script> are the deterministic half.

1. Merge to `main` (the ship), or run the deploy workflow by hand on `main`.
2. Watch the run: it authenticates with OIDC (no stored cloud keys), then builds, pushes, migrates
   (if the project has migrations), rolls out, and smoke-tests.
3. Open `<health URL>`: it reports the commit SHA you just merged.
4. Sign in and do one real write; reload; it is still there.

**Expected:** a green run, the new SHA on the health endpoint, and a write that survives a reload.

**If it fails:** the run log's first red step. A failed rollout leaves the old tasks serving; a
failed migration needs scenario 3 before anything else.

---

## 3. Roll back to the previous image

**Human checks**
- `deploy-rb-rollback` · prod · 10 min · deploy — Roll back to the last good image. Run scenario 3 of `docs/runbooks/deploy.md`: the health endpoint reports the earlier commit and the app serves.

**Not testable because:** a rollback redeploys an image already in the real registry onto the real
service. CI can't run it without deploying production.

1. Find the last good image tag: the SHA of the deploy before the bad one (`<registry>` or the
   deploy run's log).
2. Run the deploy workflow by hand with `<rollback input>=<sha>`. A rollback skips the build and
   the migration: it only redeploys that image.
3. Open `<health URL>`: it reports the rolled-back SHA.
4. If the bad deploy ran a migration, check the older image still reads the schema (`<check>`).
   A migration that dropped or rewrote data is not undone by a rollback; that restore is a human
   decision with its own command (`core.mdc`).

**Expected:** the earlier SHA serves within <n> minutes; no data written since the bad deploy is lost.

**If it fails:** the platform's deployment events (`<console path>`). An image missing from the
registry means the lifecycle policy expired it: keep at least the last <n> images.

---

## 4. Staging stands up and tears down

**Human checks**
- `deploy-rb-staging` · decision · 20 min · none — Stand staging up, then let the nightly teardown take it down. Run scenario 4 of `docs/runbooks/deploy.md`: staging serves, then is gone the next morning, and production was never touched.

**Not testable because:** it creates and deletes real resources on a schedule. The teardown's
target names are the safety, and only a real run shows what it deletes.

1. Start staging (`<staging workflow>` with `action=deploy`) and open its URL.
2. Read the teardown workflow: its target cluster and service names are literals, never `vars.*`
   or a computed name. A teardown that reads repo-level variables can resolve to production and
   delete it (`infra.mdc` → Staging).
3. Next morning: the teardown run is green, staging's URL no longer answers, and production's
   health endpoint still reports the same SHA as before.

**Expected:** staging gone, production untouched, and the bill back to idle.

**If it fails:** if production changed, stop the teardown workflow (disable it) before anything else.

---

## 5. Deploy credentials are short-lived

**Human checks**
- `deploy-rb-oidc` · decision · 10 min · none — Audit the deploy identity. Run scenario 5 of `docs/runbooks/deploy.md`: no long-lived cloud keys exist for CI, and the deploy role trusts only this repo's deploy branch.

**Not testable because:** it reads the real account's identity configuration, which CI's own
role is not allowed to list.

1. In the cloud console, open the role CI assumes (`<role>`): its trust policy names this repo and
   `ref:refs/heads/main` (or the `production` environment), not `repo:<org>/*`.
2. The repo's secrets hold no cloud access keys (`<KEY NAMES>`); the workflow uses OIDC
   (`permissions: id-token: write, contents: read`) and the role's ARN or id only.
3. The identity has no access keys of its own (`<console path>`).

**Expected:** OIDC only, scoped to one repo and one branch or environment.

**If it fails:** a stored key: rotate it out and delete it from the repo's secrets in the same sitting.

---

## Recording what you find

A failure in our code gets fixed and gets a test. A failure on the far side gets an entry in
`docs/deferred.md` with its reasoning. A scenario that turns out to be deterministic after all is
deleted from here and added to the test suite, and its check id is retired (left ticked, never reused).
