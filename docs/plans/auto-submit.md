# Auto-submit: the search agent sends applications on Greenhouse, Lever and Ashby

Today the search routine (a Claude routine in the cloud, three runs a day) writes each job into
Hussla as a ready-to-send pack: the résumé variant, the form answers, a short note. The owner opens
the posting, uploads, pastes and clicks Submit, about two minutes a job. Most startups post on
Greenhouse, Lever or Ashby, whose forms are public and need no account, so a cloud browser can fill
and submit them. This plan lets it, behind the same kind of gate the outbox puts on email: the owner
approves what goes out, either one application at a time or by a standing rule they switch on, and
Hussla, not the agent, decides whether a given application may leave.

Done looks like: the owner turns **Review first** off for Greenhouse jobs scoring 85 or more; the
next run submits two of them, each job page shows the filled form and the confirmation page as
screenshots, and the ATS's confirmation emails arrive in the owner's inbox. Nothing was sent twice,
and the one form that showed a CAPTCHA is in **Waiting** with a note.

**Trust ladder.** The owner climbs it one rung at a time; each rung is a setting, not a code change:

1. **Packs** (today): the agent prepares, the owner submits by hand.
2. **Rehearse**: the agent fills the real form, screenshots it, and stops before Submit.
3. **Approve each**: the owner approves a batch with one passkey tap; the next run submits them.
4. **Auto**: jobs that match the owner's rule are submitted without asking, after a veto window,
   under a daily cap. Everything else stays at rung 3.

Deliberately not building, ever: LinkedIn Easy Apply (its terms ban automation and it risks the
owner's account); Workday or any site that needs a new account or a sign-in; solving or routing
around a CAPTCHA; entering SSN, bank details, ID numbers or date of birth; submitting from a
browser on the owner's own computer. Not building now: other ATSs (Workable, SmartRecruiters,
company-hosted forms), cover letters written per job beyond the pack's short note, reading the
owner's inbox to confirm submissions.

## Shape (read before any phase)

- **Hussla is the gate; the routine is the hands.** The browser runs in the routine's cloud
  environment (Chromium and Playwright are preinstalled there). Hussla never runs a browser. It
  holds the policy, the approvals, the fill plan and the evidence, and hands out one application at
  a time through a claim.
- **The fill plan is what gets approved.** Per job, the agent writes an *application*: the form's
  URL and ATS, the résumé file, and every field as `{label, kind, value, source}` where source is an
  answer-bank id, the owner's profile, the résumé, or the pack note. Approval binds the plan's
  version, exactly like an email (compare-and-swap; any agent edit bumps the version and voids the
  approval).
- **Policy is evaluated by the server.** `domain.CanAutoSubmit(job, application, policy, now,
  submittedToday)` is a pure rule; the claim endpoint calls it. The agent never decides on its own
  that something may be sent. The policy is owner-only (`PATCH /api/config` already needs a passkey
  tap), typed and validated, not free-form.
- **Never submit twice.** Claim moves `approved → submitting` with a lease (compare-and-swap). The
  agent reports `submitted`, `not-submitted` (stopped before clicking Submit, with a reason) or
  `maybe-submitted` (clicked, no confirmation seen). A lease that expires unreported becomes
  `maybe-submitted`. Only `not-submitted` may go back to the queue; `maybe-submitted` waits for the
  owner (they check the inbox and mark it). Same model as `docs/decisions/0012-mail-delivery.md`.
- **Stop conditions are checked twice.** The filler stops before Submit on: a CAPTCHA challenge,
  a sign-in or account wall, a page leaving the allowed ATS hosts, a required field with no plan
  value, a failed upload, or a field asking for SSN, bank details, ID number or date of birth. The
  server refuses to store or approve a plan that contains a forbidden field (domain rule, by label
  and by value shape), so a filler bug can't carry one through.
- **Pacing.** A daily cap and a minimum gap between submissions, counted from submitted rows (never
  memory), in the owner's time zone, as knobs in `internal/config/autosubmit.go`. A burst of
  applications in one minute reads as a bot to the ATS and to recruiters.
- **Evidence.** Every rehearsal and submission attaches screenshots (filled form, confirmation or
  stop reason) to the job through the existing files API, and logs an activity line as
  `agent:<name>`.

