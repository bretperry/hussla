/*
  The Swift pack's tool helpers, runner, and edit hook: a missing, old, crashed, or hung swift is reported, never read as clean, and nothing it started outlives it.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no swift: a stand-in `swift` script on PATH plays each case.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/tool.mjs, stacks/swift/run.mjs, stacks/swift/check-edited.mjs against a temp copy of the package seed; scripts/check-edited.mjs (its limit).
*/
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";

import { testsInSource } from "./boundaries.mjs";
import { inCI, run, swiftInfo } from "./tool.mjs";
// [harness]
// Only the edit-hook tests use it; a separate line so an eject can drop it.
import { HOOK_TIMEOUT_MS } from "./tool.mjs";
// [/harness]

const REPO = resolve(".");
// [harness]
const HOOK = join(REPO, "stacks/swift/check-edited.mjs");
// [/harness]
const RUN = join(REPO, "stacks/swift/run.mjs");
const posix = process.platform !== "win32";
const skip = existsSync(join(REPO, "Package.swift")) && posix ? false : "no Swift seed here, or Windows";

// The seed package as `swift package dump-package` 6.2 prints it (the fields manifest.mjs reads): four strict layers and a strict test target.
const STRICT_DUMPED = [
  { kind: { treatAllWarnings: { _0: "error" } }, tool: "swift" },
  { kind: { enableUpcomingFeature: { _0: "ExistentialAny" } }, tool: "swift" },
];
const seedDump = (change = (dump) => dump) =>
  change({
    name: "App",
    swiftLanguageVersions: null,
    targets: [...["Config", "Domain", "UseCases", "Adapters"].map((name) => ({ name, type: "regular", settings: STRICT_DUMPED })), { name: "NoteSyncTests", type: "test", settings: STRICT_DUMPED }],
  });

// A bin dir holding a stand-in `swift`: `version` is the shell for `swift --version`, `dump` the JSON for
// `swift package dump-package` (the seed's by default), `body` the shell for anything else.
// Each call's arguments are appended to calls.log beside it.
const fakeSwift = ({ version = 'echo "Swift version 6.2.4 (swift-6.2.4-RELEASE)"', body = "exit 0", dump = seedDump() } = {}) => {
  const bin = mkdtempSync(join(tmpdir(), "swift-bin-"));
  writeFileSync(join(bin, "dump.json"), JSON.stringify(dump));
  writeFileSync(join(bin, "swift"), `#!/bin/sh\necho "$@" >> "${join(bin, "calls.log")}"\nif [ "$1" = "--version" ]; then\n${version}\nexit $?\nfi\nif [ "$1" = "package" ]; then\ncat "${join(bin, "dump.json")}"\nexit 0\nfi\n${body}\n`);
  chmodSync(join(bin, "swift"), 0o755);
  return { bin, calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "") };
};

// Only node, sh's own tools, and the stand-in (when given): no real swift can be found.
const pathWith = (bin) => `${bin === undefined ? "" : `${bin}:`}${dirname(process.execPath)}:/usr/bin:/bin`;

// A body for `swift <task>` that starts a long sleep in the background, records its pid, and waits on it.
const hangBody = (pidFile) => `sleep 30 &\necho $! > "${pidFile}"\nwait`;

// True while `pid` is a live process (a zombie waiting to be reaped counts as gone).
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = `/proc/${pid}/stat`;
  return !existsSync(stat) || !/^\d+ \(.*\) Z/.test(readFileSync(stat, "utf8"));
};

// Waits up to `ms` for `check` to hold.
const eventually = async (check, ms = 5_000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await sleep(50);
  return check();
};

// A scratch copy of the seed.
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "swift-hook-"));
  for (const name of ["Package.swift", "swift-layers.json", ".swift-format", "Sources", "Tests"]) cpSync(join(REPO, name), join(dir, name), { recursive: true });
  return dir;
};

