/*
  The C++ pack's source rules: comments and literals never trip a code rule, a NOLINT needs checks and a reason, tests are found the way run.mjs counts them, and the layer map holds its floor.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no toolchain.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/cpp/sources.mjs against small projects written to temp dirs.

  gates.mjs plants one violation per rule in a copy of the real tree; these cover the edges a plant doesn't (lookalikes in comments, strings, raw strings, digit separators).
*/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { blank, checkFile, checkLayerMap, checkSources, faultKinds, FAMILIES, testsInSource } from "./sources.mjs";

// Temp projects made here, removed after the file's tests.
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// The seed's layer map: an innermost and a middle layer that deny everything, an outer one that may link anything.
const SEED_MAP = {
  layers: {
    domain: { may: [], deny: [...FAMILIES] },
    usecases: { may: ["domain"], deny: [...FAMILIES] },
    adapters: { may: ["domain", "usecases"], deny: [], anyLibrary: true },
  },
  tests: "cpp/tests",
};

// A project with the seed's layout and map; `files` adds or replaces files, `map` changes the map.
const project = ({ files = {}, map = (value) => value } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cpp-sources-"));
  made.push(root);
  const all = {
    "cpp-layers.json": JSON.stringify(map(structuredClone(SEED_MAP))),
    "cpp/domain/src/note.cpp": "int note();\n",
    "cpp/usecases/src/sync.cpp": "int sync();\n",
    "cpp/adapters/src/clock.cpp": "int clock_now();\n",
    "cpp/tests/note_test.cpp": "TEST(Note, Works) {}\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

// Map edits: the middle row with one family taken off its deny list; the outer row without arrays.
const allowingInUsecases = (allowed) => (value) => {
  value.layers.usecases.deny = FAMILIES.filter((family) => family !== allowed);
  return value;
};
const withBrokenAdaptersRow = (value) => {
  value.layers.adapters = { may: "domain" };
  return value;
};

// Findings for one planted file in the domain layer (or `path`).
const findingsFor = (content, path = "cpp/domain/src/zz.cpp") => checkFile(project({ files: { [path]: content } }), path);

describe("blank", () => {
  it("keeps length and newlines, and hides comments and literals from the code rules", () => {
    const source = '// #pragma GCC diagnostic ignored "-Wx"\nconst char* text = "_Pragma(no_sanitize)";\n/* __lsan_disable */ int x = 1\'000;\n';
    const code = blank(source);
    assert.equal(code.length, source.length);
    assert.equal(code.split("\n").length, source.split("\n").length);
    assert.doesNotMatch(code, /pragma|_Pragma|no_sanitize|__lsan/);
    assert.match(code, /int x = 1'000;/, "a digit separator is not a char literal");
  });
  it("blanks a raw string, delimiter and all", () => {
    const code = blank('auto s = R"zz(#pragma clang diagnostic ignored ")" )zz"; int after;\n');
    assert.doesNotMatch(code, /pragma/);
    assert.match(code, /int after;/);
  });
  it("keeps only comments when asked, for the rules that live there", () => {
    assert.equal(blank('int a; // NOLINT\nchar b = \'"\';\n', { keep: "comments" }).trim(), "// NOLINT");
  });
});

describe("checkFile", () => {
  it("passes clean code that merely talks about the forbidden things", () => {
    assert.deepEqual(findingsFor('// We never #pragma GCC diagnostic ignored here.\nconst char* why = "no_sanitize";\n'), []);
  });
  it("names the line of each code rule", () => {
    const findings = findingsFor('int a;\n#  pragma clang diagnostic ignored "-Wshadow"\n[[gnu::no_sanitize_address]] void f();\n');
    assert.equal(findings.length, 2);
    assert.match(findings[0], /zz\.cpp:2: /);
    assert.match(findings[1], /zz\.cpp:3: .*no_sanitize/);
  });
  it("lets a NOLINT through only with named checks and a reason", () => {
    assert.deepEqual(findingsFor("int a;  // NOLINT(google-explicit-constructor): implicit on purpose, a value wrapper\n"), []);
    assert.deepEqual(findingsFor("// NOLINTNEXTLINE(bugprone-a,bugprone-b): both fire on the same macro\nint a;\n"), []);
    assert.match(findingsFor("int a;  // NOLINT()\n")[0], /must name its checks/);
    assert.match(findingsFor("int a;  // NOLINT(bugprone-a):\n")[0], /needs a reason/);
    assert.match(findingsFor("// NOLINTBEGIN(*): later\n")[0], /silences a whole group/);
  });
  it("ignores a NOLINT spelled inside a string", () => {
    assert.deepEqual(findingsFor('const char* s = "// NOLINT";\n'), []);
  });
  it("wants a reason on clang-format off", () => {
    assert.deepEqual(findingsFor("// clang-format off: a lookup table laid out as a grid\nint a;\n// clang-format on\n"), []);
    assert.equal(findingsFor("// clang-format off\n").length, 1);
  });
  it("holds the test-only rules in the tests directory only", () => {
    assert.equal(findingsFor("int DISABLED_count;\n").length, 0);
    assert.match(findingsFor("TEST(Zz, DISABLED_Never) {}\n", "cpp/tests/zz_test.cpp")[0], /DISABLED_/);
  });
  it("refuses a first-party header marked system, in either spelling", () => {
    assert.match(findingsFor("#pragma once\n#pragma GCC system_header\n", "cpp/domain/include/domain/zz.hpp")[0] ?? "", /zz\.hpp:2: .*system_header/);
    assert.match(findingsFor("#  pragma clang system_header\n")[0] ?? "", /system_header/);
  });
  it("refuses every spelling of a sanitizer switched off for a function", () => {
    for (const spelled of ['__attribute__((__no_sanitize__("address")))', "__attribute__((no_sanitize_thread))", "[[gnu::no_sanitize_undefined]]", "__attribute__((disable_sanitizer_instrumentation))", '[[clang::no_sanitize("memory")]]']) {
      assert.equal(findingsFor(`${spelled} void f();\n`).length, 1, spelled);
    }
  });
});

describe("include reach, by the file's own layer", () => {
  it("refuses a domain header including an adapters header, however few units include it", () => {
    const findings = findingsFor('#pragma once\n#include "adapters/clock.hpp"\n', "cpp/domain/include/domain/zz.hpp");
    assert.equal(findings.length, 0, "no such header yet: a system or third-party include is not ours to judge");
    const root = project({ files: { "cpp/adapters/include/adapters/clock.hpp": "#pragma once\n", "cpp/domain/include/domain/zz.hpp": '#pragma once\n#include <vector>\n#include "adapters/clock.hpp"\n' } });
    assert.match(checkFile(root, "cpp/domain/include/domain/zz.hpp").join("\n"), /zz\.hpp:3: includes adapters\/clock\.hpp \(cpp\/adapters\/include\/adapters\/clock\.hpp, layer 'adapters'\), which layer 'domain' may not reach/);
  });
  it("lets a layer include its own files and its allowed layers' headers, and ignores an include in a comment", () => {
    const root = project({ files: { "cpp/domain/include/domain/note.hpp": "#pragma once\n", "cpp/usecases/include/usecases/sync.hpp": '#pragma once\n#include "domain/note.hpp"\n// #include "adapters/clock.hpp"\n', "cpp/adapters/include/adapters/clock.hpp": "#pragma once\n" } });
    assert.deepEqual(checkFile(root, "cpp/usecases/include/usecases/sync.hpp"), []);
  });
  it("looks where the layer may reach first, so a same-named header out of reach isn't blamed", () => {
    const root = project({ files: { "cpp/domain/include/shared/names.hpp": "#pragma once\n", "cpp/adapters/include/shared/names.hpp": "#pragma once\n", "cpp/usecases/src/zz.cpp": '#include "shared/names.hpp"\n' } });
    assert.deepEqual(checkFile(root, "cpp/usecases/src/zz.cpp"), []);
  });
  it("finds a header in the layer's own private dir before another layer's include/ (a PRIVATE cpp/domain/src include dir)", () => {
    const root = project({ files: { "cpp/domain/src/zz_util.hpp": "#pragma once\n", "cpp/adapters/include/zz_util.hpp": "#pragma once\n", "cpp/domain/src/sub/zz_fp.cpp": '#include "zz_util.hpp"\n' } });
    assert.deepEqual(checkFile(root, "cpp/domain/src/sub/zz_fp.cpp"), []);
    rmSync(join(root, "cpp/domain/src/zz_util.hpp"));
    assert.match(checkFile(root, "cpp/domain/src/sub/zz_fp.cpp").join("\n"), /zz_fp\.cpp:1: includes zz_util\.hpp \(cpp\/adapters\/include\/zz_util\.hpp, layer 'adapters'\)/);
  });
  it("resolves a relative include from the file's own directory", () => {
    const root = project({ files: { "cpp/adapters/include/adapters/clock.hpp": "#pragma once\n", "cpp/domain/src/zz.cpp": '#include "../../adapters/include/adapters/clock.hpp"\n' } });
    assert.match(checkFile(root, "cpp/domain/src/zz.cpp").join("\n"), /layer 'adapters'/);
  });
});

// A layer-map edit: tidyOff for the tests directory.
const withTidyOff = (checks) => (value) => ({ ...value, tidyOff: { "cpp/tests": checks } });

describe("nested .clang-tidy and tidyOff", () => {
  it("wants every nested .clang-tidy to inherit the root's", () => {
    assert.deepEqual(checkSources(project({ files: { "cpp/tests/.clang-tidy": "InheritParentConfig: true\nChecks: '-readability-function-cognitive-complexity'\n" } })), []);
    assert.match(checkSources(project({ files: { "cpp/domain/.clang-tidy": "InheritParentConfig: false\nChecks: '-*'\n" } })).join("\n"), /cpp\/domain\/\.clang-tidy: a nested \.clang-tidy must say `InheritParentConfig: true`/);
  });
  it("keeps a floor check out of tidyOff", () => {
    assert.deepEqual(checkLayerMap(project({ map: withTidyOff(["readability-function-cognitive-complexity"]) })), []);
    assert.match(checkLayerMap(project({ map: withTidyOff(["modernize-use-nullptr"]) })).join("\n"), /lists modernize-use-nullptr, which is on the floor/);
    assert.match(checkLayerMap(project({ map: withTidyOff("modernize-use-nullptr") })).join("\n"), /must be a list of check names/);
  });
});

describe("testsInSource", () => {
  it("finds every test macro, including one behind #if 0, but not one in a comment", () => {
    const root = project({ files: { "cpp/tests/more_test.cpp": "TEST_F(Fix, A) {}\n#if 0\nTEST_P(Param, B) {}\n#endif\n// TEST(Commented, C) {}\nTYPED_TEST(Typed, D) {}\n" } });
    const names = testsInSource(root).map((test) => `${test.macro} ${test.suite}.${test.name}:${test.line}`).toSorted();
    assert.deepEqual(names, ["TEST Note.Works:1", "TEST_F Fix.A:1", "TEST_P Param.B:3", "TYPED_TEST Typed.D:6"]);
  });
});

describe("faultKinds and checkSources", () => {
  const catalogue = "enum class FaultKind {\n  drop,\n  disk_full = 3,\n};\n";
  it("reads the catalogue's kinds", () => {
    assert.deepEqual(faultKinds(project({ files: { "cpp/tests/chaos/fault_kind.hpp": catalogue } }))?.kinds, ["drop", "disk_full"]);
  });
  it("fails a kind no test name starts with, and passes once one does", () => {
    const missing = checkSources(project({ files: { "cpp/tests/chaos/fault_kind.hpp": catalogue, "cpp/tests/chaos_test.cpp": "TEST(Chaos, drop_Retries) {}\n" } }));
    assert.deepEqual(missing.map((line) => line.replace(/:.*?FaultKind::/, " ")), ["cpp/tests/chaos/fault_kind.hpp disk_full has no test: name one `TEST(…, disk_full_<what it proves>)` (testing-cpp.mdc → Fault injection)."]);
    assert.deepEqual(checkSources(project({ files: { "cpp/tests/chaos/fault_kind.hpp": catalogue, "cpp/tests/chaos_test.cpp": "TEST(Chaos, drop_Retries) {}\nTEST(Chaos, disk_full_Refuses) {}\n" } })), []);
  });
});

describe("checkLayerMap", () => {
  it("passes the seed's map", () => {
    assert.deepEqual(checkLayerMap(project()), []);
  });
  it("lets a middle layer allow thread, and nothing else below the floor", () => {
    assert.deepEqual(checkLayerMap(project({ map: allowingInUsecases("thread") })), []);
    assert.match(checkLayerMap(project({ map: allowingInUsecases("clock") })).join("\n"), /row 'usecases' must deny clock/);
  });
  it("leaves the outermost row free to deny nothing", () => {
    assert.ok(!checkLayerMap(project()).some((line) => line.includes("'adapters'")));
  });
  it("needs may and deny arrays on every row", () => {
    assert.match(checkLayerMap(project({ map: withBrokenAdaptersRow })).join("\n"), /row 'adapters' needs "may" and "deny" arrays/);
  });
});
