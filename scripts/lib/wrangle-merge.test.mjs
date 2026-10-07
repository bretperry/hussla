/*
  wrangle-merge.mjs with `gh` stubbed: no network, no GitHub.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/lib/wrangle-merge.mjs; a temp repo with one fixture pack that declares a heavy check.
  Ported from habit's wrangle_merge_test.py; each case is a batch that went wrong there.
*/
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { STABLE_POLLS, latestPerCheck, loadHeavyChecks, main, parseCli, requiredHeavy, verdict } from "./wrangle-merge.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A repo with one pack whose `heavyChecks` names a Mac job woken by `.swift` paths.
const fixtureRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "wrangle-merge-"));
  mkdirSync(join(root, "stacks", "apple"), { recursive: true });
  writeFileSync(join(root, "stacks", "apple", "pack.json"), JSON.stringify({ name: "apple", heavyChecks: [{ name: "Mac tests", scope: "stacks/apple/scope.mjs" }] }));
  writeFileSync(join(root, "stacks", "apple", "scope.mjs"), "export const classify = (paths) => paths.some((path) => path.endsWith('.swift'));\n");
  return root;
};
const ROOT = fixtureRoot();

const CHEAP = ["Change scope", "Checks"];
const HEAVY_ALL = ["Build", "Mac tests"];

const checks = ({ pass = [], skipping = [], pending = [], fail = [] }) =>
  Object.entries({ pass, skipping, pending, fail }).flatMap(([bucket, names]) => names.map((name) => ({ name, bucket, workflow: "CI", startedAt: "2026-10-04T10:00:00Z" })));

// A finished ready run: cheap + the given heavy pass, the other heavy skip.
const green = (heavyPass) => checks({ pass: [...CHEAP, ...heavyPass], skipping: HEAVY_ALL.filter((name) => !heavyPass.includes(name)) });

// What a PR reads right after Ready: the draft run, every heavy job skipping.
const staleDraftRun = () => checks({ pass: CHEAP, skipping: HEAVY_ALL });

const ok = (stdout = "", status = 0, stderr = "") => ({ stdout, status, stderr });

// Just enough of `gh pr view|checks|diff|merge`.
class FakeGh {
  prs = new Map();
  checks = new Map();
  paths = new Map();
  merged = [];
  calls = [];
  afterMerge = new Map();
  // `gh pr merge` exits 0 but leaves the PR open: measured in habit (an abbreviated
  // --match-head-commit SHA rejected inside GraphQL; "already merged" also exits 0).
  silentMergeFailures = new Set();

  add(n, paths, rows, { draft = false, base = "dev" } = {}) {
    this.prs.set(n, { number: n, state: "OPEN", isDraft: draft, headRefOid: `${String(n).padStart(4, "0")}aaaa${"0".repeat(32)}`, baseRefName: base, mergeable: "MERGEABLE" });
    this.checks.set(n, rows);
    this.paths.set(n, paths);
  }

  run = (argv) => {
    this.calls.push(argv);
    assert.deepEqual(argv.slice(0, 2), ["gh", "pr"]);
    const [, , sub, num] = argv;
    const n = Number(num);
    if (sub === "ready") throw new Error("wrangle-merge must never run gh pr ready");
    if (sub === "view") {
      const pr = { ...this.prs.get(n) };
      if (pr.state === "MERGED") pr.mergeCommit = { oid: `m${String(n).padStart(3, "0")}fff${"0".repeat(32)}` };
      return ok(JSON.stringify(pr));
    }
    if (sub === "checks") {
      const rows = this.checks.get(n);
      return ok(JSON.stringify(rows), rows.some((row) => row.bucket === "pending") ? 8 : 0);
    }
    if (sub === "diff") return ok(`${this.paths.get(n).join("\n")}\n`);
    if (sub === "merge") {
      assert.ok(argv.includes("--merge"));
      const sha = argv[argv.indexOf("--match-head-commit") + 1];
      const pr = this.prs.get(n);
      if (pr.headRefOid !== sha) return ok("", 1, "head commit mismatch");
      if (this.silentMergeFailures.has(n)) return ok("", 0, 'Could not coerce value "abc1234" to GitObjectID');
      pr.state = "MERGED";
      this.merged.push(n);
      this.afterMerge.get(n)?.();
      return ok();
    }
    throw new Error(`unexpected gh call ${argv.join(" ")}`);
  };
}

