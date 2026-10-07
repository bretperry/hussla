/*
  Which changed paths wake the heavy CI tier, and which don't.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/lib/ci-change-scope.mjs → classify(), packPatterns(), packsToCheck(), changedPaths(); git (a throwaway repo per case).
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { presentPacks } from "../stack.mjs";
import { changedPaths, classify, packPatterns, packsToCheck } from "./ci-change-scope.mjs";

// Writes one file, making its directory.
const put = (root, path) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), `${path}\n`);
};

// A throwaway repo with `before` committed, then `change(root)` committed; returns the root and both SHAs.
// quotePath is left at git's default (on), as on a CI runner, so the classifier must turn it off itself.
const repoWithChange = (before, change) => {
  const root = mkdtempSync(join(tmpdir(), "scope-git-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  for (const path of before) put(root, path);
  git("add", "-A");
  git("commit", "-qm", "before");
  const beforeSha = git("rev-parse", "HEAD");
  change(root);
  git("add", "-A");
  git("commit", "-qm", "after");
  return { root, beforeSha, afterSha: git("rev-parse", "HEAD") };
};

// Moves a committed file, making the target directory; content unchanged so git would call it a rename.
const move = (root, from, to) => {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  renameSync(join(root, from), join(root, to));
};

// The script run as CI runs it, on a push event in `root`; returns what it wrote to GITHUB_OUTPUT.
const runScript = ({ root, beforeSha, afterSha }) => {
  const output = join(mkdtempSync(join(tmpdir(), "scope-out-")), "out");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [resolve("scripts/lib/ci-change-scope.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "push", BEFORE_SHA: beforeSha, AFTER_SHA: afterSha } });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, "utf8");
};

describe("classify", () => {
  for (const [paths, heavy] of [
    [["src/domain/rules.ts"], true],
    [["pnpm-lock.yaml"], true],
    [["next.config.ts"], true],
    [[".github/workflows/ci.yml"], true],
    [["scripts/lib/ci-change-scope.mjs"], true],
    [["scripts/stack.mjs"], true],
    [["stacks/demo/pack.json"], true],
    [["stacks/demo/notes.md"], false],
    [["docs/deferred.md", "src/features/x/ui.tsx"], true],
    [["docs/deferred.md", "README.md"], false],
    [[".cursor/rules/core.mdc", ".claude/skills/compound/SKILL.md"], false],
    [["scripts/command-guard.mjs"], false],
    [["srcs/thing.ts"], false],
    [[], false],
  ]) {
    it(`${JSON.stringify(paths)} → heavy=${String(heavy)}`, () => {
      assert.equal(classify(paths), heavy);
    });
  }

  it("a stack pack's own build inputs wake the tier, and only at the path it names", () => {
    const patterns = [/^build\.lock$/];
    assert.equal(classify(["build.lock"], patterns), true);
    assert.equal(classify(["docs/build.lock"], patterns), false);
    assert.equal(classify(["build.lock"]), false);
  });
});

describe("packPatterns", () => {
  it("reads `ciHeavy` from every present pack", () => {
    const root = mkdtempSync(join(tmpdir(), "scope-"));
    mkdirSync(join(root, "stacks/demo"), { recursive: true });
    writeFileSync(join(root, "stacks/demo/pack.json"), JSON.stringify({ name: "demo", kind: "language", ciHeavy: ["^demo\\.toml$"] }));
    assert.equal(classify(["demo.toml"], packPatterns(root)), true);
    assert.deepEqual(packPatterns(mkdtempSync(join(tmpdir(), "scope-"))), []);
  });
});

describe("changedPaths", () => {
  it("lists a non-ASCII path as it is on disk, not git's quoted form, so it still wakes the tier", () => {
    const repo = repoWithChange(["README.md"], (root) => put(root, "src/naïve.ts"));
    assert.deepEqual(changedPaths({ GITHUB_EVENT_NAME: "push", BEFORE_SHA: repo.beforeSha, AFTER_SHA: repo.afterSha }, repo.root), ["src/naïve.ts"]);
    assert.equal(runScript(repo), "heavy=true\npacks=all\n");
  });

  it("lists both sides of a move, so moving a file out of a heavy dir still wakes the tier", () => {
    const repo = repoWithChange(["src/lib/helper.ts"], (root) => move(root, "src/lib/helper.ts", "docs/helper.ts"));
    assert.deepEqual(changedPaths({ GITHUB_EVENT_NAME: "push", BEFORE_SHA: repo.beforeSha, AFTER_SHA: repo.afterSha }, repo.root).toSorted(), ["docs/helper.ts", "src/lib/helper.ts"]);
    assert.equal(runScript(repo), "heavy=true\npacks=all\n");
  });

  it("stays light for a docs-only change", () => {
    assert.equal(runScript(repoWithChange(["README.md"], (root) => put(root, "docs/notes.md"))), "heavy=false\npacks=none\n");
  });
});

describe("packsToCheck", () => {
  // Fixture packs shaped like real ones: own files, a stacks/ dir, ciHeavy, and `ui` requiring `lang`.
  const packs = [
    { name: "lang", owns: ["lang.toml"], code: ["stacks/lang/check-edited.mjs"], ciHeavy: ["^lang-src/"] },
    { name: "ui", requires: ["lang"] },
    { name: "other", owns: ["other.lock"], code: ["other.cfg"], ciHeavy: ["^other-src/"] },
  ];
  const cases = [
    [[], []],
    [["docs/guide/start.md", ".claude/skills/help/SKILL.md", ".cursor/rules/lang.mdc", "README.md"], []],
    [["other-src/app/lib.x", "other.cfg"], ["other"]],
    [["stacks/other/boundaries.mjs"], ["other"]],
    [["lang.toml"], ["lang", "ui"]],
    [["other-src/app/lib.x", "docs/deferred.md", "lang-src/a.y"], ["lang", "ui", "other"]],
    [["scripts/stack.mjs"], "all"],
    [["package.json"], "all"],
    [["src/domain/new-file.ts"], "all"],
    [["stacks/other/pack.json"], "all"],
    [[".github/workflows/ci.yml", "other-src/app/lib.x"], "all"],
  ];
  for (const [paths, expected] of cases) {
    it(`${JSON.stringify(paths)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(packsToCheck(paths, packs), expected);
    });
  }

  it("on this repo's own packs: a skill edit runs none, and a pack's own file runs that pack", () => {
    const present = presentPacks(resolve(import.meta.dirname, "../.."));
    assert.deepEqual(packsToCheck([".claude/skills/help/SKILL.md"], present), []);
    for (const pack of present) assert.ok(packsToCheck([`stacks/${pack.name}/x.mjs`], present).includes(pack.name), pack.name);
  });
});
