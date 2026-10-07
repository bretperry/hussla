#!/usr/bin/env node
// Proves the C++ pack's gates still bite: plants a violation of each rule on a scratch copy and fails unless it is reported.
// In the app: nothing at runtime; `pnpm cpp:gates`, one of the C++ pack's checks (pnpm check, CI).
// Used by: stacks/cpp/pack.json `checks` (script `cpp:gates`).
// Uses: stacks/cpp/sources.mjs, stacks/cpp/evaluated.mjs, stacks/cpp/run.mjs, stacks/cpp/tool.mjs; CMakeLists.txt, CMakePresets.json, cpp-layers.json, .clang-tidy, .clang-format, cpp/.
//
// Why this exists: a layer map that names the wrong directory, a flag rule that stops matching, a
// sanitizer that prints and passes, or a test run that executes nothing all say "ok". So each gate
// is tested, not trusted. Every rule in sources.mjs and evaluated.mjs, the tidy floor and the
// forced warnings-as-errors, the format check, and the test verdict (zero tests, a test behind
// `#if 0`, an ASan, UBSan, LSan, and TSan report, each test property that turns a failure into a
// pass, a failure whose process exits 0, and a passing test that prints a sample report as data) has a probe here, each planted in its own scratch copy and each
// required to be reported by name. Nothing is written to the real tree but the stamp.
//
// Cost: the probes configure ~40 scratch trees and build a few small ones (~40 s cold on 4
// cores). Locally they skip when nothing they read changed since they last passed (STAMP_FILE);
// CI=true always runs them. Without the toolchain, only the source probes run (and it says so).

// Node builtins only, plus this pack's own scripts.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { build, buildDir, BUILD_ROOT, checkConfigured, checkIncludes, checkPresets, checkSymbols, configure, readModel, REQUIRED_WARNINGS } from "./evaluated.mjs";
import { buildTask, formatFiles, runTests, tidyFiles, tidyFloor, unitsOf } from "./run.mjs";
import { checkSources, cppFiles, faultKinds, LAYER_MAP, nestedTidyConfigs, REQUIRED_TIDY_CHECKS } from "./sources.mjs";
import { failure, inCI, killGroupsOnSignal, pool, requireTools, toolInfo } from "./tool.mjs";

// Knob: where the stamp of the last passing run lives (inside the ignored build root).
export const STAMP_FILE = `${BUILD_ROOT}/gates.stamp`;

// Knob: the files the probes read, besides every C++ file's path (its content is not hashed: a
// probe plants into the seed's shape, not its code) and every CMake input (cmakeInputs).
const STAMP_INPUTS = [LAYER_MAP, ".clang-format", ".clang-tidy", "stacks/cpp/gates.mjs", "stacks/cpp/run.mjs", "stacks/cpp/sources.mjs", "stacks/cpp/evaluated.mjs", "stacks/cpp/tool.mjs"];

// Knob: the tools whose versions the stamp holds (a new compiler, ninja, or nm reruns the probes).
const STAMP_TOOLS = ["cmake", "ninja", "clang++", "g++", "clang-tidy", "clang-format", "nm"];

// Knob: directories never searched for CMake inputs (dependencies, build output; dot-directories are skipped too).
const NOT_SEARCHED = new Set(["node_modules", BUILD_ROOT, "build", "target", "dist"]);

// Every CMake input in the project: any CMakeLists.txt, *.cmake, or CMake*Presets.json (CMakeUserPresets.json included).
const cmakeInputs = (dir) => {
  const found = [];
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(dir, relativeDir), { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name))) {
      const path = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !NOT_SEARCHED.has(entry.name)) walk(path);
      } else if (entry.name === "CMakeLists.txt" || entry.name.endsWith(".cmake") || /^CMake\w*Presets\.json$/.test(entry.name)) found.push(path);
    }
  };
  walk("");
  return found;
};

// The project root is the working directory the core (or you) runs this in.
const root = process.cwd();

// Told to stop: take every tool we started with us.
killGroupsOnSignal();

// Stops with a message; a failed gate is never a quiet exit.
const fail = (message) => {
  process.stderr.write(`cpp gates: ${message}\n`);
  process.exit(1);
};

// The gate stamp: every STAMP_INPUTS file, every CMake input, every nested .clang-tidy, the fault catalogue, the sorted C++ file list, and the tool versions.
export const gateStamp = (dir) => {
  const hash = createHash("sha256");
  const files = cppFiles(dir);
  const catalogue = faultKinds(dir)?.file;
  for (const path of [...STAMP_INPUTS, ...cmakeInputs(dir), ...nestedTidyConfigs(dir), ...(catalogue === undefined ? [] : [catalogue])]) hash.update(`${path}\0${existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : "<missing>"}\0`);
  hash.update(files.join("\n"));
  for (const tool of STAMP_TOOLS) hash.update(`${tool}\0${toolInfo(tool).version}\0`);
  return hash.digest("hex");
};

// What a scratch copy holds: the build's inputs (CMake modules and a user's presets too, when present), never the build trees.
const COPIED = ["CMakeLists.txt", "CMakePresets.json", "CMakeUserPresets.json", "cmake", LAYER_MAP, ".clang-tidy", ".clang-format", "cpp"];