// Fake clock + sleep that fires scripted state changes on given poll numbers.
class Harness {
  now = 0;
  sleeps = 0;
  lines = [];
  errors = [];
  onSleep = new Map();

  constructor(gh) {
    this.gh = gh;
  }

  main(...args) {
    return main([...args, "--poll-seconds", "30"], {
      root: ROOT,
      run: this.gh.run,
      clock: () => this.now,
      sleep: async (seconds) => {
        this.now += seconds;
        this.sleeps += 1;
        this.onSleep.get(this.sleeps)?.();
      },
      out: (line) => this.lines.push(line),
      err: (line) => this.errors.push(line),
    });
  }

  get text() {
    return this.lines.join("\n");
  }
}

describe("requiredHeavy", () => {
  it("asks each heavy check's classifier, and needs all of them when the paths are unknown", async () => {
    const heavy = await loadHeavyChecks(ROOT);
    assert.deepEqual(requiredHeavy(["src/app/page.tsx"], heavy), ["Build"]);
    assert.deepEqual(requiredHeavy(["Sources/App/Main.swift"], heavy), ["Mac tests"]);
    assert.deepEqual(requiredHeavy(["docs/deferred.md", "AGENTS.md"], heavy), []);
    assert.deepEqual(requiredHeavy(null, heavy), HEAVY_ALL);
  });

  it("a pack's scope module without classify() fails loud", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "stacks", "apple", "scope.mjs"), "export const other = 1;\n");
    await assert.rejects(loadHeavyChecks(root), /exports no classify/);
  });

  // Skipped once a project removes the Swift pack.
  it("this repo's packs load, and the Swift pack gates its Mac job, not the aggregator that always reports", { skip: !existsSync(join(REPO, "stacks", "swift")) }, async () => {
    const names = (await loadHeavyChecks(REPO)).map((check) => check.name);
    assert.equal(names[0], "Build");
    assert.ok(names.includes("Swift tests (macOS)"), names.join(", "));
    assert.ok(!names.includes("Swift tests"));
  });
});

const snap = (rows, extra = {}) => ({ number: 1, state: "OPEN", draft: false, head: "abc", base: "dev", mergeable: "MERGEABLE", checks: rows, error: "", wantBase: "dev", ...extra });

describe("verdict", () => {
  it("a heavy check skipping is not a pass", () => {
    assert.ok(verdict(snap(staleDraftRun()), ["Build"]).includes("Build skipping (heavy, needs pass)"));
  });

  it("the newest run wins over a stale draft row", () => {
    const rows = [...green(["Build"]), { name: "Build", bucket: "skipping", workflow: "CI", startedAt: "2026-10-04T09:00:00Z" }];
    assert.deepEqual(verdict(snap(latestPerCheck(rows)), ["Build"]), []);
  });

  it("refuses a main base outside --ship", () => {
    assert.ok(verdict(snap(green([]), { base: "main" }), []).some((reason) => reason.includes("refusing")));
  });
});

