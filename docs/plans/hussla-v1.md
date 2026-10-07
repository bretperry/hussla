# Hussla v1: a self-hosted job-search tracker

Bret tracks a job search across dozens of companies while agents on other computers search,
research, apply and draft follow-ups. Hussla is the one place all of it lands: a page per job
(description, contacts, reviews, follow-up email, résumé sent, activity) and a page per company
(quick take, stats, money, facts, anecdotes, news, reviews, contacts, call button, editable
emails sent through the server). It runs on Bret's NAS in Docker as one Go binary serving a React app; Tailscale gives him password-free
access from his own devices; agents use per-device keys. Email goes out through a provider
adapter (iCloud, Gmail, Outlook, Yahoo, Fastmail, Zoho, any SMTP server, Resend, Postmark,
SendGrid, Mailgun), only after Bret approves each message, at a human pace. Setup must work for a
non-technical person: one Tailscale key in the NAS's Docker screen, everything else in a
first-run wizard in the browser.

Done looks like: Bret opens `https://hussla.<tailnet>.ts.net` on his phone, sees his jobs and
companies, edits and approves a follow-up, and it arrives from his own address.

Deliberately not building: multi-user accounts (one owner per install; agents are keys), a
public internet exposure (tailnet only; an optional API-only Funnel), automatic sending without
approval, Postgres (SQLite in a Docker volume is enough for one person), an email inbox reader.

A working prototype exists (plain JS, same features minus provider adapters and the wizard):
`/mnt/project-files/tracker/app` in the Bizzness project. Port its behavior, not its code
shape. Its seed bundle (`seed/seed.json`: jobs, companies, answers, events) is the import format.

| Phase | What | After | Model | State |
|---|---|---|---|---|
| 0 | Repo from template, stacks (Go, TypeScript, React, infra), placeholders, architecture | —; repo created by Bret | quick (low) | running |
| 1 | Go domain types, pure rules, knobs; API contract (OpenAPI) and generated UI types | 0 | deep (high) | |
| 2 | Storage ports, SQLite adapters, migrations, seed import | 1 | workhorse (high) | |
| 3 | HTTP API, auth (Tailscale identity, agent keys), use-cases | 2 | deep (xhigh) | |
| 4 | Mail port, provider catalog, adapters, secret store, outbox pacing | 1 | deep (high) | |
| 5 | React UI: jobs, job, companies, compare, company, outbox, answers, activity, settings | 1 | workhorse (medium) | |
| 6 | First-run wizard, Docker image, compose with Tailscale, non-techy install guide | 3, 4, 5 | workhorse (medium) | |
| 7 | Install on the NAS and accept on phone | 6; NAS model, Tailscale account | — (human) | |

## Phase 0 — Repo setup

**Model:** quick · **Thinking:** low — mechanical template steps; every mistake fails `pnpm check`.

**Goal:** a whippletree project named Hussla with only the Go, TypeScript, React and infra packs;
the Go module is `github.com/bretperry/hussla` (`docs/decisions/0008-go-server.md`).
**Applies:** `docs/guide/getting-started.md` §1–4; `docs/decisions/0002-stack-packs.md`.
**Files:** `package.json` name, `AGENTS.md` placeholders and Stack, `CHANGELOG*.md`,
`.cursor/rules/architecture.mdc` (Hussla bullets), `docs/ports-and-adapters.md` (why ports here),
`README.md` (product readme), removal of the template's note-sync demo (Go and TypeScript),
`go.mod` module path, `internal/*/doc.go` and `internal/domain/slug.go` (so each layer has code
the Go gates can plant into).
**Tests:** `pnpm check`.
**Done when:**
- Only go, typescript, react, infra packs remain → verify: `pnpm stack:list`
- No `{{…}}` placeholders outside `docs/guide` → verify: `grep -rnIE '[{][{][A-Z_]+[}][}]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=guide .` prints nothing
- Checks green → verify: `pnpm check`

## Phase 1 — Domain and contracts

**Model:** deep · **Thinking:** high — every later phase builds on these shapes; a wrong field or state transition becomes hundreds of wrong lines.

