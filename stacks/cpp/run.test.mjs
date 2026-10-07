/*
  The C++ pack's test verdict: a failure, a run of zero tests, or a source test that didn't run each fail, and only a GoogleTest result line counts as a test that ran.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no toolchain: the CTest report is written here.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/cpp/run.mjs (parseJunit, testVerdict, propertyProblems, legs).

  gates.mjs proves the same verdict end to end on a real build (zero tests, #if 0, ASan, UBSan); these pin the parsing edges.
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { legs, parseJunit, propertyProblems, testVerdict } from "./run.mjs";

// One CTest JUnit <testcase>: its status, and GoogleTest's log inside it (OK, FAILED, or nothing).
const testcase = (name, status, log = status === "run" ? `[       OK ] ${name} (0 ms)` : `[  FAILED  ] ${name} (0 ms)`) =>
  `<testcase name="${name}" classname="${name}" time="0.01" status="${status}"><system-out>[ RUN      ] ${name}\n${log}\n</system-out></testcase>`;
const report = (...cases) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Linux" tests="${cases.length}">\n${cases.join("\n")}\n</testsuite>\n`;
const source = (suite, name) => ({ file: "cpp/tests/x_test.cpp", line: 1, macro: "TEST", suite, name });

describe("parseJunit", () => {
  it("reads each case, and whether GoogleTest itself finished it", () => {
    const cases = parseJunit(report(testcase("Note.Works", "run"), testcase("Note.Breaks", "fail"), testcase("Note.Crashed", "fail", "AddressSanitizer: heap-buffer-overflow")));
    assert.deepEqual(cases, [
      { name: "Note.Works", status: "run", ran: true, failedInLog: false },
      { name: "Note.Breaks", status: "fail", ran: true, failedInLog: true },
      { name: "Note.Crashed", status: "fail", ran: false, failedInLog: false },
    ]);
  });
  it("decodes XML entities in a parameterized name", () => {
    assert.equal(parseJunit(report(testcase("Each/Param.Case/0", "run").replace('name="Each/Param.Case/0"', 'name="Each/Param.Case/0&amp;"')))[0]?.name, "Each/Param.Case/0&");
  });
});

describe("testVerdict", () => {
  const sources = [source("Note", "Works"), source("Note", "AlsoWorks")];
  it("passes when every source test ran and passed", () => {
    assert.equal(testVerdict(parseJunit(report(testcase("Note.Works", "run"), testcase("Note.AlsoWorks", "run"))), sources, "asan"), "");
  });
  it("fails zero tests executed", () => {
    assert.match(testVerdict([], [], "asan"), /zero tests executed in the asan tree/);
  });
  it("fails a test that exited 0 without GoogleTest saying it finished", () => {
    assert.match(testVerdict(parseJunit(report(testcase("Note.Works", "run", "(the process exited before the result)"))), [source("Note", "Works")], "tsan"), /did not pass[\s\S]*Note\.Works \(run, no GoogleTest result\)/);
  });
  it("names a source test that never ran (behind #if 0, or in no executable)", () => {
    assert.match(testVerdict(parseJunit(report(testcase("Note.Works", "run"))), sources, "asan"), /did not run in the asan tree[\s\S]*Note\.AlsoWorks \(cpp\/tests\/x_test\.cpp:1\)/);
  });
  it("puts failures first, so a sanitizer abort is reported as a failure, not as zero tests", () => {
    assert.match(testVerdict(parseJunit(report(testcase("Note.Works", "fail", "UndefinedBehaviorSanitizer"))), sources, "asan"), /did not pass/);
  });
  it("counts a parameterized or typed instance as its source test having run", () => {
    const cases = parseJunit(report(testcase("Each/Sizes.Fit/0", "run"), testcase("Typed/0.Holds", "run"), testcase("Typed/1.Holds", "run")));
    assert.equal(testVerdict(cases, [source("Sizes", "Fit"), source("Typed", "Holds")], "asan"), "");
  });
});

describe("a log that fails whatever CTest said", () => {
  it("fails a passed case whose log shows GoogleTest failing it (WILL_FAIL, a pass pattern, an exit-0 process)", () => {
    const cases = parseJunit(report(testcase("Note.Works", "run", "[  FAILED  ] Note.Works (0 ms)")));
    assert.match(testVerdict(cases, [source("Note", "Works")], "asan"), /did not pass[\s\S]*Note\.Works \(run, but its log shows a failure or a sanitizer report\)/);
  });
  it("fails a passed case whose log holds a sanitizer report", () => {
    for (const banner of ["==1==ERROR: LeakSanitizer: detected memory leaks", "WARNING: ThreadSanitizer: data race (pid=1)", "x.cpp:3:5: runtime error: signed integer overflow", "==1==ERROR: AddressSanitizer: heap-buffer-overflow", "SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior x.cpp:3:5", "/src/a b/x.cpp:3: runtime error: load of null pointer"]) {
      const cases = parseJunit(report(testcase("Note.Works", "run", `[       OK ] Note.Works (0 ms)\n${banner}`)));
      assert.match(testVerdict(cases, [source("Note", "Works")], "asan"), /did not pass/, banner);
    }
  });
  it("fails a report on the log's first line, right after <system-out>", () => {
    const xml = report(testcase("Note.Works", "run").replace("<system-out>", "<system-out>==1==ERROR: AddressSanitizer: initialization-order-fiasco\n"));
    assert.match(testVerdict(parseJunit(xml), [source("Note", "Works")], "asan"), /did not pass/);
  });
  it("passes a test that prints a sample report after other text (a log or diagnostics test)", () => {
    for (const sample of ["input: ==1==ERROR: AddressSanitizer: heap-use-after-free (sample)", "input: foo.cpp:3:5: runtime error: signed integer overflow (sample)", "seen: WARNING: ThreadSanitizer: data race", "input: ERROR: AddressSanitizer", "&lt;system-out&gt;==1==ERROR: AddressSanitizer: (sample)"]) {
      const cases = parseJunit(report(testcase("Note.Works", "run", `${sample}\n[       OK ] Note.Works (0 ms)`)));
      assert.equal(testVerdict(cases, [source("Note", "Works")], "asan"), "", sample);
    }
  });
});

// One test as `ctest --show-only=json-v1` lists it, with these properties.
const listedTest = (...properties) => ({ name: "Note.Works", properties });

describe("propertyProblems", () => {
  it("passes gtest_discover_tests' own properties", () => {
    assert.deepEqual(propertyProblems([listedTest({ name: "SKIP_REGULAR_EXPRESSION", value: ["\\[  SKIPPED \\]"] }, { name: "LABELS", value: ["unit"] }, { name: "WORKING_DIRECTORY", value: "/b" })]), []);
  });
  it("refuses each property that turns a failure into a pass or a skip", () => {
    for (const [name, value] of [["WILL_FAIL", true], ["WILL_FAIL", "ON"], ["PASS_REGULAR_EXPRESSION", [".*"]], ["FAIL_REGULAR_EXPRESSION", ["x"]], ["SKIP_RETURN_CODE", 1], ["SKIP_REGULAR_EXPRESSION", ["\\[  SKIPPED \\]", "FAILED"]], ["DISABLED", true]]) {
      assert.equal(propertyProblems([listedTest({ name, value })]).length, 1, JSON.stringify([name, value]));
    }
  });
  it("lets a boolean property set to false through", () => {
    assert.deepEqual(propertyProblems([listedTest({ name: "WILL_FAIL", value: false }, { name: "DISABLED", value: "OFF" })]), []);
  });
  it("refuses sanitizer and GoogleTest variables in ENVIRONMENT and ENVIRONMENT_MODIFICATION, and only those", () => {
    const problems = propertyProblems([listedTest({ name: "ENVIRONMENT", value: ["ASAN_OPTIONS=detect_leaks=0", "HOME=/tmp"] }, { name: "ENVIRONMENT_MODIFICATION", value: ["TSAN_OPTIONS=set:report_bugs=0", "GTEST_FILTER=reset:"] })]);
    assert.deepEqual(problems.map((line) => /sets (\w+)/.exec(line)?.[1]), ["ASAN_OPTIONS", "TSAN_OPTIONS", "GTEST_FILTER"]);
  });
});

describe("legs", () => {
  it("runs the sanitizer trees always and the gcc tree only under CI or on request", () => {
    assert.deepEqual(legs({}), ["asan", "tsan"]);
    assert.deepEqual(legs({ CI: "true" }), ["asan", "tsan", "gcc"]);
    assert.deepEqual(legs({ CI: "1" }), ["asan", "tsan", "gcc"]);
    assert.deepEqual(legs({ CI: "false" }), ["asan", "tsan"]);
    assert.deepEqual(legs({ CPP_PACK_GCC: "1" }), ["asan", "tsan", "gcc"]);
  });
});
