#!/usr/bin/env node
// Runs one of the Go pack's tool checks (lint, test, tidy) and says plainly when the tool isn't installed.
// In the app: nothing at runtime; package.json `go:lint`, `go:test`, `go:tidy` call it, so `pnpm check` and CI do.
// Used by: package.json scripts, stacks/go/pack.json `checks`.
// Uses: golangci-lint and go on PATH.
//
// Why a wrapper and not the commands in package.json: knip reads every binary a package.json
// script names and fails on one it can't find in node_modules, and these live on PATH. A missing
// tool also gets one line saying what to install, not a shell's "command not found".

// Node builtins only.
import { spawnSync } from "node:child_process";

// Knob: each task's command. `-race` needs cgo (a C compiler); `tidy -diff` prints what
// `go mod tidy` would change and exits non-zero, touching nothing.
const TASKS = {
  lint: ["golangci-lint", ["run", "./..."]],
  test: ["go", ["test", "-race", "-count=1", "./..."]],
  tidy: ["go", ["mod", "tidy", "-diff"]],
};

// Which task: argv[2].
const name = process.argv[2] ?? "";
const task = TASKS[name];
if (task === undefined) {
  process.stderr.write(`go pack: unknown task '${name}'; one of ${Object.keys(TASKS).join(", ")}\n`);
  process.exit(2);
}

// Run it with the terminal attached, so its output is the check's output.
const [command, args] = task;
const result = spawnSync(command, args, { stdio: "inherit" });

// Not installed: say what to install. Anything else (killed by a signal, a failed run) is a failure too, never a pass.
if (result.error?.code === "ENOENT") {
  process.stderr.write(`go pack: \`${command}\` is not on PATH. Install Go (go.mod's \`go\` line) and golangci-lint v2 (the version in .github/workflows/ci.yml).\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
