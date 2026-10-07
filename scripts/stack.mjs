#!/usr/bin/env node
// Lists, checks, and removes stack packs: every file a stack owns, named in one stacks/<name>/pack.json.
// In the app: nothing at runtime; `pnpm stack:list` / `stack:remove <name>` by hand, `pnpm check` and CI run `check`.
// Used by: package.json (`check`, `stack:*`), ci.yml, scripts/check-edited.mjs, scripts/lib/ci-change-scope.mjs, scripts/harness-eject.mjs.
// Uses: harness.json `stacks`, stacks/*/pack.json, harness.project.json `removedStacks`, git, scripts/sync-claude-rules.mjs;
//   tested by scripts/stack.test.mjs.
//
// A pack is a language (lint, boundaries, tests, an edit-hook branch) or an add-on that `requires`
// one. A pack is installed when its directory is on disk; that is the only record of it. Removing
// a pack deletes the files it lists (minus any a kept pack also claims), strips its fenced regions
// from every tracked text file, takes its scripts and dependencies out of package.json and its
// permissions out of .claude/settings.json, and notes it in harness.project.json → removedStacks.
// Why one command: a stack woven through a dozen files gets half-removed by hand, and the half
// left behind fails CI. Design: docs/decisions/0002-stack-packs.md.
//
//   list              each pack: present, removed, or available upstream
//   remove <name>     remove a pack, and any pack that requires it (prints a pack's `leftovers` for you to delete,
//                     and its `requiredChecks` for you to drop from the rulesets)
//   required-checks   the CI check names every present pack requires (pack.json `requiredChecks`), comma-separated
//   check             the harness's own checks, then each present pack's, then generated-file drift (stops at the first failure)
//   check --packs [<list>]  every present pack's checks, all of them even after a failure (the CI step);
//                     <list> is Change scope's `packs` (all, none, or names): only those packs run
//   drift             regenerate each pack's generated files and fail when git sees a difference

// Node builtins only, so it runs before `pnpm install` and in a project with no Node stack at all.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// [harness]
import { sync as syncClaudeRules } from "./sync-claude-rules.mjs";
// [/harness]

// Where packs live: one directory per pack, its manifest inside.
const STACKS_DIR = "stacks";

// The harness's own checks, run before any pack's: they need Node and nothing else.
// `[harness]` fences are what `pnpm harness:eject` strips (scripts/harness-eject.mjs).
const CORE_CHECKS = [
  // [harness]
  { name: "Claude rules in sync", script: "rules:check" },
  { name: "Plan tables", script: "plans:check" },
  { name: "Harness tests", script: "test:harness" },
  // [/harness]
  // Only after an eject: the kept tests (packs' own, scripts/lib's) under the script eject adds.
  { name: "Tool tests", script: "test:tools", ifPresent: true },
];

// Files bigger than this are never fence-scanned (lockfiles, fixtures); a fence lives in prose or config.
const MAX_SCANNED_BYTES = 2_000_000;

// A JSON file's content, or `fallback` when it doesn't exist.
const readJson = (root, path, fallback) => (existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), "utf8")) : fallback);

// Writes `value` to a JSON file only when it changed, keeping the file's own layout where it can.
//
// First try: drop the lines that held removed array items (`drop.items`) or keys (`drop.keys`),
// then the commas they leave dangling. If that text parses to exactly `value`, write it, so a
// hand-formatted file (settings.json's one-line hook objects) shows only the removed lines. Else
// fall back to a two-space rewrite, which is how package.json is already formatted.
const writeJson = (root, path, value, drop = { items: [], keys: [] }) => {
  const target = join(root, path);
  const before = existsSync(target) ? readFileSync(target, "utf8") : null;
  // Unchanged: no write, no diff.
  if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(value)) return false;
  if (before !== null) {
    const itemLines = new Set(drop.items.map((item) => JSON.stringify(item)));
    const keyPrefixes = drop.keys.map((key) => `${JSON.stringify(key)}:`);
    // A line goes when, minus its trailing comma, it is exactly a dropped item or starts with a dropped key.
    const pruned = before
      .split("\n")
      .filter((line) => {
        const bare = line.trim().replace(/,$/, "");
        return !itemLines.has(bare) && !keyPrefixes.some((prefix) => bare.startsWith(prefix));
      })
      .join("\n")
      .replace(/,(\s*[\]}])/g, "$1");
    // Only keep the minimal edit when it means exactly what we computed.
    let parsed = null;
    try {
      parsed = JSON.parse(pruned);
    } catch {
      parsed = null;
    }
    if (parsed !== null && JSON.stringify(parsed) === JSON.stringify(value)) {
      writeFileSync(target, pruned);
      return true;
    }
  }
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return true;
};

