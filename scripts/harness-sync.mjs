#!/usr/bin/env node
// Keeps a project's harness files (shared rules, skills, guards) in step with whippletree, both ways.
// In the app: nothing at runtime; `pnpm harness:status` / `harness:pull` / `harness:push` by hand, status weekly in CI.
// Used by: package.json, .github/workflows/harness-drift.yml.
// Uses: harness.json + stacks/<name>/pack.json (upstream's file lists), harness.project.json (base, skips), git, gh (push only);
//   tested by scripts/harness-sync.test.mjs.
//
// Harness files are byte-identical in every project; project additions live in companion files
// (`branching.project.mdc`), so a harness file can be copied wholesale. The one piece of state is
// `base` in harness.project.json: the upstream commit this project last took. It turns every file
// into a three-way comparison, so we can tell "upstream moved" (pull it) from "we edited it here"
// (push it) from "both" (merge), instead of guessing and clobbering one side.
//
// Stack packs (docs/decisions/0002-stack-packs.md) list their own harness files in
// stacks/<name>/pack.json. Only packs installed here (their stacks/<name>/ directory exists) are
// compared, so a removed pack is never reported as drift or pulled back, and a pack upstream adds
// later is announced, never half-installed: new packs are opt-in. One exception, adoption: a
// project that predates packs (no stacks/ dir, no `removedStacks`) already holds some packs'
// files. Such a pack counts as installed, so pull writes its pack.json and keeps its files in step
// instead of silently dropping them from sync.
//
//   status  what differs, and which way it should flow; exits 1 when anything does
//   pull    take upstream's changes (three-way merge where both sides edited), move `base`, re-sync rules
//   push    open a draft PR on upstream `dev` with this project's edits, merged onto upstream `dev`

// Node builtins only, so it runs before `pnpm install` and in a bare CI job.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The upstream's list of harness files; it syncs like any other harness file.
const MANIFEST = "harness.json";

// This project's own state: the upstream commit last taken and the files it opts out of.
const PROJECT_FILE = "harness.project.json";