**Goal:** the Go domain for jobs, companies, contacts, reviews, emails, answers and events, the
pure rules, the knobs, and the API contract the UI is generated from.
**Applies:** `architecture.mdc` (writes are patches; knobs), `go.mdc`, `testing-go.mdc`, `testing.mdc`.
**Files:** `internal/config/{statuses,mail}.go` (status list, pacing knobs),
`internal/domain/{job,company,contact,review,email,answer,event,text,pacing,patch}.go`,
`api/openapi.yaml` (every route, request and response shape), `src/shared/api-types.ts`
generated from it (`pnpm api:types`, checked for drift in `pnpm check`).
Rules: job status set and transitions that set `appliedAt`; patch merge (fields named in the
patch only; `followup` merges by key; `null` clears); company summary (best fit, top pay, average
rating over 5-point review sources, health rank, layoffs count); email state machine
(`draft → approved → sending → sent | failed`, `draft|approved|failed → canceled`, editing an
approved email returns it to draft); pacing decision `CanSendNow(now, lastSentAt, sentToday, knobs)`
(window hours in a time zone, minimum gap plus jitter, daily cap); markdown-to-plain for email
bodies; address list parsing and validation.
**Tests:** table tests + `rapid` properties: patch never drops unnamed fields; pacing never allows
two sends inside the gap or more than the cap per local day; state machine rejects every
undeclared transition.
**Done when:**
- Rules covered → verify: `pnpm go:test` green
- Domain imports nothing outside the standard library → verify: `pnpm go:lint` and `pnpm go:gates`
- UI types match the contract → verify: `pnpm api:types && git diff --exit-code src/shared/api-types.ts`

## Phase 2 — Storage

**Model:** workhorse · **Thinking:** high — a bad migration or mapping silently loses Bret's data.

**Goal:** repositories behind ports, SQLite via a pure-Go driver (`modernc.org/sqlite`, no cgo),
forward-only migrations embedded with `embed`, and an idempotent import of the prototype's `seed.json`.
**Applies:** `architecture.mdc` (storage behind ports; one unit of work per write).
**Files:** `internal/app/*/ports.go` (jobs, companies, events, answers, files, tokens, settings,
emails), `internal/adapters/sqlite/*.go`, `internal/adapters/sqlite/migrations/*.sql`,
`internal/app/importseed/`, `internal/testsupport/fakes/*`.
**Tests:** one contract suite run against SQLite (temp file) and the in-memory fakes;
migration from empty and from the prototype's schema; import twice = same rows.
**Done when:**
- Contract suite green on both → verify: `pnpm go:test`
- Prototype DB opens and upgrades without loss → verify: test `TestMigratesPrototypeDB`

## Phase 3 — API and auth

**Model:** deep · **Thinking:** xhigh — auth and CSRF mistakes are silent and expose Bret's data.

**Goal:** the JSON API (parity with the prototype's `AGENTS.md`, plus company profile, news and
company emails), use-cases, and the composition root.
Auth: Tailscale Serve identity headers trusted only from loopback and only for `ALLOWED_USERS`;
agent bearer keys (hashed, revocable, named in the activity log); browser writes need the
`X-Hussla` header; agent keys cannot approve email, delete, change settings or manage keys.
A token-only API listener for an optional Funnel.
**Files:** `internal/httpapi/*` (add its depguard rule and gates entry: imports `internal/app`
and `internal/domain`, never an adapter), `internal/app/*`, `cmd/hussla/main.go` (composition
root, serves the built UI from `embed`), `docs/agents-api.md` (served at `/api/docs`).
**Tests:** route tests through the real router with fakes; auth matrix (no identity, wrong user,
spoofed header from non-loopback, agent on user-only routes, missing CSRF header) all refused.
**Done when:**
- Auth matrix green → verify: `go test ./internal/httpapi/...`
- Prototype API calls work unchanged → verify: test `TestAgentsDocExamples` replays every curl in the doc

## Phase 4 — Mail

