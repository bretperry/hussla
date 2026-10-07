#!/usr/bin/env node
// Runs one of the Swift pack's tool checks (lint, test) and says plainly when swift isn't installed or a run executed nothing.
// In the app: nothing at runtime; package.json `swift:lint`, `swift:test` call it, so `pnpm check` and CI do. The macOS job runs `test` directly.
// Used by: package.json scripts, stacks/swift/pack.json `checks`, .github/workflows/ci.yml, stacks/swift/gates.mjs.
// Uses: swift on PATH (via tool.mjs), stacks/swift/manifest.mjs, stacks/swift/count-tests.mjs, stacks/swift/boundaries.mjs (the @Tests in the source).
//
// Both tasks first check the evaluated package (manifest.mjs: `swift package dump-package`), so a
// Package.swift that drops a strict setting through code instead of text fails here.
// `test` is plain `swift test`: no filter, no flag, nothing that could hide a test (the fault
// tests included). It then reads the log, because a run that executed zero tests exits 0, and a
// test hidden from the compiler (`#if false`) is simply absent: every @Test in the source must
// show in the log as passed or failed (one `#if os(...)` leaves to another platform excepted).
// `lint` is `swift format lint --strict` (the formatter ships in the toolchain; config `.swift-format`).
// Each task has a timeout; a hung run is killed with its process group and named, never waited out.
//
// `version` prints `swift --version` and fails when swift is missing or older than 6.2: the CI
// toolchain step (the runner image's own Swift, no setup action), so a drifted image says so
// before any check runs.
//
//   node stacks/swift/run.mjs lint|test|version

// Node builtins only, plus this pack's own scripts.
import { testsInSource } from "./boundaries.mjs";
import { testsNotRun, verdict } from "./count-tests.mjs";
import { checkEvaluatedManifest } from "./manifest.mjs";
import { killGroupsOnSignal, limit, MIN_SWIFT, requireSwift, run, swiftInfo } from "./tool.mjs";

// Knob: each task's command, what it needs swift for, and how long it may run. `test` stays under
// the CI Checks job's 10 minutes (a cold build there is the slow part), so this names the hang first.
const TASKS = {
  lint: { args: ["format", "lint", "--strict", "--recursive", "Sources", "Tests", "Package.swift"], what: "swift format lint", timeoutMs: 120_000 },
  test: { args: ["test"], what: "swift test", timeoutMs: 480_000 },
};

// Which task: argv[2]. `version` needs no swift task table.
if (process.argv[2] === "version") {
  const info = swiftInfo();
  process.stdout.write(`swift pack: ${info.version.trim() || info.state} (needs ${MIN_SWIFT.join(".")}+)\n`);
  if (info.state === "ok") process.exit(0);
  // Missing is a failure here on purpose: this step exists to prove CI has a toolchain.
  process.stderr.write(`swift pack: toolchain is ${info.state}; the runner image must provide Swift ${MIN_SWIFT.join(".")} or newer.\n`);
  process.exit(1);
}
const name = process.argv[2] ?? "";
const task = TASKS[name];
if (task === undefined) {
  process.stderr.write(`swift pack: unknown task '${name}'; one of ${Object.keys(TASKS).join(", ")}\n`);
  process.exit(2);
}

// Skips loudly (exit 0) when swift is missing locally; fails under CI.
if (!requireSwift(task.what)) process.exit(0);

// Told to stop (Ctrl-C, gates.mjs timing us out): take swift's process group with us.
killGroupsOnSignal();

// The evaluated package first: a target that escapes the rules makes the task's verdict meaningless.
const manifestProblems = await checkEvaluatedManifest(process.cwd());
if (manifestProblems.length > 0) {
  process.stderr.write(`✗ swift pack: Package.swift, as evaluated:\n${manifestProblems.map((line) => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}

// Run it with its output passed through live, and kept for the count.
const timeoutMs = limit(task.timeoutMs);
const result = await run("swift", task.args, { timeoutMs, onOutput: (text) => process.stdout.write(text) });
if (result.error !== undefined) {
  process.stderr.write(`swift pack: could not run swift: ${result.error.message}\n`);
  process.exit(1);
}
if (result.timedOut) {
  process.stderr.write(`swift pack: swift ${task.args[0]} timed out after ${String(timeoutMs / 1000)} s and was killed with its process group (TASKS.${name}.timeoutMs in stacks/swift/run.mjs)\n`);
  process.exit(1);
}
// Killed by a signal is a failure, never a pass.
if (result.status === null) {
  process.stderr.write(`swift pack: swift ${task.args[0]} was killed by ${result.signal}\n`);
  process.exit(1);
}

// Lint's exit code is the verdict; test's also needs the count, and every @Test in the source in the log.
const problem =
  name === "test"
    ? verdict(result.output, result.status) || testsNotRun(result.output, testsInSource(process.cwd()))
    : result.status === 0
      ? ""
      : `swift ${task.args[0]} exited ${result.status}`;
if (problem !== "") {
  process.stderr.write(`swift pack: ${problem}\n`);
  process.exit(1);
}
