#!/usr/bin/env node
// The TypeScript pack's per-edit check: typecheck, type-aware lint, and import boundaries for one file.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a file this pack claims.
// Used by: scripts/check-edited.mjs, through stacks/typescript/pack.json `editCheck`.
// Uses: tsc, oxlint, depcruise from node_modules/.bin (silent until `pnpm install`).
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. tsc checks the whole project (types cross files) but
// only this file's errors are printed, so a half-done multi-file refactor doesn't drown the agent
// in errors it is about to fix. Output is capped per tool: the agent needs the first errors, not all.

// Node builtins only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Lines kept per tool.
const MAX_LINES_PER_TOOL = 30;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it.
const file = process.argv[2] ?? "";

// Before `pnpm install` there are no tools to run; say nothing rather than fail every edit.
const bin = (name) => join(root, "node_modules", ".bin", name);
if (file === "" || !existsSync(bin("tsc"))) process.exit(0);

// Knob: per-tool timeouts. Their sum (75 s) stays under the core's 80 s per-pack limit, so a slow
// tool is reported here by name instead of the whole pack timing out.
const TIMEOUT_MS = { tsc: 40_000, oxlint: 20_000, depcruise: 15_000 };

// Runs one tool from the project root; returns its combined output, or "" when it passed.
const run = (name, args) => {
  const result = spawnSync(bin(name), args, { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS[name] });
  // Killed by the timeout: say so, since there is no output to show.
  if (result.signal !== null) return `${name} timed out after ${TIMEOUT_MS[name] / 1000} s`;
  return result.status === 0 ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

// Trims a tool's output to what the agent can act on.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const kept = lines.slice(0, MAX_LINES_PER_TOOL);
  return lines.length > kept.length ? [...kept, `… ${lines.length - kept.length} more lines`].join("\n") : kept.join("\n");
};

// Collected failures, one block per tool.
const failures = [];

// Types: whole project, this file's errors only (lines start with its path); a timeout is kept whole.
const tscOutput = run("tsc", ["--noEmit", "--pretty", "false"]);
const typeErrors = tscOutput.startsWith("tsc timed out")
  ? tscOutput
  : tscOutput
      .split("\n")
      .filter((line) => line.startsWith(file))
      .join("\n");
if (typeErrors !== "") failures.push(`tsc:\n${cap(typeErrors)}`);

// Lint, type-aware, this file only.
const lintOutput = run("oxlint", ["--type-aware", "--deny-warnings", file]);
if (lintOutput !== "") failures.push(`oxlint:\n${cap(lintOutput)}`);

// Import boundaries for this file, when the config exists and the file is in a cruised tree.
if (existsSync(join(root, ".dependency-cruiser.cjs")) && /^(src|scripts)\//.test(file)) {
  // Drop dependency-cruiser's TypeScript 7 notice (see .dependency-cruiser.cjs); it is not a finding.
  const boundaryOutput = run("depcruise", [file, "--config", ".dependency-cruiser.cjs", "--output-type", "err-long"])
    .split(/\n(?=‼ missing-typescript-transpiler)/)[0] ?? "";
  if (boundaryOutput !== "") failures.push(`dependency-cruiser (docs/ports-and-adapters.md):\n${cap(boundaryOutput)}`);
}

// Print for the core to hand back; nothing printed means clean.
if (failures.length > 0) process.stdout.write(failures.join("\n\n"));
