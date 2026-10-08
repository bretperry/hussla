# Hussla v1: a self-hosted job-search tracker

Bret tracks a job search across dozens of companies while agents on other computers search,
research, apply and draft follow-ups. Hussla is the one place all of it lands: a page per job
(description, contacts, reviews, follow-up email, résumé sent, activity) and a page per company
(quick take, stats, money, facts, anecdotes, news, reviews, contacts, call button, editable
emails sent through the server). It is one Go binary serving a React app, run in Docker (or as a
plain binary) on whatever the owner has: a laptop, desktop, home server, NAS, or a rented cloud
server. A laptop sleeps and shuts down, so Hussla must stop at any moment and come back clean:
no lost writes, no email sent twice, no burst of queued sends on wake. Tailscale (embedded in
the binary) gives the owner password-free access from their own devices; agents use per-agent keys, through a built-in MCP
endpoint (Claude Code, Claude Desktop, Cursor …) or the plain HTTP API. Email goes out through a provider
adapter (iCloud, Gmail, Outlook, Yahoo, Fastmail, Zoho, any SMTP server, Resend, Postmark,
SendGrid, Mailgun), only after Bret approves each message, at a human pace. Setup must work for a
non-technical person: one Tailscale key in the Docker screen (NAS) or Docker Desktop (laptop),
a setup code from the log, everything else in a first-run wizard in the browser.

Done looks like: Bret opens `https://hussla.<tailnet>.ts.net` on his phone, sees his jobs and
companies, edits and approves a follow-up, and it arrives from his own address.

Deliberately not building: multi-user accounts (one owner per install; agents are keys), a
public internet exposure (tailnet only; no Funnel: a cloud agent joins the tailnet instead), automatic sending without
approval, Postgres (SQLite in a Docker volume is enough for one person), an email inbox reader,
a hosted multi-customer service, and signed native desktop apps (Docker Desktop or the plain
binary covers laptops; code-signing and installers are deferred).

A working prototype exists (plain JS, same features minus provider adapters and the wizard). Its
reference lives in the repo, sanitized: `docs/reference/prototype/` holds its schema
(`schema.sql`), its agent API guide (`agents-api.md`, the parity target), and a synthetic sample of
its seed bundle (`seed-sample.json`, the import format: config, companies, jobs, answers, events).
Port its behavior, not its code shape.

**This repo is public.** Fixtures and test data are synthetic only: never copy the owner's real
seed, database, résumé, pitches or contacts into the repo. The real seed and pitch drafts are
imported at install time from a file the owner picks, never from git.

## Security model (read before Phases 3, 3b, 4, 6)

From two adversarial reviews (2026-10-08, Claude and Codex). Every phase that touches auth or
mail must keep these true and test them.

- **Identity comes from the connection, never from headers.** The binary embeds Tailscale (`tsnet`)
  and calls `WhoIs` on each connection's real peer; no `Tailscale-User-*` header is ever trusted,
  from loopback or anywhere. Requests must carry an allowed `Host` (the ts.net name, or
  `localhost` on the local listener) and, for browser writes and `/mcp`, an allowed `Origin`;
  this also closes DNS rebinding.
- **Owner = the Tailscale user who owns the node.** If the node is tagged (no owning user),
  ownership is claimed once with a one-time setup code printed to the log. A fresh install
  serves only the "enter setup code" screen until the owner is set: fail closed.
- **Local listener (laptop without Tailscale):** `hussla open` reads a one-time token from a
  0600 file in the data dir and opens `http://localhost:<port>/signin?t=…`; the token is
  single-use, expires in 2 minutes, and trades for a HttpOnly, SameSite=Strict session cookie.
  Settings has "sign out everywhere". Loopback alone grants nothing.
- **Agents are keys, and a key is never upgraded.** A request with a bearer key is that agent,
  even from the owner's own device with owner identity; only requests with no key can be the owner.
- **Owner-only actions need a passkey tap.** Approve or send email, delete, change settings,
  manage agent keys, pick a live pitch: the browser signs a WebAuthn user-presence challenge
  (Face ID / Touch ID / phone). An agent on the owner's laptop can reach the owner's tailnet
  identity, but it can't produce that tap. Viewing and editing stay password-free.
