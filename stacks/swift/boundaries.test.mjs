/*
  The Swift pack's boundary scanner: clean seed passes, and each rule fires on a planted violation.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no swift.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/boundaries.mjs (and count-tests.mjs testsNotRun) against a temp copy of this repo's package seed.

  The point of every case: a rule that matches nothing passes silently, so each rule is shown to
  fire. A planted file goes into a copy, never the real tree.
*/
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { checkBoundaries, faultTestsByKind, importsOf, packageTargets, testsInSource, withoutCommentsAndStrings } from "./boundaries.mjs";
import { testsNotRun } from "./count-tests.mjs";

const REPO = resolve(".");
const present = existsSync(join(REPO, "Package.swift")) && existsSync(join(REPO, "swift-layers.json"));
const skip = present ? false : "no Swift package seed in this checkout";

// A scratch copy of the package seed; `plant` writes { path: content } into it.
const scratch = (plant = {}, edit = {}) => {
  const root = mkdtempSync(join(tmpdir(), "swift-boundaries-"));
  for (const name of ["Package.swift", "swift-layers.json", "Sources", "Tests"]) cpSync(join(REPO, name), join(root, name), { recursive: true });
  for (const [path, content] of Object.entries(edit)) writeFileSync(join(root, path), content(readFileSync(join(root, path), "utf8")));
  for (const [path, content] of Object.entries(plant)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

// Problems for a planted scratch copy; the copy is removed.
const problemsWith = (plant, edit) => {
  const root = scratch(plant, edit);
  try {
    return checkBoundaries(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("source reading", () => {
  it("finds every import form and ignores comments and strings", () => {
    const source = ['import Foundation', '@testable import Domain', 'internal import Config', 'import struct UseCases.Entry', '// import Adapters', '/* import Hidden */', 'let s = "import Nope"', 'import Testing // trailing'].join("\n");
    assert.deepEqual(importsOf(source).map((entry) => entry.module), ["Foundation", "Domain", "Config", "UseCases", "Testing"]);
  });

  it("keeps line numbers across a nested block comment", () => {
    assert.equal(withoutCommentsAndStrings("/* a /* b */ c */\nimport X").split("\n").length, 2);
  });
});

describe("the seed", () => {
  it("is clean", { skip }, () => {
    assert.deepEqual(checkBoundaries(REPO), []);
  });

  it("fails with a message when there is no layer map at all, rather than checking nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "swift-boundaries-empty-"));
    assert.match(checkBoundaries(root)[0], /swift-layers\.json is missing/);
    writeFileSync(join(root, "swift-layers.json"), '{ "layers": {} }');
    assert.match(checkBoundaries(root)[0], /no layers/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("planted violations", () => {
  /** @type {[string, Record<string, string>, RegExp][]} */
  const cases = [
    ["Domain importing an adapter target", { "Sources/Domain/Zz.swift": "import Adapters\n" }, /Sources\/Domain\/Zz\.swift:1: Domain imports 'Adapters'/],
    ["Domain importing Foundation (I/O)", { "Sources/Domain/Zz.swift": "import Foundation\n" }, /Domain imports 'Foundation'/],
    ["a @testable import smuggling an adapter into a use-case", { "Sources/UseCases/Zz.swift": "@testable import Adapters\n" }, /UseCases imports 'Adapters'/],
    ["Config importing a layer", { "Sources/Config/Zz.swift": "import Domain\n" }, /Config imports 'Domain'/],
    ["a third-party module in Domain", { "Sources/Domain/Zz.swift": "import GRDB\n" }, /Domain imports 'GRDB'/],
    ["a target directory with no layer row", { "Sources/Zz/Zz.swift": "// nothing\n" }, /Sources\/Zz is a target with no row/],
    ["`default:` in a domain switch", { "Sources/Domain/Zz.swift": "func f(o: Outcome) -> Int {\n    switch o {\n    case .applied: return 1\n    default: return 0\n    }\n}\n" }, /Zz\.swift:4: `default:` in Domain/],
    ["a disabled test", { "Tests/NoteSyncTests/Zz.swift": "import Testing\n@Test(.disabled(\"flaky\")) func f() {}\n" }, /a `\.disabled\(\.\.\.\)` trait/],
    ["a disabled test spaced `.disabled (`", { "Tests/NoteSyncTests/Zz.swift": "import Testing\n@Test(.disabled (\"flaky\")) func f() {}\n" }, /a `\.disabled\(\.\.\.\)` trait/],
    ["an `.enabled(if:)` test", { "Tests/NoteSyncTests/Zz.swift": "import Testing\n@Test(.enabled(if: false)) func f() {}\n" }, /a `\.enabled\(\.\.\.\)` trait/],
    ["@_silgen_name in Domain", { "Sources/Domain/Zz.swift": '@_silgen_name("getpid")\nfunc pid() -> Int32\n' }, /Sources\/Domain\/Zz\.swift:1: `@_silgen_name` in Domain/],
    ["@_extern in UseCases", { "Sources/UseCases/Zz.swift": '@_extern(c, "getpid")\nfunc pid() -> Int32\n' }, /Sources\/UseCases\/Zz\.swift:1: `@_extern` in UseCases/],
  ];
  for (const [label, plant, expected] of cases) {
    it(`reports ${label}`, { skip }, () => {
      assert.ok(problemsWith(plant).some((line) => expected.test(line)), `not reported: ${label}`);
    });
  }

  it("does not report `@unknown default` or a default in a comment", { skip }, () => {
    const source = "// default: here\nfunc f(o: Outcome) -> Int {\n    switch o {\n    case .applied: return 1\n    @unknown default: return 0\n    }\n}\n";
    assert.deepEqual(problemsWith({ "Sources/Domain/Zz.swift": source }).filter((line) => /default/.test(line)), []);
  });

  it("reports a layer row whose directory is misspelled, and one Package.swift never declares", { skip }, () => {
    const problems = problemsWith({}, { "swift-layers.json": (text) => text.replace('"Domain": ["Config"]', '"Domian": ["Config"]') });
    assert.ok(problems.some((line) => /row 'Domian' matches no Swift files/.test(line)));
    assert.ok(problems.some((line) => /row 'Domian' is not a target in Package\.swift/.test(line)));
    assert.ok(problems.some((line) => /Sources\/Domain is a target with no row/.test(line)));
  });

  it("reports an allowed module that is neither a layer nor a known system module", { skip }, () => {
    const problems = problemsWith({}, { "swift-layers.json": (text) => text.replace('"UseCases", "Foundation"', '"UseCaess", "Foundation"') });
    assert.ok(problems.some((line) => /allows 'UseCaess'/.test(line)));
  });

  it("reports a noDefaultIn layer that does not exist", { skip }, () => {
    const problems = problemsWith({}, { "swift-layers.json": (text) => text.replace('"noDefaultIn": ["Domain", "UseCases"]', '"noDefaultIn": ["Domian"]') });
    assert.ok(problems.some((line) => /noDefaultIn names 'Domian'/.test(line)));
  });

  it("reports a floating or uncommented third-party package", { skip }, () => {
    const floating = problemsWith({}, { "Package.swift": (text) => text.replace("targets: [", '    dependencies: [\n        // why: a reason.\n        .package(url: "https://example.com/x.git", from: "1.0.0"),\n    ],\n    targets: [') });
    assert.ok(floating.some((line) => /not pinned with `exact:`/.test(line)));
    const uncommented = problemsWith({}, { "Package.swift": (text) => text.replace("targets: [", '    dependencies: [\n        .package(url: "https://example.com/x.git", exact: "1.0.0"),\n    ],\n    targets: [') });
    assert.ok(uncommented.some((line) => /no comment on the line above/.test(line)));
    const fine = problemsWith({}, { "Package.swift": (text) => text.replace("targets: [", '    dependencies: [\n        // GRDB: SQLite access; no stdlib equivalent.\n        .package(url: "https://example.com/x.git", exact: "1.0.0"),\n    ],\n    targets: [') });
    assert.deepEqual(fine.filter((line) => /Package\.swift:\d+/.test(line)), []);
  });

  it("reports a floating package wherever it sits: inline, after other text on the line", { skip }, () => {
    const inline = problemsWith({}, { "Package.swift": (text) => text.replace("    targets: [", '    dependencies: [.package(url: "https://example.com/x.git", from: "1.0.0")], targets: [') });
    assert.ok(inline.some((line) => /not pinned with `exact:`/.test(line)));
    assert.ok(inline.some((line) => /no comment on the line above/.test(line)));
  });

  /** @type {[string, (text: string) => string, RegExp][]} */
  const manifestCases = [
    ["a target whose path is outside Sources/<Name>", (text) => text.replace('.target(name: "Domain", dependencies', '.target(name: "Domain", path: "Elsewhere/Domain", dependencies'), /target 'Domain' has `path: "Elsewhere\/Domain"`/],
    ["a test target whose path is outside Tests/<Name>", (text) => text.replace('name: "NoteSyncTests",', 'name: "NoteSyncTests", path: "Sources/Domain",'), /target 'NoteSyncTests' has `path: "Sources\/Domain"`/],
    ["a target with no layer row", (text) => text.replace("targets: [", 'targets: [\n        .target(name: "Extra", swiftSettings: strict),'), /target 'Extra' has no row in swift-layers\.json/],
    ["a target without the strict settings", (text) => text.replace('.target(name: "Config", swiftSettings: strict)', '.target(name: "Config")'), /target 'Config' does not take `swiftSettings: strict`/],
    ["a strict array missing warnings-as-errors", (text) => text.replace(".treatAllWarnings(as: .error),", ""), /`strict` lacks `\.treatAllWarnings\(as: \.error\)`/],
    ["a strict array missing ExistentialAny", (text) => text.replace('.enableUpcomingFeature("ExistentialAny"),', ""), /`strict` lacks `\.enableUpcomingFeature\("ExistentialAny"\)`/],
    ["unsafeFlags", (text) => text.replace('.target(name: "Config", swiftSettings: strict)', '.target(name: "Config", swiftSettings: strict + [.unsafeFlags(["-Onone"])])'), /`unsafeFlags`/],
  ];
  for (const [label, edit, expected] of manifestCases) {
    it(`reports ${label} in Package.swift`, { skip }, () => {
      const problems = problemsWith({}, { "Package.swift": edit });
      assert.ok(problems.some((line) => expected.test(line)), `not reported: ${label}\n${problems.join("\n")}`);
    });
  }

  it("reads target declarations, not a `.target(name:)` dependency inside one", () => {
    const manifest = 'let package = Package(name: "A", targets: [\n    .target(name: "A", dependencies: [.target(name: "B")], path: "Sources/A", swiftSettings: strict),\n    // .target(name: "Commented")\n    .testTarget(name: "ATests"),\n])\n';
    assert.deepEqual(
      packageTargets(manifest).map(({ kind, name, path, strict }) => ({ kind, name, path, strict })),
      [
        { kind: "target", name: "A", path: "Sources/A", strict: true },
        { kind: "testTarget", name: "ATests", path: undefined, strict: false },
      ],
    );
  });

  it("lists a fault test hidden by #if false, so a run without it is caught", { skip }, () => {
    const root = scratch({}, { "Tests/NoteSyncTests/NoteSyncChaosTests.swift": (text) => text.replace('@Suite("Fault injection: NoteSync")', '#if false\n@Suite("Fault injection: NoteSync")').replace('/// One random script', "#endif\n\n/// One random script") });
    try {
      const byKind = faultTestsByKind(root);
      assert.ok(byKind.get("refused")?.some((test) => test.display?.startsWith("4xx")));
      assert.deepEqual([...byKind.keys()].toSorted(), ["delay", "dropAfterApply", "dropBeforeApply", "refused", "serverError"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists every @Test, marking one only a `#if os(...)` for another platform hides; #if false and other conditions hide nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "swift-tests-"));
    try {
      mkdirSync(join(root, "Tests/T"), { recursive: true });
      const source = [
        "import Testing",
        "@Test func plain() {}",
        "#if false",
        "@Test func neverCompiled() {}",
        "#endif",
        "#if os(macOS)",
        "@Test func macOnly() {}",
        "#else",
        "@Test func notMac() {}",
        "#endif",
        "#if !os(Linux)",
        "@Test func notLinux() {}",
        "#endif",
        "#if os(macOS) || DEBUG",
        "@Test func compound() {}",
        "#endif",
        "#if os(Linux)",
        "@Test func linuxOnly() {}",
        "#endif",
        "",
      ].join("\n");
      writeFileSync(join(root, "Tests/T/A.swift"), source);
      const hidden = (platform) => Object.fromEntries(testsInSource(root, platform).map((test) => [test.func, test.hidden]));
      assert.deepEqual(hidden("linux"), { plain: false, neverCompiled: false, macOnly: true, notMac: false, notLinux: true, compound: false, linuxOnly: false });
      assert.deepEqual(hidden("darwin"), { plain: false, neverCompiled: false, macOnly: false, notMac: true, notLinux: false, compound: false, linuxOnly: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an os-fenced @Test is required on its own platform's job and exempt only on the other", () => {
    const root = mkdtempSync(join(tmpdir(), "swift-tests-"));
    try {
      mkdirSync(join(root, "Tests/T"), { recursive: true });
      writeFileSync(join(root, "Tests/T/A.swift"), ["import Testing", "#if os(macOS)", "@Test func macOnly() {}", "#endif", "#if os(Linux)", "@Test func linuxOnly() {}", "#endif", ""].join("\n"));
      // An empty log: nothing ran, so each platform must name exactly the test its own job owes.
      const owed = (platform) => [...testsNotRun("", testsInSource(root, platform)).matchAll(/\b(\w+)\(\)/g)].map((match) => match[1]);
      assert.deepEqual(owed("darwin"), ["macOnly"]);
      assert.deepEqual(owed("linux"), ["linuxOnly"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a fault kind no test plays", { skip }, () => {
    const problems = problemsWith({}, { "Tests/NoteSyncTests/Chaos/FaultServer.swift": (text) => text.replace("    case refused\n", "    case refused\n    case clockJump\n") });
    assert.ok(problems.some((line) => /FaultKind\.clockJump has no test/.test(line)));
  });
});
