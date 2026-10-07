#!/usr/bin/env node
// Runs one of the C++ pack's checks (build, lint, test) and says plainly when a tool is missing or a run executed nothing.
// In the app: nothing at runtime; package.json `cpp:build`, `cpp:lint`, `cpp:test` call it, so `pnpm check` and CI do; CI's toolchain step runs `version`.
// Used by: package.json scripts, stacks/cpp/pack.json `checks`, .github/workflows/ci.yml, stacks/cpp/gates.mjs (runTests, tidyFiles).
// Uses: stacks/cpp/tool.mjs (tools, process groups), stacks/cpp/sources.mjs (source rules), stacks/cpp/evaluated.mjs (configured, included, called).
//
// build  configures and builds each tree (asan, tsan; gcc too under CI=true or CPP_PACK_GCC=1),
//        then checks it as evaluated: the File API model, ninja's include record, nm of each layer.
// lint   the source rules, clang-format on every file, each directory's evaluated clang-tidy config
//        (the REQUIRED_TIDY_CHECKS floor, the root's checks less "tidyOff", and their options),
//        then clang-tidy on every first-party translation unit with warnings as errors forced on
//        the command line. Locally, a unit whose inputs are unchanged since it last passed is
//        skipped (TIDY_CACHE); CI=true always runs every one.
// test   refuses a test property that changes the verdict or the sanitizers' options (WILL_FAIL,
//        a pass/fail/skip pattern, ASAN_OPTIONS in ENVIRONMENT …), runs CTest in each tree with the
//        sanitizers' options set here (a report stops the test), then reads the JUnit report: zero
//        tests executed fails, a log with a FAILED line or a sanitizer report fails whatever CTest
//        said, and so does any TEST in the source missing from a tree's run (#if 0 compiles it away).
// version prints each tool's version and fails when one is missing or below its floor (CI's toolchain step).
//
//   node stacks/cpp/run.mjs build|lint|test|version

// Node builtins only, plus this pack's own scripts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build, buildDir, checkConfigured, checkIncludes, checkPresets, checkSymbols, configure, parseDeps, PRESETS, readModel } from "./evaluated.mjs";
import { checkSources, cppFiles, LAYER_MAP, readLayerMap, REQUIRED_TIDY_CHECKS, SOURCE_ROOT, testsInSource } from "./sources.mjs";
import { failure, inCI, killGroupsOnSignal, limit, pool, requireTools, run, toolInfo, TOOLS } from "./tool.mjs";

// Knob: per-run limits. A tidy unit with GoogleTest takes ~15 s cold; a whole CTest run is seconds.
export const TIMEOUTS = { format: 60_000, listChecks: 30_000, tidyUnit: 180_000, ctest: 300_000 };

// Knob: each test's own limit inside CTest (a hung test is named, not waited out).
const CTEST_TEST_TIMEOUT_S = 60;

// Knob: how much of each test's output CTest keeps for the report (its default for a passing test
// is 1 KB, which can cut off the FAILED line or sanitizer report the verdict reads).
const CTEST_OUTPUT_BYTES = 1_048_576;

// Knob: the sanitizers' options for every test run. Set here, not inherited, so an environment
// variable can't make a report print and pass.
export const SANITIZER_ENV = {
  ASAN_OPTIONS: "halt_on_error=1:detect_leaks=1:abort_on_error=0:strict_string_checks=1",
  UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
  TSAN_OPTIONS: "halt_on_error=1:second_deadlock_stack=1",
  LSAN_OPTIONS: "",
};

// Knob: where tidy remembers a unit that passed, per tree (inside the ignored build tree).
const TIDY_CACHE = `${buildDir("asan")}/tidy-cache`;

// The presets this run builds and tests: the sanitizer trees always; the second compiler under CI or on request.
export const legs = (env = process.env) => Object.keys(PRESETS).filter((preset) => !PRESETS[preset].ci || inCI(env) || env.CPP_PACK_GCC === "1");