**Why not the ATS APIs:** Greenhouse's application POST, Lever's apply endpoint and Ashby's
`applicationForm.submit` all take the *employer's* API key (inferred from their public docs;
Phase 1 confirms). A candidate has none, so the public form is the only door.

| Phase | What | After | Model | State |
|---|---|---|---|---|
| 0 | Allow the ATS hosts in the routine's cloud environment | — | — (human) | |
| 1 | Research spike: measure the three forms from the cloud (hosts, CAPTCHAs, uploads, form schema, confirmation), synthetic fixtures | 0 | workhorse (high) | |
| 2 | Domain and contract: Application, fill plan, states, policy, forbidden-field rule, knobs; OpenAPI | 1 | deep (xhigh) | |
| 3 | Storage, use-cases, HTTP and MCP: write plan, approve (batch, passkey), claim lease, report, recovery | 2 | deep (xhigh) | |
| 4 | The filler: `inspect`, `rehearse`, `submit` per ATS, stop conditions, fixture tests | 1, 2 | workhorse (high) | |
| 5 | UI: Application section on the job page, Ready to send list with batch approve, Auto-submit settings card | 3 | workhorse (medium) | |
| 6 | Routine run loop and agents guide: claim, fill, report; rehearse mode | 3, 4; agent API on Funnel | workhorse (medium) | |
| 7 | Climb the trust ladder on real jobs | 5, 6 | — (human) | |

## Phase 0 — Allow the ATS hosts

**Model:** — (human)

