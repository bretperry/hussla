# Deferred

Things we decided not to do *yet*, and meant to come back to. Not a wishlist and not a bug
tracker — an entry earns its place by being a decision someone already made with a reason, or a
defect we confirmed and chose to live with. Anything nobody has looked at properly does not go
here.

The point is that a deferral survives the conversation it happened in. A "let's come back to that"
in a PR thread is lost the moment the PR merges.

**To ask for this list from a fresh session:** "read `docs/deferred.md` and tell me what's
outstanding."

**To add an entry:** title, one line of what, then *why we deferred it*, *where it lives*, and
*what changes if we take it*. Date it and say where it came from, so a reader can find the
argument. Delete an entry when it's done — the file is the open set, and git keeps the history.

**Status** is one of: `open`, `in flight` (someone is on it), `won't do` (kept briefly with the
reason, then deleted).

---

<!-- ## Title
`open` · recorded YYYY-MM-DD · from <PR / plan / thread>

What. **Why deferred:** … **Where:** … **If we take it:** … -->

## Search now: no way to clear the routine or its token
`open` · recorded 2026-10-10 · from PR #27's dynamite test

Settings → Job search routine can replace the routine and token but not remove them, and the `SecretStore` port has no delete. **Why deferred:** the owner can revoke the token on the routine's page at claude.ai (that stops it at once) or save another routine; clearing needs a new port method and a new route. **Where:** `internal/app/mailsetup` (`SecretStore`), `internal/adapters/secretfile`, `internal/app/searchrun`, `api/openapi.yaml`. **If we take it:** `SecretStore.Delete`, `DELETE /api/search` (passkey tap), and a "Remove" button beside Save routine.

## Agent door on Funnel: no limit on wrong keys, no per-key scopes, rate limit or quota
`open` · recorded 2026-10-09 · from `docs/decisions/0016-agent-api-on-funnel.md`; widened by the ship dynamite test (2026-10-09)