// Runs git and returns stdout; throws on a non-zero exit so a failed step never passes silently.
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A file's content at a commit, or null when it isn't there.
const show = (clone, ref, path) => {
  // `git show` exits non-zero for a missing path; that is an answer, not an error.
  const result = spawnSync("git", ["show", `${ref}:${path}`], { cwd: clone, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
};

// A local file's content, or null when it doesn't exist.
const readLocal = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);

// True when `path` is skipped: the key names the file itself or a directory above it.
export const isSkipped = (path, skip) =>
  Object.keys(skip).some((key) => path === key || path.startsWith(key.endsWith("/") ? key : `${key}/`));

// Which way one file should flow, from its three versions (null = absent).
//   same      nothing to do
//   upstream  only upstream changed since base: pull takes it
//   local     only this project changed it: push offers it
//   both      both changed: pull merges, push merges onto upstream dev
//   unknown   no base recorded yet: pull takes upstream (first adoption)
export const classify = ({ ours, base, theirs, hasBase }) => {
  // Already identical: the common case.
  if (ours === theirs) return "same";
  // No base: we can't tell who moved.
  if (!hasBase) return "unknown";
  // Untouched here since base, so the difference is upstream's.
  if (ours === base) return "upstream";
  // Upstream hasn't touched it since base, so the difference is ours.
  if (theirs === base) return "local";
  // Both sides moved.
  return "both";
};

// Three-way text merge via `git merge-file`; returns { text, conflicts }.
const merge = (ours, base, theirs) => {
  // merge-file works on files, so stage the three versions in a scratch dir.
  const dir = mkdtempSync(join(tmpdir(), "harness-merge-"));
  const [o, b, t] = ["ours", "base", "theirs"].map((name) => join(dir, name));
  writeFileSync(o, ours ?? "");
  writeFileSync(b, base ?? "");
  writeFileSync(t, theirs ?? "");
  // -p prints the result; the exit code is the number of conflicts (negative on error).
  const result = spawnSync("git", ["merge-file", "-p", "-L", "this project", "-L", "base", "-L", "upstream", o, b, t], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (result.status === null || result.status < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
  return { text: result.stdout, conflicts: result.status };
};

// Clones upstream (all branches, no blobs until read) into a scratch dir; returns its path.
// HARNESS_UPSTREAM_URL points it at another clone (a local path works), for trying a change before it ships.
// HARNESS_TOKEN reads a private upstream from CI, where no git credential helper is set up.
const cloneUpstream = (upstream) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-upstream-"));
  const token = process.env.HARNESS_TOKEN ?? "";
  const url = (process.env.HARNESS_UPSTREAM_URL ?? "") || `https://${token === "" ? "" : `x-access-token:${token}@`}github.com/${upstream}.git`;
  // Blobless keeps it fast; `git show` fetches only the files we read.
  git(["clone", "--quiet", "--filter=blob:none", "--no-checkout", url, dir]);
  return dir;
};

// The GitHub slug (owner/name) of this repo's origin, or "" when it can't be read.
const originSlug = (root) => {
  // Absent remote or odd URL: not fatal, it only decides whether we are the upstream.
  try {
    return git(["remote", "get-url", "origin"], root).trim().replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
};

// Upstream's packs: installed here (`isPresent`), adopted (not installed but `canAdopt`), or available.
// `kept` (installed + adopted) is what gets compared; `available` is only announced.
export const splitPacks = (manifest, isPresent, canAdopt = () => false) => {
  const shipped = manifest.stacks ?? [];
  const adopted = shipped.filter((name) => !isPresent(name) && canAdopt(name));
  return {
    kept: shipped.filter((name) => isPresent(name) || adopted.includes(name)),
    adopted,
    available: shipped.filter((name) => !isPresent(name) && !adopted.includes(name)),
  };
};

// True when a project that predates packs already holds any of `pack`'s harness files outside its
// own stacks/<name>/ dir (habit's TypeScript rule and compiler baseline): those files were synced
// before packs existed, and must keep syncing. A pack whose files are generic (rustfmt.toml,
// clippy.toml, a Makefile, a rule named for its topic like infra.mdc) names the ones only it would
// have in `adoptOn`, so a project that merely has a rustfmt.toml, or its own infra.mdc, doesn't
// adopt a pack it never used (and get conflict markers in its rule). An empty `adoptOn` means the
// pack has no such file, so it is never adopted: it postdates packs, so no pre-pack project holds it.
export const holdsPackFiles = (root, name, pack) =>
  (pack.adoptOn ?? [...(pack.docs ?? []), ...(pack.code ?? [])]).some((path) => !path.startsWith(`stacks/${name}/`) && existsSync(join(root, path)));

// Tags each path with its group: docs can go straight to dev, code needs a PR.
const tag = (paths, group) => (paths ?? []).map((path) => ({ path, group }));

// Every harness path with its group: the core lists, then each kept pack's manifest and files.
// `packs` maps a kept pack's name to its pack.json.
export const harnessPaths = (manifest, packs) => {
  // A manifest is code: it decides which files get deleted and what CI and the edit hook run.
  const packPaths = Object.entries(packs).flatMap(([name, pack]) => [
    ...tag(pack.docs, "docs"),
    ...tag([`stacks/${name}/pack.json`, ...(pack.code ?? [])], "code"),
  ]);
  return [...tag(manifest.docs, "docs"), ...tag(manifest.code, "code"), ...packPaths];
};

// Every harness file's three versions and verdict, for this project against upstream `ref`.
const compare = (root, clone, ref, project, command) => {
  // A branch upstream doesn't have would read as an empty manifest, so "in step" with nothing compared: refuse it.
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `origin/${ref}`], { cwd: clone }).status !== 0) {
    throw new Error(`harness: upstream has no branch ${ref} (harness.json → ref, or --ref)`);
  }
  // The file lists are upstream's, so a file upstream adds reaches every project.
  const manifest = JSON.parse(show(clone, `origin/${ref}`, MANIFEST) ?? "{}");
  const hasBase = typeof project.base === "string" && project.base !== "";
  // Each upstream pack's manifest, read once; a pack upstream lists but hasn't built is skipped.
  const upstreamPacks = Object.fromEntries(
    (manifest.stacks ?? [])
      .map((name) => [name, JSON.parse(show(clone, `origin/${ref}`, `stacks/${name}/pack.json`) ?? "null")])
      .filter(([, pack]) => pack !== null),
  );
  // Adoption only for a project that has never recorded packs: once stacks/ or removedStacks exists, disk decides.
  const predatesPacks = !existsSync(join(root, "stacks")) && project.removedStacks === undefined;
  const { kept, adopted, available } = splitPacks(
    { stacks: Object.keys(upstreamPacks) },
    (name) => existsSync(join(root, "stacks", name)),
    (name) => predatesPacks && holdsPackFiles(root, name, upstreamPacks[name]),
  );
  // Say what happens to each pack not installed yet; neither line fails anything.
  const verb = command === "pull" ? "adopted" : "would adopt";
  for (const name of adopted) console.log(`harness: ${verb} pack ${name}: its files were already here`);
  for (const name of available) console.log(`harness: upstream ships pack ${name}, not installed (stack:add is deferred)`);
  const packs = Object.fromEntries(kept.map((name) => [name, upstreamPacks[name]]));
  return harnessPaths(manifest, packs)
    .filter(({ path }) => !isSkipped(path, project.skip ?? {}))
    .map(({ path, group }) => {
      const ours = readLocal(root, path);
      const base = hasBase ? show(clone, project.base, path) : null;
      const theirs = show(clone, `origin/${ref}`, path);
      return { path, group, ours, base, theirs, verdict: classify({ ours, base, theirs, hasBase }) };
    });
};

