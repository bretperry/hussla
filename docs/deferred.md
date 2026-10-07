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
<!-- [stack:rust] -->

## Run the Rust checks only when Rust files change

`open` · recorded 2026-10-01 · from go-public Phase 2a

The Rust pack's steps run in the one "Checks" job like every pack's (`docs/decisions/0002-stack-packs.md`),
so a PR that touches no Rust still pays the toolchain setup and a cached `cargo` run.
**Why deferred:** `stack.mjs check --packs` runs every present pack, so skipping one needs either a
per-pack change scope in `ci-change-scope.mjs` or a separate `Rust checks` job that the pack runner
skips. Neither is worth building before a second pack makes the cost real.
**Where:** `.github/workflows/ci.yml` (the `[stack:rust]` fence), `scripts/stack.mjs` `runPackChecks`.
**If we take it:** give `pack.json` a `ciPaths` list, emit `pack_<name>` outputs from the scope job, and gate that pack's setup and checks on it.

## Run `cargo deny` advisories on a schedule

`open` · recorded 2026-10-01 · from go-public Phase 2a QA

`pnpm check`, pre-push and PR CI run `rust:deny` (bans, licenses, sources), which is offline and
deterministic. Advisories (`pnpm rust:advisories`) need the RustSec database and fail on any new
RUSTSEC entry, so a green PR would go red with no change of ours; they belong on a schedule.
**Why deferred:** there is no scheduled workflow in the template yet, and adding one is a CI change
of its own. Until then nothing runs advisories automatically.
**Where:** a new `.github/workflows/` job on `schedule:`, running `pnpm rust:advisories`.
**If we take it:** open an issue (or fail the run) when it finds one.
<!-- [/stack:rust] -->
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

<!-- [stack:swift] -->

## Swift pack: a slow clock's later edit loses, and the seed has no real adapter beyond the clock

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2e

The Swift tier-2 seed (`Sources/UseCases/NoteSyncService.swift`) copies the TypeScript seed's
merge rule: compose-time last writer wins, a fast stamp clamped, a slow clock's later edit still
losing while the flush reports `delivered`. The test "clock skew, the other way" pins it.
**Why deferred:** the seed shows fault injection, not a sync design; any fix is a choice a real
project makes for its own data. It ships one adapter (`SystemTime`) and no composition root, no
HTTP client, no store. **Also:** the fault tests run on real (short) time, not virtual time; Swift
has no `synctest`, and a hand-rolled fake clock needs an "every task is blocked" signal the
language doesn't give. **Where:** `Sources/Domain/Note.swift`,
`Tests/NoteSyncTests/NoteSyncChaosTests.swift`. **If we take it:** anchor stamps to server time or
use a hybrid logical clock, then flip that test; add the first adapter under `Sources/Adapters`
with its own row in `swift-layers.json`.

## Swift pack: a Package.swift or test file written to fool the checks on purpose

`open` · recorded 2026-10-02 · from the go-public plan, Phase 2e (QA round 2)

The pack checks the evaluated package (`stacks/swift/manifest.mjs`) and wants every `@Test` in the
log (`run.mjs test`), which catches drift and any setting that switches a gate off, written as text
or as code. Not caught: a manifest that evaluates differently under `dump-package` than under
`build` (branching on `Context.environment` or a file it reads), and a hidden test whose display
name or function name another test that does run also uses (the log is matched by name).
**Why deferred:** both take deliberate effort to write and stand out in review; the threat model
for the pack's gates is drift and cheap switches, not a determined author. **Where:**
`stacks/swift/manifest.mjs`, `stacks/swift/count-tests.mjs`. **If we take it:** refuse
`Context.environment` and file reads in `Package.swift` (text scan), and require unique @Test
names per target.
<!-- [/stack:swift] -->
<!-- [stack:kotlin] -->

## Kotlin pack: the Android leg's open ends

`open` · recorded 2026-10-04 · from the go-public plan, Phase 2i