// A scratch copy: `remove` drops copied files, `edit` ({ path: (text) => text }) rewrites one, then `plant` ({ path: content }) writes files.
const scratchCopy = ({ plant = {}, edit = {}, remove = [] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "cpp-gates-"));
  for (const name of COPIED) if (existsSync(join(root, name))) cpSync(join(root, name), join(dir, name), { recursive: true });
  for (const path of remove) rmSync(join(dir, path), { force: true });
  for (const [path, change] of Object.entries(edit)) {
    const before = readFileSync(join(dir, path), "utf8");
    const after = change(before);
    // A probe whose edit found nothing to change proves nothing: say so instead of passing.
    if (after === before) {
      rmSync(dir, { recursive: true, force: true });
      fail(`a probe could not be planted in ${path} (the text it edits is not there); update stacks/cpp/gates.mjs with the file.`);
    }
    writeFileSync(join(dir, path), after);
  }
  for (const [path, content] of Object.entries(plant)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

// Edits: a JSON file through a mutation, a CMakeLists append, a preset's cache variable.
const json = (change) => (text) => {
  const value = JSON.parse(text);
  change(value);
  return `${JSON.stringify(value, null, 2)}\n`;
};
const append = (cmake) => (text) => `${text}\n${cmake}\n`;
const presetVariable = (preset, variable, change) =>
  json((presets) => {
    const found = presets.configurePresets.find((candidate) => candidate.name === preset);
    found.cacheVariables = { ...found.cacheVariables, [variable]: change(found.cacheVariables?.[variable] ?? "") };
  });

const map = JSON.parse(readFileSync(join(root, LAYER_MAP), "utf8"));
const layers = Object.keys(map.layers);
// The innermost layer (allows no other) and one layer that others depend on but that isn't innermost.
const innermost = layers.find((name) => map.layers[name].may.length === 0) ?? layers[0];
const middle = layers.find((name) => name !== innermost && layers.some((other) => map.layers[other].may.includes(name))) ?? innermost;
const outermost = layers.find((name) => !layers.some((other) => map.layers[other].may.includes(name))) ?? layers.at(-1);
const testsDir = map.tests;
// A real source file in a layer, for probes that append code to one.
const sourceIn = (layer) => cppFiles(root, `cpp/${layer}`).find((file) => file.endsWith(".cpp")) ?? fail(`layer '${layer}' has no .cpp file to plant into`);
const innerSource = sourceIn(innermost);

// ── Source probes: no toolchain needed. Each { proves, setup, expect(line) }.
const sourceProbes = [];
const sourceProbe = (proves, setup, expect) => sourceProbes.push({ proves, setup, expect });
const planted = (name, content) => ({ plant: { [`cpp/${innermost}/src/${name}`]: content } });
const plantedTest = (name, content) => ({ plant: { [`${testsDir}/${name}`]: content } });

sourceProbe("no layer map", { remove: [LAYER_MAP] }, (line) => line.includes(`${LAYER_MAP} is missing`));
sourceProbe("a layer map that is not JSON", { edit: { [LAYER_MAP]: (text) => `${text}}` } }, (line) => line.includes("is not valid JSON"));
sourceProbe("a layer map with no layers", { edit: { [LAYER_MAP]: json((value) => (value.layers = {})) } }, (line) => line.includes("has no layers"));
sourceProbe("a directory with no row", { plant: { "cpp/zzunlisted/zz.cpp": "int zz_gate();\n" } }, (line) => line.includes("cpp/zzunlisted/ has no row"));
sourceProbe("a row with no directory", { edit: { [LAYER_MAP]: json((value) => (value.layers.zzgate = { may: [], deny: [...map.layers[innermost].deny] })) } }, (line) => line.includes("row 'zzgate' matches no C++ files"));
sourceProbe("a row that may use no layer", { edit: { [LAYER_MAP]: json((value) => value.layers[outermost].may.push("zztypo")) } }, (line) => line.includes("may use 'zztypo'"));
sourceProbe("a row that lists itself", { edit: { [LAYER_MAP]: json((value) => value.layers[outermost].may.push(outermost)) } }, (line) => line.includes(`row '${outermost}' lists itself`));
sourceProbe("a deny family that is a typo", { edit: { [LAYER_MAP]: json((value) => value.layers[outermost].deny.push("zztypo")) } }, (line) => line.includes("denies 'zztypo'"));
sourceProbe("the innermost row loosened below the floor", { edit: { [LAYER_MAP]: json((value) => (value.layers[innermost].deny = [])) } }, (line) => line.includes(`row '${innermost}' must deny`));
sourceProbe("an inner row loosened below the floor", { edit: { [LAYER_MAP]: json((value) => (value.layers[middle].deny = value.layers[middle].deny.filter((family) => family !== "io"))) } }, (line) => line.includes(`row '${middle}' must deny io`));
sourceProbe("anyLibrary on a layer others depend on", { edit: { [LAYER_MAP]: json((value) => (value.layers[middle].anyLibrary = true)) } }, (line) => line.includes(`row '${middle}' sets anyLibrary`));
sourceProbe("a tests entry that names no directory", { edit: { [LAYER_MAP]: json((value) => (value.tests = "cpp/zznotests")) } }, (line) => line.includes('"tests" must name the tests directory'));
sourceProbe("a bare NOLINT", planted("zz_nolint.cpp", "int zz_gate();  // NOLINT\n"), (line) => line.includes("zz_nolint.cpp:1:") && line.includes("must name its checks"));
sourceProbe("a NOLINT with no reason", planted("zz_nolint_reason.cpp", "int zz_gate();  // NOLINT(modernize-use-nullptr)\n"), (line) => line.includes("zz_nolint_reason.cpp:1:") && line.includes("needs a reason"));
sourceProbe("a NOLINT over a whole group", planted("zz_nolint_glob.cpp", "int zz_gate();  // NOLINT(bugprone-*): all of them\n"), (line) => line.includes("zz_nolint_glob.cpp:1:") && line.includes("silences a whole group"));
sourceProbe("a bare NOLINTNEXTLINE", planted("zz_nolint_next.cpp", "// NOLINTNEXTLINE\nint zz_gate();\n"), (line) => line.includes("zz_nolint_next.cpp:1:") && line.includes("NOLINTNEXTLINE must name"));
sourceProbe("a bare NOLINTBEGIN", planted("zz_nolint_begin.cpp", "// NOLINTBEGIN\nint zz_gate();\n// NOLINTEND\n"), (line) => line.includes("zz_nolint_begin.cpp:1:") && line.includes("NOLINTBEGIN must name"));
sourceProbe("#pragma clang diagnostic ignored", planted("zz_pragma_clang.cpp", '#pragma clang diagnostic ignored "-Wshadow"\n'), (line) => line.includes("zz_pragma_clang.cpp:1:"));
sourceProbe("#pragma GCC diagnostic ignored", planted("zz_pragma_gcc.cpp", '#pragma GCC diagnostic ignored "-Wconversion"\n'), (line) => line.includes("zz_pragma_gcc.cpp:1:"));
sourceProbe("#pragma warning", planted("zz_pragma_warning.cpp", "#pragma warning(disable : 4996)\n"), (line) => line.includes("zz_pragma_warning.cpp:1:"));
sourceProbe("_Pragma", planted("zz_pragma_operator.cpp", '_Pragma("clang diagnostic ignored \\"-Wshadow\\"")\n'), (line) => line.includes("zz_pragma_operator.cpp:1:"));
sourceProbe("#pragma GCC system_header", planted("zz_system_header.hpp", "#pragma once\n#pragma GCC system_header\n"), (line) => line.includes("zz_system_header.hpp:2:") && line.includes("system_header"));
sourceProbe("#pragma clang system_header", planted("zz_system_header_clang.hpp", "#pragma once\n#pragma clang system_header\n"), (line) => line.includes("zz_system_header_clang.hpp:2:") && line.includes("system_header"));
sourceProbe("a no_sanitize attribute", planted("zz_no_sanitize.cpp", '[[clang::no_sanitize("address")]] int zz_gate();\n'), (line) => line.includes("zz_no_sanitize.cpp:1:"));
sourceProbe("a __no_sanitize__ attribute", planted("zz_no_sanitize_reserved.cpp", '__attribute__((__no_sanitize__("address"))) int zz_gate();\n'), (line) => line.includes("zz_no_sanitize_reserved.cpp:1:"));
sourceProbe("disable_sanitizer_instrumentation", planted("zz_no_instrument.cpp", "__attribute__((disable_sanitizer_instrumentation)) int zz_gate();\n"), (line) => line.includes("zz_no_instrument.cpp:1:"));
sourceProbe("a nested .clang-tidy that doesn't inherit the root's", { plant: { [`cpp/${innermost}/.clang-tidy`]: `Checks: "-*,${REQUIRED_TIDY_CHECKS.join(",")}"\n` } }, (line) => line.startsWith(`cpp/${innermost}/.clang-tidy:`) && line.includes("InheritParentConfig: true"));
sourceProbe('a floor check in "tidyOff"', { edit: { [LAYER_MAP]: json((value) => (value.tidyOff = { [testsDir]: [REQUIRED_TIDY_CHECKS[0]] })) } }, (line) => line.includes(`lists ${REQUIRED_TIDY_CHECKS[0]}, which is on the floor`));
// A header judged by its own layer: only the outermost layer's source would include it, and that build is fine.
const outerHeader = cppFiles(root, `cpp/${outermost}/include`)[0] ?? fail(`layer '${outermost}' has no header under cpp/${outermost}/include to include`);
sourceProbe(
  "an inner header including an outer layer's header",
  { plant: { [`cpp/${innermost}/include/${innermost}/zz_edge.hpp`]: `#pragma once\n\n#include "${outerHeader.slice(`cpp/${outermost}/include/`.length)}"\n` } },
  (line) => line.includes(`zz_edge.hpp:3: includes`) && line.includes(`which layer '${innermost}' may not reach`),
);
sourceProbe("sanitizer default options in the source", planted("zz_asan_options.cpp", 'extern "C" const char* __asan_default_options() { return "halt_on_error=0"; }\n'), (line) => line.includes("zz_asan_options.cpp:1:"));
sourceProbe("LeakSanitizer switched off in the source", planted("zz_lsan.cpp", "void zz_gate() { __lsan_disable(); }\n"), (line) => line.includes("zz_lsan.cpp:1:"));
sourceProbe("clang-format off with no reason", planted("zz_format_off.cpp", "// clang-format off\nint zz_gate();\n// clang-format on\n"), (line) => line.includes("zz_format_off.cpp:1:"));
sourceProbe("a DISABLED_ test", plantedTest("zz_disabled_test.cpp", "TEST(ZzGate, DISABLED_Never) {}\n"), (line) => line.includes("zz_disabled_test.cpp:1:") && line.includes("DISABLED_"));
sourceProbe("GTEST_SKIP", plantedTest("zz_skip_test.cpp", "TEST(ZzGate, Skips) { GTEST_SKIP(); }\n"), (line) => line.includes("zz_skip_test.cpp:1:") && line.includes("GTEST_SKIP"));
const faults = faultKinds(root);
if (faults !== undefined) {
  sourceProbe("a FaultKind no test plays", { edit: { [faults.file]: (text) => text.replace(/(enum\s+class\s+FaultKind\b[^{]*\{)/, "$1\n  zz_gate_kind,") } }, (line) => line.includes("FaultKind::zz_gate_kind has no test"));
}

// The real tree must pass first, or "reported" below means nothing.
const clean = checkSources(root);
if (clean.length > 0) fail(`the real tree is not clean, so the probes can't be judged:\n${clean.map((line) => `  ${line}`).join("\n")}`);

const missed = [];
for (const { proves, setup, expect } of sourceProbes) {
  const scratch = scratchCopy(setup);
  try {
    const reported = checkSources(scratch);
    if (!reported.some(expect)) missed.push(`${proves}:\n      ${reported.join("\n      ") || "(nothing reported)"}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (missed.length > 0) fail(`${missed.length} of ${sourceProbes.length} source probes were not reported. A rule that says nothing here would say nothing about real code.\n${missed.map((line) => `  ✗ ${line}`).join("\n")}`);
process.stdout.write(`cpp gates: all ${sourceProbes.length} planted source violations were reported.\n`);

// ── The probes that need the toolchain.
if (!requireTools("the C++ build, tidy, format, and test gates", ["cmake", "ninja", "clang++", "g++", "clang-tidy", "clang-format", "nm"])) process.exit(0);

const stampAtStart = gateStamp(root);
const stampPath = join(root, STAMP_FILE);
if (!inCI() && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === stampAtStart) {
  process.stdout.write(`cpp gates: toolchain probes skipped, nothing they read changed since they last passed (${STAMP_FILE}; CI=true or deleting it forces a run).\n`);
  process.exit(0);
}

// The real asan and tsan trees, clean and built: the baseline, and the GoogleTest source every scratch configure reuses.
if ((await buildTask(root, ["asan", "tsan"])) > 0) fail("the real build is not clean (above), so the toolchain probes can't be judged.");
const googletest = resolve(root, buildDir("asan"), "_deps/googletest-src");
if (!existsSync(googletest)) fail(`${googletest} is missing after the build; the probes reuse it instead of downloading GoogleTest per copy.`);
const reuse = [`-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=${googletest}`];

// Configures `preset` in a scratch copy; resolves the problem text, or "" (the model is read by the caller).
const configureScratch = async (dir, preset) => {
  const result = await configure(dir, preset, { extraArgs: reuse });
  const why = failure(`cmake --preset ${preset} (scratch)`, result, 0, "CONFIGURE_TIMEOUT_MS");
  return why === "" ? "" : `${why}\n${result.output.split("\n").slice(-15).join("\n")}`;
};

// Each heavy probe: { proves, setup, check(dir) → reported lines, expect(line) }.
const heavy = [];
const heavyProbe = (proves, setup, check, expect) => heavy.push({ proves, setup, check, expect: (lines) => lines.some(expect) });
// The same, judged on every line at once: for a probe that must come back with several findings.
const heavyProbeAll = (proves, setup, check, expect) => heavy.push({ proves, setup, check, expect });

// A configured probe: configure `preset`, read the File API, run the configured checks.
const configured = (preset) => async (dir) => {
  const problem = await configureScratch(dir, preset);
  if (problem !== "") return [`(configure failed) ${problem}`];
  const model = readModel(dir, preset);
  return model === undefined ? ["(no File API reply)"] : checkConfigured(dir, preset, model);
};
const domainTarget = `target '${innermost}' (asan)`;

heavyProbeAll("the warning set emptied", { edit: { "CMakeLists.txt": (text) => text.replace(/set\(CPP_WARNINGS[^)]*\)/, "set(CPP_WARNINGS)") } }, configured("asan"), (lines) => REQUIRED_WARNINGS.every((flag) => lines.some((line) => line.includes(`${domainTarget} compiles without ${flag} `))));
heavyProbe("-Wno-error on a layer", { edit: { "CMakeLists.txt": append(`target_compile_options(${innermost} PRIVATE -Wno-error)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles with -Wno-error`));
heavyProbe("-w on a layer", { edit: { "CMakeLists.txt": append(`target_compile_options(${middle} PRIVATE -w)`) } }, configured("asan"), (line) => line.includes(`target '${middle}' (asan) compiles with -w,`));
const systemFlags = ["--no-warnings", `-isystem\${CMAKE_CURRENT_SOURCE_DIR}/cpp/${innermost}/include`, `--system-header-prefix=${innermost}/`, "-iwithprefixbefore${CMAKE_CURRENT_SOURCE_DIR}", "-isystem-after${CMAKE_CURRENT_SOURCE_DIR}"];
heavyProbeAll(
  "--no-warnings, and each flag that marks first-party headers as system ones",
  { edit: { "CMakeLists.txt": append(`target_compile_options(${innermost} PRIVATE ${systemFlags.join(" ")})`) } },
  configured("asan"),
  (lines) => ["--no-warnings", "-isystem/", "--system-header-prefix=", "-iwithprefixbefore", "-isystem-after"].every((flag) => lines.some((line) => line.includes(`${domainTarget} compiles with ${flag}`))),
);
heavyProbe("a layer's own headers marked SYSTEM", { edit: { "CMakeLists.txt": append(`target_include_directories(${innermost} SYSTEM PUBLIC \${CMAKE_CURRENT_SOURCE_DIR}/cpp/${innermost}/include)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} has`) && line.includes(`cpp/${innermost}/include as a SYSTEM include directory`));
heavyProbe("a C source in a layer", { plant: { [`cpp/${innermost}/src/zz_gate.c`]: "int zz_gate_c(void) { return 1; }\n" }, edit: { "CMakeLists.txt": append(`enable_language(C)\ntarget_sources(${innermost} PRIVATE cpp/${innermost}/src/zz_gate.c)\nset_source_files_properties(cpp/${innermost}/src/zz_gate.c PROPERTIES COMPILE_OPTIONS -w)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles C (cpp/${innermost}/src/zz_gate.c)`));
heavyProbe("a layer linking an outer one through $<LINK_ONLY:…>", { edit: { "CMakeLists.txt": append(`target_link_libraries(${innermost} PRIVATE $<LINK_ONLY:${outermost}>)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} links '${outermost}'`) && line.includes("which its row doesn't allow"));
heavyProbe("a -Wno-* through the preset's CMAKE_CXX_FLAGS", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => `${flags} -Wno-conversion`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles with -Wno-conversion`));
heavyProbe("a -Wno-* as one source's COMPILE_OPTIONS", { edit: { "CMakeLists.txt": append(`set_source_files_properties(${innerSource} PROPERTIES COMPILE_OPTIONS -Wno-shadow)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles with -Wno-shadow`));
heavyProbe("the standard below C++20", { edit: { "CMakeLists.txt": (text) => text.replace(/set\(CMAKE_CXX_STANDARD \d+\)/, "set(CMAKE_CXX_STANDARD 17)") } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles as C++17`));
heavyProbe("GNU extensions on", { edit: { "CMakeLists.txt": (text) => text.replace("set(CMAKE_CXX_EXTENSIONS OFF)", "set(CMAKE_CXX_EXTENSIONS ON)") } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles as gnu++`));
heavyProbe("AddressSanitizer dropped from the asan preset", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => flags.replace("address,", "")) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles without -fsanitize=address`));
heavyProbe("-fno-sanitize=undefined after the sanitizers", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => `${flags} -fno-sanitize=undefined`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles without -fsanitize=undefined`));
heavyProbe("-fsanitize-recover", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => `${flags} -fsanitize-recover=all`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles with -fsanitize-recover=all`));
heavyProbe("-fno-sanitize-recover=all dropped", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => flags.replace("-fno-sanitize-recover=all", "")) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles without -fno-sanitize-recover=all`));
heavyProbe("a sanitizer ignore list", { plant: { "zz-gate-ignorelist.txt": "fun:zz_gate\n" }, edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_FLAGS", (flags) => `${flags} -fsanitize-ignorelist=\${sourceDir}/zz-gate-ignorelist.txt`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles with -fsanitize-ignorelist=`));
heavyProbe("a sanitizer taken off the link", { edit: { "CMakeLists.txt": (text) => text.replace(/(project\([^)]*\))/, "$1\nadd_link_options(-fno-sanitize=address)") } }, configured("asan"), (line) => /links without -fsanitize=address/.test(line));
heavyProbe("ThreadSanitizer dropped from the tsan preset", { edit: { "CMakePresets.json": presetVariable("tsan", "CMAKE_CXX_FLAGS", (flags) => flags.replace("-fsanitize=thread", "")) } }, configured("tsan"), (line) => line.includes(`target '${innermost}' (tsan) compiles without -fsanitize=thread`));
heavyProbe("the sanitizer tree on another compiler", { edit: { "CMakePresets.json": presetVariable("asan", "CMAKE_CXX_COMPILER", () => "g++") } }, configured("asan"), (line) => line.includes("the asan tree compiles with GNU, not Clang"));
heavyProbe("a layer linking a layer its row doesn't allow", { edit: { "CMakeLists.txt": append(`target_link_libraries(${innermost} PRIVATE ${outermost})`) } }, configured("asan"), (line) => line.includes(`${domainTarget} links '`) && line.includes("which its row doesn't allow"));
heavyProbe("an inner layer linking third-party code", { edit: { "CMakeLists.txt": append(`target_link_libraries(${middle} PRIVATE GTest::gtest)`) } }, configured("asan"), (line) => line.includes(`target '${middle}' (asan) links 'gtest', which is no layer`));
heavyProbe("a first-party target with no row", { edit: { "CMakeLists.txt": append(`add_library(zz_gate STATIC ${innerSource})`) } }, configured("asan"), (line) => line.includes("target 'zz_gate' (asan) has no row"));
heavyProbe("a layer compiling a file outside its directory", { edit: { "CMakeLists.txt": append(`target_sources(${innermost} PRIVATE ${sourceIn(outermost)})`) } }, configured("asan"), (line) => line.includes(`${domainTarget} compiles ${sourceIn(outermost)}, outside`));
heavyProbe("a layer with another layer's headers on its include path", { edit: { "CMakeLists.txt": append(`target_include_directories(${innermost} PRIVATE cpp/${outermost}/include)`) } }, configured("asan"), (line) => line.includes(`${domainTarget} has`) && line.includes(`cpp/${outermost}/include on its include path`));
heavyProbe("a stray include_directories over every target", { edit: { "CMakeLists.txt": (text) => text.replace(/(project\([^)]*\))/, "$1\ninclude_directories(cpp)") } }, configured("asan"), (line) => line.includes(`${domainTarget} has`) && line.endsWith("/cpp on its include path, which its row doesn't reach."));
heavyProbe("a row with no CMake target", { edit: { [LAYER_MAP]: json((value) => (value.layers.zzgate = { may: [], deny: [...map.layers[innermost].deny] })) }, plant: { "cpp/zzgate/src/zz.cpp": "int zz_gate();\n" } }, configured("asan"), (line) => line.includes("row 'zzgate' is not a CMake target"));
heavyProbe("a preset building outside the build root", { edit: { "CMakePresets.json": json((value) => (value.configurePresets.find((preset) => preset.name === "asan").binaryDir = "${sourceDir}/zz-out")) } }, async (dir) => checkPresets(dir), (line) => line.includes("preset 'asan' must build in"));
heavyProbe("a pack preset deleted", { edit: { "CMakePresets.json": json((value) => (value.configurePresets = value.configurePresets.filter((preset) => preset.name !== "tsan"))) } }, async (dir) => checkPresets(dir), (line) => line.includes("no configure preset 'tsan'"));

// Built probes: configure, build only what the probe needs, then read what was included or called.
const built = (layer, check) => async (dir) => {
  const problem = await configureScratch(dir, "asan");
  if (problem !== "") return [`(configure failed) ${problem}`];
  const result = await build(dir, "asan", { targets: [layer] });
  const why = failure("cmake --build (scratch)", result, 0, "BUILD_TIMEOUT_MS");
  if (why !== "") return [`(build failed) ${why}\n${result.output.split("\n").filter((line) => /error/.test(line)).join("\n")}`];
  const model = readModel(dir, "asan");
  return model === undefined ? ["(no File API reply)"] : check(dir, "asan", model);
};
heavyProbe(
  "a layer reaching another's header by a relative path",
  {
    plant: { [`cpp/${outermost}/include/${outermost}/zz_gate.hpp`]: "#pragma once\n\ninline int zz_gate_value() { return 1; }\n" },
    edit: { [innerSource]: (text) => `${text}\n#include "../../${outermost}/include/${outermost}/zz_gate.hpp"\nint zz_gate_use();\nint zz_gate_use() { return zz_gate_value(); }\n` },
  },
  built(innermost, checkIncludes),
  (line) => line.includes(`${innerSource} includes cpp/${outermost}/include/${outermost}/zz_gate.hpp`),
);
// One function per symbol family; each must come back as a call the innermost row denies.
const familyCalls = [
  "#include <dlfcn.h>",
  "#include <sys/socket.h>",
  "",
  "#include <chrono>",
  "#include <cstdlib>",
  "#include <fstream>",
  "#include <random>",
  "#include <thread>",
  "",
  "namespace zz_gate {",
  'const char* zz_env() { return std::getenv("ZZ_GATE"); }',
  "long long zz_clock() { return static_cast<long long>(std::chrono::system_clock::now().time_since_epoch().count()); }",
  'void zz_io() { std::ofstream out("zz-gate.txt"); out << 1; }',
  "unsigned zz_random() { std::random_device device; return device(); }",
  "void zz_thread() { std::thread worker([] {}); worker.join(); }",
  'int zz_process() { return std::system("true"); }',
  "int zz_net() { return socket(AF_INET, SOCK_STREAM, 0); }",
  'void* zz_dynamic() { return dlopen("zz-gate.so", RTLD_LAZY); }',
  "}  // namespace zz_gate",
  "",
].join("\n");
const families = map.layers[innermost].deny;
heavyProbeAll(`the innermost layer calling every denied family (${families.join(", ")})`, { plant: { [`cpp/${innermost}/src/zz_gate_calls.cpp`]: familyCalls }, edit: { "CMakeLists.txt": append(`target_sources(${innermost} PRIVATE cpp/${innermost}/src/zz_gate_calls.cpp)`) } }, built(innermost, checkSymbols), (lines) => families.every((family) => lines.some((line) => line.includes(`layer '${innermost}' calls`) && line.includes(`(${family})`))));
heavyProbe(`an inner layer ('${middle}') calling getenv`, { plant: { [`cpp/${middle}/src/zz_gate_env.cpp`]: '#include <cstdlib>\n\nnamespace zz_gate {\nconst char* zz_env() { return std::getenv("ZZ_GATE"); }\n}  // namespace zz_gate\n' }, edit: { "CMakeLists.txt": append(`target_sources(${middle} PRIVATE cpp/${middle}/src/zz_gate_env.cpp)`) } }, built(middle, checkSymbols), (line) => line.includes(`layer '${middle}' calls getenv (env)`));

// Tidy: one violation of every floor check, with WarningsAsErrors emptied in the config (run.mjs forces it on the command line).
const tidyPlant = [
  "",
  "#include <cstdint>",
  "#include <cstdlib>",
  "#include <ctime>",
  "#include <optional>",
  "#include <string>",
  "#include <utility>",
  "",
  "namespace zz_gate {",
  "std::string zz_moved(std::string text) { std::string other = std::move(text); return text + other; }",
  "int zz_unchecked(const std::optional<int>& value) { return *value; }",
  "std::tm* zz_mt(const std::time_t* when) { return std::localtime(when); }",
  "void* zz_malloc() { return std::malloc(4); }",
  "std::uintptr_t zz_cast(const int* value) { return reinterpret_cast<std::uintptr_t>(value); }",
  "struct ZzImplicit { ZzImplicit(int value) : held(value) {} int held; };",
  "const int* zz_null() { return 0; }",
  "std::size_t zz_by_value(std::string text) { return text.size(); }",
  "}  // namespace zz_gate",
  "",
].join("\n");
heavyProbe(
  `every floor tidy check (${REQUIRED_TIDY_CHECKS.length}), with WarningsAsErrors emptied in .clang-tidy`,
  { edit: { [innerSource]: (text) => `${text}${tidyPlant}`, ".clang-tidy": (text) => text.replace(/WarningsAsErrors:.*/, 'WarningsAsErrors: ""') } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    if (problem !== "") return [`(configure failed) ${problem}`];
    const units = unitsOf(dir, "asan").filter((unit) => unit.file === innerSource);
    const [result] = await tidyFiles(dir, units);
    return result === undefined ? ["(no unit)"] : [result.problem];
  },
  // A compile error (a .modmap only a build writes, say) is a miss: the unit must lint on an unbuilt tree, as `pnpm cpp:lint` first does.
  (line) => line.startsWith("clang-tidy ") && REQUIRED_TIDY_CHECKS.every((check) => line.includes(`[${check}`)) && !line.includes("clang-diagnostic-error"),
);
// A nested config that replaces the root's: everything but the floor goes off, and tidyFloor names what it lost.
heavyProbe(
  "a nested .clang-tidy keeping only the floor (InheritParentConfig: false)",
  { plant: { [`cpp/${innermost}/.clang-tidy`]: `InheritParentConfig: false\nChecks: "-*,${REQUIRED_TIDY_CHECKS.join(",")}"\n` } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    return problem === "" ? tidyFloor(dir) : [`(configure failed) ${problem}`];
  },
  (line) => line.startsWith(`cpp/${innermost}/`) && line.includes("but the root .clang-tidy has it on"),
);
heavyProbe(
  "a nested .clang-tidy retuning a floor check (CheckOptions)",
  { plant: { [`cpp/${innermost}/.clang-tidy`]: "InheritParentConfig: true\nCheckOptions:\n  performance-unnecessary-value-param.AllowedTypes: '.*'\n" } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    return problem === "" ? tidyFloor(dir) : [`(configure failed) ${problem}`];
  },
  (line) => line.startsWith(`cpp/${innermost}/`) && line.includes("sets performance-unnecessary-value-param.AllowedTypes to"),
);
heavyProbe(
  "a nested .clang-tidy retuning a non-floor check the root turns on (CheckOptions)",
  { plant: { [`cpp/${innermost}/.clang-tidy`]: "InheritParentConfig: true\nCheckOptions:\n  readability-function-cognitive-complexity.Threshold: 100000\n" } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    return problem === "" ? tidyFloor(dir) : [`(configure failed) ${problem}`];
  },
  (line) => line.startsWith(`cpp/${innermost}/`) && line.includes("sets readability-function-cognitive-complexity.Threshold to"),
);
heavyProbe(
  "a nested .clang-tidy dropping a floor check",
  { plant: { [`cpp/${innermost}/.clang-tidy`]: `InheritParentConfig: true\nChecks: "-${REQUIRED_TIDY_CHECKS[0]}"\n` } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    return problem === "" ? tidyFloor(dir) : [`(configure failed) ${problem}`];
  },
  (line) => line.startsWith(`cpp/${innermost}/`) && line.includes(`has ${REQUIRED_TIDY_CHECKS[0]} off`),
);
heavyProbe(
  "the root .clang-tidy dropping a floor check",
  // Last in the list, since a later glob (performance-*) would turn an earlier removal back on.
  { edit: { ".clang-tidy": (text) => text.replace(/\n(WarningsAsErrors:)/, `,\n  -${REQUIRED_TIDY_CHECKS.at(-1)}\n$1`) } },
  async (dir) => {
    const problem = await configureScratch(dir, "asan");
    return problem === "" ? tidyFloor(dir) : [`(configure failed) ${problem}`];
  },
  (line) => line.includes(`has ${REQUIRED_TIDY_CHECKS.at(-1)} off`),
);
heavyProbe("a badly formatted file", { plant: { [`cpp/${innermost}/src/zz_gate_format.cpp`]: "int   zz_gate( ){return 1;}\n" } }, async (dir) => [await formatFiles(dir, [`cpp/${innermost}/src/zz_gate_format.cpp`])], (line) => line.includes("zz_gate_format.cpp"));

// The test verdict, on a tiny project of its own: no tests, a test behind #if 0, sanitizer reports,
// each test property that can turn a failure into a pass, and a log that fails whatever the exit code.
// `properties` goes into gtest_discover_tests(... PROPERTIES …), as a project would write it.
const discoverLine = (properties) => `gtest_discover_tests(lib_tests DISCOVERY_MODE PRE_TEST${properties === "" ? "" : ` PROPERTIES ${properties}`})`;
const tinyProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "cpp-gates-tests-"));
  const files = {
    "CMakePresets.json": readFileSync(join(root, "CMakePresets.json"), "utf8"),
    [LAYER_MAP]: `${JSON.stringify({ layers: { lib: { may: [], deny: map.layers[innermost].deny } }, tests: "cpp/tests" }, null, 2)}\n`,
    "CMakeLists.txt": [
      "cmake_minimum_required(VERSION 3.28)",
      "project(zz_gate LANGUAGES CXX)",
      "set(CMAKE_CXX_STANDARD 20)",
      "set(CMAKE_CXX_EXTENSIONS OFF)",
      "add_library(lib STATIC cpp/lib/src/lib.cpp)",
      "include(FetchContent)",
      'FetchContent_Declare(googletest URL "unused: FETCHCONTENT_SOURCE_DIR_GOOGLETEST is set" SYSTEM)',
      'set(BUILD_GMOCK OFF CACHE BOOL "" FORCE)',
      'set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)',
      "FetchContent_MakeAvailable(googletest)",
      "enable_testing()",
      "include(GoogleTest)",
      "add_executable(lib_tests cpp/tests/lib_test.cpp)",
      "target_link_libraries(lib_tests PRIVATE lib GTest::gtest_main)",
      discoverLine(""),
      "",
    ].join("\n"),
    "cpp/lib/src/lib.cpp": "int zz_gate_lib() { return 1; }\n",
    "cpp/tests/lib_test.cpp": "#include <gtest/gtest.h>\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

// Test bodies the steps share: one that fails, one that leaks, and one with a data race.
const FAILS = "TEST(ZzGate, Fails) { EXPECT_EQ(1, 2); }\n";
const LEAKS = "TEST(ZzGate, Leaks) {\n  int* values = new int[4];\n  values[0] = 1;\n  EXPECT_EQ(values[0], 1);\n}\n";
const RACES = [
  "#include <thread>",
  "",
  "TEST(ZzGate, Races) {",
  "  int counter = 0;",
  "  std::thread first([&counter] { for (int i = 0; i < 10000; ++i) ++counter; });",
  "  std::thread second([&counter] { for (int i = 0; i < 10000; ++i) ++counter; });",
  "  first.join();",
  "  second.join();",
  "  EXPECT_GT(counter, 0);",
  "}",
  "",
].join("\n");

// A passing test that prints sanitizer-looking lines as data (a log or diagnostics test), to stdout and stderr: no report starts its line.
const ECHOES_SAMPLES = [
  "#include <iostream>",
  "",
  "TEST(ZzGate, EchoesSampleReports) {",
  '  std::cout << "input: ==1==ERROR: AddressSanitizer: heap-use-after-free (sample)\\n";',
  '  std::cout << "input: foo.cpp:3:5: runtime error: signed integer overflow (sample)\\n";',
  '  std::cerr << "input: ERROR: AddressSanitizer (sample)\\n";',
  '  std::cerr << "input: WARNING: ThreadSanitizer: data race (sample)\\n";',
  "  EXPECT_TRUE(true);",
  "}",
  "",
].join("\n");

// Each step: the test file, its gtest_discover_tests properties, and why run.mjs must fail the run
// (`expect`), or `passes: true` for a run that must pass (a scan that matched too much fails it).
const TEST_VERDICT_STEPS = {
  asan: [
    { proves: "a passing test that prints sample sanitizer reports as data", test: ECHOES_SAMPLES, passes: true },
    { proves: "a test executable with no tests", test: "", expect: /zero tests executed/ },
    { proves: "a test behind #if 0", test: "TEST(ZzGate, Runs) {}\n\n#if 0\nTEST(ZzGate, Hidden) {}\n#endif\n", expect: /did not run[\s\S]*ZzGate\.Hidden/ },
    { proves: "an UndefinedBehaviorSanitizer report", test: "#include <climits>\n\nTEST(ZzGate, Overflows) {\n  volatile int big = INT_MAX;\n  volatile int one = 1;\n  EXPECT_NE(big + one, 0);\n}\n", expect: /did not pass[\s\S]*ZzGate\.Overflows/ },
    { proves: "an AddressSanitizer report", test: "TEST(ZzGate, ReadsPastTheEnd) {\n  int* values = new int[2];\n  volatile int index = 2;\n  EXPECT_NE(values[index], 7);\n  delete[] values;\n}\n", expect: /did not pass[\s\S]*ZzGate\.ReadsPastTheEnd/ },
    { proves: "a LeakSanitizer report", test: LEAKS, expect: /did not pass[\s\S]*ZzGate\.Leaks/ },
    { proves: "WILL_FAIL on a failing test", test: FAILS, properties: "WILL_FAIL TRUE", expect: /ZzGate\.Fails: WILL_FAIL/ },
    { proves: "PASS_REGULAR_EXPRESSION on a failing test", test: FAILS, properties: 'PASS_REGULAR_EXPRESSION ".*"', expect: /ZzGate\.Fails: PASS_REGULAR_EXPRESSION/ },
    { proves: "FAIL_REGULAR_EXPRESSION", test: FAILS, properties: 'FAIL_REGULAR_EXPRESSION "zz-never-printed"', expect: /ZzGate\.Fails: FAIL_REGULAR_EXPRESSION/ },
    { proves: "SKIP_RETURN_CODE", test: FAILS, properties: "SKIP_RETURN_CODE 1", expect: /ZzGate\.Fails: SKIP_RETURN_CODE/ },
    { proves: "SKIP_REGULAR_EXPRESSION other than GoogleTest's own", test: FAILS, properties: 'SKIP_REGULAR_EXPRESSION "FAILED"', expect: /ZzGate\.Fails: SKIP_REGULAR_EXPRESSION .*FAILED/ },
    { proves: "DISABLED", test: FAILS, properties: "DISABLED TRUE", expect: /ZzGate\.Fails: DISABLED/ },
    { proves: "ASAN_OPTIONS in a test's ENVIRONMENT (a leak let through)", test: LEAKS, properties: 'ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0"', expect: /ZzGate\.Leaks: ENVIRONMENT sets ASAN_OPTIONS=detect_leaks=0/ },
    { proves: "GTEST_ in a test's ENVIRONMENT", test: FAILS, properties: 'ENVIRONMENT "GTEST_FILTER=Nothing.*"', expect: /ZzGate\.Fails: ENVIRONMENT sets GTEST_FILTER/ },
    // No property: the process itself exits 0 after GoogleTest printed FAILED (an atexit handler), so only the log shows it.
    { proves: "a FAILED line in a process that exits 0", test: "#include <cstdlib>\n\nnamespace {\nconst int zz_quiet = (std::atexit([] { std::_Exit(0); }), 0);\n}  // namespace\n\n" + FAILS, expect: /did not pass[\s\S]*ZzGate\.Fails \(run, but its log shows/ },
    // The leak report still prints, but exitcode=0 (default options, refused in a layer's source, not here) keeps the exit code 0.
    { proves: "a LeakSanitizer report in a process that exits 0", test: `extern "C" const char* __asan_default_options() { return "exitcode=0"; }\n\n${LEAKS}`, expect: /did not pass[\s\S]*ZzGate\.Leaks \(run, but its log shows/ },
  ],
  tsan: [
    { proves: "a passing test that prints sample sanitizer reports as data", test: ECHOES_SAMPLES, passes: true },
    { proves: "a ThreadSanitizer data race", test: RACES, expect: /did not pass[\s\S]*ZzGate\.Races/ },
    { proves: "TSAN_OPTIONS in a test's ENVIRONMENT_MODIFICATION (a race let through)", test: RACES, properties: 'ENVIRONMENT_MODIFICATION "TSAN_OPTIONS=set:report_bugs=0"', expect: /ZzGate\.Races: ENVIRONMENT_MODIFICATION sets TSAN_OPTIONS=set:report_bugs=0/ },
  ],
};
const verdictProbeCount = Object.values(TEST_VERDICT_STEPS).flat().length;

// Runs one preset's steps in a tiny project of its own; resolves the misses.
const testVerdictProbes = async (preset) => {
  const dir = tinyProject();
  const misses = [];
  try {
    const problem = await configureScratch(dir, preset);
    if (problem !== "") return [`the ${preset} test-verdict project did not configure: ${problem}`];
    // Each step rewrites the test file and the properties, rebuilds (CMake reconfigures itself), and must fail the run for its reason (or pass, for `passes`).
    for (const { proves, test, properties = "", expect, passes = false } of TEST_VERDICT_STEPS[preset]) {
      writeFileSync(join(dir, "cpp/tests/lib_test.cpp"), `#include <gtest/gtest.h>\n\n${test}`);
      const cmake = readFileSync(join(dir, "CMakeLists.txt"), "utf8").replace(/^gtest_discover_tests\(.*\)$/m, discoverLine(properties));
      writeFileSync(join(dir, "CMakeLists.txt"), cmake);
      const result = await build(dir, preset);
      const why = failure("cmake --build (test-verdict project)", result, 0, "BUILD_TIMEOUT_MS");
      if (why !== "") {
        misses.push(`${proves}: the project did not build: ${why}\n${result.output.split("\n").filter((line) => /error/i.test(line)).join("\n")}`);
        continue;
      }
      const verdict = await runTests(dir, preset);
      if (passes) {
        if (verdict !== "") misses.push(`${proves} (${preset}) must pass, but run.mjs test failed it:\n${verdict}`);
      } else if (!expect.test(verdict)) misses.push(`${proves} (${preset}) was not failed by run.mjs test for its reason:\n${verdict || "(it passed)"}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return misses;
};

// Every copy is planted before any tool starts (fail() exits on an unplantable probe), then the
// probes run side by side, each tool in its own process group via run().
const scratches = heavy.map(({ setup }) => scratchCopy(setup));
let heavyMisses = [];
let verdictMisses = [];
try {
  const width = Math.max(2, availableParallelism());
  const [results, ...verdicts] = await Promise.all([
    pool(heavy.map(({ check }, index) => () => check(scratches[index])), width),
    ...Object.keys(TEST_VERDICT_STEPS).map((preset) => testVerdictProbes(preset)),
  ]);
  heavyMisses = heavy.flatMap(({ proves, expect }, index) => (expect(results[index]) ? [] : [`${proves}:\n      ${results[index].join("\n      ") || "(nothing reported)"}`]));
  verdictMisses = verdicts.flat();
} finally {
  for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
}
const allMisses = [...heavyMisses, ...verdictMisses];
if (allMisses.length > 0) fail(`${allMisses.length} of ${heavy.length + verdictProbeCount} toolchain probes were not reported:\n${allMisses.map((line) => `  ✗ ${line}`).join("\n")}`);
process.stdout.write(`cpp gates: all ${heavy.length} configured, built, tidy, and format probes and ${verdictProbeCount} test-verdict probes were reported.\n`);

// Record the pass under the stamp taken at the start, and only if nothing changed while the probes ran.
if (gateStamp(root) === stampAtStart) {
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${stampAtStart}\n`);
}
