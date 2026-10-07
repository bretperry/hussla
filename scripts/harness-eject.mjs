#!/usr/bin/env node
// Takes whippletree out of a project: every agent rule, hook, sync, and process file goes, the stack packs' gates stay.
// In the app: nothing at runtime; `pnpm harness:eject` by hand (a dry run), `--apply` on a publish branch.
// Used by: package.json `harness:eject`; tested by scripts/harness-eject.test.mjs.
// Uses: harness.json (`docs`, `code`, `eject`), stacks/*/pack.json (`docs`, `ejectRemove`), `[harness]` fences in any
//   tracked text file, package.json, git; scripts/stack.mjs (presentPacks, markerOf, stripMarked, trackedFiles, assertSafePath).
//
// For a project developed with whippletree and shipped without it (an open-source release). The
// shipped tree keeps the product and the gates that make `pnpm check` mean something to an
// outside contributor: each pack's lint, boundary, and test runners, `scripts/stack.mjs check`,
// the CI change-scope classifier, and ci.yml. What goes is everything whippletree adds on top:
// agent rules and skills, the hooks (command-guard, check-edited, pre-push), harness sync and
// drift, plans, human checks, the guide. Decision: docs/decisions/0006-harness-eject.md.
//
// What to remove is data, not code here: harness.json itself and its `docs` + `code` minus `eject.keep`, plus
// `eject.remove` (a trailing `/` is a whole directory), plus each pack's rules (`docs`) and its
// `ejectRemove`. A file that mixes kept and harness parts fences the harness part with `[harness]`
// … `[/harness]` comment lines, the same shape as a pack's `[stack:<name>]` fence.
//
// It never touches history. Ejecting on a branch leaves every harness file in the commits before
// it; a public repo needs a fresh history (`git checkout --orphan`) or a mirror that only ever
// receives ejected trees. The summary says so.
//
//   (no flag)   dry run: what would be deleted and edited, and what the scan would report
//   --apply     do it (clean tree, not on dev or main); exits 1 when the scan finds leftovers

// Node builtins only, like stack.mjs: it must run in a project with no Node stack.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertSafePath, markerOf, presentPacks, stripMarked, trackedFiles } from "./stack.mjs";

// The fence label eject strips: `[harness]` … `[/harness]`.
const FENCE = "harness";

// Branches eject refuses to run on: they are where development goes on with the harness.
const PROTECTED_BRANCHES = new Set(["dev", "main"]);

// Files bigger than this are never scanned or fence-stripped (lockfiles, fixtures), as in stack.mjs.
const MAX_SCANNED_BYTES = 2_000_000;

// Pack manifest fields that only the harness reads (sync, adoption, the edit hook, agent permissions).
const PACK_HARNESS_FIELDS = ["docs", "adoptOn", "editCheck", "claudeSettings", "ejectRemove"];

// The words a shipped tree must not carry: the harness's name, and an unfilled bootstrap placeholder.
const LEAK_PATTERNS = [
  { label: "names whippletree", pattern: /whippletree/i },
  { label: "unfilled placeholder", pattern: /\{\{[A-Z][A-Z0-9_]*\}\}/ },
];

// A JSON file's content, or `fallback` when it doesn't exist.
const readJson = (root, path, fallback) => (existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), "utf8")) : fallback);