// A pack's manifest path, by name.
const manifestPath = (name) => `${STACKS_DIR}/${name}/pack.json`;

// Orders packs so every pack comes after the ones it requires; a missing requirement is ignored here.
export const orderByRequires = (packs) => {
  const byName = new Map(packs.map((pack) => [pack.name, pack]));
  const ordered = [];
  const seen = new Set();
  // Depth-first: place a pack's requirements, then the pack.
  const visit = (pack) => {
    if (seen.has(pack.name)) return;
    seen.add(pack.name);
    for (const required of pack.requires ?? []) {
      const dependency = byName.get(required);
      if (dependency !== undefined) visit(dependency);
    }
    ordered.push(pack);
  };
  // Name order first, so the result is the same on every machine.
  for (const pack of packs.toSorted((a, b) => a.name.localeCompare(b.name))) visit(pack);
  return ordered;
};

// The packs on disk in this checkout (stacks/*/pack.json), requirements first.
export const presentPacks = (root) => {
  // No stacks dir: a project with no packs, which is allowed.
  if (!existsSync(join(root, STACKS_DIR))) return [];
  const names = readdirSync(join(root, STACKS_DIR)).filter((name) => existsSync(join(root, manifestPath(name))));
  const packs = names.map((name) => {
    const pack = readJson(root, manifestPath(name), null);
    // The directory is the pack's identity (harness sync, removal); a manifest naming another pack is a copy-paste slip.
    if (pack?.name !== name) throw new Error(`${manifestPath(name)} names itself '${String(pack?.name)}'; it must be '${name}'`);
    return pack;
  });
  return orderByRequires(packs);
};

// What a required check name may hold: a CI job name, never a comma (bootstrap-repo.sh splits the
// list on commas) or a quote. A name outside it is refused, not sent half-parsed to a ruleset.
const CHECK_NAME = /^[A-Za-z0-9 ._()-]+$/;

// The CI check names `packs` declare in `requiredChecks`, in pack order, each once.
// bootstrap-repo.sh adds them to the rulesets; removing a pack must take them out again.
export const requiredChecksOf = (packs) => {
  for (const pack of packs) {
    for (const name of pack.requiredChecks ?? []) {
      if (typeof name !== "string" || !CHECK_NAME.test(name)) throw new Error(`stacks/${String(pack.name)}/pack.json requiredChecks has ${JSON.stringify(name)}: a check name is letters, digits, spaces, and . _ ( ) - only`);
    }
  }
  return [...new Set(packs.flatMap((pack) => pack.requiredChecks ?? []))];
};

// `name` plus every present pack that requires it, directly or through another; dependents first.
export const withDependents = (name, packs) => {
  const result = [];
  // Walk down from `name`, collecting each pack that names a collected one in `requires`.
  const visit = (current) => {
    for (const pack of packs) {
      if ((pack.requires ?? []).includes(current) && !result.includes(pack.name)) visit(pack.name);
    }
    if (!result.includes(current)) result.push(current);
  };
  visit(name);
  return result;
};

// A manifest path made safe to delete: repo-relative, plain segments, inside root. Throws otherwise.
//
// A manifest is data from upstream or a hand edit; `""`, `.`, `../x`, or `src/` would otherwise
// reach a recursive delete and take the repo with it.
export const assertSafePath = (root, path) => {
  if (typeof path !== "string" || path === "") throw new Error(`empty path in a pack manifest`);
  if (isAbsolute(path) || path.includes("\\")) throw new Error(`'${path}' must be a repo-relative path with forward slashes`);
  // Every segment a real name: no `.`, `..`, or empty (a trailing or doubled slash).
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`'${path}' must name a file with plain segments (no '.', '..', or trailing '/')`);
  }
  // Belt and braces: the resolved path must still sit under root.
  const rel = relative(resolve(root), resolve(root, path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`'${path}' resolves outside the repo`);
  return path;
};

