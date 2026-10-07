// The Kotlin gates' pure parts: the floors the LAYERS rows can't go below, and the stamp that lets a local run skip the gates when nothing they read has changed.
// In the app: nothing at runtime; stacks/kotlin/gates.mjs (`pnpm kotlin:gates`) calls these.
// Used by: stacks/kotlin/gates.mjs; stacks/kotlin/gates.test.mjs (node:test).
// Uses: Node builtins only (crypto for the hash, fs to read what the gates depend on).
//
// Why a separate module: the gates themselves take a JDK and ~40 s, so the rules that decide
// *whether* they run, and what a row must hold before any probe is planted, are tested here
// without Gradle.

// Node builtins only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Knob: where the stamp lives. Under the root build/ (ignored by git, cleared by `./gradlew clean`).
export const STAMP_FILE = "build/kotlin-gates.stamp";

// Knob: single files the gates' outcome depends on, besides the Gradle build itself (below).
// Source *contents* aren't here on purpose: a probe plants its own code, so an edit to a .kt file
// can't change what the gates prove; the package directories can (the gates plant into them).
export const STAMP_INPUTS = ["config/detekt/detekt.yml", "stacks/kotlin/gates.mjs", "stacks/kotlin/gates-lib.mjs"];

// Knob: directories hashed whole, every file's bytes: `gradle/` (wrapper jar and properties,
// daemon-JVM properties, version catalog, applied scripts) and `buildSrc/` (build logic every
// build file can call). An included build's directory is hashed the same way (includedBuilds).
export const STAMP_TREES = ["gradle", "buildSrc"];

// Knob: file names hashed wherever they sit in the tree: any Gradle script (`*.gradle.kts`,
// `*.gradle`, settings included) and any `gradle.properties`.
const isGradleFile = (name) => name.endsWith(".gradle.kts") || name.endsWith(".gradle") || name === "gradle.properties";

// Directories a walk of the tree skips: build output, caches, other stacks' installs, git.
const SKIP = new Set(["build", ".gradle", ".kotlin", "node_modules", ".git"]);

// Every directory and regular file under `dir`, as paths relative to `base`, skipping SKIP.
const walk = (base, dir, found = { dirs: [], files: [] }) => {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(base, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      found.dirs.push(rel);
      walk(base, path, found);
    } else if (entry.isFile()) found.files.push(rel);
  }
  return found;
};

// Plain code-unit order, the same on every machine and locale.
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Whether `path` is `dir` or sits under it ("." holds everything).
const within = (path, dir) => dir === "." || path === dir || path.startsWith(`${dir}/`);