// Runs git and returns stdout, or null when git fails (not a repo, no branch).
const git = (root, args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

// A path in the remove lists made safe: a file, or a directory when it ends in `/`.
const safeEntry = (root, entry) => {
  const isDir = entry.endsWith("/");
  assertSafePath(root, isDir ? entry.slice(0, -1) : entry);
  return { path: isDir ? entry.slice(0, -1) : entry, isDir };
};

// True when `path` is `entry` itself or sits inside a directory entry.
const covers = (entry, path) => (entry.isDir ? path === entry.path || path.startsWith(`${entry.path}/`) : path === entry.path);

// Everything eject would do, computed without writing: { removed, edits, packageJson, problems }.
//
// `removed` lists the remove entries that exist; `edits` maps a kept path to its new text
// (fence-stripped files, rewritten pack manifests, package.json); `problems` is the scan of the
// tree as it would be afterwards.
export const planEject = (root) => {
  const manifest = readJson(root, "harness.json", null);
  if (manifest?.eject === undefined) throw new Error("harness.json has no `eject` block; nothing says what to remove");
  const { keep = [], remove = [], dropScripts = [], addScripts = {} } = manifest.eject;
  const packs = presentPacks(root);
  // Every remove entry, validated before anything else runs: one bad path stops the whole eject.
  const listed = [...manifest.docs ?? [], ...manifest.code ?? []].filter((path) => !keep.includes(path));
  const packFiles = packs.flatMap((pack) => [...(pack.docs ?? []), ...(pack.ejectRemove ?? [])]);
  // harness.json always goes: it is this manifest, and whippletree's file list.
  const entries = [...new Set(["harness.json", ...listed, ...remove, ...packFiles])].map((entry) => safeEntry(root, entry));
  const kept = (path) => !entries.some((entry) => covers(entry, path));
  const tracked = trackedFiles(root);
  const survivors = tracked.filter(kept);
  // Fences first, in memory: an unbalanced marker stops the eject before any file changes.
  const edits = new Map();
  for (const path of survivors) {
    if (lstatSync(join(root, path)).size > MAX_SCANNED_BYTES) continue;
    const text = readFileSync(join(root, path), "utf8");
    // Only a whole-line marker counts, so prose that names the fence (a rule, a decision) is left alone.
    if (text.includes("\0") || !text.split("\n").some((line) => markerOf(line) === `[${FENCE}]` || markerOf(line) === `[/${FENCE}]`)) continue;
    try {
      const stripped = stripMarked(text, FENCE);
      if (stripped !== text) edits.set(path, stripped);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  // Pack manifests: drop the harness-only fields and any `code` file that is going.
  for (const pack of packs) {
    const path = `stacks/${pack.name}/pack.json`;
    const next = Object.fromEntries(Object.entries(pack).filter(([key]) => !PACK_HARNESS_FIELDS.includes(key)));
    if (Array.isArray(next.code)) next.code = next.code.filter(kept);
    if (JSON.stringify(next) !== JSON.stringify(pack)) edits.set(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  // package.json: the harness's scripts out, the kept tests' script in.
  const pkg = readJson(root, "package.json", null);
  if (pkg !== null) {
    const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([name]) => !dropScripts.includes(name)));
    edits.set("package.json", `${JSON.stringify({ ...pkg, scripts: { ...scripts, ...addScripts } }, null, 2)}\n`);
  }
  // What exists to remove, minus entries a removed directory already covers (one line per directory).
  const present = entries.filter((entry) => tracked.some((path) => covers(entry, path)) || existsSync(join(root, entry.path)));
  const removed = present.filter((entry) => !present.some((other) => other !== entry && other.isDir && covers(other, entry.path)));
  const problems = scan(root, survivors, edits, entries);
  return { removed: removed.map((entry) => (entry.isDir ? `${entry.path}/` : entry.path)), edits, problems };
};

// What the tree would still carry after eject: leaks, and package.json scripts that run a removed file.
//
// A leak is a line naming whippletree or an unfilled `{{…}}`; README, the changelogs, and seeded
// decisions are the usual places, and only a person can rewrite those, so eject reports them
// rather than deleting. A script pointing at a removed file would fail the first contributor
// who runs it, so it is a problem too.
export const scan = (root, survivors, edits, entries) => {
  const problems = [];
  const textOf = (path) => edits.get(path) ?? readFileSync(join(root, path), "utf8");
  for (const path of survivors) {
    if (!edits.has(path) && lstatSync(join(root, path)).size > MAX_SCANNED_BYTES) continue;
    const text = textOf(path);
    if (text.includes("\0")) continue;
    for (const [index, line] of text.split("\n").entries()) {
      for (const { label, pattern } of LEAK_PATTERNS) {
        if (pattern.test(line)) problems.push(`${path}:${index + 1}: ${label}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  // Every repo path a kept script names must survive the eject.
  const pkgText = edits.get("package.json");
  const scripts = pkgText === undefined ? {} : (JSON.parse(pkgText).scripts ?? {});
  for (const [name, command] of Object.entries(scripts)) {
    for (const [ref] of command.matchAll(/(?:scripts|stacks)\/[\w./-]+\.(?:mjs|js|py|sh)/g)) {
      if (entries.some((entry) => covers(entry, ref))) problems.push(`package.json: script "${name}" runs ${ref}, which eject removes`);
    }
  }
  return problems;
};

// Removes a file or a whole directory entry; true when something was there.
const removeEntry = (root, entry) => {
  const target = join(root, entry.path);
  if (!existsSync(target)) return false;
  const isDir = lstatSync(target).isDirectory();
  // A listed file that is a directory (or the reverse) is a manifest slip; refuse rather than guess.
  if (isDir !== entry.isDir) throw new Error(`'${entry.path}' is ${isDir ? "a directory" : "a file"}; list it ${isDir ? "with" : "without"} a trailing '/'`);
  rmSync(target, { recursive: entry.isDir });
  return true;
};

// Writes the plan: edits, then deletes, then the installed pre-push copy when it is whippletree's.
export const applyEject = (root, plan) => {
  // The installed hook is a copy in .git/hooks (install-git-hooks.sh); it would keep calling removed
  // scripts on every push. Only an unmodified copy goes: a hook the user wrote is theirs.
  const hookSource = join(root, ".githooks/pre-push");
  const hooksDir = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])?.trim();
  const installed = hooksDir ? join(hooksDir, "pre-push") : null;
  const dropHook = installed !== null && existsSync(hookSource) && existsSync(installed) && readFileSync(installed, "utf8") === readFileSync(hookSource, "utf8");
  for (const [path, text] of plan.edits) writeFileSync(join(root, path), text);
  for (const entry of plan.removed) removeEntry(root, safeEntry(root, entry));
  if (dropHook) rmSync(installed);
  return { droppedHook: dropHook };
};

// Refuses to apply anywhere development continues, or over uncommitted work.
const preconditions = (root) => {
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() ?? "";
  if (PROTECTED_BRANCHES.has(branch)) throw new Error(`on '${branch}': eject on a publish branch or a scratch clone, never where development goes on`);
  const status = git(root, ["status", "--porcelain"]);
  if (status === null) throw new Error("not a git repository; eject needs git to list files and to undo");
  if (status.trim() !== "") throw new Error("uncommitted changes; commit or stash first, so `git checkout .` undoes the eject");
};

// CLI: `node scripts/harness-eject.mjs [--apply]`, from the repo root.
const main = () => {
  const root = process.cwd();
  const apply = process.argv.includes("--apply");
  if (apply) preconditions(root);
  const plan = planEject(root);
  console.log(`harness:eject${apply ? "" : " (dry run; --apply to do it)"}`);
  console.log(`  delete: ${plan.removed.join(", ") || "nothing"}`);
  console.log(`  edit:   ${[...plan.edits.keys()].join(", ") || "nothing"}`);
  if (apply) {
    const { droppedHook } = applyEject(root, plan);
    if (droppedHook) console.log("  removed the installed .git/hooks/pre-push (whippletree's copy)");
  }
  if (plan.problems.length > 0) {
    console.log(`  ${plan.problems.length} leftover(s) to fix by hand before publishing:`);
    for (const problem of plan.problems) console.log(`    ${problem}`);
  }
  console.log("  Then: pnpm install && pnpm check. History still holds every harness file: publish with fresh history");
  console.log("  (git checkout --orphan) or to a mirror that only gets ejected trees. Add a LICENSE if there is none.");
  return apply && plan.problems.length > 0 ? 1 : 0;
};

// Run only as a script, so the tests can import the parts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`harness:eject: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