// Comment wrappers a marker line may sit in: `#`, `//`, `--`, `;`, `<!-- … -->`, `/* … */`.
const COMMENT_WRAPPER = /^(?:<!--|\/\*|\/\/|#|--|;)?\s*(.*?)\s*(?:-->|\*\/)?$/;

// The marker text on a line when the whole trimmed line is a marker in a comment, else "".
export const markerOf = (line) => (COMMENT_WRAPPER.exec(line.trim())?.[1] ?? "").trim();

// Drops every line from a `[stack:<name>]` marker line through its `[/stack:<name>]` marker line.
export const stripFences = (text, name) => stripMarked(text, `stack:${name}`);

// Drops every line from a `[<label>]` marker line through its `[/<label>]` marker line. Shared by
// pack removal (`stack:<name>`) and harness eject (`harness`, scripts/harness-eject.mjs).
//
// A marker counts only as a whole line (inside a comment), so prose that mentions one is left
// alone. Throws on an unclosed, stray, or doubled marker, or both on one line, so a typo never
// deletes the rest of a file.
export const stripMarked = (text, label) => {
  const open = `[${label}]`;
  const close = `[/${label}]`;
  const kept = [];
  let inside = false;
  for (const [index, line] of text.split("\n").entries()) {
    // Both on one line would fence nothing and hide intent; refuse.
    if (line.includes(open) && line.includes(close)) throw new Error(`line ${index + 1}: ${open} and ${close} on one line`);
    const marker = markerOf(line);
    // A marker line is dropped; it only flips the state.
    if (marker === open) {
      if (inside) throw new Error(`line ${index + 1}: ${open} opened twice`);
      inside = true;
      continue;
    }
    if (marker === close) {
      if (!inside) throw new Error(`line ${index + 1}: ${close} with no opening marker`);
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  if (inside) throw new Error(`${open} is never closed`);
  return kept.join("\n");
};

// Every file git would track here (tracked, or new and not ignored), as repo-relative paths.
//
// git, not a disk walk: a walk enters nested worktrees, build output, and `.env` files, and would
// rewrite another checkout's files. Fails loudly when git can't answer.
export const trackedFiles = (root) => {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed in ${root}: ${(result.stderr ?? "").trim() || "not a git repository?"}`);
  // Regular files only: a nested repo shows as a directory, a symlinked node_modules as a link.
  return result.stdout.split("\0").filter((path) => path !== "" && existsSync(join(root, path)) && lstatSync(join(root, path)).isFile());
};

// The tracked text files that carry a marker line for `name`.
const fencedFiles = (root, name) => markedFiles(root, `stack:${name}`);

// The tracked text files that carry a `[<label>]` or `[/<label>]` marker line.
export const markedFiles = (root, label) =>
  trackedFiles(root).filter((path) => {
    if (lstatSync(join(root, path)).size > MAX_SCANNED_BYTES) return false;
    const text = readFileSync(join(root, path), "utf8");
    // A NUL byte means binary; a fence can't live there.
    return !text.includes("\0") && text.split("\n").some((line) => markerOf(line) === `[${label}]` || markerOf(line) === `[/${label}]`);
  });

// Every claim a set of packs makes, by kind, so a removal can leave shared ones alone.
const claimsOf = (packs) => {
  const union = (pick) => new Set(packs.flatMap(pick));
  return {
    files: union((pack) => [...(pack.docs ?? []), ...(pack.code ?? []), ...(pack.owns ?? [])]),
    scripts: union((pack) => pack.packageJson?.scripts ?? []),
    dependencies: union((pack) => pack.packageJson?.dependencies ?? []),
    devDependencies: union((pack) => pack.packageJson?.devDependencies ?? []),
    ignoredBuiltDependencies: union((pack) => pack.packageJson?.ignoredBuiltDependencies ?? []),
    allow: union((pack) => pack.claudeSettings?.allow ?? []),
    plugins: union((pack) => pack.claudeSettings?.plugins ?? []),
  };
};

// The pack's claims minus anything a kept pack also claims: what removing it may really take.
export const exclusiveClaims = (pack, keptPacks) => {
  const kept = claimsOf(keptPacks);
  const mine = claimsOf([pack]);
  const only = (kind) => [...mine[kind]].filter((entry) => !kept[kind].has(entry));
  return {
    files: only("files"),
    scripts: only("scripts"),
    dependencies: only("dependencies"),
    devDependencies: only("devDependencies"),
    ignoredBuiltDependencies: only("ignoredBuiltDependencies"),
    allow: only("allow"),
    plugins: only("plugins"),
  };
};

// package.json without the given scripts, dependencies, and build-approval entries.
export const packageJsonWithout = (pkg, claims) => {
  const next = structuredClone(pkg);
  // Drop the named keys from a map, and the map itself once it is empty.
  const dropKeys = (field, keys) => {
    if (next[field] === undefined) return;
    for (const key of keys) delete next[field][key];
    if (Object.keys(next[field]).length === 0) delete next[field];
  };
  dropKeys("scripts", claims.scripts);
  dropKeys("dependencies", claims.dependencies);
  dropKeys("devDependencies", claims.devDependencies);
  // pnpm's list of packages whose install scripts we decline to run.
  if (Array.isArray(next.pnpm?.ignoredBuiltDependencies)) {
    next.pnpm.ignoredBuiltDependencies = next.pnpm.ignoredBuiltDependencies.filter((name) => !claims.ignoredBuiltDependencies.includes(name));
    if (next.pnpm.ignoredBuiltDependencies.length === 0) delete next.pnpm.ignoredBuiltDependencies;
    if (Object.keys(next.pnpm).length === 0) delete next.pnpm;
  }
  return next;
};

// .claude/settings.json without the given allow-list entries and plugins.
// An emptied plugin map stays as `{}`, so the line-level edit in writeJson can keep the file's layout.
export const settingsWithout = (settings, claims) => {
  const next = structuredClone(settings);
  // Allow-list entries the pack added (its own commands).
  if (Array.isArray(next.permissions?.allow)) {
    next.permissions.allow = next.permissions.allow.filter((entry) => !claims.allow.includes(entry));
  }
  // Plugins the pack turned on (a language server).
  if (next.enabledPlugins !== undefined) {
    for (const plugin of claims.plugins) delete next.enabledPlugins[plugin];
  }
  return next;
};

// Deletes one file (never a directory), then each parent directory it leaves empty, stopping at root.
const removeFile = (root, path) => {
  if (!existsSync(join(root, path))) return false;
  if (!lstatSync(join(root, path)).isFile()) throw new Error(`'${path}' is not a file; a pack lists files, not directories`);
  rmSync(join(root, path));
  // A removed Python file's bytecode cache goes too, even when the folder keeps other files.
  if (path.endsWith(".py")) rmSync(join(root, dirname(path), "__pycache__"), { recursive: true, force: true });
  pruneEmptyParents(root, path);
  return true;
};

// Build-cache folders a tool recreates by itself; a directory holding only these counts as empty.
// Why: once a pack's .gitignore lines are fenced away, its `__pycache__` folders show up as untracked.
const REGENERATED_DIRS = new Set(["__pycache__"]);

// Removes each now-empty parent directory of `path`, up to (not including) root.
const pruneEmptyParents = (root, path) => {
  // Climb while the directory is empty; an empty dir is noise git won't even track.
  for (let parent = dirname(path); parent !== "." && parent !== ""; parent = dirname(parent)) {
    if (!existsSync(join(root, parent))) break;
    // Only regenerated cache folders left: they go, so the directory can.
    const entries = readdirSync(join(root, parent));
    if (entries.length > 0 && entries.every((entry) => REGENERATED_DIRS.has(entry))) {
      for (const entry of entries) rmSync(join(root, parent, entry), { recursive: true });
    }
    if (readdirSync(join(root, parent)).length > 0) break;
    rmdirSync(join(root, parent));
  }
};

// Removes pack `name` and every pack that requires it; returns what changed, for the summary.
// `lockfile: false` skips refreshing pnpm-lock.yaml (tests; no network, no pnpm needed).
export const removePack = (root, name, { lockfile = true } = {}) => {
  const packs = presentPacks(root);
  if (!packs.some((pack) => pack.name === name)) throw new Error(`no pack '${name}' here (${manifestPath(name)} is missing)`);
  // Dependents go first, so a pack is never left requiring one that is gone.
  const names = withDependents(name, packs);
  const removing = names.map((packName) => packs.find((pack) => pack.name === packName));
  const keptPacks = packs.filter((pack) => !names.includes(pack.name));
  // What the removed packs may take: their claims minus every kept pack's.
  const claims = removing.map((pack) => exclusiveClaims(pack, keptPacks));
  const merged = (kind) => [...new Set(claims.flatMap((claim) => claim[kind]))];
  const files = merged("files");
  // Validate every path before touching anything: one bad entry stops the whole removal.
  for (const path of files) assertSafePath(root, path);
  for (const pack of removing) assertSafePath(root, `${STACKS_DIR}/${pack.name}`);
  // Strip fences in memory first: an unbalanced marker stops the removal before any file changes.
  const edits = new Map();
  for (const pack of removing) {
    for (const path of fencedFiles(root, pack.name)) {
      const current = edits.get(path) ?? readFileSync(join(root, path), "utf8");
      try {
        edits.set(path, stripFences(current, pack.name));
      } catch (error) {
        throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
  }
  // Delete the listed files, then each pack's own directory (the one recursive delete, at a fixed path).
  const deleted = [];
  for (const path of files) {
    edits.delete(path);
    if (removeFile(root, path)) deleted.push(path);
  }
  for (const pack of removing) {
    const dir = `${STACKS_DIR}/${pack.name}`;
    for (const path of edits.keys()) if (path.startsWith(`${dir}/`)) edits.delete(path);
    if (existsSync(join(root, dir))) {
      rmSync(join(root, dir), { recursive: true });
      pruneEmptyParents(root, dir);
      deleted.push(`${dir}/`);
    }
  }
  // Write the fence-stripped files; record only the ones whose text changed.
  const edited = [];
  for (const [path, text] of edits) {
    if (readFileSync(join(root, path), "utf8") === text) continue;
    writeFileSync(join(root, path), text);
    edited.push(path);
  }
  const all = { scripts: merged("scripts"), dependencies: merged("dependencies"), devDependencies: merged("devDependencies"), ignoredBuiltDependencies: merged("ignoredBuiltDependencies"), allow: merged("allow"), plugins: merged("plugins") };
  // package.json: scripts and dependencies; remember whether the dependency set moved.
  const pkgBefore = readJson(root, "package.json", null);
  let dependenciesChanged = false;
  if (pkgBefore !== null) {
    const pkgAfter = packageJsonWithout(pkgBefore, all);
    dependenciesChanged = JSON.stringify([pkgBefore.dependencies, pkgBefore.devDependencies]) !== JSON.stringify([pkgAfter.dependencies, pkgAfter.devDependencies]);
    if (writeJson(root, "package.json", pkgAfter, { items: all.ignoredBuiltDependencies, keys: [...all.scripts, ...all.dependencies, ...all.devDependencies] })) edited.push("package.json");
  }
  // .claude/settings.json: the pack's permissions and plugins, keeping the file's layout.
  const settings = readJson(root, ".claude/settings.json", null);
  if (settings !== null && writeJson(root, ".claude/settings.json", settingsWithout(settings, all), { items: all.allow, keys: all.plugins })) {
    edited.push(".claude/settings.json");
  }
  // [harness]
  // harness.project.json: note what was removed, so `stack:list` can tell removed from never installed.
  const project = readJson(root, "harness.project.json", { base: "", skip: {} });
  const removedStacks = [...new Set([...(project.removedStacks ?? []), ...names])].toSorted((a, b) => a.localeCompare(b));
  if (writeJson(root, "harness.project.json", { ...project, removedStacks })) edited.push("harness.project.json");
  // Regenerate .claude/rules and AGENTS.md's block, so removed rules' copies go too.
  if (existsSync(join(root, ".cursor/rules"))) edited.push(...syncClaudeRules(root));
  // [/harness]
  // Refresh the lockfile when dependencies went; say how when pnpm can't.
  let lockfileNote = "";
  if (lockfile && dependenciesChanged && existsSync(join(root, "pnpm-lock.yaml"))) {
    const result = spawnSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "inherit" });
    if (result.status === 0) edited.push("pnpm-lock.yaml");
    else lockfileNote = "pnpm-lock.yaml not refreshed: run `pnpm install --lockfile-only`.";
  }
  // Things the removal can't delete safely (a virtualenv, tool caches): a pack lists them in `leftovers`, we say which still exist.
  const leftovers = removing.flatMap((pack) => pack.leftovers ?? []).filter((path) => existsSync(join(root, assertSafePath(root, path.replace(/\/$/, "")))));
  // A required check the removed CI job no longer reports would block every PR: say which to drop.
  const keptChecks = requiredChecksOf(keptPacks);
  const requiredChecks = requiredChecksOf(removing).filter((check) => !keptChecks.includes(check));
  return { removed: names, deleted, edited: [...new Set(edited)], kept: presentPacks(root).map((pack) => pack.name), lockfileNote, leftovers, requiredChecks };
};

// Runs a package.json script, output straight to the terminal; true when it passed.
// npm, not pnpm: npm ships with Node, so a project with no Node stack needs nothing else.
const runScript = (root, script, { quiet = false } = {}) => spawnSync("npm", ["run", "--silent", script], { cwd: root, stdio: quiet ? "ignore" : "inherit" }).status === 0;

// Runs git; throws with its stderr on a non-zero exit, so a broken repo never reads as "no drift".
const gitOrThrow = (root, args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr ?? "").trim() || `exit ${String(result.status)}`}`);
  return result.stdout;
};

// Regenerates every present pack's generated files; returns { declared, problems }.
//
// A problem is a generator that failed, a declared file missing after generation, one git ignores
// (its drift could never show), or one git sees as changed or untracked.
export const drift = (root, { quiet = false } = {}) => {
  const entries = presentPacks(root).flatMap((pack) => (pack.generated ?? []).map((entry) => ({ pack: pack.name, ...entry })));
  const problems = [];
  for (const entry of entries) {
    for (const path of entry.files) assertSafePath(root, path);
    // Regenerate; a generator that fails is a drift failure too, not a pass.
    if (!runScript(root, entry.script, { quiet })) {
      problems.push(`${entry.pack}: \`${entry.script}\` failed`);
      continue;
    }
    for (const path of entry.files) {
      if (!existsSync(join(root, path))) {
        problems.push(`${entry.pack}: ${path} missing after \`${entry.script}\``);
        continue;
      }
      // check-ignore: 0 = ignored, 1 = not ignored, anything else = git failed.
      const ignored = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: root });
      if (ignored.status === 0) problems.push(`${entry.pack}: ${path} is gitignored, so its drift can't be seen`);
      else if (ignored.status !== 1) throw new Error(`git check-ignore failed on ${path}`);
    }
    // Changed or untracked, as git sees it.
    const status = gitOrThrow(root, ["status", "--porcelain", "--untracked-files=all", "--", ...entry.files]);
    for (const line of status.split("\n").filter(Boolean)) problems.push(`${entry.pack}: ${line.slice(3)} differs from what is committed`);
  }
  return { declared: entries.length, problems };
};

