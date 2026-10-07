#!/usr/bin/env node
// After an agent edits a file, runs each stack pack's per-edit check on it and hands failures back to the agent.
// In the app: nothing at runtime; Claude Code PostToolUse (Edit|Write) and Cursor postToolUse (Write) call it after every edit.
// Used by: .claude/settings.json, .cursor/hooks.json.
// Uses: stacks/*/pack.json `editCheck` (`extensions`, `names`, `files`, via scripts/stack.mjs presentPacks); scripts/sync-claude-rules.mjs for .mdc edits.
//
// The point is breaking fast: a type error or a layering violation is caught on the edit that
// caused it, not three steps later in CI. Only failures are reported, so a clean edit costs the
// agent zero tokens. The core knows no language: each pack declares the extensions it checks (or
// basename patterns, for names an extension can't claim, like `Dockerfile.prod`) and
// a script (`node <run> <repo-relative path>`) that prints its failures, or nothing when clean.
// A file several packs claim gets every one of their checks, run side by side. A check that
// crashes, times out, or dies on a signal is reported, never read as clean. Tests are not run here
// (they run in `pnpm check`, pre-push, and CI); per-edit checks stay static so this takes seconds.
//
// Time budget: the hooks allow 90 s (.claude/settings.json, .cursor/hooks.json). Packs run in
// parallel with PACK_TIMEOUT_MS each, so the whole hook fits; a pack's own tool timeouts must sum
// under it (the TypeScript pack's do: 40 + 20 + 15 s).

// Node builtins only, plus the harness's own pack reader.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

import { presentPacks } from "./stack.mjs";

// Knob: how long one pack's check may run; under the hooks' 90 s so we always answer in time.
const PACK_TIMEOUT_MS = 80_000;

// Which host called us decides the input and output shapes.
const host = process.argv[2] === "cursor" ? "cursor" : "claude";

// Project root: both hosts export it (Cursor also sets CLAUDE_PROJECT_DIR for compatibility).
const root = process.env.CLAUDE_PROJECT_DIR ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();

// Claude: tool_input.file_path. Cursor's Write tool: file_path or path, depending on version.
const input = JSON.parse(readFileSync(0, "utf8"));
const rawPath = input.tool_input?.file_path ?? input.tool_input?.path ?? input.file_path;

// An edited Cursor rule: regenerate Claude's copy (.claude/rules) so the two never drift.
if (typeof rawPath === "string" && /\.cursor[\\/]rules[\\/][^\\/]+\.mdc$/.test(rawPath)) {
  spawnSync(process.execPath, [join(root, "scripts", "sync-claude-rules.mjs")], { cwd: root, stdio: "ignore" });
  process.exit(0);
}

// Nothing to check: no path, outside the project, or in dependencies.
if (typeof rawPath !== "string") process.exit(0);
const file = relative(root, isAbsolute(rawPath) ? rawPath : join(root, rawPath));
if (file.startsWith("..") || file.split(sep).includes("node_modules")) process.exit(0);

// Forward slashes, so `editCheck.files` matches and a pack's script sees the same path on every OS.
const posixFile = file.split(sep).join("/");

// True when a pack claims this file: by its extension in any case (`M.SQL` too), by a basename pattern (`editCheck.names`,
// regexes), or by exact repo-relative path (`editCheck.files`: a pack's own config, e.g. a layer
// map in JSON, whose extension is too common to claim).
const claims = (pack) =>
  (pack.editCheck?.extensions ?? []).some((extension) => extension.toLowerCase() === extname(file).toLowerCase()) ||
  (pack.editCheck?.names ?? []).some((pattern) => new RegExp(pattern).test(basename(file))) ||
  pack.editCheck?.files?.includes(posixFile) === true;

// The packs that claim this file; none (docs, images) means exit at once.
const packs = presentPacks(root).filter(claims);
if (packs.length === 0) process.exit(0);

// Runs one pack's check; resolves to its failure text, or "" when it passed clean.
const runPack = (pack) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [join(root, pack.editCheck.run), posixFile], { cwd: root, timeout: PACK_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // A script that can't even start (missing file, bad path) is a failed check.
    child.on("error", (error) => done(`[${pack.name}] edit check failed: ${error.message}`));
    child.on("close", (code, signal) => {
      // Printed failures are the normal report, whatever the exit code.
      if (stdout.trim() !== "") return done(`[${pack.name}]\n${stdout.trim()}`);
      if (code === 0 && signal === null) return done("");
      // Nothing printed but it didn't exit clean: say why instead of reading it as a pass.
      const why = signal === "SIGTERM" ? `timed out after ${PACK_TIMEOUT_MS / 1000} s` : signal !== null ? `killed by ${signal}` : stderr.trim().split("\n").slice(0, 10).join("\n") || `exit ${code}`;
      return done(`[${pack.name}] edit check failed: ${why}`);
    });
  });

// Every claiming pack at once; collect the non-empty reports.
const failures = (await Promise.all(packs.map(runPack))).filter((report) => report !== "");

// Clean edit: no output at all, so it costs no context.
if (failures.length === 0) process.exit(0);

// Hand the failures back to the agent as context for its next step.
const message = `check-edited: ${file} has problems. Fix them before moving on.\n\n${failures.join("\n\n")}`;
process.stdout.write(
  JSON.stringify(
    host === "cursor"
      ? { additional_context: message }
      : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } },
  ),
);
