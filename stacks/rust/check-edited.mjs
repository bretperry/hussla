#!/usr/bin/env node
// The Rust pack's per-edit check: rustfmt on the file, clippy (which includes cargo check) on its crate, boundaries on a Cargo.toml.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a file this pack claims.
// Used by: scripts/check-edited.mjs, through stacks/rust/pack.json `editCheck`.
// Uses: cargo, clippy, rustfmt, cargo-deny (for deny.toml), stacks/rust/boundaries.mjs; tested by stacks/rust/check-edited.test.mjs.
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. Scope: the crate that owns the file, never the whole
// workspace, so a half-done change in another crate doesn't drown the agent. Warm, one crate's
// clippy takes a second or two; cold, a few seconds more (measured 8 s). A tool past its timeout is
// killed with everything it started (cargo holds the build lock, so an orphan would block the
// next edit) and reported by name.
// Output is capped: the agent needs the first errors, not all.

// Node builtins only.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Lines kept per tool.
const MAX_LINES_PER_TOOL = 30;

// Knob: per-tool timeouts. Their sum stays under the core's 80 s per-pack limit, so a slow tool is
// reported here by name instead of the whole pack timing out.
const TIMEOUT_MS = { metadata: 10_000, rustfmt: 10_000, clippy: 45_000, boundaries: 10_000, deny: 10_000 };
// Test seam: one number for every tool, so a timeout test doesn't wait 45 s.
const OVERRIDE_MS = Number(process.env.RUST_EDIT_CHECK_TIMEOUT_MS ?? "");
const timeoutFor = (label) => (OVERRIDE_MS > 0 ? OVERRIDE_MS : TIMEOUT_MS[label]);

// Cargo's progress chatter, which is never a finding.
const NOISE = /^\s*(Checking|Compiling|Finished|Blocking|Locking|Updating|Downloaded|Downloading)\b|^warning: build failed, waiting for other jobs/;

const root = process.cwd();
const file = process.argv[2] ?? "";

// Runs a command from the project root in its own process group; resolves to its combined output,
// as { ok, output, text }: `text` is what to report ("" when it passed). A timeout kills the whole group.
const run = (label, command, args) =>
  new Promise((done) => {
    const child = spawn(command, args, { cwd: root, detached: true, env: { ...process.env, CARGO_TERM_COLOR: "never" } });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      // Negative pid: the group, so cargo's rustc children go too.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutFor(label));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, output: "", text: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return done({ ok: false, output: "", text: `${label} timed out after ${timeoutFor(label) / 1000} s and was killed (run \`pnpm rust:lint\` to warm the build cache)` });
      done({ ok: code === 0, output, text: code === 0 ? "" : output });
    });
  });

// Trims a tool's output to what the agent can act on.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !NOISE.test(line));
  const kept = lines.slice(0, MAX_LINES_PER_TOOL);
  return lines.length > kept.length ? [...kept, `… ${lines.length - kept.length} more lines`].join("\n") : kept.join("\n");
};

// The crate owning `path` (the package whose directory is the deepest ancestor of it), its edition,
// and cargo's target directory; undefined when none does.
export const owningCrate = (metadata, path) => {
  const absolute = resolve(root, path);
  const owner = metadata.packages
    .map((pack) => ({ pack, dir: dirname(pack.manifest_path) }))
    .filter(({ dir }) => absolute.startsWith(dir + sep))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0];
  return owner === undefined ? undefined : { name: owner.pack.name, edition: owner.pack.edition, dir: owner.dir, targetDirectory: metadata.target_directory };
};

// True when a compile of `crate` listed `path` as an input, per cargo's dep-info (`target/debug/deps/<crate>-*.d`).
// Undefined when there is no dep-info to ask. A .rs file outside the module tree is compiled by nothing,
// so clippy passes it without reading a line.
export const isCompiled = (targetDirectory, crateName, path) => {
  const depsDir = join(targetDirectory, "debug", "deps");
  if (!existsSync(depsDir)) return undefined;
  const prefix = `${crateName.replaceAll("-", "_")}-`;
  const infos = readdirSync(depsDir).filter((name) => name.startsWith(prefix) && name.endsWith(".d"));
  if (infos.length === 0) return undefined;
  const target = resolve(root, path);
  // Inputs are paths relative to the workspace root, or absolute.
  return infos.some((name) => readFileSync(join(depsDir, name), "utf8").split(/[\s:]+/).some((entry) => entry !== "" && resolve(root, entry) === target));
};

// Runs the checks for `path`; returns the failure blocks, [] when clean.
const check = async (path) => {
  const failures = [];
  // Which files are ours: a .rs file, or one of the two manifests whose edits we check. Any other .toml is someone else's.
  if (!path.endsWith(".rs") && !["Cargo.toml", "deny.toml"].includes(basename(path))) return failures;
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  // One line, the same for every file kind: an unchecked edit is said out loud, not read as clean.
  if (cargo.error?.code === "ENOENT") return ["cargo not installed: Rust edits unchecked"];

  if (path.endsWith(".rs")) {
    const meta = await run("metadata", "cargo", ["metadata", "--format-version", "1", "--no-deps"]);
    if (!meta.ok) return [`cargo metadata failed:\n${cap(meta.text)}`];
    const metadata = JSON.parse(meta.output);
    const crate = owningCrate(metadata, path);
    if (crate === undefined) return [`${path} is not inside a crate of this workspace: add it to one, or it is never compiled.`];

    // Format: this file only, with the crate's edition and the workspace's rustfmt.toml.
    const format = await run("rustfmt", "rustfmt", ["--check", "--color", "never", "--edition", crate.edition, "--config-path", ".", path]);
    if (format.text !== "") failures.push(`rustfmt (run \`cargo fmt --all\`):\n${cap(format.text)}`);

    // Lint + type check: this crate, all targets and features, the workspace's deny list. Short format: one line per finding.
    const lint = await run("clippy", "cargo", ["clippy", "-p", crate.name, "--all-targets", "--locked", "--color", "never", "--message-format", "short", "--", "-D", "warnings"]);
    if (lint.text !== "") failures.push(`clippy -p ${crate.name} (docs/ports-and-adapters.md for a boundary finding):\n${cap(lint.text)}`);
    // Only meaningful once clippy passed: a compile error already says more.
    else if (isCompiled(crate.targetDirectory, crate.name, path) === false) {
      failures.push(`${path} is not reachable from ${crate.name}'s module tree, so nothing compiles or lints it: add \`mod <name>;\` to its parent, or delete the file.`);
    }
  } else if (basename(path) === "Cargo.toml") {
    // A manifest edit can break the layering without touching a .rs file.
    const boundaries = await run("boundaries", process.execPath, ["stacks/rust/boundaries.mjs"]);
    if (boundaries.text !== "") failures.push(`boundaries:\n${cap(boundaries.text)}`);
  } else if (basename(path) === "deny.toml") {
    // The offline half of the audit: advisories need the network and a database, and run on a schedule.
    const deny = await run("deny", "cargo", ["deny", "--locked", "check", "bans", "licenses", "sources"]);
    if (deny.text !== "") failures.push(`cargo deny:\n${cap(deny.text)}`);
  }
  return failures;
};

// Run only as a script, so the tests can import the pure parts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await check(file);
  // Print for the core to hand back; nothing printed means clean.
  if (failures.length > 0) process.stdout.write(failures.join("\n\n"));
}
