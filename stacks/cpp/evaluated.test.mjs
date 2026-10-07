/*
  The C++ pack's checks on the build as evaluated: flag rules, the sanitizer set as the compiler reads it, the layer rules over a File API model, and the ninja-deps and nm parsers.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no toolchain: the model and tool output are written here.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/cpp/evaluated.mjs; a temp project holding only cpp-layers.json and the seed's directories.
*/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { checkConfigured, familyOf, flagProblems, parseDeps, parseUndefined, REQUIRED_WARNINGS, sanitizersOf } from "./evaluated.mjs";
import { FAMILIES } from "./sources.mjs";

// The asan preset's flags as CMake hands them to the compiler, plus the warning set.
const ASAN_FLAGS = ["-fsanitize=address,undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer", "-g", "-std=c++20", ...REQUIRED_WARNINGS];
const TSAN_FLAGS = ["-fsanitize=thread", "-fno-omit-frame-pointer", "-std=c++20", ...REQUIRED_WARNINGS];

// Flags as a File API compile group carries them (CMAKE_CXX_FLAGS arrives as one fragment).
const fragments = (flags) => [{ fragment: flags.join(" ") }];

// A set as a sorted array, for comparing.
const sorted = (set) => [...set].toSorted((left, right) => left.localeCompare(right));

describe("sanitizersOf", () => {
  it("reads the set left on after every -fsanitize and -fno-sanitize, in order", () => {
    assert.deepEqual(sorted(sanitizersOf(["-fsanitize=address,undefined"])), ["address", "undefined"]);
    assert.deepEqual([...sanitizersOf(["-fsanitize=address,undefined", "-fno-sanitize=undefined"])], ["address"]);
    assert.deepEqual([...sanitizersOf(["-fsanitize=address", "-fno-sanitize=all", "-fsanitize=thread"])], ["thread"]);
  });
});

describe("flagProblems", () => {
  it("passes each preset's own flags", () => {
    assert.deepEqual(flagProblems(ASAN_FLAGS, "asan", "t"), []);
    assert.deepEqual(flagProblems(TSAN_FLAGS, "tsan", "t"), []);
  });
  it("refuses anything that turns a warning off or down", () => {
    for (const flag of ["-w", "-Wno-error", "-Wno-error=shadow", "-Wno-conversion", "-fpermissive"]) assert.equal(flagProblems([...ASAN_FLAGS, flag], "asan", "t").length, 1, flag);
  });
  it("names each missing warning", () => {
    const problems = flagProblems(ASAN_FLAGS.filter((flag) => flag !== "-Werror" && flag !== "-Wshadow"), "asan", "t");
    assert.deepEqual(problems.map((line) => /without (\S+)/.exec(line)?.[1]), ["-Wshadow", "-Werror"]);
  });
  it("refuses a sanitizer taken back, a recover, an ignore list, and GNU extensions", () => {
    assert.match(flagProblems([...ASAN_FLAGS, "-fno-sanitize=address"], "asan", "t").join("\n"), /without -fsanitize=address/);
    assert.match(flagProblems([...ASAN_FLAGS, "-fsanitize-recover=undefined"], "asan", "t").join("\n"), /-fsanitize-recover=undefined/);
    assert.match(flagProblems([...ASAN_FLAGS, "-fsanitize-ignorelist=x.txt"], "asan", "t").join("\n"), /ignore list/);
    assert.match(flagProblems([...ASAN_FLAGS, "-std=gnu++20"], "asan", "t").join("\n"), /compiles as gnu\+\+20/);
    assert.match(flagProblems(ASAN_FLAGS.filter((flag) => flag !== "-fno-sanitize-recover=all"), "asan", "t").join("\n"), /print and pass/);
  });
});

