// The Swift pack's check of the *evaluated* package: what `swift package dump-package` says each target is, not what Package.swift's text looks like.
// In the app: nothing at runtime; run.mjs (lint, test) and gates.mjs run it whenever swift is present.
// Used by: stacks/swift/run.mjs, stacks/swift/gates.mjs; tested by stacks/swift/manifest.test.mjs.
// Uses: `swift package dump-package` (via tool.mjs run()), swift-layers.json; STRICT from stacks/swift/boundaries.mjs.
//
// Package.swift is a program. boundaries.mjs reads its text, which needs no swift, but code beats a
// text scan: a path held in a variable, a target mutated after it is built, a settings array
// filtered to nothing. dump-package runs the manifest and prints the targets it produced, so the
// rules below hold however the manifest was written. The text scan stays for runs without swift.
//
// The rules, per evaluated target (swift.mdc says the same):
// - a library, executable, or macro target has a swift-layers.json row; a test target needs none;
//   any other kind (plugin, binary, system library) is refused, since no row can describe it;
// - `path` is unset or `<sources>/<Name>` (`Tests/<Name>` for a test target), and `sources` is unset;
// - its settings hold both strict settings, unconditionally;
// - none of its settings is `treatAllWarnings(as: .warning)`, `swiftLanguageMode`, or `unsafeFlags`;
// and the package sets no language mode other than 6.

// Node builtins only, plus this pack's own scripts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STRICT } from "./boundaries.mjs";
import { limit, run } from "./tool.mjs";

// Knob: how long `swift package dump-package` may take. It compiles and runs the manifest; a cold
// toolchain took a few seconds, so this names a hang rather than racing a slow machine.
export const DUMP_TIMEOUT_MS = 60_000;

// Target kinds that are code in a layer (need a row), and the test kind (needs none).
const LAYER_TYPES = new Set(["regular", "executable", "macro"]);

// STRICT's settings as dump-package prints them: { treatAllWarnings: "error" }, { enableUpcomingFeature: "ExistentialAny" }.
const STRICT_KINDS = STRICT.settings.map((setting) => {
  const [, name, value] = /^\.(\w+)\((?:as:\s*\.)?"?([\w]+)"?\)$/.exec(setting) ?? [];
  return { name, value, setting };
});

// The one argument a dumped setting carries (`{ kind: { name: { _0: value } } }`); `_0` is SwiftPM's key for an unlabeled argument.
const settingKind = (setting) => {
  const [name] = Object.keys(setting.kind ?? {});
  return { name, value: setting.kind?.[name]?.["_0"] };
};

// Problems in a dump-package JSON, as readable lines ending in the fix; [] when clean.
export const evaluatedProblems = (dump, layers, sources = "Sources") => {
  const problems = [];
  for (const target of dump.targets ?? []) {
    const where = `Package.swift (evaluated): target '${target.name}'`;
    const isTest = target.type === "test";
    if (!isTest && !LAYER_TYPES.has(target.type)) {
      problems.push(`${where} is a ${target.type} target: the boundary check has no row for one, so it can't be checked; remove it (swift.mdc).`);
      continue;
    }
    if (!isTest && !(target.name in layers)) problems.push(`${where} has no row in swift-layers.json: add one, or its imports are unchecked.`);
    const home = isTest ? `Tests/${target.name}` : `${sources}/${target.name}`;
    if (target.path != null && target.path.replace(/\/+$/, "") !== home) problems.push(`${where} has path "${target.path}": the boundary check reads ${home} only, so move the sources there and drop \`path:\`.`);
    if (target.sources != null) problems.push(`${where} sets \`sources:\` (${JSON.stringify(target.sources)}): it can compile files the boundary check never reads; drop it.`);
    const settings = (target.settings ?? []).map((setting) => ({ ...settingKind(setting), condition: setting.condition }));
    for (const { name, value, setting } of STRICT_KINDS) {
      if (!settings.some((found) => found.name === name && found.value === value && found.condition == null)) problems.push(`${where} lacks \`${setting}\` (unconditionally): every target takes \`swiftSettings: ${STRICT.name}\` as is (swift.mdc).`);
    }
    for (const { name, value } of settings) {
      if (name === "treatAllWarnings" && value !== "error") problems.push(`${where} sets \`.treatAllWarnings(as: .${value})\`: warnings stay errors (swift.mdc).`);
      if (name === "swiftLanguageMode") problems.push(`${where} sets \`.swiftLanguageMode(.v${value})\`: every target builds in language mode 6, strict concurrency included (swift.mdc).`);
      if (name === "unsafeFlags") problems.push(`${where} sets \`unsafeFlags\`: raw compiler flags can turn off any check here; use a SwiftSetting.`);
    }
  }
  for (const mode of dump.swiftLanguageVersions ?? []) {
    if (mode !== "6") problems.push(`Package.swift (evaluated): \`swiftLanguageModes\` includes ${mode}: the package builds in language mode 6 (swift.mdc).`);
  }
  return problems;
};

// Runs dump-package in `root` and checks it against root's swift-layers.json. Resolves to the problems; [] when clean.
// Needs swift (the caller has checked); a manifest that doesn't evaluate, or a hang, is a problem, never a pass.
export const checkEvaluatedManifest = async (root) => {
  if (!existsSync(join(root, "swift-layers.json"))) return ["swift-layers.json is missing: it lists what each target may import (docs/ports-and-adapters.md)."];
  let config;
  try {
    config = JSON.parse(readFileSync(join(root, "swift-layers.json"), "utf8"));
  } catch (error) {
    return [`swift-layers.json is not valid JSON: ${error.message}`];
  }
  const timeoutMs = limit(DUMP_TIMEOUT_MS);
  const result = await run("swift", ["package", "dump-package"], { cwd: root, timeoutMs });
  if (result.error !== undefined) return [`\`swift package dump-package\` could not run: ${result.error.message}`];
  if (result.timedOut) return [`\`swift package dump-package\` timed out after ${String(timeoutMs / 1000)} s and was killed (DUMP_TIMEOUT_MS in stacks/swift/manifest.mjs).`];
  if (result.status !== 0) return [`\`swift package dump-package\` failed (${result.status === null ? `killed by ${result.signal}` : `exit ${result.status}`}), so the package can't be checked:\n${result.output.trim()}`];
  // The JSON is stdout alone; a warning on stderr is not part of it.
  let dump;
  try {
    dump = JSON.parse(result.stdout);
  } catch (error) {
    return [`\`swift package dump-package\` printed no package JSON (${error.message}):\n${result.output.trim().slice(0, 500)}`];
  }
  return evaluatedProblems(dump, config.layers ?? {}, config.sources ?? "Sources");
};
