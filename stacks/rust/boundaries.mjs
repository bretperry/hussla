#!/usr/bin/env node
// The Rust pack's boundary check: every crate may depend only on the layers and registry crates Cargo.toml allows.
// In the app: nothing at runtime; `pnpm rust:boundaries` (so `pnpm check`, CI, and the edit hook on a Cargo.toml) runs it.
// Used by: package.json `rust:boundaries`, stacks/rust/check-edited.mjs; tested by stacks/rust/boundaries.test.mjs.
// Uses: `cargo metadata --no-deps`; Cargo.toml → [workspace.metadata.layers]; docs/decisions/0003-ports-and-adapters.md.
//
// Layout (domain → app → adapters) already makes cargo refuse an inward dependency as a cycle. What
// cargo can't say is "domain takes no packages at all" or "app takes only these", and a layer map
// that names no real crate would pass without checking anything. So this reads the real declared
// dependencies (`--no-deps`, so a cycle is read as a violation here instead of an opaque cargo error),
// and fails on a crate with no row, a row with no crate, and a `may-use` that names nothing.
//
// Two more ways to slip past are closed here. A crate without `[lints] workspace = true` gets none of
// the workspace's clippy denies (clippy exits 0), so every manifest is read for it. And `#[path]`,
// `include!` and friends can compile another crate's source into this one, which no dependency
// shows, so every .rs file is scanned for a path that leaves its crate.
//
//   node stacks/rust/boundaries.mjs [--root <dir>]     exit 0 clean, 1 on any violation or if cargo can't answer

// Node builtins only.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Violations as readable lines, each ending in the fix; [] when clean. `metadata` is `cargo metadata --no-deps` output.
export const checkLayers = (metadata, { readText = (path) => readFileSync(path, "utf8") } = {}) => {
  const layers = metadata.metadata?.layers;
  // No map at all would pass every crate; refuse.
  if (layers === undefined || layers === null || typeof layers !== "object") {
    return ["Cargo.toml has no [workspace.metadata.layers] table: add a row per crate (docs/ports-and-adapters.md)."];
  }
  const packages = metadata.packages ?? [];
  const names = new Set(packages.map((pack) => pack.name));
  const problems = [];

  // Both directions, so a misspelled crate name can't leave a rule matching nothing.
  for (const name of names) {
    if (!(name in layers)) problems.push(`crate '${name}' has no row in [workspace.metadata.layers]: add one, or its dependencies are unchecked.`);
  }
  for (const [name, row] of Object.entries(layers)) {
    if (!names.has(name)) problems.push(`[workspace.metadata.layers] row '${name}' matches no crate (${[...names].join(", ")}): fix the spelling, or the rule checks nothing.`);
    for (const used of row["may-use"] ?? []) {
      if (!names.has(used)) problems.push(`layer '${name}': may-use '${used}' matches no crate: fix the spelling.`);
    }
  }

  for (const pack of packages) {
    const row = layers[pack.name];
    if (row === undefined) continue;
    const mayUse = row["may-use"] ?? [];
    const external = row.external ?? [];
    // A string other than "*" would be matched as a substring ("tokio".includes("tok")): refuse it.
    if (external !== "*" && !Array.isArray(external)) {
      problems.push(`layer '${pack.name}': external must be an array of crate names or "*", not ${JSON.stringify(external)}.`);
      continue;
    }
    if (pack.manifest_path !== undefined && !hasWorkspaceLints(readText(pack.manifest_path))) {
      problems.push(`crate '${pack.name}' has no \`[lints] workspace = true\` in its Cargo.toml: add it, or none of the workspace's clippy denies apply to it.`);
    }
    for (const dep of pack.dependencies ?? []) {
      // `kind` is null for a normal dependency, "build" or "dev" otherwise; dev ones may use any registry crate (proptest, a test runtime).
      const isDev = dep.kind === "dev";
      // A crate's dev-dependency on itself only switches on its own test features; it adds no layer.
      if (isDev && dep.name === pack.name) continue;
      if (names.has(dep.name)) {
        if (!mayUse.includes(dep.name)) {
          problems.push(`crate '${pack.name}'${isDev ? " (dev)" : ""} depends on '${dep.name}', which its layer may not use (may-use: [${mayUse.join(", ")}]): invert the dependency behind a port in the app crate (docs/ports-and-adapters.md).`);
        }
      } else if (typeof dep.source !== "string" || !dep.source.startsWith("registry+")) {
        // Not a workspace crate and not from a registry: a path outside the workspace or a git checkout.
        problems.push(`crate '${pack.name}' depends on '${dep.name}' from ${dep.source ?? "a path outside the workspace"}: put it in the workspace as a crate, or take it from the registry.`);
      } else if (!isDev && external !== "*" && !external.includes(dep.name)) {
        problems.push(`crate '${pack.name}' depends on registry crate '${dep.name}', which its layer does not allow (external: ${external === "*" ? "*" : `[${external.join(", ")}]`}): move that code to a crate whose layer allows it, or widen the row on purpose.`);
      }
    }
  }
  return problems;
};

