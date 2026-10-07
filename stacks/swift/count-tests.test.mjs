/*
  The Swift test counter: a run that executed nothing is not a pass, in either framework's output shape.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no swift.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/count-tests.mjs. The sample logs are real `swift test` 6.2 output, trimmed.
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countTests, testsNotRun, verdict } from "./count-tests.mjs";

// What `swift test` printed for a package with no XCTests and 16 Swift Testing tests.
const SWIFT_TESTING_ONLY = [
  "Test Suite 'All tests' passed at 2026-10-01 19:25:16.995",
  "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds",
  "✔ Test \"a\" passed after 0.001 seconds.",
  "✔ Test run with 16 tests in 4 suites passed after 8.522 seconds.",
].join("\n");

// An empty test target: both frameworks ran and found nothing.
const EMPTY = ["\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds", "✔ Test run with 0 tests in 0 suites passed after 0.001 seconds."].join("\n");

// XCTest nests its totals: class, bundle, "All tests", each an outward total.
const XCTEST_NESTED = ["\t Executed 2 tests, with 0 failures (0 unexpected)", "\t Executed 5 tests, with 1 failure (1 unexpected)", "\t Executed 5 tests, with 1 failure (1 unexpected)"].join("\n");

// Every test skipped: two XCTSkips, two `.disabled` tests and one `.enabled(if: false)` (swift test 6.2.4, Linux). It exits 0.
const ALL_SKIPPED = [
  "Test Case 'XT.testSkip' skipped (0.001 seconds)",
  "\t Executed 2 tests, with 2 tests skipped and 0 failures (0 unexpected) in 0.102 (0.102) seconds",
  "\t Executed 2 tests, with 2 tests skipped and 0 failures (0 unexpected) in 0.102 (0.102) seconds",
  '➜ Test b() skipped: "off"',
  '➜ Test a() skipped: "off"',
  "➜ Test c() skipped.",
  "✔ Test run with 3 tests in 0 suites passed after 0.001 seconds.",
].join("\n");

// A disabled suite of two beside two that ran, and an XCTest run with a skip and a failure (swift test 6.2.4).
const SOME_SKIPPED = [
  "\t Executed 3 tests, with 1 test skipped and 1 failure (0 unexpected) in 0.002 (0.002) seconds",
  '➜ Suite Off skipped: "off"',
  '➜ Test b() skipped: "off"',
  '➜ Test a() skipped: "off"',
  "✔ Test on() passed after 0.001 seconds.",
  "✔ Test param(x:) with 2 test cases passed after 0.001 seconds.",
  "✔ Test run with 4 tests in 1 suite passed after 0.002 seconds.",
].join("\n");

describe("countTests", () => {
  it("counts Swift Testing, and ignores the 0 XCTest line beside it", () => {
    assert.deepEqual(countTests(SWIFT_TESTING_ONLY), { executed: 16, skipped: 0, failures: 0 });
  });

  it("counts an empty target as zero", () => {
    assert.equal(countTests(EMPTY).executed, 0);
  });

  it("takes the outermost XCTest total instead of summing the nesting", () => {
    assert.deepEqual(countTests(XCTEST_NESTED), { executed: 5, skipped: 0, failures: 1 });
  });

  it("adds the two frameworks, which run different tests", () => {
    assert.equal(countTests(`${XCTEST_NESTED}\n✔ Test run with 3 tests in 1 suite passed after 1 seconds.`).executed, 8);
  });

  it("counts a failed Swift Testing run as a failure", () => {
    assert.deepEqual(countTests("✘ Test run with 4 tests in 1 suite failed after 0.1 seconds with 1 issue."), { executed: 4, skipped: 0, failures: 1 });
  });

  it("takes skipped tests off both frameworks' totals, and reads XCTest's skipped shape", () => {
    assert.deepEqual(countTests(ALL_SKIPPED), { executed: 0, skipped: 5, failures: 0 });
    // XCTest 3 - 1 skipped, Swift Testing 4 - 2 skipped (the suite's own line is not a test); the failure is read too.
    assert.deepEqual(countTests(SOME_SKIPPED), { executed: 4, skipped: 3, failures: 1 });
  });

  it("does not read a passing test whose name says skipped as a skip", () => {
    assert.equal(countTests('✔ Test "a note is skipped. when stale" passed after 0.1 seconds.\n✔ Test run with 1 test in 1 suite passed after 0.1 seconds.').executed, 1);
  });
});

describe("verdict", () => {
  it("passes a run that executed tests", () => assert.equal(verdict(SWIFT_TESTING_ONLY, 0), ""));
  it("fails a green run that executed zero tests", () => assert.match(verdict(EMPTY, 0), /zero tests executed/));
  it("fails a log with no test output at all", () => assert.match(verdict("Build complete!", 0), /zero tests executed/));
  it("fails a non-zero exit even when tests were counted", () => assert.match(verdict(SWIFT_TESTING_ONLY, 1), /exited 1/));
  it("fails reported failures even on exit 0", () => assert.match(verdict(XCTEST_NESTED, 0), /1 failure/));
  it("fails a green run where every test was skipped", () => assert.match(verdict(ALL_SKIPPED, 0), /zero tests executed \(5 skipped\)/));
});

// A source @Test as boundaries.mjs testsInSource() lists it.
const at = (func, display, extra = {}) => ({ file: "Tests/T/A.swift", line: 1, display, func, ...extra });

describe("testsNotRun", () => {
  const tests = [at("drop", "drop: retries"), at("delayRetries", undefined), at("mergeIsIdempotent", "merge: idempotent"), at("kill", "kill (mid-write)")];
  const ran = [
    '✔ Test "drop: retries" passed after 0.1 seconds.',
    "✔ Test delayRetries() passed after 0.2 seconds.",
    '✘ Test "merge: idempotent" failed after 0.1 seconds with 1 issue.',
    '✔ Test "kill (mid-write)" with 2 test cases passed after 0.1 seconds.',
  ].join("\n");

  it("passes when the log shows every test passing or failing, by display name, function name, or parameterized", () => {
    assert.equal(testsNotRun(ran, tests), "");
  });

  it("names any test that never ran, fault test or not (hidden from the compiler by #if false)", () => {
    const hidden = ran.split("\n").filter((line) => !line.includes("delayRetries")).join("\n");
    assert.match(testsNotRun(hidden, tests), /1 @Test\(s\) in the source did not run .*Tests\/T\/A\.swift:1 delayRetries\(\)/);
  });

  it("does not count a skipped test as run", () => {
    assert.match(testsNotRun("➜ Test delayRetries() skipped.", [at("delayRetries", undefined)]), /delayRetries\(\)/);
  });

  it("leaves a test another platform's #if os(...) block holds to that platform's job", () => {
    assert.equal(testsNotRun("", [at("macOnly", undefined, { hidden: true })]), "");
  });

  it("has nothing to say when the source has no tests", () => assert.equal(testsNotRun("", []), ""));
});
