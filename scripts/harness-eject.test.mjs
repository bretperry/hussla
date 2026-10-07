/*
  Harness eject: what it removes, what it keeps, the leftover scan, and its refusals, on fixtures and on this repo.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/harness-eject.mjs, scripts/stack.mjs (trackedFiles), git.

  The end-to-end case ejects a copy of this checkout: a harness file someone adds without listing
  it, or a script left pointing at a removed file, is the failure that matters, because it ships
  to an open-source repo where nobody runs the harness.
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { applyEject, planEject } from "./harness-eject.mjs";
import { trackedFiles } from "./stack.mjs";

// This repo's root and the script, for spawning it against fixtures.
const REPO = resolve(".");
const EJECT = join(REPO, "scripts/harness-eject.mjs");

// A throwaway git identity, so commits work on a machine (or CI runner) with none configured.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// Runs git in `cwd` and returns stdout.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

// Writes `files` ({ path: content }) under root; an object is written as JSON.
const writeFiles = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
};

// A temp git repo holding `files`, committed on `branch`.
const fixtureRepo = (files, branch = "publish") => {
  const root = mkdtempSync(join(tmpdir(), "eject-fixture-"));
  writeFiles(root, files);
  git(root, "init", "--quiet", `--initial-branch=${branch}`);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
};

// A small project: two harness files, one kept, a pack with a rule and a hook, a fenced file.
const PROJECT = {
  "harness.json": {
    docs: ["CLAUDE.md", ".cursor/rules/core.mdc"],
    code: ["scripts/guard.mjs", "scripts/stack.mjs"],
    eject: { keep: ["scripts/stack.mjs"], remove: [".claude/", "AGENTS.md"], dropScripts: ["guard"], addScripts: { "test:tools": "node --test stacks/**/*.test.mjs" } },
  },
  "CLAUDE.md": "@AGENTS.md\n",
  "AGENTS.md": "# agents\n",
  ".cursor/rules/core.mdc": "rule\n",
  ".cursor/rules/lang.mdc": "lang rule\n",
  ".claude/settings.json": "{}\n",
  ".claude/skills/x/SKILL.md": "skill\n",
  "scripts/guard.mjs": "guard\n",
  "scripts/stack.mjs": "stack\n",
  "stacks/lang/pack.json": { name: "lang", docs: [".cursor/rules/lang.mdc"], code: ["stacks/lang/run.mjs", "stacks/lang/hook.mjs"], editCheck: { extensions: [".x"], run: "stacks/lang/hook.mjs" }, ejectRemove: ["stacks/lang/hook.mjs"], checks: [{ name: "Lang", script: "lang" }] },
  "stacks/lang/run.mjs": "run\n",
  "stacks/lang/hook.mjs": "hook\n",
  "ci.yml": "steps:\n  # [harness]\n  - run: pnpm guard\n  # [/harness]\n  - run: pnpm lang\n",
  "package.json": { name: "app", scripts: { guard: "node scripts/guard.mjs", lang: "node stacks/lang/run.mjs" } },
  "src/app.ts": "export const x = 1;\n",
  // Prose naming both markers on one line is not a fence, and must not trip the unbalanced-fence refusal.
  "docs/note.md": "Wrap it in `[harness]` and `[/harness]` lines.\n",
};

describe("planEject", () => {
  it("removes harness files and directories, keeps `keep`, and lists a removed directory once", () => {
    const plan = planEject(fixtureRepo(PROJECT));
    assert.deepEqual(plan.removed.toSorted((a, b) => a.localeCompare(b)), [".claude/", ".cursor/rules/core.mdc", ".cursor/rules/lang.mdc", "AGENTS.md", "CLAUDE.md", "harness.json", "scripts/guard.mjs", "stacks/lang/hook.mjs"]);
  });

  it("strips fences, drops a pack's harness fields, and swaps the scripts", () => {
    const { edits } = planEject(fixtureRepo(PROJECT));
    assert.equal(edits.get("ci.yml"), "steps:\n  - run: pnpm lang\n");
    assert.ok(!edits.has("docs/note.md"));
    assert.deepEqual(JSON.parse(edits.get("stacks/lang/pack.json")), { name: "lang", code: ["stacks/lang/run.mjs"], checks: [{ name: "Lang", script: "lang" }] });
    assert.deepEqual(JSON.parse(edits.get("package.json")).scripts, { lang: "node stacks/lang/run.mjs", "test:tools": "node --test stacks/**/*.test.mjs" });
  });

  it("reports leaks and a kept script that runs a removed file", () => {
    const root = fixtureRepo({ ...PROJECT, "README.md": "# Built with Whippletree\n", "LICENSE": "{{OWNER}}\n", "package.json": { name: "app", scripts: { hook: "node stacks/lang/hook.mjs" } } });
    const { problems } = planEject(root);
    assert.ok(problems.some((line) => line.startsWith("README.md:1: names whippletree")), problems.join("\n"));
    assert.ok(problems.some((line) => line.startsWith("LICENSE:1: unfilled placeholder")), problems.join("\n"));
    assert.ok(problems.includes('package.json: script "hook" runs stacks/lang/hook.mjs, which eject removes'), problems.join("\n"));
  });

  it("refuses an unbalanced fence and an unsafe path, before writing anything", () => {
    assert.throws(() => planEject(fixtureRepo({ ...PROJECT, "ci.yml": "# [harness]\nrun: x\n" })), /ci\.yml: \[harness\] is never closed/);
    const unsafe = structuredClone(PROJECT);
    unsafe["harness.json"].eject.remove.push("../outside");
    assert.throws(() => planEject(fixtureRepo(unsafe)), /plain segments/);
  });

  it("refuses a project with no eject block", () => {
    assert.throws(() => planEject(fixtureRepo({ ...PROJECT, "harness.json": { docs: [], code: [] } })), /no `eject` block/);
  });
});