// True when a Cargo.toml opts in to the workspace lints: `[lints] workspace = true` or `lints.workspace = true`.
export const hasWorkspaceLints = (text) => {
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) table = header[1].trim();
    else if (table === "lints" && /^workspace\s*=\s*true$/.test(line)) return true;
    else if (table === "package" && /^lints\.workspace\s*=\s*true$/.test(line)) return true;
  }
  return false;
};

// Every .rs file under a crate directory, skipping build output.
const rustFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return ["target", ".git", "node_modules"].includes(entry.name) ? [] : rustFiles(join(dir, entry.name));
    return entry.name.endsWith(".rs") ? [join(dir, entry.name)] : [];
  });

// Source files that pull in a file outside their own crate (`#[path]`, `include!`, `include_str!`, `include_bytes!`).
// Reads each package's .rs files; returns readable problems, [] when clean.
export const checkSources = (packages) => {
  const problems = [];
  for (const pack of packages) {
    if (pack.manifest_path === undefined) continue;
    const crateDir = dirname(pack.manifest_path);
    for (const file of rustFiles(crateDir)) {
      const text = readFileSync(file, "utf8");
      // A `#[path]` is relative to the file's dir, or to dir/<stem> in a non-mod.rs file: test both.
      const stem = file.replace(/\.rs$/, "");
      const bases = [dirname(file), stem];
      const leaves = (target) => bases.some((base) => isAbsolute(target) || relative(crateDir, resolve(base, target)).startsWith(".."));
      for (const match of text.matchAll(/#\s*\[\s*path\s*=\s*"([^"]+)"/g)) {
        if (leaves(match[1])) problems.push(`crate '${pack.name}': ${relative(crateDir, file)} has #[path = "${match[1]}"], which leaves the crate: depend on the crate that owns it instead.`);
      }
      for (const match of text.matchAll(/\binclude(?:_str|_bytes)?!\s*\(([^)]*)\)/g)) {
        const literal = /^\s*"([^"]+)"\s*$/.exec(match[1]);
        const escapes = literal !== null ? leaves(literal[1]) : match[1].includes("..");
        if (escapes) problems.push(`crate '${pack.name}': ${relative(crateDir, file)} has ${match[0]}, which reaches outside the crate: depend on the crate that owns it instead.`);
      }
    }
  }
  return problems;
};

// `cargo metadata --no-deps` for the workspace at `root`; throws with cargo's own words when it can't answer.
const readMetadata = (root) => {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(root, "Cargo.toml")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`cargo did not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata failed:\n${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
};

// CLI: `--root <dir>` (default: the working directory).
const main = () => {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = resolve(rootFlag === -1 ? "." : (args[rootFlag + 1] ?? "."));
  const metadata = readMetadata(root);
  const problems = [...checkLayers(metadata), ...checkSources(metadata.packages)];
  if (problems.length > 0) {
    process.stderr.write(`✗ rust boundaries:\n${problems.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`rust boundaries: ok (${metadata.packages.length} crates).\n`);
  return 0;
};

// Run only as a script, so the tests can import checkLayers.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`✗ rust boundaries: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