// `list`: each pack upstream ships or this project carries: present, removed, or available.
const list = (root) => {
  const present = presentPacks(root);
  const shipped = readJson(root, "harness.json", {}).stacks ?? [];
  const removed = readJson(root, "harness.project.json", {}).removedStacks ?? [];
  // Union, so a project's own pack and an upstream one not installed both show.
  const names = [...new Set([...present.map((pack) => pack.name), ...shipped, ...removed])];
  for (const name of names) {
    const pack = present.find((candidate) => candidate.name === name);
    const requires = pack?.requires?.length ? ` (requires ${pack.requires.join(", ")})` : "";
    if (pack !== undefined) console.log(`  ${name.padEnd(12)} present    ${pack.kind}${requires}: ${pack.summary ?? ""}`);
    else if (removed.includes(name)) console.log(`  ${name.padEnd(12)} removed`);
    else console.log(`  ${name.padEnd(12)} available  upstream ships it; not installed (stack:add is deferred)`);
  }
  if (names.length === 0) console.log("  no stack packs");
  return 0;
};

// The packs a `--packs` list selects: empty or `all` is every present pack (empty is a failed
// Change scope job, so it fails closed), `none` is no pack, anything else is comma-separated names.
export const selectPacks = (packs, selection = "") => {
  const wanted = selection.trim();
  if (wanted === "" || wanted === "all") return packs;
  if (wanted === "none") return [];
  const names = new Set(wanted.split(",").map((name) => name.trim()));
  return packs.filter((pack) => names.has(pack.name));
};