describe("batch", () => {
  it("waits through the stale draft run for a real heavy pass", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/app/page.tsx"], staleDraftRun());
    const h = new Harness(gh);
    // Poll 2: the ready run registers (heavy pending). Poll 4: it finishes green.
    h.onSleep.set(1, () => gh.checks.set(165, checks({ pass: CHEAP, pending: ["Build"] })));
    h.onSleep.set(3, () => gh.checks.set(165, green(["Build"])));
    assert.equal(await h.main("165"), 0, h.text);
    assert.deepEqual(gh.merged, [165]);
    // Green from poll 4, then STABLE_POLLS polls in a row.
    assert.ok(h.sleeps >= 3 + STABLE_POLLS - 1);
    assert.match(h.text, /#165 MERGED m165fff/);
    assert.match(h.text, /Build skipping \(heavy, needs pass\)/);
  });

  it("a green draft run alone never merges a PR that needs the heavy tier", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/app/page.tsx"], staleDraftRun());
    const h = new Harness(gh);
    assert.equal(await h.main("165", "--wait-minutes", "5"), 1);
    assert.deepEqual(gh.merged, []);
  });

  it("a docs-only PR needs no heavy check, but still waits the stable polls", async () => {
    const gh = new FakeGh();
    gh.add(170, ["docs/deferred.md", "AGENTS.md"], staleDraftRun());
    const h = new Harness(gh);
    assert.equal(await h.main("170"), 0, h.text);
    assert.deepEqual(gh.merged, [170]);
    assert.match(h.text, /heavy none \(cheap checks only\)/);
    assert.equal(h.sleeps, STABLE_POLLS - 1);
  });

  it("skips a PR whose head changed after it qualified", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(166, ["src/y.ts"], green(["Build"]));
    gh.afterMerge.set(165, () => {
      gh.prs.get(166).headRefOid = `beefbeef${"0".repeat(32)}`;
    });
    const h = new Harness(gh);
    assert.equal(await h.main("165", "166"), 1);
    assert.deepEqual(gh.merged, [165]);
    assert.match(h.text, /#166 SKIPPED: head changed 0166aaa -> beefbee/);
  });

  it("skips a PR flipped back to draft mid-batch, and never runs gh pr ready", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(166, ["Sources/A.swift"], green(["Mac tests"]));
    gh.afterMerge.set(165, () => {
      gh.prs.get(166).isDraft = true;
    });
    const h = new Harness(gh);
    assert.equal(await h.main("165", "166"), 1);
    assert.deepEqual(gh.merged, [165]);
    assert.match(h.text, /#166 SKIPPED: draft/);
    assert.ok(!gh.calls.some((call) => call[2] === "ready"));
  });

  it("skips a PR closed mid-batch", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(166, ["src/y.ts"], green(["Build"]));
    gh.afterMerge.set(165, () => {
      gh.prs.get(166).state = "CLOSED";
    });
    const h = new Harness(gh);
    assert.equal(await h.main("165", "166"), 1);
    assert.match(h.text, /#166 SKIPPED: PR is CLOSED/);
  });

  it("a PR closed before qualifying stops all-or-nothing at once", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(166, ["src/y.ts"], green(["Build"]));
    gh.prs.get(166).state = "CLOSED";
    const h = new Harness(gh);
    assert.equal(await h.main("165", "166"), 1);
    assert.deepEqual(gh.merged, []);
    assert.equal(h.sleeps, 0);
    assert.match(h.text, /#166 NOT QUALIFIED: PR is CLOSED/);
  });

  it("a timeout is all-or-nothing", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(168, ["Sources/A.swift"], checks({ pass: CHEAP, pending: ["Mac tests"] }));
    const h = new Harness(gh);
    assert.equal(await h.main("165", "168", "--wait-minutes", "10"), 1);
    assert.deepEqual(gh.merged, []);
    assert.match(h.text, /#168 NOT QUALIFIED: pending: Mac tests/);
    assert.match(h.text, /merged none/);
    assert.ok(h.now <= 10 * 60 + 30);
  });

  it("--partial merges the qualified ones after a timeout", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(168, ["Sources/A.swift"], checks({ pass: CHEAP, fail: ["Mac tests"] }));
    const h = new Harness(gh);
    assert.equal(await h.main("165", "168", "--wait-minutes", "10", "--partial"), 1);
    assert.deepEqual(gh.merged, [165]);
    assert.match(h.text, /#168 NOT QUALIFIED: failing: Mac tests/);
  });

  it("refuses a PR not based on dev", async () => {
    const gh = new FakeGh();
    gh.add(1, ["src/x.ts"], green(["Build"]), { base: "main" });
    const h = new Harness(gh);
    assert.equal(await h.main("1", "--partial"), 1);
    assert.deepEqual(gh.merged, []);
    assert.match(h.text, /refusing/);
  });

  it("a merge that exits 0 without merging is not reported merged", async () => {
    const gh = new FakeGh();
    gh.add(1, ["src/x.ts"], green(["Build"]));
    gh.silentMergeFailures.add(1);
    const h = new Harness(gh);
    assert.notEqual(await h.main("1"), 0);
    assert.deepEqual(gh.merged, []);
    assert.equal(gh.prs.get(1).state, "OPEN");
    assert.match(h.text, /MERGE FAILED/);
    assert.doesNotMatch(h.text, /#1 MERGED/);
  });

  it("merges in input order, once each, with merge commits pinned to the head", async () => {
    const gh = new FakeGh();
    for (const n of [168, 165, 166]) gh.add(n, ["docs/x.md"], green([]));
    const h = new Harness(gh);
    assert.equal(await h.main("168", "165", "166", "165"), 0, h.text);
    assert.deepEqual(gh.merged, [168, 165, 166]);
    const merges = gh.calls.filter((call) => call[2] === "merge");
    assert.ok(merges.every((call) => call.includes("--merge") && call.includes("--match-head-commit")));
  });

  it("--dry-run merges nothing and prints each verdict", async () => {
    const gh = new FakeGh();
    gh.add(165, ["src/x.ts"], green(["Build"]));
    gh.add(166, ["Sources/A.swift"], staleDraftRun(), { draft: true });
    const h = new Harness(gh);
    assert.equal(await h.main("165", "166", "--dry-run"), 0);
    assert.ok(!gh.calls.some((call) => call[2] === "merge"));
    assert.match(h.text, /#165 ready now/);
    assert.match(h.text, /#166 NOT READY/);
    assert.match(h.text, /Mac tests skipping \(heavy, needs pass\)/);
  });
});

describe("--ship", () => {
  it("refuses a PR based on dev", async () => {
    const gh = new FakeGh();
    gh.add(1, ["src/x.ts"], green(HEAVY_ALL));
    const h = new Harness(gh);
    assert.equal(await h.main("1", "--ship"), 1);
    assert.deepEqual(gh.merged, []);
    assert.match(h.text, /refusing/);
  });

  it("merges a main-based PR and says it deploys", async () => {
    const gh = new FakeGh();
    gh.add(1, ["src/x.ts"], green(HEAVY_ALL), { base: "main" });
    const h = new Harness(gh);
    assert.equal(await h.main("1", "--ship"), 0, h.text);
    assert.deepEqual(gh.merged, [1]);
    assert.match(h.text, /deploys production immediately/);
  });

  it("requires every heavy check even when the diff is docs-only", async () => {
    // A PR into main runs every heavy job; asking the classifiers would require nothing here.
    const gh = new FakeGh();
    gh.add(1, ["docs/plans/whatever.md"], green([]), { base: "main" });
    const h = new Harness(gh);
    assert.equal(await h.main("1", "--ship", "--wait-minutes", "2"), 1);
    assert.deepEqual(gh.merged, []);
    for (const name of HEAVY_ALL) assert.match(h.text, new RegExp(`${name} skipping`));
  });

  it("takes exactly one PR, and never with --partial", async () => {
    const gh = new FakeGh();
    gh.add(1, ["src/x.ts"], green(HEAVY_ALL), { base: "main" });
    gh.add(2, ["src/y.ts"], green(HEAVY_ALL), { base: "main" });
    const h = new Harness(gh);
    assert.equal(await h.main("1", "2", "--ship"), 2);
    assert.equal(await h.main("1", "--ship", "--partial"), 2);
    assert.deepEqual(gh.merged, []);
    assert.equal(gh.calls.length, 0);
  });
});

describe("parseCli", () => {
  it("refuses what isn't a positive PR number or a known flag", () => {
    assert.match(parseCli([]).error, /at least one PR/);
    assert.match(parseCli(["0"]).error, /positive/);
    assert.match(parseCli(["12abc"]).error, /positive/);
    assert.match(parseCli(["1", "--merge-now"]).error, /Unknown option/);
    assert.match(parseCli(["1", "--wait-minutes", "soon"]).error, /take a number/);
  });
});