- **Approval binds the exact content.** Approve carries the email's version; it's a
  compare-and-swap (`UPDATE … WHERE status='draft' AND version=?`), and every edit bumps the version,
  so an agent edit after the owner looked makes the approval fail with "changed since you read it".
  Every state change is a conditional update.
- **Agent writes are reversible.** Agent patches can't clear (`null`) or overwrite a field the owner
  last wrote; every agent change keeps the prior value in the activity log so the owner can restore it.
- **Untrusted text is never markup.** Descriptions, news, reviews, pitches and emails come from
  agents and scraped pages: one sanitizing markdown renderer with raw HTML off and only
  `http(s)`/`mailto`/`tel` links, a strict CSP from the server (no inline script), and tests that
  `<script>`, event attributes and `javascript:` links are inert.
- **Never send twice.** Retry only failures before SMTP `DATA` (or before an HTTP request is
  written); anything later is `failed` with "may have been sent". A deterministic Message-ID per
  email, and an Idempotency-Key where the provider supports one. One process per data dir
  (exclusive `flock`, second start refuses). Pacing state is derived from sent rows, never memory.
  A `failed` email returns to the queue only by the owner's re-approval (`failed → approved`, with
  the warning shown).
- **Secrets:** the AES key file sits beside the data, so encryption protects a leaked backup or
  log, not someone holding the whole volume; say so in Settings and the install guide.
  CR/LF/NUL are refused in every header field (domain and adapter tests).
- **Time:** store UTC as fixed-width `2006-01-02T15:04:05.000Z`; a `lastSentAt` in the future (clock
  jump) counts as now; embed `time/tzdata`.