The Android leg ships one Android module, `:app` (the composition root), with Android lint, host
unit tests, and instrumented tests on an emulator. Left out on purpose:
- **No Android library row.** Only the composition root may be an Android module (`LAYERS`
  `android`), so an adapter that wraps an Android API (Room, DataStore, WorkManager) lives in
  `:app` for now. **If we take it:** a second row kind, an Android library adapter (`com.android.library`,
  `ANY_LIBRARY`, `mayUse` the ports), and the gates' Android probes run per Android row (they already loop).
- **No Robolectric.** Host tests in `:app` are plain JUnit 6 over `AppGraph`, which has no Android
  types; anything that needs a real `Context` is an instrumented test. Robolectric runs on JUnit 4
  only and downloads an Android jar per SDK level at test time. **If we take it:** add it when a
  screen has logic worth testing without an emulator, with the JUnit vintage engine beside Jupiter.
- **Lint and detekt run on debug.** `check` runs lint on the default variant and detekt on debug and
  release; `lintRelease` and `lintVitalRelease` run only when asked (or `assembleRelease`, for vital).
  **If we take it:** add `lintRelease` to `check` once a release build type differs from debug.
- **The emulator job is not required, and runs one API level.** API 35, Automated Test Device image.
  **If we take it:** add "Android tests (emulator)" to the rulesets, or a matrix with `minSdk`.
- **detekt's Android tasks call a deprecated Gradle API** ("Querying the output of an artifact
  transform from a task action", removed in Gradle 10); `./gradlew check --warning-mode all` shows it
  on `:app:detektDebug`. Bump detekt once a release declares the input.
- **checkSuppressions reads text, not a parse tree.** `tools:ignore="all"` is found only under the
  `tools:` prefix (an XML file that binds the tools namespace to another prefix slips past), a
  named `tools:ignore` or `<!--suppress Id -->` needs no reason, and `noinspection` is found at the
  start of a comment line (`//`, `/*`, a KDoc `*` line), not mid-comment. **If we
  take it:** parse each XML file and resolve the namespace, or run lint with a custom check.
- **A gate task can still be skipped with `onlyIf { false }`.** The disabled-task check
  (`build.gradle.kts`, `GATE_TASK`) sees `enabled = false`, but an `onlyIf` is a closure Gradle
  evaluates only as the task runs. **If we take it:** compare each gate task's outcome after the
  build (a build service listening for SKIPPED), and fail the build on one.