// The tools a task needs, given the legs it runs.
const toolsFor = (task, presets) => {
  const compilers = presets.includes("gcc") ? ["clang++", "g++"] : ["clang++"];
  if (task === "build") return ["cmake", "ninja", ...compilers, "nm"];
  if (task === "lint") return ["cmake", "ninja", "clang++", "clang-format", "clang-tidy"];
  return ["cmake", "ninja", ...compilers];
};

// Prints findings under a heading and returns how many there were.
const report = (heading, findings) => {
  if (findings.length > 0) process.stderr.write(`✗ ${heading}:\n${findings.map((line) => `  ${line}`).join("\n")}\n`);
  return findings.length;
};

// Last lines of a tool's output, for a failure message.
const tail = (text, lines = 40) => text.split("\n").filter((line) => line.trim() !== "").slice(-lines).join("\n");

// Configures a tree unless it already is (lint and test); build always reconfigures, since a preset edit doesn't.
const ensureConfigured = async (root, preset, { always = false } = {}) => {
  if (!always && existsSync(join(root, buildDir(preset), "CMakeCache.txt"))) return "";
  const result = await configure(root, preset);
  const why = failure(`cmake --preset ${preset}`, result, 0, "CONFIGURE_TIMEOUT_MS in stacks/cpp/evaluated.mjs");
  return why === "" ? "" : `${why}\n${tail(result.output)}`;
};

// `build`: every leg configured, built, and checked as evaluated; resolves the finding count.
export const buildTask = async (root, presets = legs()) => {
  let problems = report("cpp presets", checkPresets(root));
  if (problems > 0) return problems;
  for (const preset of presets) {
    const configured = await ensureConfigured(root, preset, { always: true });
    if (configured !== "") return report(`cpp ${preset} configure`, [configured]);
    const model = readModel(root, preset);
    if (model === undefined) return report(`cpp ${preset}`, ["CMake wrote no File API reply, so nothing could be checked."]);
    const built = await build(root, preset);
    const why = failure(`cmake --build ${buildDir(preset)}`, built, 0, "BUILD_TIMEOUT_MS in stacks/cpp/evaluated.mjs");
    // A failed build is reported, but the configured checks still run: they need no build, and often explain it.
    if (why !== "") problems += report(`cpp ${preset} build`, [`${why}\n${tail(built.output.split("\n").filter((line) => /error|FAILED/.test(line)).join("\n") || built.output)}`]);
    problems += report(`cpp ${preset} configured (File API)`, checkConfigured(root, preset, model));
    if (why === "") {
      problems += report(`cpp ${preset} includes (ninja deps)`, await checkIncludes(root, preset, model));
      problems += report(`cpp ${preset} calls (nm)`, await checkSymbols(root, preset, model));
    }
  }
  return problems;
};

// Each first-party translation unit in a tree's compile_commands.json: { file (repo-relative), command }.
export const unitsOf = (root, preset) => {
  const path = join(root, buildDir(preset), "compile_commands.json");
  if (!existsSync(path)) return [];
  const prefix = `${resolve(root)}/${SOURCE_ROOT}/`;
  return JSON.parse(readFileSync(path, "utf8"))
    .filter((unit) => unit.file.startsWith(prefix))
    .map((unit) => ({ file: unit.file.slice(resolve(root).length + 1), command: unit.command ?? (unit.arguments ?? []).join(" ") }));
};

// What clang-tidy has on for `file`, as configured by every .clang-tidy above it: the checks, and
// every enabled check's options (`check.Option: value` lines from --dump-config, defaults included).
const evaluatedTidy = async (root, file) => {
  const ms = limit(TIMEOUTS.listChecks);
  const [listed, dumped] = await Promise.all([
    run("clang-tidy", ["--list-checks", "-p", buildDir("asan"), file], { cwd: root, timeoutMs: ms }),
    run("clang-tidy", ["--dump-config", "-p", buildDir("asan"), file], { cwd: root, timeoutMs: ms }),
  ]);
  const why = failure("clang-tidy --list-checks", listed, TIMEOUTS.listChecks, "TIMEOUTS.listChecks in stacks/cpp/run.mjs") || failure("clang-tidy --dump-config", dumped, TIMEOUTS.listChecks, "TIMEOUTS.listChecks in stacks/cpp/run.mjs");
  const checks = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[a-z][\w.-]+$/.test(line));
  const options = new Map(
    dumped.stdout
      .split("\n")
      .map((line) => /^\s+([\w.-]+)\.(\w+):\s*(.*)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [`${match[1]}.${match[2]}`, match[3].trim()]),
  );
  return { why, checks, options };
};

