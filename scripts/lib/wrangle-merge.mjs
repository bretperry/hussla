#!/usr/bin/env node
// Burst-merges a batch of PRs into dev, but only once each one is really green.
// In the app: nothing at runtime. The wrangler runs it at merge time (wrangler.mdc → Merge mechanically).
// Used by: `node scripts/lib/wrangle-merge.mjs 165 166 168 [--wait-minutes 55] [--partial] [--dry-run] [--ship]`;
//   tested by scripts/lib/wrangle-merge.test.mjs; scripts/command-guard.mjs asks before a real run.
// Uses: the `gh` CLI (subprocess); scripts/lib/ci-change-scope.mjs → classify(), packPatterns();
//   each present pack's `heavyChecks` (stacks/*/pack.json, via scripts/stack.mjs). Node builtins otherwise.
//
// Ported from habit's scripts/lib/wrangle_merge.py. Why a script: habit merged batches with ad-hoc
// shell, and a zsh word-splitting bug merged nothing, macOS bash 3.2 has no associative arrays, and
// one PR went back to draft and another was closed mid-batch. The subtle one is the stale draft run:
// right after the user clicks Ready, the draft run still reads all green (heavy jobs `skipping`)
// until the ready run registers, so "every check passes" alone would merge untested code.
//
// Rules, per PR:
// - base is `dev` (`main` only with --ship); OPEN, not draft, not conflicting.
// - no check pending; every check pass or skipping.
// - each heavy check its changed paths need must be `pass`. A missing or `skipping` heavy check is
//   the stale draft run, so keep waiting. Heavy checks: HEAVY_CHECKS below (ci.yml's Build, woken by
//   the same classifier as the Change scope job) plus each present pack's `heavyChecks`
//   (`{ name, scope }`: the job's name and a module exporting `classify(paths)` for when it runs).
// - all of the above on the same head for STABLE_POLLS polls in a row. The head is then pinned.
// Right before each merge: re-check everything, plus head == pinned, then merge with
// --match-head-commit, so a push between the check and the merge still can't land. The merge is
// confirmed by re-reading the PR's state, not by `gh pr merge`'s exit code, which is 0 for
// "already merged" and for at least one GraphQL rejection that leaves the PR open.
//
// All-or-nothing by default: if the wait ends with any PR unqualified, nothing merges. Never runs
// `gh pr ready`. Merge commits, back-to-back.
//
// --ship is the only way to reach base `main`: exactly one PR, and every heavy check is required
// rather than asking the classifiers (a PR into main runs every heavy job, so a docs-only ship
// would otherwise merge on the cheap checks alone). Merging it deploys production.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { presentPacks } from "../stack.mjs";
import { classify, packPatterns } from "./ci-change-scope.mjs";

// Knobs. The batch base, and the ship base guarded behind --ship: merging into it deploys
// production, so it must never be reachable by a typo in a list of PR numbers.
const BASE_BRANCH = "dev";
const SHIP_BASE_BRANCH = "main";
export const STABLE_POLLS = 3;
const DEFAULT_WAIT_MINUTES = 55;
const DEFAULT_POLL_SECONDS = 30;

// Knob: the core heavy checks, by ci.yml job `name:`. The cheap ones (Checks, Change scope …) are
// covered by "every check pass or skipping". Add a project's e2e job here with the classifier its
// `if:` reads.
const HEAVY_CHECKS = [{ name: "Build", classify: (paths, root) => classify(paths, packPatterns(root)) }];

// One shell-free process call; `gh`'s exit code is only a hint (see fetch and merge).
const defaultRun = (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message || "") };
};

const short = (sha) => (sha || "?").slice(0, 7);

// Every heavy check this checkout has: the core ones plus each present pack's `heavyChecks`, its
// `scope` module imported for its classify(). A pack whose scope module lacks one fails loud here.
export const loadHeavyChecks = async (root) => {
  const checks = HEAVY_CHECKS.map((check) => ({ name: check.name, classify: (paths) => check.classify(paths, root) }));
  for (const pack of presentPacks(root)) {
    for (const spec of pack.heavyChecks ?? []) {
      const mod = await import(pathToFileURL(join(root, spec.scope)).href);
      if (typeof mod.classify !== "function") throw new Error(`stacks/${pack.name}/pack.json heavyChecks: ${spec.scope} exports no classify(paths)`);
      checks.push({ name: spec.name, classify: (paths) => mod.classify(paths) });
    }
  }
  return checks;
};

