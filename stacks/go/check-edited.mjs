#!/usr/bin/env node
// The Go pack's per-edit check: compile errors, vet, the lint floor, import boundaries, and formatting for one file's package.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a .go file.
// Used by: scripts/check-edited.mjs, through stacks/go/pack.json `editCheck`.
// Uses: golangci-lint on PATH (it runs go vet, depguard, and gofumpt from .golangci.yml).
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. golangci-lint lints a package at a time (types cross
// files), so the package is linted and only this file's findings are printed: a half-done
// multi-file edit doesn't drown the agent in errors it is about to fix. Tests are not run here
// (`pnpm check`, pre-push, and CI run them).
//
// Fast enough for the hook: a warm cache lints one package in about a second; the timeout below
// is for a cold one. A missing golangci-lint is reported, not read as clean, because "no output"
// must never mean "not checked".

// Node builtins only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Knob: lines kept; the agent needs the first findings, not all.
const MAX_LINES = 30;

// Knob: one lint's timeout. Under the core's 80 s per-pack limit, so a slow cold build is reported here by name.
const TIMEOUT_MS = 70_000;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it.
const file = process.argv[2] ?? "";

// No go.mod at the root: not a Go module here (or the pack is half-removed); nothing to lint against.
if (file === "" || !existsSync(join(root, "go.mod"))) process.exit(0);

// The file's package directory, as a ./ pattern (`./internal/domain`, or `.` at the root).
const dir = dirname(file);
const pattern = dir === "." ? "." : `./${dir}`;

const result = spawnSync(
  "golangci-lint",
  ["run", "--max-issues-per-linter", "0", "--max-same-issues", "0", "--show-stats=false", "--output.text.print-issued-lines=false", pattern],
  { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS },
);

// Not installed: say so, since there is no output to show.
if (result.error?.code === "ENOENT") {
  process.stdout.write("golangci-lint is not on PATH, so this edit was not checked. Install the version pinned in .github/workflows/ci.yml (go.mdc → Tools).");
  process.exit(0);
}
// Killed: by our timeout (SIGTERM) or by something else; name which.
if (result.signal !== null) {
  const why = result.signal === "SIGTERM" ? `timed out after ${TIMEOUT_MS / 1000} s` : `was killed by ${result.signal}`;
  process.stdout.write(`golangci-lint ${why} on ${pattern}; this edit was not checked.`);
  process.exit(0);
}
if (result.status === 0) process.exit(0);

// golangci-lint exits 1 when it found issues; anything else (config error, crash) is not a finding.
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").filter((line) => line.trim() !== "");
// A finding line starts `path:line:col:`.
const isFinding = (line) => /^[^\s:]+:\d+(?::\d+)?: /.test(line);
const mine = output.filter((line) => line.startsWith(`${file}:`));
const others = output.filter((line) => isFinding(line) && !line.startsWith(`${file}:`)).length;
// Not findings at all (a bad config, a package that won't load) are shown whole: they are about the edit too.
const notFindings = output.filter((line) => !isFinding(line) && !/^\d+ issues?:|^\* /.test(line));
const shown = [...mine, ...(mine.length === 0 ? notFindings : [])];
if (shown.length === 0 && others === 0) shown.push(`golangci-lint exited ${result.status} with no output`);
const kept = shown.slice(0, MAX_LINES);
const text = shown.length > kept.length ? [...kept, `… ${shown.length - kept.length} more lines`] : kept;
// Findings in other files of the package are not this edit's to fix yet: count them, don't list them.
if (others > 0) text.push(`(${others} finding${others === 1 ? "" : "s"} in other files of ${pattern}; \`pnpm go:lint\` lists them)`);

// Print for the core to hand back; nothing printed means clean.
process.stdout.write(`golangci-lint (docs/ports-and-adapters.md for a boundary finding):\n${text.join("\n")}`);