// Where only the root .clang-tidy applies: a file at the repo root (it need not exist).
const ROOT_TIDY_PROBE = "zz-tidy-root.cpp";

// The tidy floor, per directory holding C++ files, as clang-tidy evaluates every .clang-tidy above it:
// - each REQUIRED_TIDY_CHECKS check is on;
// - every check the root turns on is on, unless cpp-layers.json "tidyOff" lists it for that directory
//   (so a nested `InheritParentConfig: false` + `Checks: '-*,<the floor>'` drops nothing quietly);
// - each floor check's options are the root's, and so are those of every check the root turns on
//   that is still on there and not in "tidyOff" for it (so a nested CheckOptions can't neuter one,
//   or quietly retune a threshold).
export const tidyFloor = async (root) => {
  const problems = [];
  const dirs = [...new Map(cppFiles(root).map((file) => [dirname(file), file])).values()];
  const [base, ...results] = await pool([ROOT_TIDY_PROBE, ...dirs].map((file) => () => evaluatedTidy(root, file)), availableParallelism());
  if (base.why !== "") return [`the root .clang-tidy: ${base.why}`];
  const tidyOff = readLayerMap(root).map?.tidyOff ?? {};
  const allowedOff = (dir, check) => Object.entries(tidyOff).some(([prefix, checks]) => (dir === prefix || dir.startsWith(`${prefix}/`)) && Array.isArray(checks) && checks.includes(check));
  for (const [index, { why, checks, options }] of results.entries()) {
    const dir = dirname(dirs[index]);
    if (why !== "") {
      problems.push(`${dir}/: ${why}`);
      continue;
    }
    for (const check of REQUIRED_TIDY_CHECKS) if (!checks.includes(check)) problems.push(`${dir}/: clang-tidy has ${check} off there (a .clang-tidy dropped it); it is on the floor (stacks/cpp/sources.mjs REQUIRED_TIDY_CHECKS).`);
    for (const check of base.checks) {
      if (!REQUIRED_TIDY_CHECKS.includes(check) && !checks.includes(check) && !allowedOff(dir, check)) problems.push(`${dir}/: clang-tidy has ${check} off there, but the root .clang-tidy has it on; a nested .clang-tidy may turn off only what ${LAYER_MAP} "tidyOff" lists for its directory.`);
    }
    for (const key of new Set([...base.options.keys(), ...options.keys()])) {
      const check = key.slice(0, key.lastIndexOf("."));
      const floor = REQUIRED_TIDY_CHECKS.includes(check);
      // A check only this directory turns on, one "tidyOff" lets it drop, or one already reported off above: its options aren't the root's to judge.
      if (!floor && (!base.checks.includes(check) || !checks.includes(check) || allowedOff(dir, check))) continue;
      if (base.options.get(key) !== options.get(key)) problems.push(`${dir}/: clang-tidy sets ${key} to ${options.get(key) ?? "(unset)"} there, but the root has ${base.options.get(key) ?? "(unset)"}; a check's options are the root's (CheckOptions in a nested .clang-tidy), unless ${LAYER_MAP} "tidyOff" lists the check for that directory.`);
    }
  }
  return problems;
};

// A hash of everything a unit's tidy verdict depends on: tidy's version, the unit's command, its
// text, every first-party header it includes, each .clang-tidy above it, and this pack's scripts.
const tidyKey = (root, unit, headers, version) => {
  const hash = createHash("sha256");
  const add = (label, text) => hash.update(`${label}\0${text}\0`);
  add("version", version);
  add("command", unit.command);
  for (const path of [unit.file, ...headers, "stacks/cpp/run.mjs", "stacks/cpp/sources.mjs"]) add(path, existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "<missing>");
  for (let dir = dirname(unit.file); ; dir = dirname(dir)) {
    const config = join(dir, ".clang-tidy");
    add(config, existsSync(join(root, config)) ? readFileSync(join(root, config), "utf8") : "");
    if (dir === "." || dir === "") break;
  }
  return hash.digest("hex");
};

