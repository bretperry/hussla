#!/usr/bin/env node
// The C++ pack's per-edit check: source rules, format, the build, the layer checks, and clang-tidy, for an edited C++ file or pack config.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a C++ file, CMakeLists.txt, CMakePresets.json, cpp-layers.json, or a clang config.
// Used by: scripts/check-edited.mjs, through stacks/cpp/pack.json `editCheck` (`extensions`, `names`, `files`).
// Uses: stacks/cpp/sources.mjs (no tools needed), then cmake, ninja, clang++, nm, clang-format, clang-tidy on PATH (via tool.mjs, evaluated.mjs, run.mjs).
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. "Nothing printed" must never mean "not checked", so a
// missing or too-old tool is said out loud (the source rules, which need none, still run); a tool
// that times out is killed with its whole process group and reported by name. Tests are not run
// here (`pnpm check`, pre-push, and CI run them).
//
// What runs per edit:
// - a C++ file: its source rules, clang-format on it, the asan tree built (incrementally), what each
//   layer includes and calls, then clang-tidy on it (on a header: on one unit that includes it).
// - CMakeLists.txt, CMakePresets.json, cpp-layers.json: the map and presets, a configure, and the
//   configured checks (flags, links, include paths, rows).
// - a .clang-tidy: the tidy floor. .clang-format: format over every file.
//
// Time: the core kills this at 80 s (PACK_TIMEOUT_MS) with SIGTERM. Each step has a limit
// (HOOK_TIMEOUT_MS) and the slowest path (format, build, tidy) sums to 75 s, so a slow tool is
// reported here by name first; if the signal comes anyway, every tool's process group goes with us.

// Node builtins only, plus this pack's own scripts.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { buildDir, checkConfigured, checkIncludes, checkPresets, checkSymbols, configure, parseDeps, readModel } from "./evaluated.mjs";
import { formatFiles, tidyFiles, tidyFloor, unitsOf } from "./run.mjs";
import { checkFile, checkLayerMap, CPP_EXTENSIONS, cppFiles } from "./sources.mjs";
import { failure, killGroupsOnSignal, run, toolInfo } from "./tool.mjs";

// Knob: each step's limit; format + build + tidy must stay under the core's 80 s (PACK_TIMEOUT_MS).
export const HOOK_TIMEOUT_MS = { format: 10_000, configure: 40_000, build: 40_000, tidy: 25_000 };

// Knob: lines kept; the agent needs the first findings, not all.
const MAX_LINES = 30;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it.
const file = process.argv[2] ?? "";

// No CMakeLists.txt: not a C++ project here (or the pack is half-removed); nothing to check against.
if (file === "" || !existsSync(join(root, "CMakeLists.txt"))) process.exit(0);

// The core's timeout (SIGTERM) or a Ctrl-C: kill every tool's process group, not just us.
killGroupsOnSignal();

// Keeps the first MAX_LINES non-empty lines.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${String(lines.length - MAX_LINES)} more lines`].join("\n") : lines.join("\n");
};

// Collected failures, one block per step.
const failures = [];
const add = (heading, lines) => {
  if (lines.length > 0) failures.push(`${heading}:\n${cap(lines.join("\n"))}`);
};

const isSource = CPP_EXTENSIONS.some((extension) => file.endsWith(extension)) && existsSync(join(root, file));
const isBuildConfig = ["CMakeLists.txt", "CMakePresets.json", "cpp-layers.json"].includes(file);
const isTidyConfig = basename(file) === ".clang-tidy";
const isFormatConfig = file === ".clang-format";

// Source rules and the layer map: need no tools, so they always run.
try {
  add("cpp sources (cpp.mdc)", [...checkLayerMap(root), ...(isSource ? checkFile(root, file) : []), ...(isBuildConfig ? checkPresets(root) : [])]);
} catch (error) {
  failures.push(`cpp sources could not run: ${error instanceof Error ? error.message : String(error)}`);
}