// One line per file that isn't `same`, with the arrow that says which way it flows.
const ARROWS = { upstream: "↓ upstream changed", local: "↑ edited here     ", both: "↕ both changed    ", unknown: "? no base yet      " };
const report = (rows) => rows.filter((row) => row.verdict !== "same").map((row) => `  ${ARROWS[row.verdict]}  ${row.path}`);

// `status`: print what differs; exit 1 when anything does, so CI can flag drift.
const status = (rows, ref, upstream) => {
  const lines = report(rows);
  if (lines.length === 0) {
    console.log(`harness: in step with ${upstream}@${ref}.`);
    return 0;
  }
  console.log(`harness: ${lines.length} file(s) differ from ${upstream}@${ref}:\n${lines.join("\n")}`);
  console.log("  ↓ / ↕ / ?: pnpm harness:pull    ↑ / ↕: pnpm harness:push");
  return 1;
};

// `pull`: write upstream's changes (merging where both sides edited), move base, regenerate rules.
const pull = (root, clone, rows, ref, project) => {
  const written = [];
  const conflicted = [];
  for (const row of rows) {
    // Ours-only edits stay; push offers them upstream.
    if (row.verdict === "same" || row.verdict === "local") continue;
    // Upstream removed it: leave the local copy and say so, rather than deleting a file.
    if (row.theirs === null) {
      console.log(`  upstream no longer has ${row.path}; left in place`);
      continue;
    }
    // Both edited: three-way merge; conflict markers stay in the file for a human.
    const { text, conflicts } = row.verdict === "both" ? merge(row.ours, row.base, row.theirs) : { text: row.theirs, conflicts: 0 };
    mkdirSync(dirname(join(root, row.path)), { recursive: true });
    writeFileSync(join(root, row.path), text);
    written.push(row);
    if (conflicts > 0) conflicted.push(row.path);
  }
  // Record the upstream commit we now stand on, keeping the skips as they were.
  const head = git(["rev-parse", `origin/${ref}`], clone).trim();
  writeFileSync(join(root, PROJECT_FILE), `${JSON.stringify({ ...project, base: head }, null, 2)}\n`);
  // Regenerate Claude's rule copies and AGENTS.md's block from the new .mdc files.
  if (existsSync(join(root, "scripts/sync-claude-rules.mjs"))) {
    execFileSync(process.execPath, [join(root, "scripts/sync-claude-rules.mjs")], { cwd: root, stdio: "inherit" });
  }
  // Tell the human how to land it: docs-only goes straight to dev, anything else is a PR.
  const code = written.filter((row) => row.group === "code").map((row) => row.path);
  console.log(`harness: pulled ${written.length} file(s) from ${ref} (${head.slice(0, 7)}).`);
  if (conflicted.length > 0) console.log(`  Resolve conflict markers in:\n${conflicted.map((path) => `    ${path}`).join("\n")}`);
  console.log(code.length > 0 ? `  Code changed (${code.join(", ")}): feature branch + draft PR.` : "  Docs only: commit on dev with [skip ci].");
  return conflicted.length > 0 ? 1 : 0;
};