**Model:** deep · **Thinking:** high — a mail bug sends the wrong thing to a recruiter, or leaks a password.

**Goal:** `MailSender` port; provider catalog in `internal/config` (id, label, kind smtp|api, host, port,
security, username hint, help steps, app-password URL, daily limit); adapters: SMTP
(`net/smtp`-style client over `crypto/tls`: STARTTLS/TLS, AUTH PLAIN/LOGIN) used by every SMTP preset and "Other SMTP", and HTTP adapters for
Resend, Postmark, SendGrid, Mailgun; secrets encrypted at rest (AES-256-GCM, key file in the data
volume, never logged, never returned by the API); outbox dispatcher using the Phase 1 pacing rule;
a "send test" use-case.
**Files:** `internal/config/mailproviders.go`, `internal/app/outbox/`, `internal/app/mailsetup/`
(ports `MailSender`, `SecretStore`), `internal/adapters/{smtpmail,resend,postmark,sendgrid,mailgun}/`,
`internal/adapters/secretfile/`.
**Tests:** SMTP adapter against an in-process fake server (STARTTLS, auth failure, dot-stuffing,
UTF-8 subject); HTTP adapters against `httptest.Server`; dispatcher under `testing/synctest` (retries, cap,
window, crash mid-send returns to queue); secret store round-trip and wrong-key failure.
**Done when:**
- Adapter and dispatcher suites green → verify: `pnpm go:test`
- No secret in any API response or log line → verify: test `TestSecretsNeverLeave`

## Phase 5 — UI

**Model:** workhorse · **Thinking:** medium — visible work, reviewed with screenshots.

**Goal:** Vite + React SPA with the prototype's pages and look, plus: company page (quick take,
stat tiles, money, facts, anecdotes, news, reviews, contacts with call and email links, editable
follow-up drafts per job and a new-email composer, sent/queued history), companies table with
sorting and a 2–4 company side-by-side compare. Works at 390px.
**Applies:** `react.mdc`; architecture "Client state".
**Files:** `src/features/{jobs,companies,outbox,answers,activity,settings}/`, `src/shared/ui/*`,
`src/shared/api.ts` (typed client over the generated `api-types.ts`), `index.html`, `vite.config.ts`;
dev server proxies `/api` to a local Go server.
**Tests:** component tests for the email editor (save, approve confirm, inferred-address warning,
placeholder warning) and the compare table sort.
**Done when:**
- Component tests green → verify: `pnpm test src/features`
- Screens match on desktop and phone → verify: Playwright screenshots attached to the PR

## Phase 6 — Setup and packaging

**Model:** workhorse · **Thinking:** medium — the bar is a non-technical person finishing setup alone.

**Goal:** first-run wizard (your name and email; pick an email provider from the catalog with
its steps and a link to its app-password page; paste the password; send a test; make the first
agent key), Docker image (one static binary on a distroless base, non-root, healthcheck), `docker-compose.yml` with a
Tailscale sidecar where the only required value is `TS_AUTHKEY`, and an install guide with
Synology Container Manager steps written for a non-technical reader.
**Files:** `src/features/setup/`, `internal/app/setup/`, `Dockerfile` (multi-stage: Node builds the
UI, Go builds a static binary, final stage distroless non-root),
`docker-compose.yml`, `tailscale/serve.json`, `docs/install.md`.
**Tests:** wizard flow component test; `pnpm infra:docker` (hadolint); container smoke test.
**Done when:**
- Fresh container shows the wizard and finishes it → verify: Playwright run against `docker run`
- Image lint clean → verify: `pnpm infra:docker`

## Phase 7 — Install and accept

**Model:** — (human)

**Human checks**
- `hussla-p7-phone` · iPhone · 5 min · deploy — With Tailscale on, open the Hussla address on your phone. It opens signed in, with your jobs.
- `hussla-p7-mail` · iPhone · 5 min · deploy — In Settings, send a test email. It arrives in your inbox from your address.
- `hussla-p7-followup` · Mac · 10 min · deploy — On a company page, edit a follow-up, approve it to yourself as the recipient, and confirm it arrives as written.