- **`:data` could reach Android types through a file dependency.** `:domain` and `:usecases` refuse
  `compileOnly(files(".../android.jar"))` (a file dependency isn't in their `libraries`), but `:data`
  allows `ANY_LIBRARY`, so it would compile against the SDK jar and stop being host-testable.
  **If we take it:** refuse an SDK jar by path in every non-Android row, whatever its libraries.

## Kotlin pack: a slow clock's later edit loses, and the seed has no vendor adapter

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2f

The Kotlin tier-2 seed copies the TypeScript seed's merge rule: compose-time last writer wins, a
fast stamp clamped, a slow clock's later edit still losing while the flush reports delivered
(`NoteSyncChaosTest`, "clock skew, the other way"). Its only adapter is `SystemWallClock`; there is
no HTTP remote or database outbox. **Why deferred:** the seed shows fault injection, not a sync
design. **Where:** `domain/.../Note.kt`, `usecases/src/test/.../NoteSyncChaosTest.kt`, `data/`.
**If we take it:** anchor stamps to server time or use a hybrid logical clock, then flip that test;
add the first vendor adapter under `data/` with a test against `FaultServer`'s contract.

## Kotlin pack: tooling to revisit

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2f

- **detekt is an alpha** (2.0.0-alpha.6): 1.23.8, the last stable, is built on Kotlin 2.0 and
  can't read current syntax. Move to 2.0.0 stable when it ships; rule names may change, and
  `pnpm kotlin:gates` will say if a planted violation stops being reported.
- **A plugin calls a deprecated Gradle API** (`Configuration.setVisible`, removed in Gradle 11);
  `./gradlew help --warning-mode all` shows it. Bump detekt or ktfmt-gradle once a release drops it.
- **No Claude Code language-server plugin is enabled.** The pack's `claudeSettings.plugins` is
  empty because no Kotlin LSP plugin under `claude-plugins-official` could be verified; the
  directory has community ones. Enable one when an official name can be checked.
- **No unused-dependency check.** Gradle has no `go mod tidy -diff`; the `dependency-analysis`
  plugin's `buildHealth` is the candidate. Add it when a stale dependency costs something.

## Kotlin pack: what the gates don't stop

`open` · recorded 2026-10-02 · from the go-public plan, Phase 2f (QA round 3)

The layer gates catch drift and settings that switch a gate off (`kotlin.mdc` → What the gates are
for). They are not a sandbox, and these known classes get past them on purpose:
- **Another spelling of a denied API.** The bytecode rules are lists, and the JDK has more ways in:
  JShell (`jdk.jshell` is denied in `:usecases` only as part of `jdk/`), scripting engines,
  `java.time.zone.ZoneRulesProvider` (allowed in `:domain` with the rest of `java.time`), a
  `MethodHandle` built from an allowed lookup.
- **Overloads.** A rule names a member, not a signature, so a pure overload of a denied member
  (`String.format(Locale.ROOT, …)`) is refused with the impure one.
- **`:usecases` has a denylist, not an allowlist.** A JDK package nobody listed passes there; only
  `:domain` refuses the unlisted. An allowlist for `:usecases` would have to admit kotlinx-coroutines
  and whatever its ports need, and would be refused often by everyday code.
- **Settings flipped after configuration.** `ignoreFailures` and detekt's `failOnSeverity` are read
  once every build file is evaluated; one set later (`doFirst`, `taskGraph.whenReady`) isn't seen
  there. The gates' `> Task … FAILED` check still catches it in every probe's scratch build. Gradle
  leaves `ignoreFailures` out of a test task's build-cache key, so a run that got past this once
  can leave a passing result for failing tests in the cache; the gates' failing-test probe runs its
  task with `--rerun` for that reason. Local up-to-date state carries over the same way: once the
  setting is removed, the task can stay up to date and keep the passing result. The way out is
  `./gradlew :<mod>:test --rerun`, or `./gradlew clean` (and `--no-build-cache` on the next run).
- **Suppressions through the compiler.** `-Xsuppress-warning`, `-nowarn`, or a `freeCompilerArgs`
  entry turns warnings off without an annotation; `allWarningsAsErrors` is the only line here.

**Why deferred:** each is deliberate evasion, not drift, and closing one means another rule list
that reviewers then have to trust. **Where:** `build.gradle.kts` (`LAYERS`, the check tasks),
`stacks/kotlin/gates.mjs`. **If we take one:** add the deny or setting check, a probe in `gates.mjs`
that fails without it, and delete its line here.

## Kotlin pack: CI detection and the change-scope helper

`open` · recorded 2026-10-04 · from the CI-scope adversarial review (branch claude/prereview-ci-scope-jmkutb)

- **`stacks/kotlin/gates-lib.mjs` counts any non-empty `CI` as CI**, so `CI=0` or `CI=false` still
  forces the full run there, unlike infra, sql-migrations, swift, and cpp (anything but "", 0, or
  false). Stricter, not a silent pass, so left alone.
- **Open PR #31 adds `stacks/kotlin/scope.mjs`** with its own `git diff --name-only`, which has the
  quoted-path and rename holes fixed here for the harness and Swift classifiers.

**Why deferred:** PR #31 isn't on dev, and the CI rule only errs toward running. **Where:**
`stacks/kotlin/gates-lib.mjs`, `stacks/kotlin/scope.mjs` (PR #31). **If we take it:** import
`changedPaths` from `scripts/lib/ci-change-scope.mjs` as the Swift pack's scope does, and copy
the cpp pack's `inCI` rule.
<!-- [/stack:kotlin] -->
<!-- [stack:cpp] -->

## C++ pack: dependencies by FetchContent, not vcpkg or CPM, and no rapidcheck

`open` · recorded 2026-10-03 · from the go-public plan, Phase 2j

The seed's one dependency, GoogleTest 1.17.0, comes through CMake's own `FetchContent`, pinned by
URL and sha256; each build tree downloads it once (the gates reuse that copy). There is no vcpkg
manifest or CPM lockfile and no fully offline first build. Property tests use a seeded loop
(`cpp/tests/support/property.hpp`), not rapidcheck. **Why deferred:** one test-only dependency
doesn't pay for a package manager; rapidcheck has no release tags to pin and would build once per
sanitizer tree. **Where:** `CMakeLists.txt` (`FetchContent_Declare`), `testing-cpp.mdc`. **If we
take it:** a vcpkg manifest with a `builtin-baseline` and binary caching (or CPM with
`CPM_SOURCE_CACHE` in CI's cache) once a second dependency lands; offline means
`FETCHCONTENT_FULLY_DISCONNECTED` over a pre-filled source cache. Swap in rapidcheck if shrinking
becomes worth a pinned commit.

## C++ pack: a slow clock's later edit loses, the seed has no vendor adapter, and no early stop

`open` · recorded 2026-10-03 · from the go-public plan, Phase 2j

Same merge rule and retry shape as the other seeds: compose-time last writer wins, so a slow
device's later edit loses while the flush reports delivered
(`NoteSyncChaos.clock_skew_slow_…`), and a dead server costs the full retry budget per queued
write. The only adapter is `SystemClock`. **Why deferred:** the seed shows fault injection, not a
sync design. **Where:** `cpp/domain/src/note.cpp`, `cpp/usecases/src/note_sync.cpp`,
`cpp/domain/include/config/sync.hpp`, `cpp/adapters/`. **If we take it:** server-anchored stamps or
a hybrid logical clock (then flip that test), a circuit breaker after one write exhausts its
attempts, and the first vendor adapter with a test against `FaultServer`'s contract.

## C++ pack: toolchain to revisit

`open` · recorded 2026-10-03 · from the go-public plan, Phase 2j

- **C++20, not 23.** clang 18 can't compile libstdc++ 13's `<expected>`, so the floor
  (`MIN_STANDARD` in `stacks/cpp/evaluated.mjs`) is 20 and the domain has its own `Outcome`. Move to
  C++23 and `std::expected` when the CI image's clang and libstdc++ agree (clang 19+).
- **clang-format's major version isn't pinned.** Its output can shift between majors, so a newer
  local clang-format can disagree with CI's. Pin one (a `clang-format` wheel from PyPI by version,
  like hadolint in the infra pack) if that starts costing time.
- **The gcc leg runs only in CI** (`CPP_PACK_GCC=1` runs it locally), to keep a cold local
  `pnpm check` near 1 min. Move it local if gcc-only errors keep reaching CI.
- **The sanitizer runtimes come from apt** (`stacks/cpp/install-tools.sh`), so a non-Debian Linux
  or a non-admin self-hosted runner installs them by hand.

## C++ pack: what the gates don't stop

`open` · recorded 2026-10-03 · from the go-public plan, Phase 2j

The gates catch drift and settings that switch a gate off (`cpp.mdc` → What the gates are for).
They are not a sandbox, and these known classes get past them on purpose:
- **A raw library on an inner layer by flag.** A `-lfoo` or a path in `target_link_options` /
  `CMAKE_*_LINKER_FLAGS` isn't a target link, so the File API can't attribute it to a row; the
  symbol check still sees what the layer calls, but not which library answers.
- **Header-only code is judged where it's compiled.** A template or `inline` function in a layer's
  header that calls a denied family shows up only in the archive of a layer that instantiates it,
  and a header nobody includes is never compiled (tidy and the symbol check don't see it; its
  `#include`s are still judged by its own layer, `stacks/cpp/sources.mjs`).
- **Another spelling of a denied call.** The families are symbol lists (`SYMBOL_FAMILIES` in
  `stacks/cpp/evaluated.mjs`); a syscall through inline assembly, a function pointer fetched at
  runtime, or a family nobody listed gets past.
- **A tidy check neutered by the root's own options.** A nested `.clang-tidy` can't retune a floor
  check or any other check the root turns on (its evaluated options must equal the root's, unless
  `"tidyOff"` lists that check for the directory; `tidyFloor` in `stacks/cpp/run.mjs`), but a
  `CheckOptions` entry in the root `.clang-tidy` that narrows one (an empty function list, a raised
  threshold) is the project's own setting and isn't judged.
- **Flags from outside CMake.** `CXXFLAGS` in the environment is folded into the configured flags
  (and checked), but a `CMAKE_CXX_COMPILER_LAUNCHER`, a compiler wrapper script, or a
  toolchain-level spec file that adds `-w` or strips a flag after CMake is not seen: the File API
  shows the flags CMake asked for, not the ones the compiler got.
- **A call to a function only forward-declared.** A domain source that declares `int adapter_fn();`
  and calls it needs no include and no link of its own: it links because the test executable links
  adapters. `nm` already lists the layer's undefined symbols; flagging one defined in a layer its
  row doesn't allow would close it.

**Why deferred:** each is deliberate evasion, not drift, and closing one means another rule list
that reviewers then have to trust. **Where:** `stacks/cpp/evaluated.mjs`, `stacks/cpp/run.mjs`,
`stacks/cpp/gates.mjs`. **If we take one:** add the check, a probe in `gates.mjs` that fails
without it, and delete its line here.

## C++ pack: its CI leg runs on every PR

`open` · recorded 2026-10-03 · from the go-public plan, Phase 2j (QA round 1)

Like the Rust and Kotlin packs, the C++ checks run in the one "Checks" job on every PR, docs-ish or
TypeScript-only included: under `CI=true` that is an apt install when the image lacks
libclang-rt, three cold trees (asan, tsan, gcc), uncached clang-tidy, and the gates (~40 scratch
configures, a few small builds). It is the heaviest Linux leg (~95 s cold plus the gcc tree).
**Why deferred:** skipping a pack needs a per-pack output from the scope classifier, the same change
the Rust entry above names; it belongs to the CI cost pass (go-public Phases 5 and 7), not to the
pack. `ciHeavy` doesn't list `^cpp/` either, which is moot while Build is a no-op.
**Where:** `.github/workflows/ci.yml` (the `[stack:cpp]` fence), `scripts/lib/ci-change-scope.mjs`,
`scripts/stack.mjs` `check --packs`, `stacks/cpp/pack.json` `ciHeavy`.
**If we take it:** a `cpp` scope output (as swift has) that skips the toolchain step and the cpp
checks when no C++ path changed.
<!-- [/stack:cpp] -->

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

<!-- [stack:python] -->
## Python pack: Windows venv paths, and a Python language server for Claude Code

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2c

`stacks/python/check-edited.mjs` looks for tools in `.venv/bin`, so on Windows the per-edit hook
stays silent (CI and `pnpm check` are unaffected). The TypeScript pack enables an LSP plugin in
`.claude/settings.json`; the Python pack ships none. **Why deferred:** no Windows user yet, and a
Python LSP plugin needs a global `pyright` install that the pack's own `uv` venv doesn't provide.
**Where:** `stacks/python/check-edited.mjs` (`bin`), `.claude/settings.json` `enabledPlugins`.
**If we take it:** try `.venv/Scripts/<tool>.exe` as a fallback; add the pyright LSP plugin to the
pack's `claudeSettings.plugins` and a README step for the global install.
<!-- [/stack:python] -->

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

<!-- [stack:python] -->
## Note-sync seeds: no early stop when the server is down (about 23.5 s per write)

`open` · recorded 2026-10-01 · from the Python pack's QA (Phase 2c)

Each write gets the full retry budget (4 attempts at the 5 s timeout, plus 0.5 + 1 + 2 s of backoff,
about 23.5 s), so a flush over a dead server takes 23.5 s per queued write. **Why deferred:** a seed
that shows the fault handlers, not a tuned sync engine; a circuit breaker is a product decision.
**Where:** `src/app/services/note_sync.py` (`_deliver`), `src/app/config.py`; the TypeScript seed
has the same shape. **If we take it:** after one write exhausts its attempts, stop the flush and
requeue the rest, and add a chaos test counting requests.
<!-- [/stack:python] -->
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

<!-- [stack:sql-migrations] -->
## Strike the project's own migrations, not only the pack's fixtures

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2d

`stacks/sql-migrations/kill-partway.test.mjs` proves the atomic rule on fixture migrations, and
`pnpm migrations:lint` checks every real migration's shape (BEGIN/COMMIT when the tool doesn't
wrap). Nothing yet strikes a project's real migrations partway. **Why deferred:** it needs each
tool's ordering and file shape (Prisma directories, sqlx `.up.sql`, goose Up sections), and rows
that look like production's to be worth more than the lint. **Where:** the test's `runStatements`
and `fingerprint` already take any statement list. **If we take it:** a `migrations:strike` script
that applies `migrations/` in order to a loopback copy seeded by the project, and strikes after
every statement of each migration not yet in production (`.squawk.toml` → `excluded_paths`).

## A merged migration is never edited: make it a check

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2d

`migrations.mdc` says a merged migration is history (a database that applied it never re-runs
it, so an edit silently diverges). The lint checks it only for files in `excluded_paths` (PR #21
round 3, where `origin/dev` is fetched anyway); for the rest, only review holds that line. **Why
deferred:** checking every migration needs the base branch in the Checks job on every run, not
only when `excluded_paths` is set. **Where:** `stacks/sql-migrations/lint.mjs` (`changedFromDev`),
`ci.yml`. **If we take it:** fail when any migration file that exists on `origin/dev` differs from
it, fetching `dev` the way `devFiles()` does.

## The data-loss lint misses deletes it can't see in one statement

`open` · recorded 2026-10-02 · from PR #21 round-3 QA (S7 and nits)

`dataLossProblem()` reads each statement on its own, so these pass without a `-- data-loss:` marker:
a function defined in one statement and called in the next (`CREATE FUNCTION wipe() … DELETE …;
SELECT wipe();`: the definition is skipped as code that only defines), a delete built at run time
(`EXECUTE 'DEL' || 'ETE FROM users'`), and a column cleared to a value rather than `NULL`
(`UPDATE … SET email = ''`, `= DEFAULT`). (The guard reads both since its round-5 review: against a
real database a human runs even a targeted backfill.) **Why deferred:** each needs either cross-statement tracking or reading strings as SQL, and an
`= ''` rule would flag every ordinary backfill. **Where:** `stacks/sql-migrations/lint.mjs`
(`DATA_LOSS`, `DEFINES_CODE`). **If we take it:**
remember function names whose body deletes and flag a later call; flag `EXECUTE` of a concatenation
in a migration as needing a marker; add `SET col = ''`/`DEFAULT` only behind a marker-or-ignore
comment so a real backfill can say so.

## Alembic revisions aren't linted

`open` · recorded 2026-10-01 · from the go-public plan, Phase 2d

Alembic revisions are Python, so squawk and the atomic check never see them; the rule loads for
them (`**/alembic/versions/**`) but no check runs. **Why deferred:** no project here uses Alembic
yet. **If we take it:** render each new revision with `alembic upgrade <prev>:<rev> --sql` into a
temp `migrations/` dir and lint that.

<!-- [/stack:sql-migrations] -->

## Stop reading `model-tiers.project.json` and `dynamite-test.project.json`

`open` · recorded 2026-10-04 · from the "agent override config" project thread (decision 0006)

`agent-overrides.json` replaces both, and `scripts/agent-overrides.mjs` still reads them beneath it. **Why deferred:** projects made before it may hold either file, and dropping them quietly would change who reviews and on which model. **Where:** `LEGACY` in `scripts/agent-overrides.mjs`, the legacy tests in `scripts/model-tiers.test.mjs` and `scripts/rival-review.test.mjs`. **If we take it:** fail loudly when either file exists, naming the move (`tiers` → `models`, keys → `dynamiteTest`), once every project on whippletree has moved.