// Heavy check names the given changed paths make mandatory. null (unknown) needs all of them.
export const requiredHeavy = (paths, checks) => checks.filter((check) => paths === null || check.classify(paths)).map((check) => check.name);

// A draft run and a ready run on one head can both be listed. Keep the newest per (workflow, name),
// so a superseded draft `skipping` can't mask the ready run.
export const latestPerCheck = (rows) => {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.workflow ?? ""}\u0000${row.name ?? ""}`;
    const prev = latest.get(key);
    if (prev === undefined || (row.startedAt ?? "") >= (prev.startedAt ?? "")) latest.set(key, row);
  }
  return [...latest.values()];
};

// One read of a PR: its state plus its checks on the current head. `wantBase` is per run, never
// per PR: a batch is feature PRs into dev or the one ship PR into main, never a mix.
const fetchPr = (number, run, wantBase = BASE_BRANCH) => {
  const snap = { number, state: "?", draft: true, head: "", base: "", mergeable: "UNKNOWN", checks: [], error: "", wantBase };
  const view = run(["gh", "pr", "view", String(number), "--json", "number,state,isDraft,headRefOid,baseRefName,mergeable"]);
  if (view.status !== 0) return { ...snap, error: `gh pr view failed: ${view.stderr.trim() || view.status}` };
  let data;
  try {
    data = JSON.parse(view.stdout);
  } catch {
    return { ...snap, error: "gh pr view returned non-JSON" };
  }
  Object.assign(snap, {
    state: data.state ?? "?",
    draft: data.isDraft ?? true,
    head: data.headRefOid ?? "",
    base: data.baseRefName ?? "",
    mergeable: data.mergeable ?? "UNKNOWN",
  });
  // Non-zero exit is normal here (8 = pending, 1 = failing or none reported yet). Trust the JSON
  // when there is some; no JSON means no checks yet, which reads pending.
  const checks = run(["gh", "pr", "checks", String(number), "--json", "name,bucket,state,workflow,startedAt"]);
  try {
    snap.checks = latestPerCheck(checks.stdout.trim() ? JSON.parse(checks.stdout) : []);
  } catch {
    return { ...snap, error: "gh pr checks returned non-JSON" };
  }
  return snap;
};

// Why waiting can't help (closed, merged, wrong base), or "" if it might.
const terminal = (snap) => {
  if (snap.error) return "";
  if (snap.state !== "OPEN") return `PR is ${snap.state}`;
  if (snap.base !== snap.wantBase) return `base is '${snap.base}', not '${snap.wantBase}'; refusing`;
  return "";
};

// The PR's changed paths, or null if gh can't say (the caller then requires every heavy check).
const changedPaths = (number, run) => {
  const diff = run(["gh", "pr", "diff", String(number), "--name-only"]);
  if (diff.status !== 0) return null;
  return diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
};

// Reasons this PR can't merge right now. Empty means ready on this poll.
export const verdict = (snap, heavy) => {
  if (snap.error) return [snap.error];
  if (terminal(snap)) return [terminal(snap)];
  const reasons = [];
  if (snap.draft) reasons.push("draft");
  if (snap.mergeable === "CONFLICTING") reasons.push(`merge conflict with ${snap.wantBase}`);
  if (snap.checks.length === 0) reasons.push("no checks reported yet");
  const byName = new Map();
  for (const row of snap.checks) byName.set(row.name ?? "", [...(byName.get(row.name ?? "") ?? []), row.bucket ?? ""]);
  const pending = [...byName].filter(([, buckets]) => buckets.includes("pending")).map(([name]) => name).toSorted((a, b) => a.localeCompare(b));
  const bad = [...byName]
    .filter(([, buckets]) => buckets.some((bucket) => !["pass", "skipping", "pending"].includes(bucket)))
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));
  if (pending.length > 0) reasons.push(`pending: ${pending.join(", ")}`);
  if (bad.length > 0) reasons.push(`failing: ${bad.join(", ")}`);
  for (const name of heavy) {
    const buckets = byName.get(name);
    if (!buckets) reasons.push(`${name} not reported (heavy)`);
    else if (!pending.includes(name) && !bad.includes(name) && !buckets.includes("pass")) reasons.push(`${name} ${buckets.join("/")} (heavy, needs pass)`);
  }
  return reasons;
};

const scopeLabel = (heavy) => (heavy.length > 0 ? heavy.join(", ") : "none (cheap checks only)");

// Polls a set of PRs until each has been ready for STABLE_POLLS polls, then merges them.
class Batch {
  constructor(numbers, { checks, run = defaultRun, clock = () => performance.now() / 1000, sleep = (s) => new Promise((done) => setTimeout(done, s * 1000)), out = console.log, ship = false }) {
    Object.assign(this, { numbers, checks, run, clock, sleep, out, ship });
    this.wantBase = ship ? SHIP_BASE_BRANCH : BASE_BRANCH;
    this.heavyCache = new Map();
  }

  // The ship asks for every heavy check, not the paths (see the header). Otherwise keyed by head:
  // a new push can change the path class.
  heavyFor(snap) {
    if (this.ship) return this.checks.map((check) => check.name);
    const key = `${snap.number}@${snap.head}`;
    if (!this.heavyCache.has(key)) this.heavyCache.set(key, requiredHeavy(changedPaths(snap.number, this.run), this.checks));
    return this.heavyCache.get(key);
  }

  check(number) {
    const snap = fetchPr(number, this.run, this.wantBase);
    const heavy = snap.error || terminal(snap) ? [] : this.heavyFor(snap);
    return { snap, heavy, reasons: verdict(snap, heavy) };
  }

  dryRun() {
    for (const n of this.numbers) {
      const { snap, heavy, reasons } = this.check(n);
      const head = `base=${snap.base || "?"} head=${short(snap.head)} heavy=${scopeLabel(heavy)}`;
      if (reasons.length > 0) this.out(`#${n} NOT READY (${head}): ${reasons.join("; ")}`);
      else this.out(`#${n} ready now (${head}); a real run still waits ${STABLE_POLLS} stable polls`);
    }
    this.out("dry run: nothing merged");
    return 0;
  }

  // Returns { pinned: Map(number → head), unqualified: Map(number → last reasons) }.
  async wait(waitSeconds, pollSeconds, partial) {
    const deadline = this.clock() + waitSeconds;
    const pinned = new Map();
    const streak = new Map(this.numbers.map((n) => [n, 0]));
    const lastHead = new Map();
    const reasons = new Map();
    const dead = new Set();
    const lastLine = new Map();
    for (;;) {
      for (const n of this.numbers) {
        if (pinned.has(n) || dead.has(n)) continue;
        const { snap, heavy, reasons: why } = this.check(n);
        if (terminal(snap)) dead.add(n);
        let line;
        if (why.length > 0) {
          streak.set(n, 0);
          reasons.set(n, why);
          line = `#${n} waiting: ${why.join("; ")}`;
        } else {
          streak.set(n, lastHead.get(n) === snap.head ? streak.get(n) + 1 : 1);
          reasons.set(n, [`ready ${streak.get(n)}/${STABLE_POLLS} polls, not yet stable`]);
          line = `#${n} ready ${streak.get(n)}/${STABLE_POLLS} head ${short(snap.head)} heavy ${scopeLabel(heavy)}`;
        }
        lastHead.set(n, snap.head);
        if (line !== lastLine.get(n)) {
          this.out(line);
          lastLine.set(n, line);
        }
        if (streak.get(n) >= STABLE_POLLS) {
          pinned.set(n, snap.head);
          reasons.delete(n);
          this.out(`#${n} QUALIFIED head ${short(snap.head)}`);
        }
      }
      const remaining = this.numbers.filter((n) => !pinned.has(n));
      if (remaining.length === 0) break;
      // Closed / merged / wrong base won't fix itself: all-or-nothing stops now.
      if (dead.size > 0 && !partial) break;
      if (remaining.every((n) => dead.has(n))) break;
      if (this.clock() >= deadline) break;
      await this.sleep(pollSeconds);
    }
    const unqualified = new Map(this.numbers.filter((n) => !pinned.has(n)).map((n) => [n, reasons.get(n) ?? ["never checked"]]));
    return { pinned, unqualified };
  }

  // Merges each pinned PR in input order after a fresh check. Returns the merged numbers.
  merge(pinned) {
    const merged = [];
    for (const n of this.numbers) {
      if (!pinned.has(n)) continue;
      const { snap, reasons: why } = this.check(n);
      if (!snap.error && snap.head !== pinned.get(n)) why.unshift(`head changed ${short(pinned.get(n))} -> ${short(snap.head)}`);
      if (why.length > 0) {
        this.out(`#${n} SKIPPED: ${why.join("; ")}`);
        continue;
      }
      const result = this.run(["gh", "pr", "merge", String(n), "--merge", "--match-head-commit", pinned.get(n)]);
      // `gh pr merge` exiting 0 does not mean it merged. Measured in habit 2026-09-21: "already
      // merged" exits 0 having done nothing, and an abbreviated SHA to --match-head-commit fails
      // inside GraphQL while the PR stays open. So the state is the success signal, not the code.
      const { state, sha } = this.mergeState(n);
      if (state !== "MERGED" || !sha) {
        this.out(`#${n} MERGE FAILED (state=${state || "?"}): ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
        continue;
      }
      this.out(`#${n} MERGED ${short(sha)}`);
      merged.push(n);
    }
    return merged;
  }

  // (state, merge commit oid) as GitHub reports them after a merge attempt.
  mergeState(number) {
    const view = this.run(["gh", "pr", "view", String(number), "--json", "state,mergeCommit"]);
    if (view.status !== 0) return { state: "", sha: "" };
    try {
      const data = JSON.parse(view.stdout);
      return { state: data.state ?? "", sha: data.mergeCommit?.oid ?? "" };
    } catch {
      return { state: "", sha: "" };
    }
  }
}

const USAGE = "usage: wrangle-merge.mjs PR [PR ...] [--wait-minutes N] [--poll-seconds N] [--partial] [--dry-run] [--ship]";

// Parsed options, or { error } for a usage mistake (exit 2).
export const parseCli = (argv) => {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "wait-minutes": { type: "string", default: String(DEFAULT_WAIT_MINUTES) },
        "poll-seconds": { type: "string", default: String(DEFAULT_POLL_SECONDS) },
        partial: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        ship: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    return { error: error.message };
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) return { error: "name at least one PR" };
  if (!positionals.every((p) => /^[1-9]\d*$/.test(p))) return { error: "PR numbers must be positive integers" };
  const waitMinutes = Number(values["wait-minutes"]);
  const pollSeconds = Number(values["poll-seconds"]);
  if (!(waitMinutes >= 0) || !(pollSeconds >= 0)) return { error: "--wait-minutes and --poll-seconds take a number" };
  // Keep order, drop repeats: merging #165 twice is a failed merge, not a feature.
  const prs = [...new Set(positionals.map(Number))];
  // A ship is one PR by definition, and --partial means nothing with one. Refusing both keeps
  // --ship from ever reading as "merge whichever of these happens to be green".
  if (values.ship && prs.length !== 1) return { error: `--ship takes exactly one PR (the ${BASE_BRANCH} -> ${SHIP_BASE_BRANCH} ship PR)` };
  if (values.ship && values.partial) return { error: "--ship and --partial are contradictory" };
  return { prs, waitMinutes, pollSeconds, partial: values.partial, dryRun: values["dry-run"], ship: values.ship };
};

