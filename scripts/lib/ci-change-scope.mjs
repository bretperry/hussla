#!/usr/bin/env node
// Classifies this CI event's changed paths: does the heavy tier (build, e2e) need to run, and which packs' checks?
// In the app: nothing at runtime; the "Change scope" job in .github/workflows/ci.yml runs it.
// Used by: ci.yml (`heavy` and `packs` outputs); tested by scripts/lib/ci-change-scope.test.mjs.
// Uses: git diff (-z, no renames); stacks/*/pack.json `ciHeavy` (via scripts/stack.mjs); GITHUB_OUTPUT, GITHUB_EVENT_NAME, PR_BASE_SHA, PR_BASE_REF, BEFORE_SHA, AFTER_SHA.
//
// Cheap checks always run. Heavy jobs skip, via job-level `if:`, when no path that can break
// them changed. The workflow itself still triggers on every PR so required checks report: a
// skipped job counts as passing, a workflow that never ran leaves the PR stuck (branching.mdc).
// Checks always runs, but its "Stack pack checks" step runs only the packs `packs` names: about
// 60% of a Checks run, paid on every PR for packs a skill or rule edit can't touch.
// Fails closed: any error collecting or classifying writes heavy=true packs=all and exits 0, so a broken
// classifier bills minutes rather than silently skipping a gate. Ported from habit's
// ci-change-scope.sh + ci_change_scope.py, collapsed to one tier until a project needs more.

// Node builtins only, plus the harness's own pack reader: this runs before `pnpm install`.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { presentPacks, withDependents } from "../stack.mjs";

// Knob: directories whose contents can break the heavy tier. Trailing slash so a root file
// with the same name can't match by accident. Add a project's app dirs here (apple/, desktop/ …).
const HEAVY_PREFIXES = ["src/", "public/", "e2e/", "prisma/", ".github/actions/"];

// Knob: single files that feed the build or e2e. The classifier and ci.yml are here so a change
// to what gates the heavy tier is verified by actually running it.
const HEAVY_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  ".nvmrc",
  "Dockerfile",
  "playwright.config.ts",
  "scripts/lib/ci-change-scope.mjs",
  "scripts/stack.mjs",
  ".github/workflows/ci.yml",
]);

// A pack manifest decides what CI runs and which paths are heavy, so changing one is verified by running it.
const PACK_MANIFEST = /^stacks\/[^/]+\/pack\.json$/;

// Root framework configs (next.config.ts, vite.config.ts …) feed the build.
const ROOT_BUILD_CONFIG = /^[a-z]+\.config\.[cm]?[jt]s$/;

// Each present stack pack's own build inputs (`ciHeavy` regexes), so a pack's compiler config wakes the tier.
export const packPatterns = (root) => presentPacks(root).flatMap((pack) => (pack.ciHeavy ?? []).map((source) => new RegExp(source)));

// True when any changed path can affect the heavy tier. An empty list is "nothing changed".
export const classify = (paths, patterns = []) =>
  paths.some(
    (path) =>
      HEAVY_FILES.has(path) ||
      ROOT_BUILD_CONFIG.test(path) ||
      PACK_MANIFEST.test(path) ||
      HEAVY_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      patterns.some((pattern) => pattern.test(path)),
  );

// Docs-only paths (branching.mdc → docs-only, the same list .githooks/pre-push skips): prose no
// pack check reads, so a change made only of these runs no pack's checks.
const DOCS_ONLY = /^(docs\/|\.cursor\/rules\/|\.claude\/(skills|rules)\/|[^/]+\.md$|harness(\.project)?\.json$)/;

// True when `path` is one of `pack`'s own files: under stacks/<name>/, in its `owns` or `code`
// list, or matching its `ciHeavy` patterns. A pack manifest is never "own": it changes what CI runs.
const ownedBy = (pack, path) =>
  (path.startsWith(`stacks/${pack.name}/`) && !PACK_MANIFEST.test(path)) ||
  (pack.owns ?? []).includes(path) ||
  (pack.code ?? []).includes(path) ||
  (pack.ciHeavy ?? []).some((source) => new RegExp(source).test(path));