// The tools this edit needs, said out loud when one can't run.
const needed = isFormatConfig ? ["clang-format"] : isTidyConfig ? ["cmake", "clang-tidy"] : isBuildConfig ? ["cmake", "ninja", "clang++"] : ["cmake", "ninja", "clang++", "nm", "clang-format", "clang-tidy"];
const unusable = needed.map((name) => ({ name, ...toolInfo(name) })).filter((info) => info.state !== "ok");
if (unusable.length > 0) {
  failures.push(`C++ edits unchecked (${unusable.map((info) => `${info.name}: ${info.state === "missing" ? "not installed" : info.version || info.state}`).join("; ")}): format, build, layer, and tidy checks were not run. Install the toolchain (cpp.mdc → Tools); CI checks them regardless.`);
} else {
  // Configured once (cold, it downloads GoogleTest); a build-config edit always reconfigures.
  const configuredAlready = existsSync(join(root, buildDir("asan"), "CMakeCache.txt"));
  let configured = true;
  if (!isFormatConfig && (isBuildConfig || !configuredAlready)) {
    const result = await configure(root, "asan");
    const why = failure("cmake --preset asan", result, HOOK_TIMEOUT_MS.configure, "HOOK_TIMEOUT_MS.configure in stacks/cpp/check-edited.mjs");
    if (why !== "") {
      configured = false;
      add("cpp configure", [why, ...result.output.split("\n").filter((line) => /Error|error/.test(line))]);
    }
  }
  if (isFormatConfig) {
    const problem = await formatFiles(root, cppFiles(root));
    if (problem !== "") add("cpp format", [problem]);
  } else if (isTidyConfig && configured) {
    add("cpp clang-tidy floor", await tidyFloor(root));
  } else if (isBuildConfig && configured) {
    const model = readModel(root, "asan");
    add("cpp configured (File API)", model === undefined ? ["CMake wrote no File API reply."] : checkConfigured(root, "asan", model));
  } else if (isSource && configured) {
    const problem = await formatFiles(root, [file]);
    if (problem !== "") add(`cpp format (fix with \`clang-format -i ${file}\`)`, [problem]);
    const built = await run("cmake", ["--build", buildDir("asan")], { cwd: root, timeoutMs: HOOK_TIMEOUT_MS.build });
    const why = failure("cmake --build", built, HOOK_TIMEOUT_MS.build, "HOOK_TIMEOUT_MS.build in stacks/cpp/check-edited.mjs");
    if (why !== "") {
      const errors = built.output.split("\n").filter((line) => /error:/.test(line));
      add("cpp build", errors.length > 0 ? errors : [why, built.output.split("\n").slice(-10).join("\n")]);
    } else {
      const model = readModel(root, "asan");
      if (model !== undefined) add("cpp layers (docs/ports-and-adapters.md)", [...(await checkIncludes(root, "asan", model)), ...(await checkSymbols(root, "asan", model))]);
      // Tidy this unit, or for a header one unit that includes it (the asan tree's include record says which).
      const units = unitsOf(root, "asan");
      let unit = units.find((candidate) => candidate.file === file);
      if (unit === undefined) {
        const deps = await run("ninja", ["-C", buildDir("asan"), "-t", "deps"], { cwd: root, timeoutMs: 10_000 });
        const including = [...parseDeps(deps.stdout).entries()].find(([, headers]) => headers.includes(join(root, file)))?.[0];
        unit = units.find((candidate) => including?.endsWith(`/${candidate.file}.o`) === true);
      }
      if (unit === undefined) add("cpp clang-tidy", [`${file} is in no compile unit, so clang-tidy did not look at it: list it in a target in CMakeLists.txt (or include it from one).`]);
      else {
        const [result] = await tidyFiles(root, [unit], { cache: true, timeoutMs: HOOK_TIMEOUT_MS.tidy });
        if (result.problem !== "") add(`cpp clang-tidy (fix it, or \`// NOLINT(<check>): <why>\`)${unit.file === file ? "" : ` via ${unit.file}`}`, [result.problem]);
      }
    }
  }
}

// Print for the core to hand back; nothing printed means every check ran and was clean.
if (failures.length > 0) process.stdout.write(failures.join("\n\n"));