// Runs each selected pack's checks, all of them; true when every one passed. CI's one pack step.
const runPackChecks = (root, selection) => {
  const failed = [];
  // GitHub folds each check into its own group, so the log reads like separate steps.
  const grouped = process.env.GITHUB_ACTIONS === "true";
  const packs = presentPacks(root);
  const selected = selectPacks(packs, selection);
  // Say what this change skipped, so a green run never hides which checks didn't run.
  const skipped = packs.filter((pack) => !selected.includes(pack)).map((pack) => pack.name);
  if (skipped.length > 0) console.log(`skipped (no path of theirs changed): ${skipped.join(", ")}`);
  for (const pack of selected) {
    for (const step of pack.checks ?? []) {
      console.log(grouped ? `::group::${pack.name}: ${step.name}` : `── ${pack.name}: ${step.name}`);
      const passed = runScript(root, step.script);
      if (grouped) console.log("::endgroup::");
      if (!passed) {
        failed.push(`${pack.name}: ${step.name} (\`${step.script}\`)`);
        if (grouped) console.log(`::error::${pack.name}: ${step.name} failed`);
      }
    }
  }
  if (failed.length > 0) console.error(`✗ stack pack checks failed:\n${failed.map((line) => `  ${line}`).join("\n")}`);
  return failed.length === 0;
};