// Runs clang-tidy on `units` (warnings as errors forced here, header filter on first-party headers);
// resolves the failures. `cache` skips a unit whose key matches its last pass.
export const tidyFiles = async (root, units, { cache = false, timeoutMs = limit(TIMEOUTS.tidyUnit) } = {}) => {
  const version = toolInfo("clang-tidy").version;
  // First-party headers per object, from the asan tree's include record (absent before a build: no cache then).
  const deps = await run("ninja", ["-C", buildDir("asan"), "-t", "deps"], { cwd: root, timeoutMs: limit(60_000) });
  // The record is the last build's: a header edited or added since (lint before build) can change
  // what a unit includes, so then no unit is skipped or remembered (no key) until a build catches up.
  const record = join(root, buildDir("asan"), ".ninja_deps");
  const recorded = existsSync(record) ? statSync(record).mtimeMs : 0;
  const stale = cppFiles(root).some((file) => !/\.(cpp|cc|cxx)$/.test(file) && statSync(join(root, file)).mtimeMs > recorded);
  const included = deps.status === 0 && !stale ? parseDeps(deps.stdout) : new Map();
  const prefix = `${resolve(root)}/`;
  const headersOf = (file) => {
    const found = [...included.entries()].find(([object]) => object.endsWith(`/${file}.o`))?.[1];
    return found?.filter((path) => path.startsWith(`${prefix}${SOURCE_ROOT}/`)).map((path) => path.slice(prefix.length)).toSorted();
  };
  const jobs = units.map((unit) => async () => {
    const headers = headersOf(unit.file);
    const stamp = join(root, TIDY_CACHE, createHash("sha256").update(unit.file).digest("hex"));
    const key = headers === undefined ? undefined : tidyKey(root, unit, headers, version);
    if (cache && key !== undefined && existsSync(stamp) && readFileSync(stamp, "utf8") === key) return { unit, cached: true, problem: "" };
    const ms = timeoutMs;
    const result = await run("clang-tidy", ["-p", buildDir("asan"), "--quiet", "--warnings-as-errors=*", `--header-filter=^${prefix}${SOURCE_ROOT}/`, unit.file], { cwd: root, timeoutMs: ms });
    const why = failure(`clang-tidy ${unit.file}`, result, ms, "TIMEOUTS.tidyUnit in stacks/cpp/run.mjs");
    if (why === "" && key !== undefined) {
      mkdirSync(dirname(stamp), { recursive: true });
      writeFileSync(stamp, key);
    }
    const findings = result.output.split("\n").filter((line) => /(warning|error):/.test(line) && !/warnings? generated/.test(line));
    return { unit, cached: false, problem: why === "" ? "" : `${why}\n${findings.join("\n") || tail(result.output)}` };
  });
  return pool(jobs, availableParallelism());
};

// clang-format over `files` (.clang-format's style); resolves the problem text, or "" when every one is formatted.
export const formatFiles = async (root, files) => {
  const ms = limit(TIMEOUTS.format);
  const format = await run("clang-format", ["--dry-run", "--Werror", ...files], { cwd: root, timeoutMs: ms });
  const why = failure("clang-format --dry-run", format, ms, "TIMEOUTS.format in stacks/cpp/run.mjs");
  return why === "" ? "" : tail(format.output.split("\n").filter((line) => /error:/.test(line)).join("\n")) || why;
};

