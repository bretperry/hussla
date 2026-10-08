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

File bytes live in `<DATA_DIR>/files/<id>` and résumés in `<DATA_DIR>/resumes/`, beside the database; the daily `VACUUM INTO` backups cover `hussla.db` only. **Why deferred:** copying the whole data directory off the device is the install guides' job (Phase 6), and a file's bytes never change after upload. **Where:** `internal/adapters/filestore`, `internal/adapters/sqlite` backups. **If we take it:** say in the install guides to copy the whole data directory (not only `backups/`), or add the two folders to an export.

## Passkey delete, rename, and recovery when every passkey is lost

`open` · recorded 2026-10-08 · from Phase 3 (`docs/plans/hussla-v1.md`)

Passkeys can be added (setup code for the first on each address, then a tap with an existing one) and listed, not removed or renamed. An owner who loses every passkey for an address can still read and edit there, but no owner-only action (approve, delete, settings, keys) works on it until a passkey is added, and adding one needs a tap or a setup code, which that address no longer gets. **Why deferred:** Phase 3 is the API's security core; managing passkeys is a Settings screen (Phase 5), and two registered devices (phone and laptop) cover a single loss. **Where:** `internal/app/auth/passkeys.go`, settings key `auth.passkeys`. **If we take it:** `DELETE /api/passkeys/{id}` behind a tap with a *different* passkey (refuse removing the last one), and `PATCH` for the name; add both to `api/openapi.yaml` and the auth matrix. For recovery, a `hussla reset-passkeys` command (access to the data directory is the proof, like `hussla open`) that sets the address's passkeys aside so the setup screen issues a code again.

## A tagged-node install can be claimed by any untagged tailnet device holding the setup code

`open` · recorded 2026-10-08 · from Phase 3 (`docs/plans/hussla-v1.md`)

When the node is tagged (no owning user) or was first claimed from the local door, the first untagged tailnet user to type the setup code becomes the owner. The code is only in the server's log, so this needs log access. **Why deferred:** it is the plan's design (the code is the proof), and restricting it to one user would need an admin-provided user id. **Where:** `auth.Service.Claim`. **If we take it:** an optional `HUSSLA_OWNER_LOGIN` env var that `Claim` and `AdoptNodeOwner` must match.

