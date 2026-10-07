#!/usr/bin/env node
// Counts the tests a `swift test` run executed, from its console output, so a run that executed none can't pass.
// In the app: nothing at runtime; run.mjs feeds it every `swift test` log.
// Used by: stacks/swift/run.mjs; tested by stacks/swift/count-tests.test.mjs. CLI: `node stacks/swift/count-tests.mjs <log>` (or stdin).
// Uses: nothing.
//
// Why this exists: `swift test` exits 0 on "Executed 0 tests" and on a Swift Testing run of 0
// tests, so a test target that never attached (a renamed folder, a file with no @Test) is green.
// A skipped test is counted in both frameworks' totals, so an all-skipped suite looks like a run;
// skips are taken off. Two frameworks print two shapes in one run, each at several levels:
// - XCTest: "Executed N tests, with [K tests skipped and] F failures" once per suite level, each an
//   outward total, so the biggest is the real one (summing would multiply it).
// - Swift Testing: one "Test run with N tests in S suites passed|failed" line, which counts skipped
//   tests too; each skipped test also prints its own "Test <name> skipped" line.
// The two frameworks' tests are different tests, so they add.

// Node builtins only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const XCTEST = /Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?/g;
const SWIFT_TESTING = /Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed)/g;
// `➜ Test a() skipped: "why"` or `➜ Test c() skipped.` (the symbol differs by platform; a suite's own skip line is not a test).
const SWIFT_TESTING_SKIPPED = /^\S+ Test .+ skipped(?:: ".*"|\.)$/gm;

// { executed, skipped, failures } for one run's text; failures counts failed XCTests plus 1 per failed Swift Testing run.
export const countTests = (text) => {
  let xctest = 0;
  let xctestSkipped = 0;
  let xctestFailures = 0;
  for (const [, total, skipped, failed] of text.matchAll(XCTEST)) {
    xctest = Math.max(xctest, Number(total));
    xctestSkipped = Math.max(xctestSkipped, Number(skipped ?? 0));
    xctestFailures = Math.max(xctestFailures, Number(failed));
  }
  let testing = 0;
  let testingFailures = 0;
  for (const [, total, verdict] of text.matchAll(SWIFT_TESTING)) {
    testing = Math.max(testing, Number(total));
    if (verdict === "failed") testingFailures += 1;
  }
  const testingSkipped = [...text.matchAll(SWIFT_TESTING_SKIPPED)].length;
  const skipped = xctestSkipped + testingSkipped;
  return { executed: Math.max(0, xctest + testing - skipped), skipped, failures: xctestFailures + testingFailures };
};

// Why a run is not a pass, or "" when it is. `status` is the swift test exit code.
export const verdict = (text, status) => {
  const { executed, skipped, failures } = countTests(text);
  if (status !== 0) return `swift test exited ${status}${failures > 0 ? ` (${failures} failing)` : ""}`;
  if (executed === 0) {
    return skipped > 0
      ? `zero tests executed (${skipped} skipped): a run where every test was skipped tested nothing`
      : "zero tests executed: a green `swift test` that ran nothing is a missing test target, not a pass";
  }
  if (failures > 0) return `${failures} failure(s) reported`;
  return "";
};

// A string as a literal piece of a RegExp.
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Why some @Test in the source didn't run, or "" when the log shows every one passing or failing.
// `tests` are boundaries.mjs testsInSource(): `{ file, line, display, func, hidden }`, `display` being
// the @Test("...") name when there is one. A test the compiler never saw (`#if false`) prints no
// line, so it shows up here; skipped is not run. One a `#if os(...)` compiles out on this platform
// (`hidden`) is not expected here: the other platform's job runs it.
export const testsNotRun = (text, tests) => {
  const ran = ({ display, func }) => {
    const label = display === undefined ? `${literal(func)}\\([^)]*\\)` : `"${literal(display)}"`;
    return new RegExp(`Test ${label} (?:with \\d+ test cases? )?(?:passed|failed)`).test(text);
  };
  const missing = tests.filter((test) => !test.hidden && !ran(test));
  if (missing.length === 0) return "";
  return `${missing.length} @Test(s) in the source did not run (compiled out by an #if, or skipped): ${missing.map(({ file, line, func }) => `${file}:${line} ${func}()`).join(", ")}. Every test runs on every platform; only \`#if os(...)\` may leave one to the other platform's job (testing-swift.mdc)`;
};

// CLI: count a saved log (exit 1 when it ran no tests or any failed).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = readFileSync(process.argv[2] ?? 0, "utf8");
  const problem = verdict(text, 0);
  process.stdout.write(`executed_tests=${countTests(text).executed}\n`);
  if (problem !== "") {
    process.stderr.write(`swift test: ${problem}\n`);
    process.exit(1);
  }
}