// `lint`: source rules, format, the tidy floor, then tidy; resolves the finding count.
const lintTask = async (root) => {
  let problems = report("cpp sources", checkSources(root));
  const formatProblem = await formatFiles(root, cppFiles(root));
  if (formatProblem !== "") problems += report("cpp format (fix with `clang-format -i <file>`)", [formatProblem]);
  const configured = await ensureConfigured(root, "asan");
  if (configured !== "") return problems + report("cpp asan configure (tidy reads its compile_commands.json)", [configured]);
  problems += report("cpp clang-tidy floor", await tidyFloor(root));
  const units = unitsOf(root, "asan");
  if (units.length === 0) return problems + report("cpp clang-tidy", ["compile_commands.json lists no first-party unit, so nothing was linted."]);
  const results = await tidyFiles(root, units, { cache: !inCI() });
  const cached = results.filter((result) => result.cached).length;
  problems += report("cpp clang-tidy (fix it, or `// NOLINT(<check>): <why>` on the line)", results.map((result) => result.problem).filter(Boolean));
  process.stdout.write(`cpp lint: clang-tidy ran on ${units.length - cached} of ${units.length} units (${cached} unchanged since they last passed; ${TIDY_CACHE}).\n`);
  return problems;
};

// XML text with the five predefined entities decoded.
const unescape = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Knob: what a sanitizer prints when it reports. A log holding one is a failure whatever the exit code said.
// Anchored to a line start, as the runtimes print them (`==PID==ERROR: …`, `WARNING: ThreadSanitizer: …`,
// `SUMMARY: …Sanitizer: …`, UBSan's `file:line:col: runtime error: …`), so a passing test that prints a
// sample report after other text (a log or diagnostics test) is not failed for it.
export const SANITIZER_REPORT =
  /^(?:==\d+==ERROR: (?:Address|Leak|Memory|Thread|UndefinedBehavior)Sanitizer\b|WARNING: ThreadSanitizer: |SUMMARY: (?:Address|Leak|Memory|Thread|UndefinedBehavior)Sanitizer: |(?:[^\s:][^:\n]*:\d+(?::\d+)?|<unknown>): runtime error: )/m;

// A CTest JUnit report: [{ name, status, ran, failedInLog }]. `ran` means GoogleTest's own log shows
// it finishing (OK or FAILED), not just a process that exited. `failedInLog` means the log shows
// GoogleTest failing it or a sanitizer report, which no exit code or CTest status can overrule.
export const parseJunit = (xml) =>
  [...xml.matchAll(/<testcase\s+name="([^"]*)"[^>]*?status="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g)].map((match) => {
    const name = unescape(match[1]);
    // The log's first line follows `<system-out>` on the same line; break it there (before decoding) so SANITIZER_REPORT's line anchor sees it.
    const body = unescape(match[3].replace(/<system-out>/g, "<system-out>\n"));
    const ran = body.includes(`[       OK ] ${name}`) || body.includes(`[  FAILED  ] ${name}`);
    const failedInLog = body.includes(`[  FAILED  ] ${name}`) || SANITIZER_REPORT.test(body);
    return { name, status: match[2], ran, failedInLog };
  });

// Knob: CTest test properties that change what counts as a pass, refused on every test.
const VERDICT_PROPERTIES = {
  WILL_FAIL: "turns a failing test into a pass",
  PASS_REGULAR_EXPRESSION: "judges the test by a pattern in its output, not by its exit code",
  FAIL_REGULAR_EXPRESSION: "judges the test by a pattern in its output, not by its exit code",
  SKIP_REGULAR_EXPRESSION: "turns a matching run into a skip",
  SKIP_RETURN_CODE: "turns an exit code into a skip",
  DISABLED: "never runs the test",
};

// gtest_discover_tests' own SKIP_REGULAR_EXPRESSION: it only marks a GTEST_SKIP (refused in the source) as skipped, and a skip fails the verdict.
const GTEST_DEFAULT_SKIP = "\\[  SKIPPED \\]";

// Knob: environment a test's own ENVIRONMENT / ENVIRONMENT_MODIFICATION may not set: it would beat SANITIZER_ENV, or pick what GoogleTest runs.
export const REFUSED_TEST_ENV = /^(ASAN|UBSAN|TSAN|LSAN|MSAN)_|^GTEST_/;