// Every included build's directory, relative to `root` (it may lie outside, as `../x`): each
// `includeBuild("…")` in the root settings script, plus every directory in the tree with a
// settings script of its own (a nested build, included or about to be).
const includedBuilds = (root, files) => {
  const named = [];
  for (const settings of ["settings.gradle.kts", "settings.gradle"]) {
    const full = join(root, settings);
    if (!existsSync(full)) continue;
    // Kotlin `includeBuild("x")` and Groovy `includeBuild 'x'`.
    for (const match of readFileSync(full, "utf8").matchAll(/includeBuild\s*\(?\s*["']([^"']+)["']/g)) named.push(relative(root, join(root, match[1])).replaceAll("\\", "/") || ".");
  }
  const nested = files.filter((path) => /(^|\/)settings\.gradle(\.kts)?$/.test(path) && path.includes("/")).map((path) => dirname(path));
  return [...new Set([...named, ...nested])].filter((dir) => dir !== ".");
};

// The hash of everything the gates read: every Gradle script and gradle.properties in the tree,
// STAMP_INPUTS, every file under STAMP_TREES and each included build, and the sorted list of
// source package directories in each module (src/<set>/kotlin and src/<set>/java).
export const gateStamp = (root) => {
  const { dirs, files } = walk(root, root);
  const builds = includedBuilds(root, files);
  const trees = [...STAMP_TREES, ...builds.filter((dir) => !dir.startsWith("../"))];
  const hashed = files.filter((path) => isGradleFile(path.split("/").at(-1)) || trees.some((dir) => within(path, dir)));
  // An included build outside the tree is walked on its own, under its `../` path.
  for (const outside of builds.filter((dir) => dir.startsWith("../"))) hashed.push(...walk(root, join(root, outside)).files);
  const hash = createHash("sha256");
  for (const path of [...new Set([...hashed, ...STAMP_INPUTS])].toSorted(byText)) {
    const full = join(root, path);
    hash.update(`file ${path}\n`);
    hash.update(existsSync(full) ? readFileSync(full) : "(missing)");
    hash.update("\n");
  }
  const modules = files.filter((path) => /(^|\/)build\.gradle(\.kts)?$/.test(path)).map((path) => dirname(path)).filter((dir) => dir !== ".");
  const packageDirs = dirs.filter((dir) => modules.some((module) => dir.startsWith(`${module}/src/`))).toSorted(byText);
  hash.update(`dirs\n${packageDirs.join("\n")}\n`);
  return hash.digest("hex");
};

// Whether this run may skip the gates: never under CI (any non-empty CI), else only when the
// stored stamp equals `stamp` (the tree's hash now, unless the caller already took it).
export const shouldSkip = (root, env = process.env, stamp = gateStamp(root)) => {
  if ((env.CI ?? "") !== "") return false;
  const path = join(root, STAMP_FILE);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").trim() === stamp;
};

// Records `stamp` as a passing run's.
export const writeStamp = (root, stamp = gateStamp(root)) => {
  const path = join(root, STAMP_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stamp}\n`);
};

// Records a pass under the stamp taken when the run *started*, and only if the tree still hashes
// to it: an edit made mid-run may not be what the scratch copies saw, so stamping it would let
// the next run skip a change no probe ran against. Returns whether it wrote.
export const recordPass = (root, stampAtStart) => {
  if (gateStamp(root) !== stampAtStart) return false;
  writeStamp(root, stampAtStart);
  return true;
};

// The floors: a probe only proves what its row asks for, so a weakened row would weaken its
// probes with it. These refuse the weakened rows themselves; each entry is one problem's message.
// `layers` is printLayers' JSON; `samples` is BYTECODE_SAMPLES' keys.
export const floorProblems = (layers, samples) => {
  const problems = [];
  const usedRules = new Set(layers.flatMap((row) => row.bytecode));
  for (const rule of samples) {
    if (!usedRules.has(rule)) problems.push(`no LAYERS row forbids "${rule}" any more, but BYTECODE_SAMPLES still has it: the samples are the floor. If dropping it is a decision (docs/decisions/), delete the sample too.`);
  }
  for (const row of layers) {
    const adapter = row.libraries.includes("*");
    const pure = row.mayUse.length === 0 && row.libraries.length === 0;
    if (pure && row.bytecodeAllowed.length === 0) problems.push(`LAYERS row ${row.path} is pure (no mayUse, no libraries) but has no bytecodeAllowed: the pure layer's compiled classes must be checked against an allowlist.`);
    // Every row but an adapter row has bytecode rules, so moving one row's rules onto another fails.
    if (!adapter && row.bytecode.length === 0 && row.bytecodeAllowed.length === 0) problems.push(`LAYERS row ${row.path} has no bytecode rules and no allowlist: only an adapter row (ANY_LIBRARY) may reach the JDK unchecked.`);
    // An Android row is the composition root: the bytecode scan doesn't run on Android, so it may
    // carry no rules that would look enforced, and it allows every library.
    if (row.android === true && (!adapter || row.bytecode.length > 0 || row.bytecodeAllowed.length > 0)) problems.push(`LAYERS row ${row.path} is an Android module, which only the composition root may be: it allows ANY_LIBRARY and has no bytecode rules (the scan doesn't run on Android). Keep rules-bound code in a JVM layer.`);
    if (!adapter && !row.requiresTests && row.noTestsReason.trim() === "") problems.push(`LAYERS row ${row.path} doesn't require tests: set requiresTests, or say why in noTestsReason (kotlin.mdc → Every gate is proved).`);
  }
  return problems;
};
