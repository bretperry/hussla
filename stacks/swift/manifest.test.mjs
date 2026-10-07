/*
  The Swift pack's evaluated-manifest check: each rule fires on a dump-package JSON that breaks it, and the seed's shape passes.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no swift.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/manifest.mjs. The JSON shapes are `swift package dump-package` 6.2 output, trimmed to the fields read.
  (`pnpm swift:gates` proves the same rules against a real dump of each planted Package.swift.)
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluatedProblems } from "./manifest.mjs";

const STRICT = [
  { kind: { treatAllWarnings: { _0: "error" } }, tool: "swift" },
  { kind: { enableUpcomingFeature: { _0: "ExistentialAny" } }, tool: "swift" },
];
const LAYERS = { Config: [], Domain: ["Config"] };

// A clean package with `extra` targets appended, after `change` edits the Config target.
const dump = ({ change = (target) => target, extra = [], modes = null } = {}) => ({
  swiftLanguageVersions: modes,
  targets: [change({ name: "Config", type: "regular", settings: STRICT }), { name: "Domain", type: "regular", path: "Sources/Domain/", settings: STRICT }, { name: "AppTests", type: "test", path: "Tests/AppTests", settings: STRICT }, ...extra],
});

describe("evaluatedProblems", () => {
  it("passes a package that keeps every rule (a path at the target's own home included)", () => {
    assert.deepEqual(evaluatedProblems(dump(), LAYERS), []);
  });

  const cases = [
    { label: "a path elsewhere", setup: { change: (t) => ({ ...t, path: "Elsewhere/Config" }) }, expected: /target 'Config' has path "Elsewhere\/Config"/ },
    { label: "a test target's path elsewhere", setup: { extra: [{ name: "MoreTests", type: "test", path: "Sources/MoreTests", settings: STRICT }] }, expected: /target 'MoreTests' has path "Sources\/MoreTests"/ },
    { label: "sources:", setup: { change: (t) => ({ ...t, sources: ["../x"] }) }, expected: /target 'Config' sets `sources:` \(\["\.\.\/x"\]\)/ },
    { label: "settings emptied", setup: { change: (t) => ({ ...t, settings: [] }) }, expected: /target 'Config' lacks `\.treatAllWarnings\(as: \.error\)`/ },
    { label: "ExistentialAny dropped", setup: { change: (t) => ({ ...t, settings: [STRICT[0]] }) }, expected: /target 'Config' lacks `\.enableUpcomingFeature\("ExistentialAny"\)`/ },
    { label: "a strict setting under a condition", setup: { change: (t) => ({ ...t, settings: [{ ...STRICT[0], condition: { platformNames: ["linux"] } }, STRICT[1]] }) }, expected: /target 'Config' lacks `\.treatAllWarnings/ },
    { label: "treatAllWarnings(as: .warning)", setup: { change: (t) => ({ ...t, settings: [...STRICT, { kind: { treatAllWarnings: { _0: "warning" } }, tool: "swift" }] }) }, expected: /sets `\.treatAllWarnings\(as: \.warning\)`/ },
    { label: "swiftLanguageMode", setup: { change: (t) => ({ ...t, settings: [...STRICT, { kind: { swiftLanguageMode: { _0: "5" } }, tool: "swift" }] }) }, expected: /sets `\.swiftLanguageMode\(\.v5\)`/ },
    { label: "unsafeFlags, any tool", setup: { change: (t) => ({ ...t, settings: [...STRICT, { kind: { unsafeFlags: { _0: ["-w"] } }, tool: "linker" }] }) }, expected: /target 'Config' sets `unsafeFlags`/ },
    { label: "a target with no row", setup: { extra: [{ name: "Rowless", type: "regular", settings: STRICT }] }, expected: /target 'Rowless' has no row/ },
    { label: "a macro with no row", setup: { extra: [{ name: "Macros", type: "macro", settings: STRICT }] }, expected: /target 'Macros' has no row/ },
    { label: "a plugin", setup: { extra: [{ name: "Plug", type: "plugin", settings: [] }] }, expected: /target 'Plug' is a plugin target/ },
    { label: "a binary target", setup: { extra: [{ name: "Blob", type: "binary", settings: [] }] }, expected: /target 'Blob' is a binary target/ },
    { label: "a package language mode of 5", setup: { modes: ["5"] }, expected: /`swiftLanguageModes` includes 5/ },
  ];
  for (const { label, setup, expected } of cases) {
    it(`reports ${label}`, () => {
      const problems = evaluatedProblems(dump(setup), LAYERS);
      assert.ok(problems.some((line) => expected.test(line)), `not reported: ${label}\n${problems.join("\n")}`);
    });
  }

  it("accepts a package language mode of 6", () => assert.deepEqual(evaluatedProblems(dump({ modes: ["6"] }), LAYERS), []));
});