// A CMake false constant (a boolean property set to one of these is off).
const cmakeFalse = (value) => /^(0|OFF|NO|FALSE|N|IGNORE|NOTFOUND|)$|-NOTFOUND$/i.test(String(value));

// Findings in `ctest --show-only=json-v1`'s tests: each property that can switch the test or sanitizer gate off.
export const propertyProblems = (tests) => {
  const problems = [];
  for (const test of tests) {
    for (const { name, value } of test.properties ?? []) {
      const values = [value].flat().map(String);
      if (name in VERDICT_PROPERTIES) {
        const harmless = (name === "WILL_FAIL" || name === "DISABLED") && values.every(cmakeFalse);
        const gtestDefault = name === "SKIP_REGULAR_EXPRESSION" && values.length === 1 && values[0] === GTEST_DEFAULT_SKIP;
        if (!harmless && !gtestDefault) problems.push(`${test.name}: ${name} ${values.join(";")} ${VERDICT_PROPERTIES[name]}.`);
      }
      if (name === "ENVIRONMENT" || name === "ENVIRONMENT_MODIFICATION") {
        for (const entry of values) if (REFUSED_TEST_ENV.test(entry.split("=")[0] ?? "")) problems.push(`${test.name}: ${name} sets ${entry}, over the options stacks/cpp/run.mjs sets for every test (SANITIZER_ENV).`);
      }
    }
  }
  return problems;
};

// True when a run test name is this source test: Suite.Name, or a parameterized/typed instance of it.
const isInstanceOf = (runName, { suite, name }) => {
  const [runSuite = "", runTest = ""] = runName.split(".");
  return runSuite.split("/").includes(suite) && runTest.split("/")[0] === name;
};

// Why a tree's test run is not a pass, or "": failures, zero executed, or a source test that didn't run.
export const testVerdict = (cases, sourceTests, preset) => {
  const executed = cases.filter((test) => test.ran);
  const failed = cases
    .filter((test) => test.status !== "run" || !test.ran || test.failedInLog)
    .map((test) => `${test.name} (${test.status}${test.ran ? "" : ", no GoogleTest result"}${test.failedInLog && test.status === "run" ? ", but its log shows a failure or a sanitizer report" : ""})`);
  if (failed.length > 0) return `in the ${preset} tree, these did not pass:\n    ${failed.join("\n    ")}`;
  if (executed.length === 0) return `zero tests executed in the ${preset} tree: a run that tested nothing is not a pass.`;
  const missing = sourceTests.filter((test) => !executed.some((ran) => isInstanceOf(ran.name, test))).map((test) => `${test.suite}.${test.name} (${test.file}:${test.line})`);
  if (missing.length > 0) return `these tests are in the source but did not run in the ${preset} tree (#if'd out, or not built into a test executable):\n    ${missing.join("\n    ")}`;
  return "";
};