// `check`: core checks, each present pack's checks, then drift; stops at the first failure.
const check = (root) => {
  const scripts = readJson(root, "package.json", {}).scripts ?? {};
  const core = CORE_CHECKS.filter((step) => !step.ifPresent || scripts[step.script] !== undefined);
  const steps = [...core, ...presentPacks(root).flatMap((pack) => pack.checks ?? [])];
  for (const step of steps) {
    if (!runScript(root, step.script)) {
      console.error(`✗ check: ${step.name} (\`${step.script}\`) failed.`);
      return 1;
    }
  }
  // Generated files last: generators may need what the pack checks just proved.
  return driftCommand(root);
};

// `drift`: prints what differs, or that nothing is declared; exit 1 on any problem.
const driftCommand = (root) => {
  const { declared, problems } = drift(root);
  if (declared === 0) console.log("drift: no generated files declared.");
  if (problems.length === 0) return 0;
  console.error(`✗ generated files differ from what is committed; regenerate and commit:\n${problems.map((line) => `  ${line}`).join("\n")}`);
  return 1;
};

// CLI: `node scripts/stack.mjs <list|remove <name>|check [--packs [<list>]]|drift|required-checks>`, from the repo root.
const main = () => {
  const root = process.cwd();
  const [command = "list", argument, selection] = process.argv.slice(2);
  if (command === "list") return list(root);
  if (command === "check") return argument === "--packs" ? (runPackChecks(root, selection) ? 0 : 1) : check(root);
  if (command === "drift") return driftCommand(root);
  // For bootstrap-repo.sh: empty output when no present pack requires a check.
  if (command === "required-checks") {
    console.log(requiredChecksOf(presentPacks(root)).join(","));
    return 0;
  }
  if (command === "remove" && argument !== undefined) {
    const result = removePack(root, argument);
    console.log(`stack: removed ${result.removed.join(", ")}.`);
    console.log(`  deleted: ${result.deleted.join(", ") || "nothing"}`);
    console.log(`  edited:  ${result.edited.join(", ") || "nothing"}`);
    console.log(`  kept:    ${result.kept.join(", ") || "no packs"}`);
    if (result.lockfileNote !== "") console.log(`  ${result.lockfileNote}`);
    if (result.leftovers.length > 0) console.log(`  delete ${result.leftovers.join(", ")} yourself: untracked build output the removal leaves alone.`);
    // Rulesets live on GitHub, out of the tree's reach; a required check nothing reports blocks every PR forever.
    for (const name of result.requiredChecks) {
      console.log(`  drop the required check "${name}" from the 'main: production' and 'dev: PR and checks' rulesets (Settings → Rules): its CI job is gone, so every PR would wait on it forever (branch-protection.mdc).`);
    }
    console.log("  Next: pnpm check, then a feature branch + draft PR (it changes code and CI).");
    return 0;
  }
  console.error("usage: node scripts/stack.mjs <list|remove <name>|check [--packs [<list>]]|drift|required-checks>");
  return 2;
};

// Run only as a script, so the tests and the hooks can import the pure parts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A refusal (unknown pack, bad manifest path, unbalanced fence) is one line, not a stack trace.
  try {
    process.exit(main());
  } catch (error) {
    console.error(`stack: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
