#!/usr/bin/env node
// The Swift pack's per-edit check: import boundaries, formatting, and the compiler, for an edited .swift file or pack config.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a .swift file, swift-layers.json, or .swift-format.
// Used by: scripts/check-edited.mjs, through stacks/swift/pack.json `editCheck` (`extensions`, `files`).
// Uses: stacks/swift/boundaries.mjs (no swift needed), then `swift format lint` and `swift build --build-tests` on PATH (via tool.mjs).
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. "Nothing printed" must never mean "not checked", so:
// a missing, too-old, or unanswering swift is said out loud (the boundary scan, which needs none,
// still runs); a tool that times out is killed with its whole process group and reported by name;
// a tool that dies or exits non-zero with no output is reported with its exit code. Tests are not
// run here (`pnpm check`, pre-push, and CI run them).
//
// What runs per file: a .swift file gets the boundary findings about it (or the layer map), format
// lint of that file, and a build. swift-layers.json gets every boundary finding (the map changed, so
// any file may now break it). .swift-format gets format lint of the whole package.
//
// Time: the core kills this at 80 s (PACK_TIMEOUT_MS) with SIGTERM. The version probe, format lint,
// and build each have a limit (HOOK_TIMEOUT_MS in tool.mjs) and the three sum to 75 s, so a slow
// tool is reported here by name first. If the core's signal comes anyway, the handler kills the
// running tool's process group, so no compiler is left holding SwiftPM's build lock.

// Node builtins only, plus this pack's own scripts.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { checkBoundaries } from "./boundaries.mjs";
import { HOOK_TIMEOUT_MS, killGroupsOnSignal, limit, MIN_SWIFT, run, swiftInfoAsync } from "./tool.mjs";

// Knob: lines kept; the agent needs the first findings, not all.
const MAX_LINES = 30;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it.
const file = process.argv[2] ?? "";

// No Package.swift: not a Swift package here (or the pack is half-removed); nothing to check against.
if (file === "" || !existsSync(join(root, "Package.swift"))) process.exit(0);

// The core's timeout (SIGTERM) or a Ctrl-C: kill the tool's process group, not just us.
killGroupsOnSignal();

// Which edit this is: the layer map, the formatter config, or Swift source.
const isLayerMap = file === "swift-layers.json";
const isFormatConfig = file === ".swift-format";

// Keeps the first MAX_LINES non-empty lines.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n") : lines.join("\n");
};

// Why a tool did not finish cleanly, or "" when it exited 0. `knob` names the limit to raise.
const failure = (name, result, ms, knob) => {
  if (result.error !== undefined) return `${name} could not run: ${result.error.message}`;
  if (result.timedOut) return `${name} timed out after ${String(ms / 1000)} s (killed with its process group; ${knob} in stacks/swift/tool.mjs)`;
  if (result.status === null) return `${name} was killed by ${result.signal}`;
  return result.status === 0 ? "" : `${name} exited ${result.status}`;
};

// Collected failures, one block per tool.
const failures = [];

// Import boundaries: needs no swift, so it always runs. Findings about this file, or about the layer map and Package.swift; all of them when the map itself changed.
try {
  const mine = checkBoundaries(root).filter((line) => isLayerMap || line.startsWith(`${file}:`) || !/^(Sources|Tests)\//.test(line));
  if (mine.length > 0) failures.push(`swift boundaries (docs/ports-and-adapters.md):\n${cap(mine.join("\n"))}`);
} catch (error) {
  failures.push(`swift boundaries could not run: ${error instanceof Error ? error.message : String(error)}`);
}

// The layer map needs nothing else; Swift source and the formatter config need the toolchain, said out loud when it can't run.
if (!isLayerMap) {
  const { state, version } = await swiftInfoAsync();
  if (state === "missing") {
    failures.push("swift not installed: Swift edits unchecked (formatting and compile errors were not looked for). Install Swift 6.2 (swift.org/install); CI checks them regardless.");
  } else if (state === "old") {
    failures.push(`${version.trim()} is older than ${MIN_SWIFT.join(".")}: Swift edits unchecked (Package.swift needs tools 6.2). Upgrade the toolchain; CI checks them regardless.`);
  } else if (state === "broken") {
    failures.push(`${version}: Swift edits unchecked. Fix the toolchain; CI checks them regardless.`);
  } else {
    // Format: this file only (a half-done multi-file edit doesn't drown the agent in other files' findings); the whole package when the rules changed.
    const formatArgs = isFormatConfig ? ["format", "lint", "--strict", "--recursive", "Sources", "Tests", "Package.swift"] : ["format", "lint", "--strict", file];
    const formatMs = limit(HOOK_TIMEOUT_MS.format);
    const format = await run("swift", formatArgs, { cwd: root, timeoutMs: formatMs });
    const formatWhy = failure("swift format lint", format, formatMs, "HOOK_TIMEOUT_MS.format");
    if (formatWhy !== "") failures.push(`swift format (fix with \`swift format -i ${isFormatConfig ? "--recursive Sources Tests Package.swift" : file}\`):\n${cap(format.output) || formatWhy}`);

    // Compiler: errors only (warnings are errors in this package, so they show as such). The whole package builds, because a layer violation is about two files.
    if (!isFormatConfig) {
      const buildMs = limit(HOOK_TIMEOUT_MS.build);
      const build = await run("swift", ["build", "--build-tests"], { cwd: root, timeoutMs: buildMs });
      const buildWhy = failure("swift build", build, buildMs, "HOOK_TIMEOUT_MS.build");
      if (buildWhy !== "") {
        const errors = build.output.split("\n").filter((line) => /error:/.test(line));
        failures.push(`swift build:\n${cap(errors.join("\n")) || `${buildWhy}\n${cap(build.output.split("\n").slice(-10).join("\n"))}`}`);
      }
    }
  }
}

// Print for the core to hand back; nothing printed means every check ran and was clean.
if (failures.length > 0) process.stdout.write(failures.join("\n\n"));