// Runs CTest in one configured, built tree and judges it; resolves the problem text, or "".
export const runTests = async (root, preset, { onOutput } = {}) => {
  const junit = resolve(root, buildDir(preset), "ctest-junit.xml");
  rmSync(junit, { force: true });
  const ms = limit(TIMEOUTS.ctest);
  const env = { ...process.env, ...SANITIZER_ENV };
  // The tests as CTest will run them, properties included (PRE_TEST discovery runs here too).
  const listed = await run("ctest", ["--test-dir", buildDir(preset), "--show-only=json-v1"], { cwd: root, timeoutMs: ms, env });
  const listWhy = failure(`ctest --show-only (${preset})`, listed, ms, "TIMEOUTS.ctest in stacks/cpp/run.mjs");
  if (listWhy !== "") return `${listWhy}\n${tail(listed.output)}`;
  let tests;
  try {
    tests = JSON.parse(listed.stdout).tests ?? [];
  } catch {
    return `ctest --show-only=json-v1 printed no JSON in the ${preset} tree, so the tests' properties were not checked:\n${tail(listed.output)}`;
  }
  const refused = propertyProblems(tests);
  if (refused.length > 0) return `in the ${preset} tree, these test properties can switch the test or sanitizer gate off (drop them from gtest_discover_tests / set_tests_properties):\n    ${refused.join("\n    ")}`;
  const outputBytes = String(CTEST_OUTPUT_BYTES);
  const result = await run("ctest", ["--test-dir", buildDir(preset), "--no-tests=error", "--output-on-failure", "--timeout", String(CTEST_TEST_TIMEOUT_S), "-j", String(availableParallelism()), "--test-output-size-passed", outputBytes, "--test-output-size-failed", outputBytes, "--output-junit", junit], { cwd: root, timeoutMs: ms, env, onOutput });
  const why = failure(`ctest (${preset})`, result, ms, "TIMEOUTS.ctest in stacks/cpp/run.mjs");
  if (result.timedOut || result.error !== undefined) return why;
  // --no-tests=error: CTest found nothing to run (it may then write no report at all).
  if (/No tests were found/.test(result.output)) return `zero tests executed in the ${preset} tree: CTest found no tests, and a run that tested nothing is not a pass.`;
  if (!existsSync(junit)) return `${why || "ctest"} wrote no JUnit report, so nothing shows a test ran:\n${tail(result.output)}`;
  const verdict = testVerdict(parseJunit(readFileSync(junit, "utf8")), testsInSource(root), preset);
  if (verdict !== "") return verdict;
  return why === "" ? "" : `${why}\n${tail(result.output)}`;
};

// `test`: every leg built (incrementally) and its tests judged; resolves the finding count.
const testTask = async (root, presets = legs()) => {
  let problems = 0;
  for (const preset of presets) {
    const configured = await ensureConfigured(root, preset);
    if (configured !== "") return problems + report(`cpp ${preset} configure`, [configured]);
    const built = await build(root, preset);
    const why = failure(`cmake --build ${buildDir(preset)}`, built, 0, "BUILD_TIMEOUT_MS in stacks/cpp/evaluated.mjs");
    if (why !== "") {
      problems += report(`cpp ${preset} build`, [`${why}\n${tail(built.output)}`]);
      continue;
    }
    const problem = await runTests(root, preset);
    if (problem !== "") problems += report(`cpp ${preset} tests`, [problem]);
    else process.stdout.write(`cpp test: ${preset} tree passed, every test in the source ran.\n`);
  }
  if (!presets.includes("gcc")) process.stdout.write("cpp test: the gcc tree runs under CI=true (or CPP_PACK_GCC=1).\n");
  return problems;
};

// `version`: each tool's version; missing or old fails here on purpose (this step proves CI has a toolchain).
const versionTask = (presets = legs()) => {
  let bad = 0;
  const names = [...new Set([...toolsFor("build", presets), ...toolsFor("lint", presets)])];
  for (const name of names) {
    const info = toolInfo(name);
    process.stdout.write(`cpp pack: ${name}: ${info.version || info.state} (needs ${TOOLS[name].floor.join(".")}+)\n`);
    if (info.state !== "ok") bad += 1;
  }
  if (bad > 0) process.stderr.write("cpp pack: a tool is missing or below its floor; the runner must provide it (ci.yml, [stack:cpp] fence).\n");
  return bad;
};

// CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = process.argv[2] ?? "";
  const root = process.cwd();
  const tasks = { build: buildTask, lint: lintTask, test: testTask };
  if (task === "version") process.exit(versionTask() > 0 ? 1 : 0);
  if (!(task in tasks)) {
    process.stderr.write(`cpp pack: unknown task '${task}'; one of build, lint, test, version\n`);
    process.exit(2);
  }
  // Skips loudly (exit 0) when a tool is missing locally; fails under CI. The source rules need no
  // tool, so a lint without a toolchain still runs them.
  if (!requireTools(`cpp:${task}`, toolsFor(task, legs()))) process.exit(task === "lint" && report("cpp sources", checkSources(root)) > 0 ? 1 : 0);
  // Told to stop (Ctrl-C, gates.mjs timing us out): take every tool's process group with us.
  killGroupsOnSignal();
  const problems = await tasks[task](root);
  process.exit(problems > 0 ? 1 : 0);
}