describe("run", () => {
  it("kills a command that outlives its timeout and says so", { skip: !posix }, async () => {
    const started = Date.now();
    const result = await run("sleep", ["30"], { timeoutMs: 200 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 10_000, "it waited out the command");
  });

  it("reports a command that can't start", async () => {
    const result = await run("definitely-not-a-command-xyz", []);
    assert.equal(result.error?.code, "ENOENT");
  });

  it("a timed-out run.mjs takes swift's own process group with it (the gates.mjs case)", { skip }, async () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: hangBody(pidFile) });
    const result = await run(process.execPath, [RUN, "test"], { cwd: dir, timeoutMs: 1_500, env: { PATH: pathWith(bin) } });
    assert.equal(result.timedOut, true);
    assert.ok(existsSync(pidFile), `swift test never started:\n${result.output}`);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await eventually(() => !alive(pid)), `swift's child ${pid} outlived run.mjs`);
  });
});

describe("swiftInfo", () => {
  it("names a `swift --version` that hangs past its limit, as broken (the ETIMEDOUT branch)", { skip: !posix }, () => {
    const { bin } = fakeSwift({ version: "exec sleep 30" });
    const saved = process.env.PATH;
    process.env.PATH = pathWith(bin);
    try {
      const info = swiftInfo({ timeoutMs: 200 });
      assert.equal(info.state, "broken");
      assert.match(info.version, /`swift --version` timed out after 0\.2 s \(VERSION_TIMEOUT_MS/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("reads an old toolchain as old", { skip: !posix }, () => {
    const { bin } = fakeSwift({ version: 'echo "Swift version 5.10 (swift-5.10-RELEASE)"' });
    const saved = process.env.PATH;
    process.env.PATH = pathWith(bin);
    try {
      assert.deepEqual(swiftInfo(), { state: "old", version: "Swift version 5.10 (swift-5.10-RELEASE)" });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("inCI", () => {
  it("counts CI set to anything but empty, 0, or false, like the infra pack (CI=1 is CI)", () => {
    for (const value of ["true", "1", "yes", "TRUE", " true "]) assert.equal(inCI({ CI: value }), true, value);
    for (const value of [undefined, "", "0", "false", "False"]) assert.equal(inCI({ CI: value }), false, String(value));
  });
});

describe("run.mjs", () => {
  // No real swift may sit in the dirs pathWith() keeps, or "missing" can't be staged.
  const noSwift = skip || (existsSync("/usr/bin/swift") || existsSync("/bin/swift") ? "a real swift is in /usr/bin or /bin" : false);
  it("fails, not skips, without swift under CI=1, and skips loudly without CI", { skip: noSwift }, () => {
    const ci = spawnSync(process.execPath, [RUN, "lint"], { cwd: project(), encoding: "utf8", env: { PATH: pathWith(), CI: "1" } });
    assert.equal(ci.status, 1, ci.stderr);
    assert.match(ci.stderr, /swift is not installed, and CI is set \(CI=1\)/);
    const local = spawnSync(process.execPath, [RUN, "lint"], { cwd: project(), encoding: "utf8", env: { PATH: pathWith(), CI: "0" } });
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stderr, /SKIPPED: swift not installed/);
  });

  it("prints why the toolchain is broken (a timed-out probe), not just that it is", { skip }, () => {
    const { bin } = fakeSwift({ version: "exec sleep 30" });
    const result = spawnSync(process.execPath, [RUN, "lint"], { cwd: project(), encoding: "utf8", env: { PATH: pathWith(bin), SWIFT_PACK_TIMEOUT_MS: "300" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`swift --version` timed out after 0\.3 s .*so swift format lint cannot run/);
  });

  it("kills a hung `swift test` at its limit, names the knob, and leaves nothing running", { skip }, () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: hangBody(pidFile) });
    const result = spawnSync(process.execPath, [RUN, "test"], { cwd: dir, encoding: "utf8", env: { PATH: pathWith(bin), SWIFT_PACK_TIMEOUT_MS: "800" }, timeout: 20_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /swift test timed out after 0\.8 s .*TASKS\.test\.timeoutMs/);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  });

  it("fails a green run whose fault tests never ran (#if false around them)", { skip }, () => {
    const log = "✔ Test run with 6 tests in 2 suites passed after 0.1 seconds.";
    const { bin } = fakeSwift({ body: `echo "${log}"` });
    const result = spawnSync(process.execPath, [RUN, "test"], { cwd: project(), encoding: "utf8", env: { PATH: pathWith(bin) } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /16 @Test\(s\) in the source did not run .*NoteSyncChaosTests\.swift:\d+ delay\(\)/);
  });

  it("fails a green run where one non-fault test never ran, and passes once the log shows it", { skip }, () => {
    const dir = project();
    // Every @Test in the seed, as the log names it, except the merge law: the #if false case.
    const lines = testsInSource(dir).map(({ display, func }) => (display === undefined ? `✔ Test ${func}() passed after 0.1 seconds.` : `✔ Test "${display}" passed after 0.1 seconds.`));
    const law = lines.findIndex((line) => line.includes("merging is idempotent"));
    assert.ok(law !== -1, "the seed's merge-law test is gone; pick another non-fault test");
    const logFile = join(dir, "log.txt");
    writeFileSync(logFile, [...lines.filter((_, index) => index !== law), "✔ Test run with 15 tests in 4 suites passed after 0.1 seconds."].join("\n"));
    const { bin } = fakeSwift({ body: `cat "${logFile}"` });
    const missing = spawnSync(process.execPath, [RUN, "test"], { cwd: dir, encoding: "utf8", env: { PATH: pathWith(bin) } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /1 @Test\(s\) in the source did not run .*DomainTests\.swift:\d+ /);
    writeFileSync(logFile, [...lines, "✔ Test run with 16 tests in 4 suites passed after 0.1 seconds."].join("\n"));
    const all = spawnSync(process.execPath, [RUN, "test"], { cwd: dir, encoding: "utf8", env: { PATH: pathWith(bin) } });
    assert.equal(all.status, 0, all.stderr);
  });

  for (const task of ["lint", "test"]) {
    it(`${task}: fails on a package that escapes a rule only when evaluated, before running the task`, { skip }, () => {
      const fake = fakeSwift({ dump: seedDump((dump) => ({ ...dump, targets: [...dump.targets, { name: "ZzPlugin", type: "plugin", settings: [] }] })) });
      const result = spawnSync(process.execPath, [RUN, task], { cwd: project(), encoding: "utf8", env: { PATH: pathWith(fake.bin) } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Package\.swift, as evaluated:\n.*target 'ZzPlugin' is a plugin target/);
      assert.doesNotMatch(fake.calls(), /^(format|test)\b/m, "the task ran anyway");
    });
  }

  it("gives `swift package dump-package` a limit and names it", { skip }, () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const fake = fakeSwift();
    // Replace the dump answer with a hang: the stand-in's `package` branch runs the hang instead.
    writeFileSync(join(fake.bin, "swift"), readFileSync(join(fake.bin, "swift"), "utf8").replace(/cat "[^"]*dump\.json"/, hangBody(pidFile)));
    const result = spawnSync(process.execPath, [RUN, "lint"], { cwd: dir, encoding: "utf8", env: { PATH: pathWith(fake.bin), SWIFT_PACK_TIMEOUT_MS: "500" }, timeout: 20_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dump-package` timed out after 0\.5 s .*DUMP_TIMEOUT_MS in stacks\/swift\/manifest\.mjs/);
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
  });
});

// A body for a stand-in swift that ignores SIGTERM (and so does its child): only SIGKILL stops it.
const stubborn = (pidFile) => `trap '' TERM\nsh -c 'trap "" TERM; sleep 30' &\necho $! > "${pidFile}"\nwait`;

describe("stopping on a signal", () => {
  it("run.mjs, told to stop, SIGTERMs swift's group, waits the grace, then SIGKILLs it, and dies of the signal", { skip }, async () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: stubborn(pidFile) });
    const child = spawn(process.execPath, [RUN, "test"], { cwd: dir, env: { PATH: pathWith(bin), SWIFT_PACK_GRACE_MS: "300" }, stdio: "ignore" });
    const exited = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""), "swift test never started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.ok(await eventually(() => !alive(pid)), `swift's child ${pid}, which ignores SIGTERM, outlived run.mjs`);
  });

  it("a parent told to stop lets its run.mjs child stop swift first, instead of SIGKILLing it and orphaning swift (gates.mjs → run.mjs → swift)", { skip }, async () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: stubborn(pidFile) });
    // gates.mjs in miniature: opts in to killGroupsOnSignal, then runs run.mjs test through run().
    const parentFile = join(dir, "parent.mjs");
    writeFileSync(parentFile, `import { killGroupsOnSignal, run } from ${JSON.stringify(pathToFileURL(join(REPO, "stacks/swift/tool.mjs")).href)};\nkillGroupsOnSignal();\nawait run(process.execPath, [${JSON.stringify(RUN)}, "test"]);\n`);
    const parent = spawn(process.execPath, [parentFile], { cwd: dir, env: { PATH: pathWith(bin), SWIFT_PACK_GRACE_MS: "300" }, stdio: "ignore" });
    const exited = new Promise((done) => parent.on("exit", (code, signal) => done({ code, signal })));
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""), "swift test never started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    parent.kill("SIGTERM");
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.ok(await eventually(() => !alive(pid)), `swift's child ${pid} outlived the parent: run.mjs was killed before it could stop it`);
  });

  it("a timed-out run.mjs under a parent's run() still gets to kill a swift that ignores SIGTERM", { skip }, async () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: stubborn(pidFile) });
    const saved = process.env.SWIFT_PACK_GRACE_MS;
    process.env.SWIFT_PACK_GRACE_MS = "300";
    try {
      const result = await run(process.execPath, [RUN, "test"], { cwd: dir, timeoutMs: 1_500, env: { PATH: pathWith(bin), SWIFT_PACK_GRACE_MS: "300" } });
      assert.equal(result.timedOut, true);
      assert.equal(result.signal, "SIGTERM", `run.mjs was SIGKILLed before it could stop swift:\n${result.output}`);
      assert.ok(existsSync(pidFile), `swift test never started:\n${result.output}`);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(await eventually(() => !alive(pid)), `swift's child ${pid} outlived run.mjs`);
    } finally {
      if (saved === undefined) delete process.env.SWIFT_PACK_GRACE_MS;
      else process.env.SWIFT_PACK_GRACE_MS = saved;
    }
  });
});

// [harness]
// The edit hook (scripts/check-edited.mjs) is the harness's; `pnpm harness:eject` drops it and these tests.
// Runs the edit hook on `file` in a scratch copy; `plant` replaces that file first. `bin` is a fakeSwift() dir, or undefined for no swift.
const hookRun = ({ bin, file = "Sources/Domain/Note.swift", plant, env = {}, dir = project() }) => {
  if (plant !== undefined) writeFileSync(join(dir, file), plant);
  const result = spawnSync(process.execPath, [HOOK, file], { cwd: dir, encoding: "utf8", env: { PATH: pathWith(bin), ...env } });
  return { status: result.status, out: result.stdout };
};

describe("check-edited", () => {
  it("says swift is not installed, and still runs the boundary scan", { skip }, () => {
    const clean = hookRun({});
    assert.match(clean.out, /swift not installed: Swift edits unchecked/);
    const dirty = hookRun({ plant: "import Adapters\n" });
    assert.match(dirty.out, /Domain imports 'Adapters'/);
    assert.match(dirty.out, /swift not installed/);
  });

  it("reports a swift that exits non-zero without output instead of reading it as clean", { skip }, () => {
    const { out } = hookRun({ bin: fakeSwift({ body: "exit 3" }).bin });
    assert.match(out, /swift format lint exited 3/);
    assert.match(out, /swift build exited 3/);
  });

  it("is silent when every tool ran and passed", { skip }, () => {
    assert.equal(hookRun({ bin: fakeSwift().bin }).out, "");
  });

  it("shows the compiler's errors, not just an exit code", { skip }, () => {
    const { out } = hookRun({ bin: fakeSwift({ body: 'if [ "$1" = "build" ]; then echo "Sources/Domain/Note.swift:3:1: error: cannot find x in scope"; exit 1; fi\nexit 0' }).bin });
    assert.match(out, /cannot find x in scope/);
  });

  it("reports an old toolchain as unchecked, and runs none of its tools", { skip }, () => {
    const fake = fakeSwift({ version: 'echo "Swift version 5.10 (swift-5.10-RELEASE)"' });
    const { out } = hookRun({ bin: fake.bin });
    assert.match(out, /Swift version 5\.10 .* is older than 6\.2: Swift edits unchecked/);
    assert.doesNotMatch(fake.calls(), /format|build/);
  });

  it("gives `swift --version` its own short limit and names it", { skip }, () => {
    const started = Date.now();
    const { out } = hookRun({ bin: fakeSwift({ version: "exec sleep 30" }).bin, env: { SWIFT_PACK_TIMEOUT_MS: "300" } });
    assert.match(out, /`swift --version` timed out after 0\.3 s \(HOOK_TIMEOUT_MS\.version in stacks\/swift\/tool\.mjs\): Swift edits unchecked/);
    assert.ok(Date.now() - started < 10_000);
  });

  it("kills the running build's process group when the core times the hook out (SIGTERM)", { skip }, async () => {
    const dir = project();
    const pidFile = join(dir, "sleep.pid");
    const { bin } = fakeSwift({ body: `if [ "$1" = "build" ]; then\n${hangBody(pidFile)}\nfi\nexit 0` });
    const hook = spawn(process.execPath, [HOOK, "Sources/Domain/Note.swift"], { cwd: dir, env: { PATH: pathWith(bin) }, stdio: "ignore" });
    const exited = new Promise((done) => hook.on("exit", (code, signal) => done({ code, signal })));
    assert.ok(await eventually(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""), "the build never started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    hook.kill("SIGTERM");
    // Death by the signal, not exit 143: the core reads a SIGTERM death as "timed out".
    assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
    assert.ok(await eventually(() => !alive(pid)), `the build's child ${pid} outlived the hook`);
  });

  it("on a swift-layers.json edit, reports a violation in any file and needs no swift", { skip }, () => {
    const dir = project();
    writeFileSync(join(dir, "Sources/Domain/Zz.swift"), "import Adapters\n");
    const fake = fakeSwift();
    const { out } = hookRun({ bin: fake.bin, file: "swift-layers.json", dir });
    assert.match(out, /Sources\/Domain\/Zz\.swift:1: Domain imports 'Adapters'/);
    assert.equal(fake.calls(), "");
  });

  it("on a .swift-format edit, lints the whole package and doesn't build", { skip }, () => {
    const fake = fakeSwift({ body: 'if [ "$1" = "format" ]; then echo "Sources/Domain/Note.swift:1:1: warning: [NeverForceUnwrap] x"; exit 1; fi\nexit 0' });
    const { out } = hookRun({ bin: fake.bin, file: ".swift-format" });
    assert.match(out, /NeverForceUnwrap/);
    assert.match(fake.calls(), /format lint --strict --recursive Sources Tests Package\.swift/);
    assert.doesNotMatch(fake.calls(), /build/);
  });

  it("keeps its tool limits under the core's per-pack limit, so a slow tool is named before the core kills the hook", () => {
    const core = Number(/const PACK_TIMEOUT_MS = ([\d_]+);/.exec(readFileSync(join(REPO, "scripts/check-edited.mjs"), "utf8"))?.[1].replaceAll("_", ""));
    assert.ok(core > 0, "PACK_TIMEOUT_MS not found in scripts/check-edited.mjs");
    const sum = HOOK_TIMEOUT_MS.version + HOOK_TIMEOUT_MS.format + HOOK_TIMEOUT_MS.build;
    assert.ok(sum < core, `hook limits sum to ${sum} ms, not under the core's ${core} ms`);
  });
});
// [/harness]
