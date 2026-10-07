#!/usr/bin/env node
// Proves the Swift pack's gates still bite: plants a violation of each rule on a scratch copy and fails unless it is reported.
// In the app: nothing at runtime; `pnpm swift:gates`, one of the Swift pack's checks (pnpm check, CI).
// Used by: stacks/swift/pack.json `checks` (script `swift:gates`).
// Uses: stacks/swift/boundaries.mjs, stacks/swift/manifest.mjs, stacks/swift/run.mjs, stacks/swift/tool.mjs; Package.swift, swift-layers.json, .swift-format, Sources/, Tests/.
//
// Why this exists: a layer map that names the wrong directory, a rule that stops matching, or a
// test run that executes nothing all say "ok". So the gate is tested, not trusted. The probes are
// derived from the project's own swift-layers.json and Package.swift (so a renamed layer is probed
// under its new name), each planted in its own scratch copy, and each must be reported by name.
// Every rule in boundaries.mjs and manifest.mjs has a probe here. The swift-dependent probes (a
// Package.swift that escapes a rule through code, a badly formatted file, a force unwrap, a test
// target with no tests, a test hidden by `#if false`) skip loudly without swift, and fail under CI.
// Nothing is written to the real tree.

// Node builtins only, plus this pack's own scripts.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkBoundaries, faultKinds, packageTargets, STRICT } from "./boundaries.mjs";
import { checkEvaluatedManifest } from "./manifest.mjs";
import { killGroupsOnSignal, limit, requireSwift, run } from "./tool.mjs";

// Knob: how long each swift-dependent probe may run. The zero-tests probe builds a tiny package from cold;
// the hidden-test probe rebuilds it after one file changes. (A manifest probe's limit is manifest.mjs DUMP_TIMEOUT_MS.)
const PROBE_TIMEOUT_MS = { format: 60_000, zeroTests: 300_000, hiddenTest: 300_000 };

// Knob: how many manifest probes (one `swift package dump-package` each, in its own copy) run at
// once. Each is mostly a cold manifest compile, so a few side by side cut the wall time without
// starving a 2-4 core CI runner.
const MANIFEST_PROBE_CONCURRENCY = 4;

// The project root is the working directory the core (or you) runs this in.
const root = process.cwd();

// Told to stop: take any swift we started with us.
killGroupsOnSignal();

// Stops with a message; a failed gate is never a quiet exit.
const fail = (message) => {
  process.stderr.write(`swift gates: ${message}\n`);
  process.exit(1);
};