// The whole run; returns the exit code (0 all merged or dry run, 1 something didn't, 2 usage).
export const main = async (argv, { root = process.cwd(), run = defaultRun, clock, sleep, out = console.log, err = console.error } = {}) => {
  const args = parseCli(argv);
  if (args.error) {
    err(`${USAGE}\nwrangle-merge: ${args.error}`);
    return 2;
  }
  const checks = await loadHeavyChecks(root);
  const batch = new Batch(args.prs, { checks, run, ...(clock && { clock }), ...(sleep && { sleep }), out, ship: args.ship });
  if (args.dryRun) return batch.dryRun();
  if (args.ship) out(`SHIP: merging #${args.prs[0]} into ${SHIP_BASE_BRANCH} deploys production immediately`);
  out(`batch ${args.prs.map((n) => `#${n}`).join(" ")}: ${args.partial ? "partial" : "all-or-nothing"}, wait up to ${args.waitMinutes} min`);
  const { pinned, unqualified } = await batch.wait(args.waitMinutes * 60, args.pollSeconds, args.partial);
  for (const [n, why] of unqualified) out(`#${n} NOT QUALIFIED: ${why.join("; ")}`);
  if (unqualified.size > 0 && !args.partial) {
    out("all-or-nothing: merged none (rerun with --partial to merge the qualified ones)");
    return 1;
  }
  return batch.merge(pinned).length === args.prs.length ? 0 : 1;
};

// Run only as a script, so the test can import the pieces.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