| Phase | What | After | Model | State |
|---|---|---|---|---|
| 0 | Repo from template, stacks (Go, TypeScript, React, infra), placeholders, architecture | —; repo created by Bret | quick (low) | QA passed (#1) |
| 1 | Go domain types, pure rules, knobs; API contract (OpenAPI) and generated UI types | 0 | deep (high) | QA passed (#2); stacked on #1 |
| 2 | Storage ports, SQLite adapters, migrations, seed import | 1 | workhorse (high) | |
| 3 | HTTP API, auth (embedded Tailscale, owner enrollment, local sign-in, passkey step-up, agent keys), use-cases | 2 | deep (xhigh) | QA passed (#5); stacked on #3 |
| 3b | MCP endpoint for agents, "Add an agent" setup snippet | 3, 5 | workhorse (high) | |
| 4 | Mail port, provider catalog, adapters, secret store, outbox pacing | 2 | deep (high) | QA passed (#4); stacked on #3 |
| 5 | React UI: jobs, job, companies, compare, company, outbox, answers, activity, settings | 1 | workhorse (medium) | |
| 5b | Pitches: ten honed pitches, dashboard billboard, versions and side-by-side compare | 3b, 5 | workhorse (medium) | |
| 6 | First-run wizard, prebuilt image, no-key no-terminal NAS install, binaries, install guides (NAS, laptop, cloud) | 3, 3b, 4, 5, 5b | workhorse (medium) | |
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
- No `{{…}}` placeholders outside `docs/guide` → verify: `grep -rnIE '[{][{][A-Z_]+[}][}]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=guide --exclude-dir=scripts .` prints nothing
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
`internal/app/importseed/`, `internal/testsupport/fakes/*`. Expect to add `encoding/json`, `io`,
`crypto/sha256` and `log/slog` to the `app` depguard allow list in `.golangci.yml`, each with a why-comment.
Slugs: a collision gets a numeric suffix (`acme-2`), and an empty slug falls back to `company-<n>`.
Ignore the `notesync` examples named in `go.mdc` / `testing-go.mdc`: that demo was removed here.
Crash safety: WAL mode, `synchronous=FULL`, every write and what it implies in one
transaction, so killing the process (laptop lid, power cut) at any instant loses at most the
request in flight; startup runs an integrity check and refuses to serve a corrupt file, pointing
to the latest automatic backup. Backups: daily and before every migration, by `VACUUM INTO` a temp
file, integrity-checked, then renamed; only then prune to the last 7 good ones. The install guides
say to copy backups off the device. Startup refuses a database with migrations this binary doesn't
know (a downgrade), naming the version to run instead.
**Tests:** one contract suite run against SQLite (temp file) and the in-memory fakes;
a kill test: a child process writing in a loop is SIGKILLed at random points and the reopened
database passes the integrity check with every acknowledged write present;
migration from empty and from `docs/reference/prototype/schema.sql` filled with synthetic rows;
import of `docs/reference/prototype/seed-sample.json` twice = same rows; a backup interrupted
midway never replaces a good one.
**Done when:**
- Contract suite green on both → verify: `pnpm go:test`
- Prototype DB opens and upgrades without loss → verify: test `TestMigratesPrototypeDB` (synthetic data)
- Survives being killed mid-write → verify: test `TestKilledMidWriteLosesNothingAcknowledged`

## Phase 3 — API and auth

**Model:** deep · **Thinking:** xhigh — auth and CSRF mistakes are silent and expose Bret's data.

**Goal:** the JSON API (parity with `docs/reference/prototype/agents-api.md`, plus company profile,
news and company emails), use-cases, the composition root, and the auth in the Security model above:
embedded Tailscale (`tsnet`, `WhoIs`), owner enrollment with the setup code, the local listener
and `hussla open`, WebAuthn passkey step-up for owner-only actions, agent bearer keys (hashed,
revocable, named in the activity log, never upgraded to owner), Host and Origin checks.
**Research:** `tailscale.com/tsnet` (state dir in the data volume, auth key from env, tagged-node
detection, `WhoIs`) and a maintained Go WebAuthn library; answer into this plan first.
**Files:** `internal/httpapi/*` (add its depguard rule and gates entry: imports `internal/app`
and `internal/domain`, never an adapter), `internal/app/*`, `internal/adapters/tailnet/`,
`cmd/hussla/main.go` (composition root, serves the built UI from `embed`, `hussla open`),
`docs/agents-api.md` (served at `/api/docs`).
**Tests:** route tests through the real router with fakes, and an auth matrix where every row is
refused: no identity; a non-owner tailnet user; identity headers sent from loopback; a bearer key
plus owner identity on an owner-only route; an owner-only route without a passkey assertion; a
wrong `Host`; a foreign `Origin`; a used or expired sign-in token; any request before the owner is
enrolled except the setup-code screen. Approve with a stale version is refused.
Lifecycle: SIGTERM/SIGINT drain in-flight requests (short timeout); startup to serving in under a
second on a laptop; a second process on the same data dir refuses to start.
**Done when:**
- Auth matrix green → verify: `go test ./internal/httpapi/...`
- Clean stop, fast start, one process per data dir → verify: tests `TestGracefulShutdownAndRestart`, `TestSecondProcessRefused`
- Prototype API calls work → verify: test `TestPrototypeAgentExamples` replays every curl in `docs/reference/prototype/agents-api.md`

## Phase 3b — MCP endpoint for agents

**Model:** workhorse · **Thinking:** high — a tool that takes the wrong action reaches a recruiter or loses data.

**Goal:** a built-in MCP server (Streamable HTTP at `/mcp`, the same agent bearer keys and the same
use-cases as the HTTP API, so permissions can't drift) exposing tools named for what agents do:
find/get/update job, add event, add contact, upsert company profile, add review or news, draft a
follow-up email, list outbox, read answers. No tool approves, sends, deletes, changes settings or
manages keys. Settings gets "Add an agent": name it, get a key, and copy a ready snippet for
Claude Code (`claude mcp add …`), Claude Desktop/Cursor (JSON), or a plain-API prompt.
**Research:** read the current MCP spec (transport, auth header, tool annotations) and pick a
maintained Go MCP library or a minimal stdlib implementation; answer into this plan first.
MCP requests need an allowed `Origin` (the spec requires the check) and a bearer key; no session
cookie or tailnet identity works there.
**Files:** `internal/mcpapi/` (with its depguard rule and gates entry, like `internal/httpapi`),
`src/features/settings/` (Add an agent), `docs/agents-api.md`.
**Tests:** every tool through an MCP client against the real router with fakes; an agent key
can't reach a user-only action by any tool; tool list matches the HTTP API's agent routes.
**Done when:**
- Tools work and refuse what agents may not do → verify: `go test ./internal/mcpapi/...`
- Claude Code connects with the copied snippet → verify: Human check `hussla-p3b-claude-code`

**Human checks**
- `hussla-p3b-claude-code` · Mac · 5 min · none — Run Hussla locally, paste the "Add an agent" snippet into Claude Code, and ask it to add a note to a job. The note appears on the job page.

## Phase 4 — Mail

**Model:** deep · **Thinking:** high — a mail bug sends the wrong thing to a recruiter, or leaks a password.

**Goal:** `MailSender` port; provider catalog in `internal/config` (id, label, kind smtp|api, host, port,
security, username hint, help steps, app-password URL, daily limit); adapters: SMTP
(`net/smtp`-style client over `crypto/tls`: STARTTLS/TLS, AUTH PLAIN/LOGIN) used by every SMTP preset and "Other SMTP", and HTTP adapters for
Resend, Postmark, SendGrid, Mailgun; secrets encrypted at rest (AES-256-GCM, key file in the data
volume, never logged, never returned by the API); outbox dispatcher using the Phase 1 pacing rule;
a "send test" use-case. Follow the Security model's "Never send twice", "Secrets" and "Time"
bullets: retry only before DATA, deterministic Message-ID and Idempotency-Key, pacing from sent
rows, `failed → approved` only by the owner.
**Files:** `internal/config/mailproviders.go`, `internal/app/outbox/`, `internal/app/mailsetup/`
(ports `MailSender`, `SecretStore`), `internal/adapters/{smtpmail,resend,postmark,sendgrid,mailgun}/`,
`internal/adapters/secretfile/`.
**Tests:** SMTP adapter against an in-process fake server (STARTTLS, auth failure, dot-stuffing,
UTF-8 subject, CR/LF/NUL refused in every header, a timeout after the final `.` is not retried);
HTTP adapters against `httptest.Server`; dispatcher under `testing/synctest` (retries, cap,
window, crash mid-send, wake from sleep). Crash mid-send: an email found in `sending` at startup
may or may not have gone out, so it moves to `failed` with "may have been sent: check your Sent
folder" and is never resent without the owner's new approval. Waking after hours asleep sends the
queue at the normal pace, never a burst, and an approval older than the window simply waits; secret store round-trip and wrong-key failure.
**Done when:**
- Adapter and dispatcher suites green → verify: `pnpm go:test`
- No secret in any API response or log line → verify: test `TestSecretsNeverLeave` (through the Phase 3 router)

## Phase 5 — UI

**Model:** workhorse · **Thinking:** medium — visible work, reviewed with screenshots.

**Goal:** Vite + React SPA with the prototype's pages (`docs/reference/prototype/agents-api.md`
lists them) in the brand the owner picked (below), plus: company page (quick take,
stat tiles, money, facts, anecdotes, news, reviews, contacts with call and email links, editable
follow-up drafts per job and a new-email composer, sent/queued history), companies table with
sorting and a 2–4 company side-by-side compare. Works at 390px.
**Brand (picked 2026-10-08): "The Gazette", a designed newspaper; front page is mockup 8c.**
The mockup is board "8c" on the owner's design canvas (private; the build follows this spec, not
the canvas, and the repo carries no copy because the mockup shows the owner's own pitches).
- **Colors:** paper `#FBFAF7`, ink `#121212`, hairlines `#D9D5CC`, secondary text `#555`, and one red
  accent `#C8102E`. Red is used only for urgent or live items (kickers, the awaiting-signature ear) and for
  the nameplate's period, never as a fill. Review & sign is the only solid black button on the page.
- **Type:** Bodoni Moda for the nameplate (112), headlines (lead 56; news and pitch 24–32), the
  pitch quote in italic, and body text (18/28). Libre Franklin for UI text and buttons (13–16).
  IBM Plex Mono for kickers, dates and counts (10–11, caps, tracked). Headlines use `text-wrap:
  balance`, body uses `pretty`, and quotes are curly. Self-host the font files (CSP: no
  Google Fonts call).
- **Grid:** at 1280, 64px margins and 12 columns of 74px with 24px gutters. Hairline column rules
  sit centered in the gutter. Spacing scale is 4/8/16/24/32 only. The same relationship always
  gets the same gap: rule → kicker 8, kicker → headline 8, headline → body 16, body →
  buttons 16, section → section 24. Every section opens with a 2px rule, then a mono kicker.
- **Masthead:** a dateline row (issue number and date, the motto centered, nav on the right). Below it,
  a left ear ("Awaiting your signature": count, a 44px Review & sign button, the companies), the
  nameplate "Hussla." centered, and a right ear (overnight agent counts: applied, reviews,
  profiles, plus "Read the agent wire →"). Then an 8px black rule over a 1px hairline under the title,
  with no rule above it.
- **Body, 8 + 4 columns:**
  - **Lead story (left 8):** kicker, headline, and one body column (about 56 characters a
    line) with an outlined Open/Prep pair. Beside it sits an "<Company> at a glance" fact box
    (valuation, revenue, cash flow, next event) drawn from that company's money fields.
  - **Pitch of the hour (left 8, below the lead):** kicker with `n / 10`; the pitch title and a
    44px Next pitch button on one row; the quote in large italic across the 8 columns; a byline.
    Its box is sized to the longest pitch the config allows, so rotation never reflows the
    page (900ms fade, none under reduced motion). Phase 5b fills it.
  - **Rail (right 4):** latest news (headline, one-line context, date), then "On the board" (the top
    jobs with status tags and an "All N jobs →" link). The rail's second rule sits on the same
    line as the pitch rule.
  - **Bottom:** both columns end on the same line.
- **Phone (390):** the masthead, then the awaiting-signature ear first, the lead, the pitch, news, then the board.
- **States:** Phase 5 designs and builds these.
  - **Day one:** no jobs and no pitches.
  - **No lead story:** the fact box is hidden.
  - **Nothing to sign:** the ear says so, with no button.
- **Tokens:** these live in `src/shared/ui/`, not as literals in features.
**Applies:** `react.mdc`; architecture "Client state".
**Files:** `src/features/{jobs,companies,outbox,answers,activity,settings}/`, `src/shared/ui/*`,
`src/shared/api.ts` (typed client over the generated `api-types.ts`), `index.html`, `vite.config.ts`;
dev server proxies `/api` to a local Go server.
All untrusted text goes through the one sanitizing renderer (Security model); approve and other
owner-only buttons run the passkey step-up.
**Tests:** component tests for the email editor (save, approve confirm, "changed since you read it",
inferred-address warning, placeholder warning), the compare table sort, and the renderer
(`<script>`, `onerror=`, `javascript:` links render inert).
**Done when:**
- Component tests green → verify: `pnpm test src/features`
- Screens work on desktop and phone → verify: Playwright screenshots at 1280px and 390px attached to the PR, no horizontal scroll, no console errors
- Front page matches the 8c spec → verify: a DOM check in the Playwright test that the lead and rail columns end within 4px of each other and that every section's left edge sits on a grid column, plus a stylist pass (finishing passes) on the 1280 screenshot noted in the PR

## Phase 5b — Pitches

**Model:** workhorse · **Thinking:** medium — a self-contained slice; mistakes show on screen.

**Goal:** the owner keeps ten pitches (short, sayable answers that fill silence and steer a
conversation: who I am, why now, why me …) and hones them over time.
- Each pitch has a slot (1–10), a title, a "when to use it" cue, and versions. A version is text,
  its author (the owner, or an agent by key name), a time and an optional note; one version per
  pitch is the live one. Agents (API and MCP) may add versions; only the owner picks the live one
  or deletes.
- **Billboard:** the live versions rotate at the top of the dashboard, under the title, one at a
  time, every few minutes (knob `PitchRotateSeconds`, default 180), with a slow cross-fade and large
  display type: title small above, pitch text large. Pause on hover or focus, click-through to
  the pitch, and no motion under `prefers-reduced-motion` (it switches without the fade).
- **Pitches page:** all ten with their live version; per pitch, the version history and a writer
  for a new version; pick any two versions to compare side by side with a word-level diff, word
  count and speaking time (knob `SpeakingWordsPerMinute`, default 150); make either one live.
- Pitches are part of the seed import format (`pitches: [{slot, title, when, text}]`, version 1
  of each); the owner's own drafts are imported at install, never committed.
**Files:** `internal/domain/pitch.go`, `internal/config/pitches.go`, storage table and migration,
API and MCP routes, `src/features/pitches/`, the dashboard billboard in `src/features/jobs/`.
**Tests:** domain: a pitch always has exactly one live version, slots stay 1–10 and unique, an
agent key cannot set live or delete; component: billboard rotates on a fake timer, pauses on
hover, skips the fade under reduced motion; compare view shows the diff and timing.
**Done when:**
- Rules and screens covered → verify: `pnpm go:test` and `pnpm test src/features/pitches`
- Billboard reads well on desktop and phone → verify: Playwright screenshots attached to the PR

**Human checks**
- `hussla-p5b-billboard` · decision · 2 min · none — Watch the billboard switch twice. It feels calm and weighty, not distracting.

## Phase 6 — Setup and packaging

**Model:** workhorse · **Thinking:** medium — the bar is a non-technical person finishing setup alone.

**Goal:** first-run flow: enter the setup code from the log (Security model), register a passkey,
then the wizard (your name and email; pick an email provider from the catalog with its steps
and a link to its app-password page; paste the password; send a test; optionally import a seed
file; make the first agent key). Docker image (one static binary on a distroless base, non-root,
healthcheck) with Tailscale embedded, so `docker-compose.yml` is one service with no required
value, `restart: unless-stopped`, and a named volume (a distroless non-root image
can't write a Synology bind mount owned by another uid, and Synology won't create a missing bind
folder at all). `TS_AUTHKEY` is optional: without it, the first start prints tsnet's Tailscale
sign-in link in the log, so there is no key to make, copy once, or paste. The image is prebuilt for
amd64 and arm64 and published to GitHub's registry; the compose file uses `image:`, never `build:`
(a small NAS must not build). The NAS path needs no terminal: Container Manager → Project → Create,
paste the compose file, Done, then open the log and click the sign-in link. Once on the tailnet, the
first page shows the `https://…ts.net` address and a QR code for the phone. Plain binaries for macOS, Windows and
Linux (amd64, arm64). Install guides for a non-technical reader: NAS (Synology Container Manager),
laptop or desktop (Docker Desktop, or the binary plus `hussla open`), and a rented cloud server
(firewall closed; reachable only over Tailscale); each says to copy backups off the device.
Guides follow what tripped up the first real NAS install (2026-10-08): one linear path with no
"if you already did step N" branches; no placeholders to edit inside commands (prompt instead);
any terminal step is one line (never `ssh` and a command pasted as two lines); every guide ends
with a check that it is running and what to paste back if not.
**Files:** `src/features/setup/`, `internal/app/setup/`, `Dockerfile` (multi-stage: Node builds the
UI, Go builds a static binary, final stage distroless non-root), `docker-compose.yml`,
`docs/install/{nas,laptop,cloud}.md`, README install link, release build script for the binaries.
**Tests:** wizard flow component test; `pnpm infra:docker` (hadolint); container smoke test:
a fresh container serves only the setup-code screen, and a wrong code is refused.
**Done when:**
- Fresh container needs the setup code, then finishes the wizard → verify: Playwright run against `docker run`
- Image lint clean → verify: `pnpm infra:docker`
- A fresh Synology (DSM 7.2, Container Manager) installs with no terminal and no auth key, from
  Project → Create to the job board on a phone, in under 5 minutes → verify: Human check `hussla-p6-nas`

**Human checks**
- `hussla-p6-nas` · Mac · 10 min · none — Install on a fresh Synology with no terminal. Container Manager → Project → Create, paste the compose file, click the Tailscale link in the log; the job board opens on your phone within 5 minutes, with no auth key and no folders made by hand.

## Phase 7 — Install and accept

**Model:** — (human)

**Human checks**
- `hussla-p7-phone` · iPhone · 5 min · deploy — With Tailscale on, open the Hussla address on your phone. It opens signed in, with your jobs.
- `hussla-p7-mail` · iPhone · 5 min · deploy — In Settings, send a test email. It arrives in your inbox from your address.
- `hussla-p7-agent` · Mac · 10 min · deploy — In Settings, add an agent and paste its snippet into Claude Code. Ask it to add a note to a job; the note appears on that job's page.
- `hussla-p7-followup` · Mac · 10 min · deploy — On a company page, edit a follow-up, approve it to yourself as the recipient, and confirm it arrives as written.