// `push`: this project's edits, merged onto upstream `dev`, as a draft PR there.
const push = (root, clone, rows, project, upstream) => {
  // Without a base we can't tell our edits from upstream's, and would revert theirs.
  if (typeof project.base !== "string" || project.base === "") {
    console.error(`harness: no base in ${PROJECT_FILE}; run pnpm harness:pull first.`);
    return 1;
  }
  const edited = rows.filter((row) => row.verdict === "local" || row.verdict === "both");
  if (edited.length === 0) {
    console.log("harness: no local edits to push.");
    return 0;
  }
  // Merge each edit onto upstream dev (not onto `ref`, should --ref name another branch), so the PR reverts nothing.
  const merged = edited.map((row) => ({ ...row, ...merge(row.ours, row.base, show(clone, "origin/dev", row.path)) }));
  const conflicted = merged.filter((row) => row.conflicts > 0).map((row) => row.path);
  if (conflicted.length > 0) {
    console.error(`harness: these conflict with upstream dev; pull first, then push:\n${conflicted.map((path) => `  ${path}`).join("\n")}`);
    return 1;
  }
  // Branch off upstream dev, named for this project and the minute, so reruns never collide.
  const projectName = basename(originSlug(root) || root);
  const branch = `harness/${projectName}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  git(["checkout", "--quiet", "-b", branch, "origin/dev"], clone);
  for (const row of merged) {
    mkdirSync(dirname(join(clone, row.path)), { recursive: true });
    writeFileSync(join(clone, row.path), row.text);
  }
  // Regenerate upstream's own .claude/rules and AGENTS.md block, or its CI fails on rule drift.
  if (existsSync(join(clone, "scripts/sync-claude-rules.mjs"))) {
    execFileSync(process.execPath, [join(clone, "scripts/sync-claude-rules.mjs")], { cwd: clone, stdio: "ignore" });
  }
  // Nothing staged means our edits were already on dev.
  git(["add", "--", ...merged.map((row) => row.path), ".claude/rules", "AGENTS.md"], clone);
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: clone }).status === 0) {
    console.log("harness: upstream dev already has these edits.");
    return 0;
  }
  git(["commit", "--quiet", "-m", `harness: changes from ${projectName}`], clone);
  git(["push", "--quiet", "-u", "origin", branch], clone);
  // Draft, per branching.mdc; the user reviews what the project changed before it reaches every project.
  const body = `Harness edits made in \`${projectName}\`, merged onto \`dev\`:\n\n${merged.map((row) => `- \`${row.path}\``).join("\n")}\n\nCheck nothing project-specific leaked in: project additions belong in \`*.project.mdc\`.`;
  execFileSync("gh", ["pr", "create", "--draft", "--repo", upstream, "--base", "dev", "--head", branch, "--title", `harness: changes from ${projectName}`, "--body", body], { stdio: "inherit" });
  return 0;
};

// CLI: `node scripts/harness-sync.mjs <status|pull|push> [--ref <branch>]`, from the repo root.
const main = () => {
  const root = process.cwd();
  const command = process.argv[2] ?? "status";
  const refFlag = process.argv.indexOf("--ref");
  // The project's state file; absent means nothing skipped and no base yet.
  const project = existsSync(join(root, PROJECT_FILE)) ? JSON.parse(readFileSync(join(root, PROJECT_FILE), "utf8")) : { base: "", skip: {} };
  // Upstream and the branch to sync with (`ref`, dev: the branch a template copy is made from) come from
  // the local manifest; the file list comes from upstream's.
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const upstream = manifest.upstream;
  const ref = refFlag > 0 ? (process.argv[refFlag + 1] ?? manifest.ref) : manifest.ref;
  // Running inside the upstream itself: there is nothing to sync against.
  if (originSlug(root) === upstream) {
    console.log(`harness: this is ${upstream}; nothing to sync.`);
    return 0;
  }
  if (!["status", "pull", "push"].includes(command)) {
    console.error("usage: node scripts/harness-sync.mjs <status|pull|push> [--ref <branch>]");
    return 2;
  }
  const clone = cloneUpstream(upstream);
  // Always clean the scratch clone, whatever the command did.
  try {
    const rows = compare(root, clone, ref, project, command);
    if (command === "pull") return pull(root, clone, rows, ref, project);
    if (command === "push") return push(root, clone, rows, project, upstream);
    return status(rows, ref, upstream);
  } catch (error) {
    // Our own refusals ("harness: …") are an answer for the human, not a crash: print them, exit 1.
    if (error instanceof Error && error.message.startsWith("harness: ")) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
};

// Run only as a script, so the test can import the pure parts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