describe("parseDeps", () => {
  it("maps each object to what it included", () => {
    const text = "cpp/x.o: #deps 2, deps mtime 1 (VALID)\n    /repo/cpp/domain/src/note.cpp\n    /repo/cpp/domain/include/domain/note.hpp\n\nother.o: #deps 0, deps mtime 1 (VALID)\n\n";
    const deps = parseDeps(text);
    assert.deepEqual(deps.get("cpp/x.o"), ["/repo/cpp/domain/src/note.cpp", "/repo/cpp/domain/include/domain/note.hpp"]);
    assert.deepEqual(deps.get("other.o"), []);
  });
});

describe("parseUndefined and familyOf", () => {
  const nm = ["", "note.cpp.o:", "                 U getenv", "                 U std::chrono::_V2::system_clock::now()", "", "sync.cpp.o:", "                 U std::mutex::lock()", "                 U std::thread::join()", "                 U operator new(unsigned long)"].join("\n");
  it("reads each archive member's undefined symbols", () => {
    assert.deepEqual(parseUndefined(nm).map(({ member }) => member), ["note.cpp.o", "note.cpp.o", "sync.cpp.o", "sync.cpp.o", "sync.cpp.o"]);
  });
  it("puts each call in its family, and leaves pure calls and locking out", () => {
    assert.deepEqual(parseUndefined(nm).map(({ symbol }) => familyOf(symbol)), ["env", "clock", undefined, "thread", undefined]);
  });
  it("has a family for every name the layer map accepts", () => {
    for (const family of FAMILIES) assert.ok(["fopen", "time", "getenv", "system", "pthread_create", "rand", "socket", "dlopen"].some((symbol) => familyOf(symbol) === family), family);
  });
});