// A scratch copy of the package seed: `remove` drops copied files, `edit` ({ path: (text) => text }) rewrites one, then `plant` ({ path: content }) writes files.
const scratchCopy = ({ plant = {}, edit = {}, remove = [] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "swift-gates-"));
  for (const name of ["Package.swift", "swift-layers.json", ".swift-format", "Sources", "Tests"]) {
    // .swift-format is optional; anything else missing is the project's problem and the clean check below says so.
    if (name === ".swift-format" && !existsSync(join(root, name))) continue;
    cpSync(join(root, name), join(dir, name), { recursive: true });
  }
  for (const path of remove) rmSync(join(dir, path));
  for (const [path, change] of Object.entries(edit)) {
    const before = readFileSync(join(dir, path), "utf8");
    const after = change(before);
    // A probe whose edit found nothing to change proves nothing: say so instead of passing.
    if (after === before) fail(`a probe could not be planted in ${path} (the text it edits is not there); update gates.mjs with the file.`);
    writeFileSync(join(dir, path), after);
  }
  for (const [path, content] of Object.entries(plant)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

// The clean tree must pass first, or "reported" below means nothing.
const clean = checkBoundaries(root);
if (clean.length > 0) fail(`the real tree is not clean, so the probes can't be judged:\n${clean.map((line) => `  ${line}`).join("\n")}`);

const config = JSON.parse(readFileSync(join(root, "swift-layers.json"), "utf8"));
const sources = config.sources ?? "Sources";
const layers = config.layers;
const layerNames = Object.keys(layers);
const [firstLayer] = layerNames;
const testTarget = packageTargets(readFileSync(join(root, "Package.swift"), "utf8")).find((target) => target.kind === "testTarget")?.name ?? "NoteSyncTests";

// A swift-layers.json edit: `change` gets the parsed map and mutates it.
const layerMap = (change) => (text) => {
  const map = JSON.parse(text);
  change(map);
  return `${JSON.stringify(map, null, 2)}\n`;
};

// A string as a literal piece of a RegExp.
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Adds `entry` as the first item of Package.swift's `targets: [` list.
const addTarget = (entry) => (text) => text.replace(/(\btargets:\s*\[)/, `$1\n        ${entry},`);

// A scratch-copy setup that appends Swift after `let package = ...`: it runs on the built package, so no target's text changes.
const after = (swift) => ({ edit: { "Package.swift": (text) => `${text}\n${swift}\n` } });

// Each probe: a scratch copy (`plant` / `edit`) and the findings that must come back, matched by `test`.
const probes = [];
const probe = (proves, setup, test) => probes.push({ proves, setup, test });

// Imports: every module a layer's row does not allow, one file each, all in one copy.
const everyModule = [...new Set([...layerNames, "Foundation", "ZzGateThirdParty"])];
const importPlant = {};
const importExpect = [];
for (const [layer, allowed] of Object.entries(layers)) {
  for (const module of everyModule) {
    if (module === layer || allowed.includes(module)) continue;
    const file = `${sources}/${layer}/ZzGate${module}.swift`;
    importPlant[file] = `import ${module}\n`;
    importExpect.push({ proves: `${layer} may not import ${module}`, test: (line) => line.startsWith(`${file}:1:`) && line.includes(`${layer} imports '${module}'`) });
  }
}

// The layer map's own rules: a typo anywhere in it must not leave a rule matching nothing, and no map is not "nothing to check".
probe("no swift-layers.json", { remove: ["swift-layers.json"] }, (line) => line.includes("swift-layers.json is missing"));
probe("a swift-layers.json that is not JSON", { edit: { "swift-layers.json": (text) => `${text}}` } }, (line) => line.includes("swift-layers.json is not valid JSON"));
probe("a swift-layers.json with no layers", { edit: { "swift-layers.json": layerMap((map) => (map.layers = {})) } }, (line) => line.includes("has no layers"));
probe("no Package.swift", { remove: ["Package.swift"] }, (line) => line === "Package.swift is missing.");
probe("a target directory with no row", { plant: { [`${sources}/ZzGateUnlisted/Zz.swift`]: "// a target nobody listed\n" } }, (line) => line.includes("ZzGateUnlisted is a target with no row"));
probe("a row with no directory", { edit: { "swift-layers.json": layerMap((map) => (map.layers.ZzGateNoDir = [])) } }, (line) => line.includes("row 'ZzGateNoDir' matches no Swift files"));
probe(
  "a row with no Package.swift target",
  { edit: { "swift-layers.json": layerMap((map) => (map.layers.ZzGateNoTarget = [])) }, plant: { [`${sources}/ZzGateNoTarget/Zz.swift`]: "// no target\n" } },
  (line) => line.includes("row 'ZzGateNoTarget' is not a target in Package.swift"),
);
probe("an allowed module that is a typo", { edit: { "swift-layers.json": layerMap((map) => map.layers[firstLayer].push("ZzGateTypo")) } }, (line) => line.includes("allows 'ZzGateTypo'"));
probe("a noDefaultIn layer that does not exist", { edit: { "swift-layers.json": layerMap((map) => (map.noDefaultIn = [...(map.noDefaultIn ?? []), "ZzGateNoLayer"])) } }, (line) => line.includes("noDefaultIn names 'ZzGateNoLayer'"));
for (const layer of config.noDefaultIn ?? []) {
  const file = `${sources}/${layer}/ZzGateDefault.swift`;
  probe(`${layer}: a switch may not use default:`, { plant: { [file]: "func zzGate(value: Int) -> Int {\n    switch value {\n    case 1: return 1\n    default: return 0\n    }\n}\n" } }, (line) => line.startsWith(`${file}:4:`));
}
probe("@_extern, a call past the import rules", { plant: { [`${sources}/${firstLayer}/ZzGateExtern.swift`]: '@_extern(c, "zz_gate")\nfunc zzGate()\n' } }, (line) => line.includes("ZzGateExtern.swift:1:") && line.includes("@_extern"));
probe("@_silgen_name, a call past the import rules", { plant: { [`${sources}/${firstLayer}/ZzGateSilgen.swift`]: '@_silgen_name("zz_gate")\nfunc zzGate()\n' } }, (line) => line.includes("ZzGateSilgen.swift:1:") && line.includes("@_silgen_name"));

// Package.swift: every way a target escapes the scan or the strict settings.
probe("a target with no row", { edit: { "Package.swift": addTarget(`.target(name: "ZzGateNoRow", swiftSettings: ${STRICT.name})`) } }, (line) => line.includes("target 'ZzGateNoRow' has no row"));
probe("a target path outside Sources/<Name>", { edit: { "Package.swift": addTarget(`.target(name: "${firstLayer}", path: "Elsewhere/ZzGate", swiftSettings: ${STRICT.name})`) } }, (line) => line.includes('path: "Elsewhere/ZzGate"'));
probe("a target without the strict settings", { edit: { "Package.swift": addTarget(`.target(name: "${firstLayer}")`) } }, (line) => line.includes(`target '${firstLayer}' does not take \`swiftSettings: ${STRICT.name}\``));
for (const setting of STRICT.settings) {
  probe(`the strict settings without ${setting}`, { edit: { "Package.swift": (text) => text.replace(new RegExp(`${literal(setting).replace(/ /g, "\\s*")},?`), "") } }, (line) => line.includes(`lacks \`${setting}\``));
}
probe("unsafeFlags", { edit: { "Package.swift": addTarget(`.target(name: "${firstLayer}", swiftSettings: ${STRICT.name} + [.unsafeFlags(["-Onone"])])`) } }, (line) => line.includes("`unsafeFlags`"));
// Appended after the package, on lines no comment precedes, inline in an array: every position the rule must see.
const floating = '\nlet zzGateMarker = 0\nlet zzGatePackages: [Package.Dependency] = [.package(url: "https://example.invalid/zz.git", from: "1.0.0")]\n';
probe("a package not pinned with exact:", { edit: { "Package.swift": (text) => `${text}${floating}` } }, (line) => line.includes("not pinned with `exact:`"));
probe("a package with no comment above it", { edit: { "Package.swift": (text) => `${text}${floating.replace("from:", "exact:")}` } }, (line) => line.includes("no comment on the line above"));

// Tests: switched off, or a fault kind nobody plays.
probe("a test may not be .disabled", { plant: { [`Tests/${testTarget}/ZzGateDisabled.swift`]: 'import Testing\n@Test(.disabled ("gate")) func zzGate() {}\n' } }, (line) => line.includes("ZzGateDisabled.swift") && line.includes(".disabled("));
probe("a test may not be .enabled(if:)", { plant: { [`Tests/${testTarget}/ZzGateEnabled.swift`]: "import Testing\n@Test(.enabled(if: false)) func zzGate() {}\n" } }, (line) => line.includes("ZzGateEnabled.swift") && line.includes(".enabled("));
const faults = faultKinds(root);
if (faults !== undefined) {
  probe("a FaultKind case no test plays", { edit: { [faults.file]: (text) => text.replace(/(enum FaultKind\b[^{]*\{)/, "$1\n    case zzGateKind") } }, (line) => line.includes("FaultKind.zzGateKind has no test"));
}

// Plant each probe in its own copy, so one finding can't mask another's rule.
const missed = [];
let planted = importExpect.length;
const importScratch = scratchCopy({ plant: importPlant });
try {
  const reported = checkBoundaries(importScratch);
  missed.push(...importExpect.filter(({ test }) => !reported.some(test)).map(({ proves }) => proves));
} finally {
  rmSync(importScratch, { recursive: true, force: true });
}
for (const { proves, setup, test } of probes) {
  planted += 1;
  const scratch = scratchCopy(setup);
  try {
    if (!checkBoundaries(scratch).some(test)) missed.push(proves);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (missed.length > 0) {
  process.stderr.write(`swift gates: ${missed.length} of ${planted} boundary probes were not reported. A rule that says nothing here would say nothing about real code.\n`);
  for (const proves of missed) process.stderr.write(`  ✗ ${proves}\n`);
  process.exit(1);
}
process.stdout.write(`swift gates: all ${planted} planted boundary violations were reported.\n`);

// The probes that need swift itself.
if (requireSwift("the evaluated-manifest, format, zero-tests, and hidden-test gates")) {
  const here = dirname(fileURLToPath(import.meta.url));

  // Package.swift is code: each probe escapes a rule in a way the text scan can't see (a variable,
  // a mutation after the package is built), and the evaluated check (manifest.mjs) must report it.
  const cleanDump = await checkEvaluatedManifest(root);
  if (cleanDump.length > 0) fail(`the real package, as evaluated, is not clean, so the manifest probes can't be judged:\n${cleanDump.map((line) => `  ${line}`).join("\n")}`);
  const where = `'${firstLayer}'`;
  const onFirst = (swift) => after(`for target in package.targets where target.name == "${firstLayer}" { ${swift} }`);
  const manifestProbes = [
    {
      proves: "a target path held in a variable",
      // In the package's own `targets:` list (the one starting a line, not a product's), as a target written there would be.
      setup: { edit: { "Package.swift": (text) => text.replace(/^let package\b/m, 'let zzGatePath = "Elsewhere/ZzGate"\nlet package').replace(/^(\s*targets:\s*\[)/m, `$1\n        .target(name: "ZzGateVar", path: zzGatePath, swiftSettings: ${STRICT.name}),`) } },
      expect: (line) => line.includes("target 'ZzGateVar' has path \"Elsewhere/ZzGate\""),
    },
    { proves: "a target path set after construction", setup: onFirst('target.path = "Elsewhere/ZzGate"'), expect: (line) => line.includes(`target ${where} has path "Elsewhere/ZzGate"`) },
    { proves: "a test target path set after construction", setup: after('for target in package.targets where target.type == .test { target.path = "Elsewhere/ZzGateTests" }'), expect: (line) => line.includes(`target '${testTarget}' has path "Elsewhere/ZzGateTests"`) },
    { proves: "sources: outside the target directory", setup: onFirst('target.sources = ["../ZzGate"]'), expect: (line) => line.includes(`target ${where} sets \`sources:\``) },
    { proves: "swiftSettings filtered to nothing", setup: onFirst(`target.swiftSettings = ${STRICT.name}.filter { _ in false }`), expect: (line) => line.includes(`target ${where} lacks`) },
    { proves: "a strict setting made conditional", setup: onFirst('target.swiftSettings = [.treatAllWarnings(as: .error, .when(platforms: [.windows])), .enableUpcomingFeature("ExistentialAny")]'), expect: (line) => line.includes(`target ${where} lacks \`.treatAllWarnings(as: .error)\``) },
    { proves: "treatAllWarnings(as: .warning) after the strict settings", setup: onFirst(`target.swiftSettings = ${STRICT.name} + [.treatAllWarnings(as: .warning)]`), expect: (line) => line.includes(`target ${where} sets \`.treatAllWarnings(as: .warning)\``) },
    { proves: "swiftLanguageMode(.v5) on a target", setup: onFirst(`target.swiftSettings = ${STRICT.name} + [.swiftLanguageMode(.v5)]`), expect: (line) => line.includes(`target ${where} sets \`.swiftLanguageMode(.v5)\``) },
    { proves: "unsafeFlags added after construction", setup: onFirst(`target.swiftSettings = ${STRICT.name} + [.unsafeFlags(["-Onone"])]`), expect: (line) => line.includes(`target ${where} sets \`unsafeFlags\``) },
    { proves: "a package language mode other than 6", setup: after("package.swiftLanguageModes = [.v5]"), expect: (line) => line.includes("`swiftLanguageModes` includes 5") },
    { proves: "a target whose name is computed, with no row", setup: after(`package.targets.append(.target(name: "ZzGate" + "Computed", swiftSettings: ${STRICT.name}))`), expect: (line) => line.includes("target 'ZzGateComputed' has no row") },
    { proves: "a plugin target", setup: after('package.targets.append(.plugin(name: "ZzGatePlugin", capability: .buildTool()))'), expect: (line) => line.includes("target 'ZzGatePlugin' is a plugin target") },
  ];
  // Every copy is planted before any swift starts, so a probe that can't be planted (fail() exits)
  // never leaves a running dump-package behind. Then MANIFEST_PROBE_CONCURRENCY run at once, and
  // every one has finished (its process group gone, via run()) before a miss is reported.
  const scratches = manifestProbes.map(({ setup }) => scratchCopy(setup));
  const misses = [];
  try {
    let next = 0;
    const worker = async () => {
      while (next < manifestProbes.length) {
        const index = next++;
        const { proves, expect } = manifestProbes[index];
        const reported = await checkEvaluatedManifest(scratches[index]);
        if (!reported.some(expect)) misses.push(`${proves} was not reported by the evaluated-manifest check:\n${reported.join("\n") || "(nothing reported)"}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MANIFEST_PROBE_CONCURRENCY, manifestProbes.length) }, worker));
  } finally {
    for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
  }
  if (misses.length > 0) fail(misses.join("\n"));
  process.stdout.write(`swift gates: all ${manifestProbes.length} Package.swift escapes through code were reported.\n`);

  // A badly formatted file, and a force unwrap (a lint rule, not layout), must each fail `swift format lint --strict`, or the lint step lints nothing.
  const formatProbes = [
    { proves: "a badly formatted file", file: `${sources}/${firstLayer}/ZzGateFormat.swift`, content: "public   let   zzGate=1\n", expect: /ZzGateFormat\.swift/ },
    { proves: "a force unwrap (NeverForceUnwrap)", file: `${sources}/${firstLayer}/ZzGateUnwrap.swift`, content: "let zzGateOptional: Int? = 1\nlet zzGate = zzGateOptional!\n", expect: /NeverForceUnwrap/ },
  ];
  for (const { proves, file, content, expect } of formatProbes) {
    const formatDir = scratchCopy({ plant: { [file]: content } });
    try {
      const lint = await run("swift", ["format", "lint", "--strict", file], { cwd: formatDir, timeoutMs: limit(PROBE_TIMEOUT_MS.format) });
      if (lint.timedOut) fail(`the format probe for ${proves} timed out (PROBE_TIMEOUT_MS.format in gates.mjs).`);
      if (lint.status === 0 || lint.status === null || !expect.test(lint.output)) fail(`${proves} passed \`swift format lint --strict\`, so the lint step would pass it:\n${lint.output}`);
      process.stdout.write(`swift gates: ${proves} was reported.\n`);
    } finally {
      rmSync(formatDir, { recursive: true, force: true });
    }
  }

  // A package whose test target holds no tests must fail run.mjs test, though plain `swift test` exits 0 on it.
  // The package keeps every rule (a row, the strict settings), so run.mjs's manifest check passes it and the count is what fails.
  const empty = mkdtempSync(join(tmpdir(), "swift-gates-empty-"));
  try {
    const files = {
      "Package.swift": `// swift-tools-version: 6.2\nimport PackageDescription\nlet ${STRICT.name}: [SwiftSetting] = [${STRICT.settings.join(", ")}]\nlet package = Package(name: "Empty", targets: [.target(name: "Lib", swiftSettings: ${STRICT.name}), .testTarget(name: "LibTests", dependencies: ["Lib"], swiftSettings: ${STRICT.name})])\n`,
      "swift-layers.json": '{ "layers": { "Lib": [] } }\n',
      "Sources/Lib/Lib.swift": "public let zzGate = 1\n",
      "Tests/LibTests/Empty.swift": "import Testing\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(empty, path)), { recursive: true });
      writeFileSync(join(empty, path), content);
    }
    // Through run(), so a hang kills run.mjs's process group and run.mjs kills swift's (killGroupsOnSignal there).
    const result = await run(process.execPath, [join(here, "run.mjs"), "test"], { cwd: empty, timeoutMs: limit(PROBE_TIMEOUT_MS.zeroTests) });
    if (result.timedOut) fail("the zero-tests probe timed out (PROBE_TIMEOUT_MS.zeroTests in gates.mjs).");
    if (result.status === 0) fail("a test target with no tests passed `run.mjs test`: a green run that executed nothing would pass.");
    if (!/zero tests executed/.test(result.output)) fail(`a test target with no tests failed for the wrong reason:\n${result.output}`);
    process.stdout.write("swift gates: a run that executed zero tests was reported.\n");

    // Same package, one test that runs and one behind `#if false`: a green run with a test compiled away must fail, naming it.
    writeFileSync(join(empty, "Tests/LibTests/Empty.swift"), "import Testing\n\n@Test func zzGateRuns() {}\n\n#if false\n@Test func zzGateHidden() {}\n#endif\n");
    const hidden = await run(process.execPath, [join(here, "run.mjs"), "test"], { cwd: empty, timeoutMs: limit(PROBE_TIMEOUT_MS.hiddenTest) });
    if (hidden.timedOut) fail("the hidden-test probe timed out (PROBE_TIMEOUT_MS.hiddenTest in gates.mjs).");
    if (hidden.status === 0) fail("a test behind `#if false` passed `run.mjs test`: a compiled-away test would pass unnoticed.");
    if (!/did not run.*zzGateHidden\(\)/.test(hidden.output) || /zzGateRuns\(\)/.test(hidden.output.split("did not run")[1] ?? "")) fail(`a test behind \`#if false\` failed for the wrong reason:\n${hidden.output}`);
    process.stdout.write("swift gates: a test hidden by #if false was reported.\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}
