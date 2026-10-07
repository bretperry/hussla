#!/usr/bin/env node
// The Python pack's per-edit check: ruff lint + format, pyright strict, and import contracts for one file.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a file this pack claims.
// Used by: scripts/check-edited.mjs, through stacks/python/pack.json `editCheck`.
// Uses: ruff, pyright, lint-imports from .venv/bin (silent until `uv sync`).
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. Fast enough for a hook (about 1.5 s for all four
// commands on the seed), so every one runs on every edit. Pyright
// checks only the edited file but resolves its imports, so a half-done multi-file refactor doesn't
// drown the agent in errors from files it is about to fix. Output is capped per tool.

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

const bin = (name) => join(root, ".venv", "bin", name);
if (file === "") process.exit(0);

// Before `uv sync` there are no tools: a syntax check with the system python3 is all that is left,
// and one line says why the rest didn't run. (The tooling profile, scripts/lib/*.py, is
// stdlib-only and needs no venv, so the syntax check is real coverage for it.)
if (!existsSync(bin("ruff"))) {
  const compiled = spawnSync("python3", ["-m", "py_compile", file], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const problem = compiled.error ? `python3 could not run: ${compiled.error.message}` : compiled.status === 0 ? "" : `${compiled.stdout ?? ""}${compiled.stderr ?? ""}`.trim();
  if (problem !== "") process.stdout.write(`py_compile:\n${problem}\n\n`);
  if (problem !== "") process.stdout.write("run `uv sync` for full checks (ruff, pyright, import contracts)");
  process.exit(0);
}

// Knob: per-tool timeouts. Their sum (70 s: ruff runs twice) stays under the core's 80 s per-pack
// limit, so a slow tool is reported here by name instead of the whole pack timing out.
const TIMEOUT_MS = { ruff: 10_000, pyright: 30_000, "lint-imports": 20_000 };

// Runs one tool from the project root; returns its combined output, or "" only when it passed.
// A tool that can't start, is killed, or exits non-zero without printing is a failure too, never clean.
const run = (name, args) => {
  const result = spawnSync(bin(name), args, { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS[name] });
  // Couldn't start (missing binary, permission): there is no output to show, so say why.
  if (result.error) return `${name} could not run: ${result.error.message}`;
  // Killed by the timeout: same.
  if (result.signal !== null) return `${name} timed out after ${TIMEOUT_MS[name] / 1000} s`;
  if (result.status === 0) return "";
  // Failed: its own report when it printed one, else just the exit code.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return output.trim() === "" ? `${name} exited ${result.status}` : output;
};

// Trims a tool's output to what the agent can act on.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const kept = lines.slice(0, MAX_LINES_PER_TOOL);
  return lines.length > kept.length ? [...kept, `… ${lines.length - kept.length} more lines`].join("\n") : kept.join("\n");
};

// Collected failures, one block per tool.
const failures = [];

// Lint: the file's own findings, with the rule's fix hint.
const lintOutput = run("ruff", ["check", "--output-format", "concise", file]);
if (lintOutput !== "") failures.push(`ruff check:\n${cap(lintOutput)}`);

// Format: a file ruff would rewrite fails; the fix is one command.
const formatOutput = run("ruff", ["format", "--check", file]);
if (formatOutput !== "") failures.push(`ruff format: run \`uv run ruff format ${file}\`\n${cap(formatOutput)}`);

// Types: strict, this file only, when pyright is installed and the file is in a checked tree.
if (existsSync(bin("pyright")) && /^(src|tests|scripts|stacks)\//.test(file)) {
  const typeOutput = run("pyright", [file]);
  if (typeOutput !== "") failures.push(`pyright (strict):\n${cap(typeOutput)}`);
}

// Import contracts: the whole app in one run (a layer violation is about two files), only for app code.
if (existsSync(bin("lint-imports")) && file.startsWith("src/")) {
  // import-linter opens with a banner in box-drawing characters; drop it so the cap keeps the violations.
  const boundaryOutput = run("lint-imports", [])
    .split("\n")
    .filter((line) => !/[╔╗╚╝║═╣╠╦╩▶◀▲│└┘┐┌]/.test(line))
    .join("\n");
  if (boundaryOutput !== "") failures.push(`import-linter (docs/ports-and-adapters.md):\n${cap(boundaryOutput)}`);
}

// Domain purity: the allow list (stdlib minus I/O) catches what ruff's deny list misses; system python3, no venv.
if (file.startsWith("src/app/domain/")) {
  const purity = spawnSync("python3", ["stacks/python/domain_purity.py"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (purity.error) failures.push(`domain_purity could not run: ${purity.error.message}`);
  else if (purity.status !== 0) failures.push(`domain_purity (python.mdc):\n${cap(`${purity.stdout ?? ""}${purity.stderr ?? ""}`) || `exited ${purity.status}`}`);
}

// Print for the core to hand back; nothing printed means clean.
if (failures.length > 0) process.stdout.write(failures.join("\n\n"));