describe("checkConfigured", () => {
  const root = mkdtempSync(join(tmpdir(), "cpp-evaluated-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "cpp-layers.json"), JSON.stringify({ layers: { domain: { may: [], deny: [...FAMILIES] }, usecases: { may: ["domain"], deny: [...FAMILIES] }, adapters: { may: ["domain", "usecases"], deny: [], anyLibrary: true } }, tests: "cpp/tests" }));
  for (const dir of ["cpp/domain/src", "cpp/usecases/src", "cpp/adapters/src", "cpp/tests"]) mkdirSync(join(root, dir), { recursive: true });

  // A File API target the way readModel returns it: a layer (library) or the test executable.
  const layer = (name, { links = [], includes = [name], flags = ASAN_FLAGS, sources = [`cpp/${name}/src/${name}.cpp`] } = {}) => ({
    id: `${name}::@1`,
    name,
    type: "STATIC_LIBRARY",
    sources: sources.map((path) => ({ path })),
    dependencies: links.map((other) => ({ id: `${other}::@1` })),
    compileGroups: [{ language: "CXX", compileCommandFragments: fragments(flags), languageStandard: { standard: "20" }, includes: includes.map((dir) => ({ path: join(root, `cpp/${dir}/include`) })) }],
    artifacts: [{ path: `lib${name}.a` }],
  });
  const tests = { id: "tests::@1", name: "domain_tests", type: "EXECUTABLE", sources: [{ path: "cpp/tests/note_test.cpp" }], dependencies: [{ id: "adapters::@1" }], compileGroups: [], link: { commandFragments: [{ fragment: "-fsanitize=address,undefined", role: "flags" }] } };
  const seed = () => [layer("domain"), layer("usecases", { links: ["domain"], includes: ["usecases", "domain"] }), layer("adapters", { links: ["usecases", "domain"], includes: ["adapters", "usecases", "domain"] }), tests];
  const model = (targets = seed()) => ({ targets, compilerIds: { CXX: "Clang" } });
  const swap = (name, replacement) => seed().map((target) => (target.name === name ? replacement : target));

  it("passes the seed's shape", () => {
    assert.deepEqual(checkConfigured(root, "asan", model()), []);
  });
  it("refuses an inward link and another layer's headers on the include path", () => {
    assert.match(checkConfigured(root, "asan", model(swap("domain", layer("domain", { links: ["adapters"] })))).join("\n"), /target 'domain' \(asan\) links 'adapters', which its row doesn't allow/);
    assert.match(checkConfigured(root, "asan", model(swap("domain", layer("domain", { includes: ["domain", "adapters"] })))).join("\n"), /cpp\/adapters\/include on its include path/);
  });
  it("refuses a target with no row, a row with no target, and a missing test executable", () => {
    const problems = checkConfigured(root, "asan", model([layer("domain"), layer("usecases", { links: ["domain"], includes: ["usecases", "domain"] }), layer("zz", { sources: ["cpp/domain/src/zz.cpp"] })])).join("\n");
    assert.match(problems, /target 'zz' \(asan\) has no row/);
    assert.match(problems, /row 'adapters' is not a CMake target/);
    assert.match(problems, /no test executable/);
  });
  it("refuses a test executable linked without its sanitizer, and the wrong compiler", () => {
    const unsanitized = { ...tests, link: { commandFragments: [{ fragment: "-fsanitize=address,undefined -fno-sanitize=address", role: "flags" }] } };
    assert.match(checkConfigured(root, "asan", model(swap("domain_tests", unsanitized))).join("\n"), /links without -fsanitize=address/);
    assert.match(checkConfigured(root, "asan", { ...model(), compilerIds: { CXX: "GNU" } }).join("\n"), /compiles with GNU, not Clang/);
  });
  it("judges flags per compile group, so one source's -Wno-* is seen", () => {
    const domain = layer("domain");
    domain.compileGroups.push({ ...domain.compileGroups[0], compileCommandFragments: fragments([...ASAN_FLAGS, "-Wno-shadow"]) });
    assert.match(checkConfigured(root, "asan", model(swap("domain", domain))).join("\n"), /compiles with -Wno-shadow/);
  });
  it("refuses a C compile group in a first-party target, naming the file", () => {
    const domain = layer("domain", { sources: ["cpp/domain/src/domain.cpp", "cpp/domain/src/zz.c"] });
    domain.compileGroups.push({ language: "C", sourceIndexes: [1], compileCommandFragments: fragments(["-w"]), includes: [] });
    assert.match(checkConfigured(root, "asan", model(swap("domain", domain))).join("\n"), /target 'domain' \(asan\) compiles C \(cpp\/domain\/src\/zz\.c\)/);
  });
  it("refuses a first-party include directory marked SYSTEM, and leaves a fetched one alone", () => {
    const domain = layer("domain");
    domain.compileGroups[0].includes = [{ path: join(root, "cpp/domain/include"), isSystem: true }, { path: join(root, "build-cpp/asan/_deps/googletest-src/googletest/include"), isSystem: true }];
    const problems = checkConfigured(root, "asan", model(swap("domain", domain)));
    assert.equal(problems.filter((line) => line.includes("SYSTEM include")).length, 1, problems.join("\n"));
    assert.match(problems.join("\n"), /cpp\/domain\/include as a SYSTEM include directory/);
  });
  it("follows a refused link, since CMake reports a link cycle as a chain", () => {
    // `target_link_libraries(domain PRIVATE $<LINK_ONLY:adapters>)` reaches the File API as domain → usecases → adapters.
    const chained = [layer("domain", { links: ["usecases"] }), layer("usecases", { links: ["adapters"], includes: ["usecases", "domain"] }), layer("adapters", { includes: ["adapters", "usecases", "domain"] }), tests];
    const problems = checkConfigured(root, "asan", model(chained)).join("\n");
    assert.match(problems, /target 'domain' \(asan\) links 'usecases', which its row doesn't allow/);
    assert.match(problems, /target 'domain' \(asan\) links 'adapters' \(through usecases\), which its row doesn't allow/);
  });
});

describe("flagProblems: warnings off by another name", () => {
  it("refuses --no-warnings and every flag that marks headers as system ones", () => {
    for (const flag of ["--no-warnings", "-isystem/repo/cpp/domain/include", "-isystem", "-isystem-after/repo", "--system-header-prefix=domain/", "-iwithprefix/repo", "-iwithprefixbefore/repo"]) assert.equal(flagProblems([...ASAN_FLAGS, flag], "asan", "t").length, 1, flag);
  });
});