// Which present packs' checks this change needs: "all", or the names (maybe none). Docs-only
// paths need none; a path only packs own needs those packs, plus every pack that requires one
// of them; any other path (harness scripts, package.json, ci.yml, a new src/ file no pack lists)
// can reach every pack, so it needs all. Fails toward "all", like `heavy`.
export const packsToCheck = (paths, packs) => {
  const names = new Set();
  for (const path of paths) {
    if (DOCS_ONLY.test(path)) continue;
    const owners = packs.filter((pack) => ownedBy(pack, path));
    if (owners.length === 0) return "all";
    // A pack that requires an owner builds on it (react on typescript), so it runs too.
    for (const pack of owners) for (const name of withDependents(pack.name, packs)) names.add(name);
  }
  return packs.filter((pack) => names.has(pack.name)).map((pack) => pack.name);
};

// Changed paths between two revisions, as git spells them on disk. `-z` with core.quotePath off:
// git otherwise C-quotes a non-ASCII path (`"src/na\303\257ve.ts"`), which no prefix matches, so a
// heavy change would skip the tier. `--no-renames`: a move lists both sides, so moving a file *out*
// of a heavy dir still counts the dir it left. Shared with each stack pack's own CI
// scope (Swift's today). git's own failure throws and fails closed upstream.
export const diffPaths = (args, cwd = process.cwd()) =>
  execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "-z", ...args], { cwd, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

// Changed paths for this event: three-dot on PRs (what the branch changed), two-dot on push.
export const changedPaths = (env, cwd = process.cwd()) => {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    // PR_BASE_SHA is the base branch tip the PR is measured against.
    if (!env.PR_BASE_SHA) throw new Error("PR_BASE_SHA is empty");
    return diffPaths([`${env.PR_BASE_SHA}...HEAD`], cwd);
  }
  if (env.GITHUB_EVENT_NAME === "push") {
    // An all-zero BEFORE_SHA is a new branch: no parent to diff against.
    if (!env.BEFORE_SHA || /^0+$/.test(env.BEFORE_SHA)) throw new Error("push has no parent SHA to diff");
    return diffPaths([env.BEFORE_SHA, env.AFTER_SHA || "HEAD"], cwd);
  }
  throw new Error(`unsupported event '${env.GITHUB_EVENT_NAME ?? ""}'`);
};

// Job entry point: writes `heavy=true|false` and `packs=all|none|<name,name>` to GITHUB_OUTPUT.
const main = () => {
  // Without GITHUB_OUTPUT the workflow can't see the answer; fail loud, since "closed" would
  // mean writing to a file that doesn't exist.
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.error("ci-change-scope: GITHUB_OUTPUT is unset; refusing to guess.");
    process.exit(1);
  }

  // Writes the answer and logs it for whoever reads the job. `none`, never empty, for no packs:
  // ci.yml reads an empty `packs` (this job failed) as "all".
  const emit = (heavy, packs = "all") => {
    const list = packs === "all" ? "all" : packs.join(",") || "none";
    appendFileSync(output, `heavy=${heavy}\npacks=${list}\n`);
    console.log(`scope: heavy=${heavy} packs=${list}`);
  };

  // A manual dispatch is "I want the full signal", whatever changed.
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    console.log("ci-change-scope: workflow_dispatch → full suite.");
    emit(true);
    return;
  }

  // Classify, or fail closed on any error.
  try {
    const paths = changedPaths(process.env);
    console.log(`ci-change-scope: ${paths.length} changed path(s):\n${paths.map((path) => `  ${path}`).join("\n")}`);
    // A PR into main is the release gate: every pack runs there, whatever changed.
    const packs = process.env.PR_BASE_REF === "main" ? "all" : packsToCheck(paths, presentPacks(process.cwd()));
    emit(classify(paths, packPatterns(process.cwd())), packs);
  } catch (error) {
    console.error(`ci-change-scope: ${error instanceof Error ? error.message : String(error)}; running everything (fail closed).`);
    emit(true);
  }
};

// Run only as a script, so the tests (and other packs' scopes) can import classify() and changedPaths().
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