The `:8443` agent door answers 401 to every wrong key with no per-address limit. A valid key has every agent route, with no per-key scope (read-only, no mail), no request rate limit and no storage quota: a leaked or looping key can create jobs, events and 25 MB files until the disk fills, and every request it makes is also a write (`Auth.Agent` touches the key's last-used time in a transaction), so request volume is SQLite write volume. **Why deferred:** a key is 256 random bits, so guessing isn't a real attack; the owner makes and revokes each key, and revoking stops it at once; a limit would cut load and log noise, and Funnel's client addresses haven't been checked to be the real ones. **Where:** `internal/httpapi/guard.go` (the agent door's 401), `internal/app/auth/service.go` (`Agent`, the `Touch`), `internal/app/attachments` (uploads). **If we take it:** a per-address wrong-key counter with a lockout and a per-key token bucket, knobs in `internal/config/auth.go` like `SetupCodeAttempts`; a per-key scope on the key record (`api/openapi.yaml`); a total-bytes quota on uploads; and `Touch` only when last-used is older than a knob (a minute), so reads stop costing a write.

## Settings → "Add an agent" doesn't show the Funnel address
`open` · recorded 2026-10-09 · from `docs/decisions/0016-agent-api-on-funnel.md`

The snippet uses the page's own origin, so a cloud agent's `:8443` address comes from the install guide, not the UI. **Why deferred:** the server would have to report the door's state in the API (`api/openapi.yaml`, generated UI types), an API shape change for one line of copy. **Where:** `src/features/settings/AddAgent.tsx`, `GET /api/me` or `GET /api/setup`. **If we take it:** a `funnelAddress` field when the door is open, and a "cloud agents" variant of the snippet.

## A review PATCHed without `fetchedAt` answers `null`
`open` · recorded 2026-10-09 · from the response-contract test (`test/contract-responses`)

`PATCH /api/companies/{slug}` with `reviews: [{"source": "Glassdoor"}]` stores the review with no fetch time, and every answer then sends `"fetchedAt": null`, where `Review` requires a string and `ReviewInput` says it "defaults to now" (only `POST .../reviews` defaults it, in `domain.UpsertReview`). Rows already stored that way also answer `null`. **Why deferred:** either fix changes behavior: default it to now on PATCH (and decide what old rows answer), or make `Review.fetchedAt` nullable (the UI's `formatWhen` and the front page's overnight count read it). **Where:** `internal/app/wire/company.go` `parseReviews`, `internal/app/tracker/companies.go`, `api/openapi.yaml` `Review`/`ReviewInput`. **If we take it:** add a PATCH-without-`fetchedAt` read to `internal/httpapi/empty_state_test.go`; the rig's contract check then proves it.

## command-guard test timing fix isn't upstream yet
`open` · recorded 2026-10-09 · from the ship dynamite test fixes (`fix/ship-findings`)

Four wall-clock asserts in `scripts/command-guard.test.mjs` failed on loaded runners (measured: 262.8 ms against the 250 ms budget, a linearity ratio of 8.5 against 8, and 1261 ms against 1 s). Bret approved fixing them here (2026-10-09), so this repo's copy now differs from whippletree's. **Why deferred:** the same fix is open upstream as whippletree#60 and lands there separately. **Where:** `scripts/command-guard.test.mjs` (the size-budget test, "looks nothing up … 5000 of them", "linear with the budgets lifted", and the 200k-character test). **If we take it:** `pnpm harness:push`, then delete this entry once `pnpm harness:status` shows no difference.

## Mail: OAuth2 sign-in for Outlook.com and Microsoft 365 (and Gmail without app passwords)
`open` · recorded 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 4

Personal Outlook.com/Hotmail accounts lost SMTP password login on 2024-09-16, and Microsoft 365 turns SMTP AUTH off by default from late December 2026; Google Workspace admins can disable app passwords. **Why deferred:** XOAUTH2 needs a registered app, a browser consent flow and token refresh, which v1's "paste an app password" setup doesn't have; the catalog says so in the Outlook entry instead. **Where:** `internal/config/mailproviders.go` (Outlook warning), `internal/adapters/smtpmail` (would add an XOAUTH2 `smtp.Auth`). **If we take it:** a token store beside the secret store, a consent screen in the wizard, and an `auth: oauth2` field per catalog entry.

## Mail: router-level `TestSecretsNeverLeave`
`open` · recorded 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 4

The plan's Done-when runs `TestSecretsNeverLeave` through the Phase 3 router. Phase 4 was built beside Phase 3, so the test exists at the use-case and adapter level (`internal/app/mailsetup/secrets_test.go`: every returned value, error, stored row and log line, with a provider that echoes the password). **Why deferred:** the router didn't exist yet. **Where:** `internal/httpapi` once Phases 3 and 4 meet. **If we take it:** drive mail settings save/view/test and the outbox listing through the real router with the same echoing fake provider and capturing slog handler, asserting on response bodies too.

## Mail: per-provider Message-ID on the API adapters
`open` · recorded 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 4

SMTP mail carries the deterministic `hussla.<id>.v<version>@domain` Message-ID; Resend, Postmark, SendGrid and Mailgun assign their own, and Hussla sends `X-Hussla-Message-Id` instead. **Why deferred:** none of the four documents overriding Message-ID, and a request a provider rejects would block every send; only a live account can confirm. **Where:** `internal/adapters/{resend,postmark,sendgrid,mailgun}`. **If we take it:** try `Message-ID` (Mailgun `h:Message-Id`) against a test account per provider and keep it where it sticks.

## Import: attached files' contents from the prototype
`open` · recorded 2026-10-09 · from the import-from-the-prototype PR

The prototype's `GET /api/export` lists file records (name, kind, size) but not their bytes, so `importseed` counts them (`FilesNotImported`) and stores none; the owner re-attaches them by hand. **Why deferred:** the bytes live only in the prototype's `data/files` folder on the NAS, and reaching it needs a terminal or a second upload format; a file record with no bytes would show a broken download. **Where:** `internal/app/importseed/importseed.go` (`files` section), `internal/app/attachments`. **If we take it:** accept a zip of the export plus `data/files`, and store each file through the attachments use-case under its old id.

## Import: the prototype's outbox is a second file
`open` · recorded 2026-10-09 · same PR

The prototype's `exportAll()` has no `emails` section, so the outbox comes over only from a second, optional file (`/api/emails` saved from the browser). **Why deferred:** the prototype is frozen (no changes to it from v1 work), and sent follow-ups already survive as job events and `followup.emailSentAt`. **Where:** `docs/install/move-from-the-old-tracker.md` (optional step), `internal/app/importseed/emails.go`. **If we take it:** add `emails: listEmails()` to the prototype's `exportAll()`; v1 already reads that section.

<!-- [stack:typescript] -->
## Drop dependency-cruiser's swc parser once it supports TypeScript 7

`open` · recorded 2026-09-29 · from the rival-harness review thread

dependency-cruiser can't load TypeScript 7 (no JS API until 7.1). With TS missing, it cruises
0 modules and reports green. **Why deferred:** the swc parser works today (tested: aliases and
type-only imports resolve), at the cost of a notice on every run, which `stacks/typescript/check-edited.mjs` strips.
**Where:** `.dependency-cruiser.cjs` `options.parser`, `@swc/core` in package.json.
**If we take it:** remove `parser: "swc"` and `@swc/core`, and confirm the fixture still fails.
<!-- [/stack:typescript] -->

## Verify the Cursor half of the hooks in a real Cursor session

`open` · recorded 2026-09-29 · same thread

`.cursor/hooks.json` follows Cursor's documented `beforeShellExecution` and `postToolUse` shapes,
but Cursor's docs don't name the `tool_input` field for its Write tool. `check-edited.mjs` reads
`file_path` or `path` and stays silent otherwise. **Why deferred:** built and tested from Claude
Code in a cloud session, with no Cursor available. **If we take it:** in Cursor, ask the agent to
run `gh pr ready 1 --undo` (expect a refusal), then to add a type error (expect it reported back).

<!-- [stack:typescript] -->
## In-editor squiggles for import boundaries

`open` · recorded 2026-09-29 · same thread

Boundaries are enforced by dependency-cruiser after each agent edit, pre-push, and in CI, but a
human in the editor sees nothing until then. **Why deferred:** ESLint's `no-restricted-imports`
(the usual approach) needs ESLint, which needs the TS 6 API; the template lints with oxlint.
**If we take it:** a project on ESLint adds per-layer `no-restricted-imports` blocks as a second signal. The
dependency-cruiser rules stay the gate.
<!-- [/stack:typescript] -->

<!-- [stack:typescript] -->
## Mutation testing for src/domain

`open` · recorded 2026-09-29 · same thread

Stryker (incremental mode, nightly, `src/domain` only) measures whether tests would notice a
broken line. **Why deferred:** the template's domain is one seed file; it pays once a project
has real domain logic. **If we take it:** add Stryker with the Vitest runner and a scheduled
workflow on `dev`, reporting only.
<!-- [/stack:typescript] -->

<!-- [stack:typescript] -->
## Compose-time LWW drops a slow clock's later edit

`open` · recorded 2026-10-01 · from [#14](https://github.com/bretperry/whippletree/pull/14) adversarial review

The TypeScript pack's tier-2 seed merges notes by compose time, last writer wins
(`src/domain/note.ts` → `mergeNote`). A stamp too far *ahead* is clamped, but a device whose clock
runs *slow* stamps its later edit in the past, so it loses to an older edit from an honest device,
and the flush still reports `delivered`. **Why deferred:** the seed is an example of fault
injection, not a sync design; any fix is a design choice a real project makes for its own data.
**Where:** `mergeNote` / `acceptWrite`; the test "clock skew, the other way" in
`src/server/services/note-sync.chaos.test.ts` pins today's behavior. **If we take it:** anchor
compose stamps to server time (a per-device offset from each answer's server clock, read from a
`serverNow` field the server returns), or use a hybrid logical clock; have the server answer `superseded` so
the client can tell the user; then flip that test to expect the later edit.
<!-- [/stack:typescript] -->
<!-- [stack:go] -->

## Go pack: a slow clock's later edit loses, and the seed has no real adapter

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2b

The Go tier-2 seed (`internal/app/notesync`) copies the TypeScript seed's merge rule: compose-time
last writer wins, a fast stamp clamped, a slow clock's later edit still losing while the flush
reports `delivered`. The test "clock skew, the other way" pins it. **Why deferred:** the seed
shows fault injection, not a sync design; any fix is a choice a real project makes for its own
data. It also ships no adapter (no HTTP client, no store) and no composition root, so
`internal/adapters/` doesn't exist until a project adds one. **Where:**
`internal/domain/note.go`, `internal/app/notesync/service_chaos_test.go`. **If we take it:** anchor
stamps to server time or use a hybrid logical clock, then flip that test; add the first adapter
under `internal/adapters/<vendor>` with a depguard rule of its own.

## Go gates cost about 9 s on every `pnpm check`

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2b QA

`pnpm go:gates` plants violations and lints a scratch copy each run, and `gates.test.mjs` adds
about 50 s to the harness tests. **Why deferred:** a cache keyed on the config alone would miss a
change to the code the probes build against, and a stale pass is the failure the gates exist to
prevent. **Where:** `stacks/go/gates.mjs`. **If we take it:** key a result cache on golangci-lint's
version plus a hash of `.golangci.yml`, `go.mod`, `go.sum`, `gates.project.json`, `gates.mjs` and
the layer packages' non-test sources, kept in the OS temp dir; CI always runs cold.
<!-- [/stack:go] -->


## Harness eject: a publish mirror, and comments that name removed files

`open` · recorded 2026-10-04 · from the "ship without whippletree" project thread

`pnpm harness:eject` leaves the tree clean enough to pass `pnpm check`, but stops short of
publishing. **Why deferred:** what an eject keeps (the gates) was picked before anyone had shipped
a project this way; the publish flow should follow a real one. **Where:** `scripts/harness-eject.mjs`.
**Open ends:**
- No publish workflow. A release that ejects in CI and pushes to a public mirror with its own
  history would keep harness files out of public history for good, but outside PRs on the mirror
  would then need carrying back to the private repo.
- File headers in kept gates still name removed files in their Used by / Uses lines
  (`stacks/*/tool.mjs` "check-edited.mjs imports it"). Not a leak (no whippletree name) and no
  code reads them, but they point a reader at nothing. Fix with `[harness]` fences per header line,
  or let the scan report them.
- The template's own README, changelog history, and decision 0001 carry the whippletree name into
  every new project; eject reports them as leftovers. Bootstrap resetting them would remove most
  of that list.
- No `stack:add`-style undo: to bring the harness back, take the commit before the eject.

## `pnpm stack:add <name>`: re-add a removed pack, or adopt a new upstream one

`open` · recorded 2026-10-01 · from the go-public plan, Phase 1

`stack:remove` exists; its inverse doesn't. **Why deferred:** removal is the common path (a
non-TypeScript project on day one); adding back means restoring project-owned files (`owns`),
package.json entries, and fenced text that only upstream's copy still has. **Where:**
`scripts/stack.mjs`, `harness.project.json` → `removedStacks`. **If we take it:** copy the pack's
`docs`/`code`/`owns` and its package.json and settings entries from upstream, drop the name from
`removedStacks`, and leave the fenced text for a human to merge (it lives in project-owned files).
For now: copy `stacks/<name>/pack.json` from upstream and run `pnpm harness:pull` for the synced files.


<!-- [stack:typescript] -->
## TypeScript pack: the edit hook reads a crashed tool as clean, and the seed's flush misses later saves

`open` · recorded 2026-10-01 · from the Python pack's QA (Phase 2c), fixed there first

Two bugs the Python pack's review found and fixed in its own twin. **Edit hook:** `run` in
`stacks/typescript/check-edited.mjs` returns "" (clean) when a tool can't start (`result.error`)
or exits non-zero without printing, so a missing binary or a crash hides every finding. **Seed:**
`flush()` in `src/server/services/note-sync.ts` returns the running flush to a second caller, so a
write saved after that run read the outbox waits for the next flush call; the Python seed runs one
more pass when asked again. **Why deferred:** the TypeScript pack was already QA-passed and waiting
to merge. **If we take it:** report `result.error` and a silent non-zero exit as failures; add a
"requested again" flag to `flush` and a chaos test (save a, flush with a delay, save b, flush: b delivered).
<!-- [/stack:typescript] -->

## Command-guard gaps: infrastructure commands it can't see

`open` · recorded 2026-10-01 · from PR #20 round-1, round-2, and round-3 QA (go-public plan, Phase 2g)

`scripts/command-guard.mjs` refuses IaC applies and cloud deletes through wrappers, substitutions,
and shells fed on stdin, and asks when an unknown program is handed `terraform apply` as words.
Some roads stay dark. **Why deferred:** each needs reading another
file, another language, or shell state from an earlier command, and the guard is a seatbelt, not a
sandbox: `core.mdc` forbids the act whatever the guard sees. **Where:** `evaluateInfra()` and
`WRAPPERS` in `scripts/command-guard.mjs`. The gaps:
- Indirection through files: package.json scripts (`pnpm deploy`), Makefiles, `just`, shell scripts run by path, `terramate script run`.
- Other IaC CLIs: `pulumi up`/`destroy`, `kubectl delete`, `helm uninstall`, `sst remove`, `supabase db reset --linked`.
- Interpreters with inline code: `python -c`, `node -e`, `perl -e`, `ruby -e`.
- Wrappers that take a command string the guard doesn't read: `script -c`, `tmux`/`screen` sessions, `at`/`batch`. (`git -c alias.x='!…'` asks since round 5.) (A program word after an unknown wrapper, as in `unshare -r terraform apply` or `docker run hashicorp/terraform apply`, asks.)
- Opaque pipes into a shell: `base64 -d | sh`, `rev <<<… | sh`, `curl … | sh` (the script is fetched or decoded at run time).
- bash's re-evaluation contexts: `${x@P}`, arithmetic subscripts (`$(( x ))` with `x='a[$(…)]'`), `[[ -v 'a[$(…)]' ]]`, and `PS4='$(…)' bash -x`.
- `eval "$VAR"` and `bash -c "$CMD"`: the string is a variable set earlier (asking would stop everyday `eval "$(ssh-agent)"`).
- Words built by printf or substitutions: `$(printf terra)form $(printf ap)ly`.
- Shell state from an earlier tool call: an alias, function, or variable defined in one Bash call and used in the next (on one line, `alias x=terraform; x apply` is read; `T=terraform; $T apply` asks).
- A cloud verb or option from a variable or xargs placeholder (`aws s3 $OP s3://b`, `xargs -I{} gcloud sql instances {} x`): asking would stop everyday `xargs -I{} aws s3 cp {} …`.
- SQL a cloud CLI reads from a file or stdin (`bq query < drop.sql`, `--sql file://x.sql`), and SQL the pattern misses (`drop/**/table`, `DROP EXTERNAL TABLE`, `DROP MATERIALIZED VIEW`). (`DELETE x` without FROM and `MERGE … THEN DELETE` are read since PR #21: `cloudVerdict()` calls `destroysSql()`.)
- Data lost by overwrite or expiry, not a delete verb: `bq cp -f`, `bq update --expiration`, `aws rds modify-db-instance --backup-retention-period 0`, `gcloud sql instances patch --no-backup`.
**If we take it:** read package.json scripts and Makefile targets the line names, add the CLIs as
built-ins with their own verbs, and treat interpreter `-c`/`-e` strings as data to scan; each with
corpus rows in `command-guard.test.mjs`. Overwrite and expiry flags need per-CLI rules like the
delete verbs (`cloudVerdict()`); opaque pipes would have to ask for any `| sh` whose source isn't text on the line.

## Command-guard: git and data rules don't read wrappers the way the infra rules do

`open` · recorded 2026-10-02 · from PR #20 round-3 QA (S3)

The branch, Ready/merge, rerun, `dropdb`, and SQL rules read each command with `segments()` /
`commandText()`, which skip only `VAR=`, `sudo`, `env`, `npx`, `pnpm` and a few prefixes, and
follow only `sh -c '…'` and substitutions. The infra rules read the line with `parseLine()` and
`runs()`, which follow every wrapper, shell stdin, and command string. So today these pass:
`timeout 5 git push -f origin main`, `bash -lc 'git push -f origin main'`, `echo 'git push -f origin main' | sh`,
`eval 'git push …'`, `xargs git push -f origin <<<main`, `timeout 9 dropdb prod`, `timeout 60 gh pr merge 20`.
**Why deferred:** pre-existing (not from the infra pack), and PR #21 rewrites the SQL rules on the
same walkers; unifying them in #20 would conflict with #21 and double the review. Server-side
rulesets still refuse force-pushes to `dev`/`main`. **Where:** `evaluateLine()`, `evaluateCommand()`,
`evaluatePush()` vs `evaluateInfra()` / `runs()` in `scripts/command-guard.mjs`. **If we take it:**
after #21 merges, one change builds a single "each program run on this line" walker (from
`parseLine()` + `runs()`, with the `cd`/`git -C` directory carried along) that the infra, SQL, and
git rules all consume, and the probe rows above move into `command-guard.test.mjs` as deny/ask.

## Command-guard: what the round-5 review left open

`open` · recorded 2026-10-04 · from the template's adversarial review of `scripts/command-guard.mjs` (branch `claude/prereview-guard-jmkutb`)

Round 5 closed full-path programs, gh's `-R`, git's abbreviated and separate-value options, `@` and
glob refspecs, `gh api` writes, `core.hooksPath` and aliases, shell writes to the guard's files, a
guard that can't load, and several data stores. Still open:
- git settings from the environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n`,
  `GIT_CONFIG_GLOBAL=f`), an alias already in `~/.gitconfig` (read by its name only), and a shell
  write to `.git/config` or `.git/hooks/pre-push` (the hook itself lives there).
- Deletes a store's CLI reads from elsewhere: `redis-cli --pipe` or a file on stdin, `KEYS … | xargs
  redis-cli DEL`, a mongosh script file (`--file`, a positional `.js`), a GraphQL query in a variable
  (`-f query="$Q"`).
- Docker volumes always ask, even on a plainly local engine: DOCKER_HOST and contexts aren't read.
- The host's own hook timeout (10 s) and a missing `node` for Cursor: the hook entry can't answer
  either. Claude Code's config adds `|| exit 2`, so there a missing entry or `node` blocks.

**Why deferred:** each needs state the line doesn't show (the environment, a config file, a script),
and the guard is a seatbelt, not a sandbox (`core.mdc`). **Where:** `evaluateGitConfig()`,
`evaluateStore()`, `guardWrites()`, `scripts/command-guard-hook.mjs`. **If we take it:** read the
`GIT_CONFIG_*` variables in `gitGlobals()` as `-c` settings, add `.git/config` and `.git/hooks/` to
`GUARD_FILE`, and ask for any `redis-cli --pipe` or mongosh script against a non-loopback host.

## Install the git hooks on `pnpm install`

`open` · recorded 2026-10-02 · from go-public Phase 3 (writing the getting-started guide)

Nothing installs the pre-push hook for a fresh clone: `pnpm install` has no `prepare` script and
nothing sets `core.hooksPath`; only `bootstrap-repo.sh` (for the clone it ran in) or a manual
`pnpm hooks:install` copies `.githooks/pre-push` into the hooks directory. A teammate or a second
machine pushes with no hook and no warning until CI. **Why deferred:** Phase 3 is docs only; the
guide (getting-started, troubleshooting) says to run `pnpm hooks:install` per clone. **Where:**
`package.json` scripts, `scripts/install-git-hooks.sh`. **If we take it:** a `prepare` script that
runs the installer (it already copies, so it is idempotent), or `core.hooksPath .githooks`, which
needs no re-run after `.githooks/` changes; then drop the troubleshooting entry.

## The guard reads only DATABASE_URL and GOOSE_DBSTRING, and asks behind `pnpm --filter`

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2d

`scripts/command-guard.mjs` judges a migration command by where it points: a URL on the line, then
`DATABASE_URL` (goose: `GOOSE_DBSTRING`) on the line, in the environment, or in `.env` (Prisma's
`prisma/.env` too, and a URL written into `schema.prisma` or `prisma.config.ts`; a config file
alone makes a loopback reading ask). Prisma's `url`/`directUrl` variable names are read since PR #21
round 3; another tool configured to read another variable (sqlx's `--database-url-env`, a knexfile)
is judged by `DATABASE_URL`, or not at all. Not modelled (PR #21 round 4):

- `pnpm --filter <pkg> <script>` and `pnpm -r`: the script is looked up in this directory's
  `package.json` only, not the filtered package's, so a `reset` script that lives only in
  `packages/db` is never read and the line runs unjudged (as on dev). One that is found asks.
- Task runners (`turbo run reset --filter=db`, `nx run db:reset`, `make db-reset`): the task's
  command is in their own config, which the guard doesn't read, so it runs unjudged (as on dev).

**Why deferred:** each is a per-project spelling; the project can add a deny or ask in
`command-guard.project.json` today. **If we take it:** read the variable name from each tool's
config as for Prisma; resolve `--filter` to the package dir through `pnpm-workspace.yaml` and read
that `package.json`; for a task runner, ask on any task whose name matches a reset or drop.

## `.gitattributes` isn't synced to projects

`open` · recorded 2026-10-04 · from the CI-scope adversarial review (branch claude/prereview-ci-scope-jmkutb)

The root `.gitattributes` (LF for `*.mdc`, `*.md`, `*.sh`, `.githooks/*`) ships with the template
but is not in `harness.json`, so a project made earlier, or one that pulls the harness, doesn't get
it. **Why deferred:** a project may have its own `.gitattributes`, and harness-sync replaces whole
files; the rule sync now reads CRLF anyway, which was the silent failure. **Where:**
`.gitattributes`, `harness.json`. **If we take it:** a `.gitattributes.project` companion or a
merged block the sync owns, like AGENTS.md's.


## Stop reading `model-tiers.project.json` and `dynamite-test.project.json`

`open` · recorded 2026-10-04 · from the "agent override config" project thread (decision 0006)

`agent-overrides.json` replaces both, and `scripts/agent-overrides.mjs` still reads them beneath it. **Why deferred:** projects made before it may hold either file, and dropping them quietly would change who reviews and on which model. **Where:** `LEGACY` in `scripts/agent-overrides.mjs`, the legacy tests in `scripts/model-tiers.test.mjs` and `scripts/rival-review.test.mjs`. **If we take it:** fail loudly when either file exists, naming the move (`tiers` → `models`, keys → `dynamiteTest`), once every project on whippletree has moved.


## Uploaded files and résumés aren't in the automatic backups

`open` · recorded 2026-10-08 · from Phase 3 (`docs/plans/hussla-v1.md`)

File bytes live in `<DATA_DIR>/files/<id>` and résumés in `<DATA_DIR>/resumes/`, beside the database; the daily `VACUUM INTO` backups cover `hussla.db` only. **Why deferred:** copying the whole data directory off the device is the install guides' job (Phase 6), and a file's bytes never change after upload. **Where:** `internal/adapters/filestore`, `internal/adapters/sqlite` backups. **If we take it:** add the two folders to an export. The install guides (Phase 6) already say to copy the whole data directory with `docker cp`.

## Passkey rename

`open` · recorded 2026-10-08 · from Phase 3 (`docs/plans/hussla-v1.md`); trimmed in Phase 6

Passkeys can be added, listed and removed (never the last; `/setup/passkeys`), and an owner who lost every one gets a recovery code from the setup screen (decision 0015). They can't be renamed: the name is the one typed when it was made. **Why deferred:** a name only tells two devices apart, and removing and re-adding one renames it. **Where:** `internal/app/auth/passkeys.go`, settings key `auth.passkeys`. **If we take it:** `PATCH /api/passkeys/{id}` with `{name}` (owner, no tap), in `api/openapi.yaml` and the auth matrix.

## Front-page overview endpoint

`open` · recorded 2026-10-08 · from Phase 5 (`docs/plans/hussla-v1.md`)

The front page fetches one company detail per open job (N+1, capped by `FRONT_PAGE_COMPANY_DETAILS`). **Why deferred:** out of Phase 5's scope. **Where:** `src/features/jobs/use-front-page.ts`. **If we take it:** add one overview endpoint to `api/openapi.yaml` and drop the second fetch wave.


## Activity nav item; no MSW

`open` · recorded 2026-10-08 · from Phase 5 (`docs/plans/hussla-v1.md`)

Activity is reachable by link only (Pitches got its nav item in Phase 5b). Tests stub `fetch` and spy on `api` instead of using MSW. **Why deferred:** out of Phase 5's scope. **Where:** `src/config/ui.ts` (`NAV_ITEMS`). **If we take it:** add the nav item (the phone nav already wraps to a second row); adopt MSW only if the stubs get unwieldy.


## MCP tools for the HTTP-only agent routes

`open` · recorded 2026-10-08 · from Phase 3b

Agents can call these over HTTP but not as MCP tools: file upload and download, the activity feed and job-less events, `PUT` a job, `PATCH` an answer, edit or cancel an email, résumé list, export. `internal/mcpapi`'s route test names each with a reason. **Why deferred:** not in the Phase 3b tool list; file bytes don't fit a tool call; edit and cancel of drafts weren't asked for. **Where:** `notAsTools` in `internal/mcpapi/door_test.go`, `catalog()` in `internal/mcpapi/tools.go`. **If we take it:** add the tool, move its route from `notAsTools` to the catalog, list it in `docs/agents-api.md`. Rate limiting per key is also absent (the spec says servers should); add it beside the tools if an agent ever loops.

## Existing installs see the setup wizard once after upgrading to Phase 6

`open` · recorded 2026-10-09 · from Phase 6 (`docs/plans/hussla-v1.md`)

The wizard's progress (`setup.wizard`) is new, so an install that already had a passkey before Phase 6 opens on the wizard's first step until the owner presses **Skip the rest** once. **Why deferred:** one install exists (Bret's), one click fixes it, and telling a pre-wizard install from a fresh one needs a marker it never wrote. **Where:** `internal/app/setup` (`readWizard`), `src/features/setup/setup-steps.ts` (`gateFor`). **If we take it:** a forward migration that marks every step skipped when passkeys exist and `setup.wizard` doesn't.

## Settings doesn't link the passkey and mail setup pages

`open` · recorded 2026-10-09 · from Phase 6 (`docs/plans/hussla-v1.md`)

Phase 6 adds `/setup/passkeys` (list, remove, add, recovery code) and `/setup/mail` (change the provider or password), but Settings has no link to either; the owner reaches them by address. **Why deferred:** another worker owns `src/features/settings/` (the "Add an agent" snippet) at the same time; two edits to one file collide. **Where:** `src/features/settings/SettingsPage.tsx` (Security and Mail sections). **If we take it:** a "Manage passkeys" and an "Change mail setup" link in those sections.

## Publish workflow's actions are pinned by tag, not commit

`open` · recorded 2026-10-09 · from Phase 6 (`docs/plans/hussla-v1.md`)

`.github/workflows/publish-image.yml` uses `docker/*@vN` and `actions/checkout@v7`, like `ci.yml`, not commit SHAs. It holds `packages: write` and `contents: write` on a release (`release.yml` calls it after each ship; a hand-pushed tag still runs it). **Why deferred:** the session that wrote it couldn't read the docker actions' repos to resolve SHAs, and `ci.yml` follows the same convention. **Where:** `.github/workflows/publish-image.yml`. **If we take it:** pin each to a full SHA with the tag in a comment, and let Dependabot bump them.

## Prerelease tags move the image's `latest`

`open` · recorded 2026-10-09 · from the ship dynamite test (finding 7, low, pre-existing)

A hand-pushed prerelease tag (`v1.0.0-rc1`) runs `publish-image.yml`, whose `type=raw,value=latest` pushes `ghcr.io/bretperry/hussla:latest` for it too, so `:latest` can point at a release candidate. **Why deferred:** pre-existing, nobody pushes prerelease tags yet, and installs pin an exact tag (`docs/install/nas.md`). **Where:** `.github/workflows/publish-image.yml` (the Tags step). **If we take it:** enable the `latest` tag only when `TAG` matches `^v[0-9]+\.[0-9]+\.[0-9]+$`, and mark a hand-made release for such a tag `--prerelease`.

## Reconnect shows the Tailscale login link to the whole home network

`open` · recorded 2026-10-09 · from PR #13's second dynamite test (low)

After **Sign out of that account**, the home-network page shows the node's new Tailscale login link to anyone on the LAN, as a fresh install does. Whoever signs in first sets the node's account; if that isn't the owner, the node is still someone else's (it fails closed again) and the owner presses Sign out once more. **Why deferred:** it is a nuisance, not a takeover: the owner record, passkeys and data never move, and the tailnet door stays closed to the wrong account. **Where:** `internal/httpapi/home.go` (needs-login view), `internal/app/setup/setup.go` (`Reconnect`). **If we take it:** after a Reconnect, show the link only on the setup code (typed on the LAN page), or name the account it must be signed in as.