The routine's environment blocked these hosts on 2026-10-07 (the proxy answered 403 to curl and
Playwright; only the WebFetch tool got through). Only the owner can change an environment's network
allowlist (claude.ai → the routine's environment → Network). Start with this list; Phase 1 measures
the complete one and the owner adds what it finds:

- `boards.greenhouse.io`, `job-boards.greenhouse.io`, `boards-api.greenhouse.io`
- `jobs.lever.co`, `api.lever.co`
- `jobs.ashbyhq.com`, `api.ashbyhq.com`

**Human checks**
- `autosubmit-p0-hosts` · decision · 5 min · none — Add the hosts above to the routine environment's allowlist. A session in that environment can `curl -sI https://job-boards.greenhouse.io` and gets an HTTP status, not a proxy 403.

## Phase 1 — Research spike: the three forms, measured

**Model:** workhorse · **Thinking:** high — no code ships, but every later phase builds on these answers; a wrong one becomes a filler that submits blind.

**Goal:** answer the open questions below *into this plan* (edit the phase sections that depend on
them) and leave synthetic fixtures the filler is tested against. Nothing is submitted in this phase.
**Applies:** `docs/install-lessons.md` (Agents and the job search); the scam and never-enter rules in `docs/agents-api.md`.
**Research:**
- Read: `docs/agents-api.md`, `docs/decisions/0012-mail-delivery.md`, each ATS's candidate-facing
  terms and public developer docs.
- Pick three live public postings per ATS, at companies already in the tracker. Load each with
  Playwright from the routine's environment (headless Chromium), record every host the page
  requests, fill it from a throwaway profile, screenshot, and **stop before Submit**.
- Open questions:
  1. The complete host list each form needs (assets, upload storage, CAPTCHA script hosts). Hand
     the additions to the owner for Phase 0.
  2. Which forms load a CAPTCHA, which kind (visible challenge, invisible score), and whether an
     invisible one blocks a headless browser from a datacenter address. If invisible scoring
     silently drops submissions, say so: it changes whether rung 4 is safe for that ATS at all.
  3. Where each form's schema can be read without a browser (Greenhouse's job board API with
     `?questions=true`, Ashby's posting API, Lever's apply page HTML), and whether it lists every
     custom question, the required flags and the option lists.
  4. How the résumé is uploaded (direct multipart, a presigned upload to another host, a parse step
     that pre-fills fields and must be corrected).
  5. What proves a submission: the confirmation page's text or URL, and the confirmation email's
     sender and subject per ATS.
  6. Duplicate handling: what each ATS does when the same email applies twice to one posting.
  7. Whether the employer-key claim in Shape holds for all three (their apply APIs need the
     employer's key).
  8. Anything in the candidate-facing terms of the three that forbids automated submission. If one
     does, that ATS is dropped from this plan.
  9. Company career pages that embed the form (an iframe on the company's site): can the filler
     always use the ATS-hosted URL instead?
**Files:** `docs/reference/ats-forms.md` (findings per ATS, host list, measured dates);
`agents/apply/fixtures/<ats>/*.html` saved form pages with every real company name, job text and
person replaced by synthetic ones (this repo is public).
**Tests:** none; this phase ships findings and fixtures.
**Done when:**
- Every open question has an answer with its evidence (a screenshot, a request log, a doc link) → verify: read `docs/reference/ats-forms.md`; each numbered question has a dated answer
- The dependent phases are edited to match the findings → verify: `git diff docs/plans/auto-submit.md` touches Phases 2, 4 and 6
- Fixtures carry no real names → verify: `grep -rniE '<the three companies used>' agents/apply/fixtures` prints nothing

## Phase 2 — Domain and contract

**Model:** deep · **Thinking:** xhigh — the states and the policy rule decide whether something is sent in the owner's name; a wrong transition is silent until a duplicate or unwanted application goes out.

**Goal:** the pure rules and the API shapes for applications and the auto-submit policy.
- `Application` per job: `ats` (`greenhouse`, `lever`, `ashby`), `formUrl`, `resume` (file name
  from `GET /api/resumes`), `fields[]` of `{label, kind, value, source, sourceId?}`, `note`,
  `version`, `status`, `approvedBy` (`owner` or `policy`), `approvedAt`, `approvedVersion`,
  `claimedAt`, `leaseUntil`, `submittedAt`, `stopReason`, `evidence[]` (file ids).
- Statuses: `draft → approved → submitting → submitted`; `submitting → not-submitted → approved`
  (retry, until a knob's attempt limit); `submitting → maybe-submitted` (owner resolves to
  `submitted` or `not-submitted`); `draft`/`approved → withdrawn`. Every change is a conditional
  update. An agent edit to an `approved` plan bumps the version and returns it to `draft`.
- `AutoSubmitPolicy` (owner-only, under `autoSubmit` in config): `mode` (`packs`, `rehearse`,
  `approve`, `auto`; default `packs`), `ats[]`, `minScore`, `workTypes[]`, `vetoHours` (a job must
  have been found at least this long ago, so the owner can skip it from the phone first),
  `dailyCap`. The UI's **Review first** switch is `mode != auto`.
- `CanAutoSubmit(job, app, policy, now, submittedToday, lastSubmittedAt)` returns allowed or the
  first reason it isn't (paused, mode, ATS, score, work type, veto window, job status not `queued`
  or `review`, scam flags present, cap, gap, unanswered required field). Reasons are an enum so the
  UI and the agent can show them.
- Forbidden fields: a plan is invalid if any label matches the forbidden list (SSN, social
  security, bank, routing, account number, date of birth, birth date, driver's license, passport,
  national ID) or any value looks like an SSN or a full date of birth. The list is a knob.
- Voluntary self-identification questions (gender, race, veteran, disability) default to the
  ATS's "decline to answer" option unless the answer bank has the owner's own answer.
- Knobs in `internal/config/autosubmit.go`: daily cap, minimum gap, lease length, attempt limit,
  default veto hours, forbidden-label list.
**Applies:** `docs/decisions/0009-api-contract-and-patch-shape.md`, `0011-connection-identity-and-passkey-step-up.md`, `0012-mail-delivery.md`, `0007-single-owner.md`; `docs/learnings/api-tests-mocked-contract-shapes.md`.
**Files:** `internal/domain/application.go`, `internal/domain/autosubmit.go`,
`internal/config/autosubmit.go`, `api/openapi.yaml` (schemas and the routes Phase 3 serves),
generated UI types.
**Tests:** table tests for every allowed and refused transition; property test: no sequence of
agent operations reaches `submitting` without an owner approval or `CanAutoSubmit` allowing it,
and none reaches `submitting` twice for one version; forbidden-field rule on labels in several
spellings and on value shapes; `CanAutoSubmit` reason for each refusal.
**Done when:**
- Rules covered → verify: `pnpm go:test` (the domain package's new tests pass)
- Contract and generated types agree → verify: `pnpm check` (generated-file drift is part of it)

## Phase 3 — Storage, use-cases, HTTP and MCP

**Model:** deep · **Thinking:** xhigh — authorization, compare-and-swap claims and lease recovery; a mistake here sends twice or lets an agent approve itself.

**Goal:** the server side of the gate.
- Migration: an `applications` table (one row per job; version, status, lease), forward-only.
- Routes (agent key unless noted; each also an MCP tool):
  - `PUT /api/jobs/{id}/application`: write or replace the plan. Refuses forbidden fields.
  - `POST /api/applications/approve` (**owner, passkey**): `{items: [{jobId, version}]}`, one tap
    for the whole batch (`docs/learnings/ui-one-passkey-prompt-per-click.md`); each item is its
    own compare-and-swap and the answer lists which ones changed since the owner looked.
  - `POST /api/applications/claim`: returns the next application that is owner-approved, or that
    `CanAutoSubmit` allows (then stamped `approvedBy: policy` with the policy's version in the
    activity log), moving it to `submitting` with a lease. Returns nothing while paused, outside
    pacing, or in `packs`/`rehearse` mode. In `rehearse` mode a separate
    `POST /api/applications/rehearsal` claim hands out drafts without moving them.
  - `POST /api/applications/{jobId}/result`: `{version, outcome, reason?, evidence[]}`. `submitted`
    sets the job to `applied` with `resumeSent` and `appliedAt`; `not-submitted` with a CAPTCHA or
    account reason sets the job to `waiting` with a `nextAction`.
  - `POST /api/applications/{jobId}/resolve` (**owner, passkey**): settle a `maybe-submitted`.
- Recovery at startup and on each claim: an expired lease becomes `maybe-submitted`.
- `PATCH /api/config` validates the `autoSubmit` block against the domain type.
**Applies:** as Phase 2; `docs/decisions/0014-mcp-endpoint.md`.
**Files:** `internal/app/applications/`, `internal/adapters/sqlite` (migration, repository),
`internal/httpapi`, `internal/mcpapi`.
**Tests:** router-level: an agent key gets 403 on approve and resolve; approve with a stale version
answers "changed since you read it"; two concurrent claims never return the same application; an
expired lease is `maybe-submitted`, never back in the queue; a result for an old version is
refused; claim returns nothing while `paused`; every answer checked against `api/openapi.yaml`.
**Done when:**
- Gate behaves as specified → verify: `pnpm go:test`
- Agents can't approve → verify: the router test for an agent key on `/api/applications/approve` passes
- Everything green → verify: `pnpm check`

## Phase 4 — The filler

**Model:** workhorse · **Thinking:** high — the code is ordinary, but a fill that looks done and isn't (a dropped upload, a silently rejected submit) fails silently.

**Goal:** a small command-line tool the routine runs, with one adapter per ATS.
- `inspect <url>`: reads the form schema (from the ATS's public data where Phase 1 found it,
  otherwise the page) and prints JSON fields the agent maps to answers.
- `rehearse <plan.json>`: fills the form, screenshots the whole page, stops before Submit, prints
  a result.
- `submit <plan.json>`: as rehearse, then submits, waits for the confirmation signal Phase 1
  named, screenshots it, prints `submitted`, `not-submitted` (with reason) or `maybe-submitted`.
- Stop conditions (Shape) are checked before any click on Submit. Navigation off the allowed hosts
  aborts. No retries after the Submit click.
- Uses the repo's `playwright-core` with the environment's Chromium; no new browser download.
**Research:** where the tool lives and how it runs (`agents/apply/` as TypeScript run by Node, or a
pnpm workspace package) so the TypeScript pack's typecheck, lint and tests cover it. Decide in the
phase, note it here.
**Applies:** `typescript.mdc`, `testing-ts.mdc`, `testing.mdc`; Phase 1's `docs/reference/ats-forms.md`.
**Files:** `agents/apply/` (cli, `greenhouse.ts`, `lever.ts`, `ashby.ts`, `stops.ts`), fixtures from Phase 1.
**Tests:** against the saved fixtures served locally: each ATS fills every field kind, uploads the
résumé, and produces the right result; each stop condition (CAPTCHA, account wall, off-host
redirect, forbidden field, missing required value, failed upload) stops before Submit; a plan with
a field the form doesn't have is reported, not ignored.
**Done when:**
- Fixture tests pass → verify: `pnpm test agents/apply`
- No Submit click on any stop path → verify: the stop-condition tests assert the Submit handler was never called
- Everything green → verify: `pnpm check`

## Phase 5 — UI

**Model:** workhorse · **Thinking:** medium — screens over a finished API; mistakes show on screen.

**Goal:**
- **Job page → Application:** the plan as a question/answer list with each answer's source, the
  résumé file, rehearsal and submission screenshots, status, stop reason, and Approve (one tap).
  For `maybe-submitted`: "Check your inbox for a confirmation from <ATS>", then Mark submitted /
  Not submitted.
- **Ready to send:** every `draft` application with a complete plan, newest first, checkboxes,
  and one **Approve selected** button (one passkey tap). Linked from the front page with a count.
- **Settings → Auto-submit:** the four rungs as a choice, **Review first** as the plain switch for
  rung 4, the rule (ATS, minimum score, work types, veto hours, daily cap), and today's count.
  Changing it is one passkey tap.
**Applies:** `react.mdc`; `docs/learnings/ui-one-passkey-prompt-per-click.md`, `api-tests-mocked-contract-shapes.md`.
**Files:** `src/features/applications/`, the job page in `src/features/jobs/`, `src/features/settings/`.
**Tests:** component tests: approve sends the version it showed; a "changed since you read it"
answer re-renders the new plan; batch approve is one passkey prompt; Review first on hides the
rule fields and shows rung 3 behavior; screenshots render through the files API.
**Done when:**
- Screens covered → verify: `pnpm test src/features/applications src/features/settings`
- Everything green → verify: `pnpm check`

## Phase 6 — Routine run loop and agents guide

**Model:** workhorse · **Thinking:** medium — prose and a prompt; Phase 7 shows whether it works.

**Goal:** the routine's prompt and `docs/agents-api.md` gain an **Applying** section:
1. After the search, for each new job on an allowed ATS: `inspect`, map every field to the answer
   bank (an unanswered required question follows the existing rule: add it unanswered, job to
   `waiting`), `PUT` the plan.
2. In `rehearse` mode: claim rehearsals, `rehearse`, upload the screenshots, log.
3. Otherwise: `claim` until it returns nothing; for each, `submit`, upload evidence, report the
   result. Never submit anything not handed out by a claim.
4. Log one run summary event: planned, rehearsed, submitted, stopped (by reason).
**After gate:** the key-only agent API reachable from the cloud on Funnel (being built in the
NAS-setup work); the résumé files must be readable over it.
**Files:** `docs/agents-api.md`, the routine prompt (kept in `docs/agents/search-routine.md` so it
is reviewed like code), `CHANGELOG.md`.
**Tests:** none beyond `pnpm docs:commands` for any bash block.
**Done when:**
- The guide and prompt describe the loop and the stop rules → verify: read `docs/agents-api.md` → Applying
- Docs checks pass → verify: `pnpm check`

## Phase 7 — Climb the trust ladder

**Model:** — (human)

**Human checks**
- `autosubmit-p7-rehearse` · decision · 20 min · none — Set Auto-submit to Rehearse for one run. Compare five rehearsal screenshots with the postings: every answer is right and nothing was submitted.
- `autosubmit-p7-approve` · iPhone · 10 min · none — Set it to Approve each and approve three applications in one tap. After the next run each job is Applied, and each ATS's confirmation email is in your inbox.
- `autosubmit-p7-stop` · decision · 10 min · none — Find a job the run stopped on (CAPTCHA, account, or unanswered question). It is in Waiting with a note that says why, and its screenshot shows the form unsent.
- `autosubmit-p7-auto` · decision · 1 week · none — Turn Review first off for one ATS with a high minimum score and a small daily cap. For a week, every auto-submitted job is one you would have approved; if one isn't, raise the score or go back to Approve each.

## Risks and what would change this plan

- **Invisible CAPTCHA scoring** may make cloud submissions vanish without an error. Phase 1
  measures it; if it does, that ATS stays at rung 3 or drops out, and the confirmation email is the
  only proof.
- **Résumé parsing** on upload can overwrite typed fields; the filler fills after the parse step.
- **Policy trust rests on the agent's score.** The veto window and the daily cap bound the damage
  of a bad score; the owner can pause everything from the phone.
- **Rejected alternative:** a browser inside the Hussla container on the NAS (a home address
  would look less like a bot). It puts Chromium and a submission engine inside the one place that
  holds the owner's secrets, and the NAS may be asleep or slow; revisit only if Phase 1 shows
  cloud addresses are blocked.