describe("applyEject", () => {
  it("writes the plan, and drops the installed pre-push only when it is the unmodified copy", () => {
    for (const [installed, dropped] of [["#!/bin/sh\nhook\n", true], ["#!/bin/sh\nmine\n", false]]) {
      const root = fixtureRepo({ ...PROJECT, ".githooks/pre-push": "#!/bin/sh\nhook\n", "harness.json": { ...PROJECT["harness.json"], eject: { ...PROJECT["harness.json"].eject, remove: [".claude/", "AGENTS.md", ".githooks/"] } } });
      writeFileSync(join(root, ".git/hooks/pre-push"), installed);
      const result = applyEject(root, planEject(root));
      assert.equal(result.droppedHook, dropped);
      assert.equal(existsSync(join(root, ".git/hooks/pre-push")), !dropped);
      for (const path of [".claude", "AGENTS.md", "CLAUDE.md", "harness.json", ".githooks", "stacks/lang/hook.mjs"]) assert.ok(!existsSync(join(root, path)), path);
      for (const path of ["scripts/stack.mjs", "stacks/lang/run.mjs", "src/app.ts"]) assert.ok(existsSync(join(root, path)), path);
      assert.equal(readFileSync(join(root, "ci.yml"), "utf8"), "steps:\n  - run: pnpm lang\n");
    }
  });
});

describe("CLI", () => {
  it("refuses --apply on dev and main, and over uncommitted changes; a dry run changes nothing", () => {
    for (const branch of ["dev", "main"]) {
      const result = spawnSync(process.execPath, [EJECT, "--apply"], { cwd: fixtureRepo(PROJECT, branch), encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`on '${branch}'`));
    }
    const dirty = fixtureRepo(PROJECT);
    writeFileSync(join(dirty, "src/app.ts"), "changed\n");
    assert.match(spawnSync(process.execPath, [EJECT, "--apply"], { cwd: dirty, encoding: "utf8" }).stderr, /uncommitted changes/);
    const root = fixtureRepo(PROJECT);
    assert.equal(spawnSync(process.execPath, [EJECT], { cwd: root, encoding: "utf8" }).status, 0);
    assert.equal(git(root, "status", "--porcelain"), "");
  });
});

describe("this repo", () => {
  it("ejects to a tree with no harness file, no fence, and no script or CI step that needs one", () => {
    // A copy of this checkout on a publish branch, ejected for real.
    const root = mkdtempSync(join(tmpdir(), "eject-repo-"));
    for (const path of trackedFiles(REPO)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(REPO, path), join(root, path));
    }
    git(root, "init", "--quiet", "--initial-branch=publish");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "fixture");
    const plan = planEject(root);
    // Only the copy's own leaks (README, changelogs, placeholders) may remain; never a broken script.
    assert.deepEqual(plan.problems.filter((line) => line.startsWith("package.json: script")), []);
    applyEject(root, plan);
    for (const path of ["AGENTS.md", "CLAUDE.md", "harness.json", ".claude", ".cursor", ".githooks", "scripts/command-guard.mjs", "scripts/check-edited.mjs", "scripts/harness-sync.mjs", "docs/guide", "docs/plans"]) {
      assert.ok(!existsSync(join(root, path)), `${path} survived the eject`);
    }
    for (const path of trackedFiles(root)) {
      const text = readFileSync(join(root, path), "utf8");
      assert.ok(!/^\s*(?:\/\/|#|<!--)\s*\[\/?harness\]/m.test(text), `${path} still has a [harness] fence`);
    }
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    for (const gone of ["rules:check", "plans:check", "test:harness"]) assert.ok(!ci.includes(gone), `ci.yml still runs ${gone}`);
    // The kept runner still loads every pack without the harness beside it.
    const list = spawnSync(process.execPath, ["scripts/stack.mjs", "list"], { cwd: root, encoding: "utf8" });
    assert.equal(list.status, 0, list.stderr);
    for (const pack of JSON.parse(readFileSync(join(REPO, "harness.json"), "utf8")).stacks.filter((name) => existsSync(join(REPO, "stacks", name)))) {
      const manifest = JSON.parse(readFileSync(join(root, "stacks", pack, "pack.json"), "utf8"));
      for (const field of ["docs", "editCheck", "claudeSettings", "ejectRemove"]) assert.ok(!(field in manifest), `${pack} pack.json keeps ${field}`);
      // `code` only: `owns` may name files a tool writes later (proptest's regression files).
      for (const path of manifest.code ?? []) assert.ok(existsSync(join(root, path)), `${pack} lists ${path}, which is gone`);
    }
  });
});
