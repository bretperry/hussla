/*
  The Swift CI scope: which changed paths wake the macOS job, and that a broken classifier fails closed.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/scope.mjs; git (a throwaway repo per case).
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { changedPaths, classify } from "./scope.mjs";

describe("classify", () => {
  it("wakes on Swift files, the package config, this pack's scripts, the workflow, and the change list it reads", () => {
    for (const path of ["Sources/Domain/Note.swift", "Tests/NoteSyncTests/X.swift", "apple/App/Main.swift", "Package.swift", "Package.resolved", "swift-layers.json", ".swift-format", "stacks/swift/run.mjs", ".github/workflows/ci.yml", "scripts/lib/ci-change-scope.mjs"]) {
      assert.equal(classify([path]), true, path);
    }
  });

  it("stays asleep for everything else, and for nothing changed", () => {
    for (const paths of [[], ["web/app.ts", "docs/plans/x.md", "README.md", "package.json", "stacks/rust/pack.json"]]) assert.equal(classify(paths), false, paths.join());
  });

  it("wakes when only one of several changed paths is Swift", () => {
    assert.equal(classify(["README.md", "Sources/Config/SyncConfig.swift"]), true);
  });
});

describe("changedPaths", () => {
  it("throws for an event it can't diff, so the entry point fails closed", () => {
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "workflow_dispatch" }), /unsupported event/);
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "pull_request" }), /PR_BASE_SHA/);
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "push", BEFORE_SHA: "0000000" }), /no parent/);
  });
});

// A throwaway repo with `before` committed, then `change(root)` committed; git's default quotePath (on), as on a runner.
const repoWithChange = (before, change) => {
  const root = mkdtempSync(join(tmpdir(), "swift-scope-git-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  const put = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  };
  git("init", "-q");
  for (const path of before) put(path);
  git("add", "-A");
  git("commit", "-qm", "before");
  const beforeSha = git("rev-parse", "HEAD");
  change(root, put);
  git("add", "-A");
  git("commit", "-qm", "after");
  return { root, env: { GITHUB_EVENT_NAME: "push", BEFORE_SHA: beforeSha, AFTER_SHA: git("rev-parse", "HEAD") } };
};

// The script run as CI runs it in `root`; returns what it wrote to GITHUB_OUTPUT.
const runScript = (root, env) => {
  const output = join(mkdtempSync(join(tmpdir(), "swift-scope-")), "out");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [resolve("stacks/swift/scope.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, "utf8");
};

describe("changed paths from git", () => {
  it("wakes on a Swift file with a non-ASCII name (git would quote it, hiding the .swift)", () => {
    const { root, env } = repoWithChange(["README.md"], (_, put) => put("Sources/Domain/Naïve.swift"));
    assert.deepEqual(changedPaths(env, root), ["Sources/Domain/Naïve.swift"]);
    assert.equal(runScript(root, env), "swift=true\n");
  });

  it("wakes when a Swift file is moved out (its old path is listed, not just the new one)", () => {
    const { root, env } = repoWithChange(["Sources/Domain/Note.swift"], (dir) => {
      mkdirSync(join(dir, "docs"), { recursive: true });
      renameSync(join(dir, "Sources/Domain/Note.swift"), join(dir, "docs/Note.txt"));
    });
    assert.deepEqual(changedPaths(env, root).toSorted(), ["Sources/Domain/Note.swift", "docs/Note.txt"]);
    assert.equal(runScript(root, env), "swift=true\n");
  });

  it("stays asleep for a docs-only change", () => {
    const { root, env } = repoWithChange(["README.md"], (_, put) => put("docs/notes.md"));
    assert.equal(runScript(root, env), "swift=false\n");
  });
});

describe("the script", () => {
  it("writes swift=true when it can't tell (fail closed)", () => {
    const output = join(mkdtempSync(join(tmpdir(), "swift-scope-")), "out");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [resolve("stacks/swift/scope.mjs")], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: "" } });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(output, "utf8"), "swift=true\n");
  });
});
