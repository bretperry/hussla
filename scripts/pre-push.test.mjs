/*
  Which pushes make .githooks/pre-push run its checks: non-ASCII and moved paths are seen, a remote tip this clone never fetched still gets checked, and runbooks wake the plan lint.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs bash, git, and npm; skipped on Windows.
  Used by: node:test (`node --test`), with node:assert.
  Uses: .githooks/pre-push, run in a throwaway repo whose `check` script and the two node-only checks are stand-ins that only record that they ran.
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

// The hook under test, from the repo root (node --test runs there).
const HOOK = resolve(".githooks/pre-push");

// Writes one file, making its directory.
const put = (root, path, text = `${path}\n`) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

// Stand-in that records it ran by creating `marker` in the repo root.
const recorder = (marker) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\n`;

// A repo whose origin/dev is the first commit, with `change(root)` committed on top; returns the root and both SHAs.
const repoWithChange = (change) => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  // No dependencies, so the hook counts it as installed; `check` records that the fast checks ran.
  put(root, "package.json", JSON.stringify({ scripts: { check: "node -e \"require('fs').writeFileSync('ran-check','')\"" } }));
  put(root, "scripts/sync-claude-rules.mjs", recorder("ran-rules"));
  put(root, "scripts/plans-status.mjs", recorder("ran-plans"));
  put(root, "src/app.ts");
  put(root, "README.md");
  put(root, ".gitignore", "ran-*\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", base);
  change(root);
  git("add", "-A");
  git("commit", "-qm", "change");
  return { root, base, head: git("rev-parse", "HEAD") };
};

// Runs the hook for one pushed branch ref, with `remoteSha` as what the remote has; returns which checks ran.
const push = ({ root, head }, remoteSha) => {
  const env = { ...process.env };
  delete env.WHIPPLETREE_SKIP_CHECKS;
  const result = spawnSync("bash", [HOOK], { cwd: root, encoding: "utf8", env, input: `refs/heads/feature ${head} refs/heads/feature ${remoteSha}\n` });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { check: existsSync(join(root, "ran-check")), rules: existsSync(join(root, "ran-rules")), plans: existsSync(join(root, "ran-plans")) };
};

// A commit id no clone has: what the remote reports after someone else pushed.
const UNFETCHED = "1234567890abcdef1234567890abcdef12345678";

describe("pre-push", { skip: process.platform === "win32" && "the hook is bash" }, () => {
  it("runs the checks for a code path with a non-ASCII name (git would quote it)", () => {
    const repo = repoWithChange((root) => put(root, "src/naïve.ts"));
    assert.deepEqual(push(repo, repo.base), { check: true, rules: false, plans: false });
  });

  it("runs the checks when code is moved into docs/ (the path it left counts)", () => {
    const repo = repoWithChange((root) => {
      mkdirSync(join(root, "docs"), { recursive: true });
      renameSync(join(root, "src/app.ts"), join(root, "docs/app.ts"));
    });
    assert.deepEqual(push(repo, repo.base), { check: true, rules: false, plans: false });
  });

  it("measures from origin/dev when the remote tip was never fetched, instead of checking nothing", () => {
    const code = repoWithChange((root) => put(root, "src/new.ts"));
    assert.deepEqual(push(code, UNFETCHED), { check: true, rules: false, plans: false });
    const docs = repoWithChange((root) => put(root, "docs/notes.md"));
    assert.deepEqual(push(docs, UNFETCHED), { check: false, rules: false, plans: false });
  });

  it("runs the plan lint for runbooks and Human checks, not just plans", () => {
    for (const path of ["docs/runbooks/smoke.md", "docs/human-checks.md", "docs/human-checks.json", "docs/plans/x.md"]) {
      const repo = repoWithChange((root) => put(root, path));
      assert.deepEqual(push(repo, repo.base), { check: false, rules: false, plans: true }, path);
    }
  });

  it("runs nothing for a docs-only push", () => {
    const repo = repoWithChange((root) => put(root, "docs/notes.md"));
    assert.deepEqual(push(repo, repo.base), { check: false, rules: false, plans: false });
  });
});
