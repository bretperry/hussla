/*
  Stack packs: fences, manifests, path safety, drift, the edit hook, and removing a pack end to end.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/stack.mjs, scripts/check-edited.mjs, scripts/harness-sync.mjs (status, pull) against a local upstream; git.

  The end-to-end cases copy the repo into a temp dir, so they run on whatever packs this checkout
  has and skip a pack it has already removed. A removal that leaves one CI step or one config file
  behind is the failure that matters: the next CI run goes red on a tool that is no longer installed.
  The rest use small fixture repos, because a removal that misbehaves must do it somewhere harmless.
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { assertSafePath, drift, exclusiveClaims, orderByRequires, packageJsonWithout, presentPacks, removePack, requiredChecksOf, selectPacks, settingsWithout, stripFences, trackedFiles, withDependents } from "./stack.mjs";

// This repo's root and its scripts, for spawning them against fixtures.
const REPO = resolve(".");
const STACK = join(REPO, "scripts/stack.mjs");
const CHECK_EDITED = join(REPO, "scripts/check-edited.mjs");

// A throwaway git identity, so commits work on a machine (or CI runner) with none configured.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

// Runs git in `cwd` and returns stdout.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

// Writes `files` ({ path: content }) under root, creating directories.
const writeFiles = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
};

// A temp git repo holding `files`, committed.
const fixtureRepo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "stack-fixture-"));
  writeFiles(root, files);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  return root;
};

// A temp git repo holding this checkout's files (tracked and new; regular files only, so a
// symlinked node_modules is skipped), committed on `dev`: the branch harness.json's `ref` names, so a
// copy can stand in for upstream as well as for a project.
const copyOfRepo = () => {
  const root = mkdtempSync(join(tmpdir(), "stack-repo-"));
  for (const path of trackedFiles(REPO)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path));
  }
  git(root, "init", "--quiet", "--initial-branch=dev");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
};

// Runs harness-sync in a project against a local upstream; returns { status, output }.
const harnessSync = (project, upstream, command) => {
  const result = spawnSync(process.execPath, ["scripts/harness-sync.mjs", command], {
    cwd: project,
    encoding: "utf8",
    env: { ...GIT_ENV, HARNESS_UPSTREAM_URL: upstream },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

// Runs the stack CLI in `cwd`; returns { status, stdout, stderr }.
const stackCli = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [STACK, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// A pack's opening fence marker, built at runtime: written out here, it would be a fence in this file.
const openMarker = (name) => `[stack:${name}]`;
const closeMarker = (name) => `[/stack:${name}]`;

// Skip reason when this checkout no longer has the pack, so a project that removed it stays green.
const unlessPresent = (name) => (existsSync(join(REPO, `stacks/${name}/pack.json`)) ? false : `${name} pack not present in this checkout`);

// Sort order for pack names, and the packs a project's harness.project.json says it removed.
const byName = (a, b) => a.localeCompare(b);
const removedStacksOf = (root) =>
  (existsSync(join(root, "harness.project.json")) ? (JSON.parse(readFileSync(join(root, "harness.project.json"), "utf8")).removedStacks ?? []) : []).toSorted(byName);

// Every tracked file in root that still carries a marker line for `name`.
const filesWithFence = (root, name) =>
  trackedFiles(root).filter((path) => readFileSync(join(root, path), "utf8").split("\n").some((line) => line.trim().includes(openMarker(name))));

// Two packs sharing a config file, a script, a dependency, and a permission, plus fenced docs.
const sharingFixture = () => ({
  "stacks/lang/pack.json": { name: "lang", kind: "language", owns: ["lang.cfg", "shared.cfg"], packageJson: { scripts: ["lint", "test"], devDependencies: ["linter", "runner"] }, claudeSettings: { allow: ["Bash(pnpm lint)", "Bash(pnpm test)"] } },
  "stacks/other/pack.json": { name: "other", kind: "language", owns: ["shared.cfg"], packageJson: { scripts: ["test"], devDependencies: ["runner"] }, claudeSettings: { allow: ["Bash(pnpm test)"] } },
  "lang.cfg": "x",
  "shared.cfg": "x",
  "package.json": { scripts: { lint: "l", test: "t" }, devDependencies: { linter: "1", runner: "1" } },
  // One-line hook objects: the layout a full rewrite would explode.
  ".claude/settings.json": '{\n  "permissions": {\n    "allow": [\n      "Bash(git status)",\n      "Bash(pnpm lint)",\n      "Bash(pnpm test)"\n    ]\n  },\n  "hooks": { "PostToolUse": [{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "x" }] }] }\n}\n',
  "README.md": `top\n<!-- ${openMarker("lang")} -->\nlang text\n<!-- ${closeMarker("lang")} -->\nbottom\n`,
  ".gitignore": "dist/\n.env\n",
});

// A pack whose generator writes `content` to out.txt; `extra` adds files to the fixture.
const driftRepo = (content, extra = {}) =>
  fixtureRepo({
    "stacks/demo/pack.json": { name: "demo", kind: "language", generated: [{ script: "gen", files: ["out.txt"] }] },
    "package.json": { scripts: { gen: content === null ? "node -e 0" : `node -e "require('fs').writeFileSync('out.txt','${content}')"` } },
    ...extra,
  });

// A pack whose edit check runs `body` (a node script).
const editPack = (name, extensions, body) => ({
  [`stacks/${name}/pack.json`]: { name, kind: "language", editCheck: { extensions, run: `stacks/${name}/check.mjs` } },
  [`stacks/${name}/check.mjs`]: body,
});

// Upstream's history as a pre-pack project saw it: commit 1 without stacks/ (the project's
// base), commit 2 adds stacks/ and edits the TypeScript rule. Returns { upstream, project, rule }.
const prePackProject = () => {
  const upstream = copyOfRepo();
  const saved = mkdtempSync(join(tmpdir(), "stack-saved-"));
  cpSync(join(upstream, "stacks"), join(saved, "stacks"), { recursive: true });
  git(upstream, "rm", "-r", "--quiet", "stacks");
  git(upstream, "commit", "--quiet", "-m", "before packs");
  const project = mkdtempSync(join(tmpdir(), "stack-prepack-"));
  git(tmpdir(), "clone", "--quiet", upstream, project);
  writeFileSync(join(project, "harness.project.json"), `${JSON.stringify({ base: git(upstream, "rev-parse", "HEAD").trim(), skip: {} }, null, 2)}\n`);
  cpSync(join(saved, "stacks"), join(upstream, "stacks"), { recursive: true });
  const rule = JSON.parse(readFileSync(join(upstream, "stacks/typescript/pack.json"), "utf8")).docs[0];
  writeFileSync(join(upstream, rule), `${readFileSync(join(upstream, rule), "utf8")}\nupstream edit\n`);
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "packs");
  return { upstream, project, rule };
};

describe("stripFences", () => {
  it("drops the marker lines and everything between them, in any comment syntax", () => {
    const text = ["keep", `# ${openMarker("demo")}`, "gone", `# ${closeMarker("demo")}`, `<!-- ${openMarker("demo")} -->`, "gone too", `<!-- ${closeMarker("demo")} -->`, "kept"].join("\n");
    assert.equal(stripFences(text, "demo"), "keep\nkept");
  });

  it("leaves another pack's fence, and prose that mentions a marker, alone", () => {
    const other = `# ${openMarker("other")}\nx\n# ${closeMarker("other")}`;
    assert.equal(stripFences(other, "demo"), other);
    const prose = `Start the region with a ${openMarker("demo")} line.`;
    assert.equal(stripFences(`a\n${prose}\nb`, "demo"), `a\n${prose}\nb`);
  });

  it("refuses an unclosed, stray, doubled, or one-line fence rather than eating the file", () => {
    assert.throws(() => stripFences(`# ${openMarker("demo")}\nx`, "demo"), /never closed/);
    assert.throws(() => stripFences(`x\n# ${closeMarker("demo")}`, "demo"), /no opening marker/);
    assert.throws(() => stripFences(`# ${openMarker("demo")}\n# ${openMarker("demo")}\n# ${closeMarker("demo")}`, "demo"), /opened twice/);
    assert.throws(() => stripFences(`<!-- ${openMarker("demo")} x ${closeMarker("demo")} -->`, "demo"), /on one line/);
  });
});

describe("pack manifests", () => {
  const lang = { name: "lang", requires: [] };
  const addon = { name: "addon", requires: ["lang"] };
  const deeper = { name: "deeper", requires: ["addon"] };

  it("orders a pack after what it requires, and finds every dependent", () => {
    assert.deepEqual(orderByRequires([addon, deeper, lang]).map((pack) => pack.name), ["lang", "addon", "deeper"]);
    assert.deepEqual(withDependents("lang", [lang, addon, deeper]), ["deeper", "addon", "lang"]);
    assert.deepEqual(withDependents("addon", [lang, addon, deeper]), ["deeper", "addon"]);
  });

  it("takes out only the claims no kept pack shares", () => {
    const leaving = { owns: ["a.cfg", "shared.cfg"], packageJson: { scripts: ["lint", "test"], devDependencies: ["linter", "runner"] }, claudeSettings: { allow: ["Bash(pnpm lint)", "Bash(pnpm test)"], plugins: ["lsp"] } };
    const staying = { owns: ["shared.cfg"], packageJson: { scripts: ["test"], devDependencies: ["runner"] }, claudeSettings: { allow: ["Bash(pnpm test)"] } };
    const claims = exclusiveClaims(leaving, [staying]);
    assert.deepEqual(claims.files, ["a.cfg"]);
    const pkg = { scripts: { lint: "l", test: "t", check: "c" }, devDependencies: { linter: "1", runner: "1" } };
    assert.deepEqual(packageJsonWithout(pkg, claims), { scripts: { test: "t", check: "c" }, devDependencies: { runner: "1" } });
    const settings = { permissions: { allow: ["Bash(pnpm lint)", "Bash(pnpm test)"] }, enabledPlugins: { lsp: true } };
    assert.deepEqual(settingsWithout(settings, claims), { permissions: { allow: ["Bash(pnpm test)"] }, enabledPlugins: {} });
  });

  it("refuses a manifest whose name isn't its directory", () => {
    const root = fixtureRepo({ "stacks/demo/pack.json": { name: "other", kind: "language" } });
    assert.throws(() => presentPacks(root), /must be 'demo'/);
  });
});

describe("path safety", () => {
  it("refuses empty, dot, parent, trailing-slash, and absolute paths", () => {
    for (const path of ["", ".", "../x", "src/", "a/../b", "/etc/passwd", "a//b", "a\\b"]) {
      assert.throws(() => assertSafePath("/repo", path), Error, `accepted '${path}'`);
    }
    assert.equal(assertSafePath("/repo", "src/a.ts"), "src/a.ts");
  });

  it("a bad owns entry stops the removal before anything is deleted", () => {
    for (const bad of ["", ".", "../x", "src/"]) {
      const root = fixtureRepo({ "stacks/demo/pack.json": { name: "demo", kind: "language", owns: ["keep.txt", bad] }, "keep.txt": "x", "src/a.txt": "a" });
      assert.throws(() => removePack(root, "demo", { lockfile: false }), Error, `accepted '${bad}'`);
      assert.ok(existsSync(join(root, "keep.txt")) && existsSync(join(root, "src/a.txt")) && existsSync(join(root, "stacks/demo/pack.json")), `'${bad}' deleted something`);
    }
  });
});

describe("removePack on a fixture", () => {
  it("keeps what a kept pack shares, and lists only what changed", () => {
    const root = fixtureRepo(sharingFixture());
    const result = removePack(root, "lang", { lockfile: false });
    assert.deepEqual(result.kept, ["other"]);
    assert.deepEqual(new Set(result.deleted), new Set(["lang.cfg", "stacks/lang/"]));
    assert.ok(existsSync(join(root, "shared.cfg")));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), { scripts: { test: "t" }, devDependencies: { runner: "1" } });
    assert.deepEqual(new Set(result.edited), new Set([".claude/settings.json", "README.md", "harness.project.json", "package.json"]));
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "top\nbottom\n");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "harness.project.json"), "utf8")).removedStacks, ["lang"]);
  });

  it("edits settings.json by the line, leaving its layout", () => {
    const root = fixtureRepo(sharingFixture());
    removePack(root, "lang", { lockfile: false });
    const diff = git(root, "diff", "--numstat", "--", ".claude/settings.json").trim();
    assert.equal(diff, "0\t1\t.claude/settings.json");
  });

  it("never touches ignored files, build output, or a nested worktree", () => {
    const root = fixtureRepo(sharingFixture());
    const fenced = `<!-- ${openMarker("lang")} -->\nx\n<!-- ${closeMarker("lang")} -->\n`;
    writeFiles(root, { "dist/out.md": fenced, ".env": fenced, ".claude/worktrees/wt/README.md": fenced });
    git(join(root, ".claude/worktrees/wt"), "init", "--quiet");
    removePack(root, "lang", { lockfile: false });
    for (const path of ["dist/out.md", ".env", ".claude/worktrees/wt/README.md"]) assert.equal(readFileSync(join(root, path), "utf8"), fenced, `${path} was edited`);
  });

  it("fails loudly outside a git repo instead of walking the disk", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-nogit-"));
    writeFiles(root, { "stacks/lang/pack.json": { name: "lang", kind: "language" } });
    assert.throws(() => removePack(root, "lang", { lockfile: false }), /git ls-files failed/);
  });
});

describe("CLI", () => {
  it("an unknown pack is one line on stderr and exit 1", () => {
    const root = fixtureRepo({ "stacks/lang/pack.json": { name: "lang", kind: "language" } });
    const result = stackCli(root, "remove", "nope");
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
    assert.match(result.stderr, /no pack 'nope'/);
  });

  it("list tells present, removed, and available apart", () => {
    const root = fixtureRepo({
      "stacks/lang/pack.json": { name: "lang", kind: "language", summary: "L" },
      "harness.json": { stacks: ["lang", "gone", "newer"] },
      "harness.project.json": { base: "", skip: {}, removedStacks: ["gone"] },
    });
    const out = stackCli(root, "list").stdout;
    assert.match(out, /lang\s+present/);
    assert.match(out, /gone\s+removed/);
    assert.match(out, /newer\s+available/);
  });
});

describe("selectPacks (check --packs <list>)", () => {
  const packs = [{ name: "rust" }, { name: "go" }, { name: "swift" }];
  const cases = [
    ["", ["rust", "go", "swift"]],
    ["all", ["rust", "go", "swift"]],
    ["none", []],
    ["go", ["go"]],
    ["swift,rust", ["rust", "swift"]],
  ];
  for (const [list, expected] of cases) {
    it(`${JSON.stringify(list)} → ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(selectPacks(packs, list).map((pack) => pack.name), expected);
    });
  }
});

describe("drift", () => {
  it("passes when the committed file is what the generator writes", () => {
    assert.deepEqual(drift(driftRepo("fresh", { "out.txt": "fresh" }), { quiet: true }), { declared: 1, problems: [] });
  });

  it("fails when it differs, is untracked, is missing, or is gitignored", () => {
    assert.deepEqual(drift(driftRepo("fresh", { "out.txt": "stale" }), { quiet: true }).problems, ["demo: out.txt differs from what is committed"]);
    assert.deepEqual(drift(driftRepo("fresh"), { quiet: true }).problems, ["demo: out.txt differs from what is committed"]);
    assert.deepEqual(drift(driftRepo(null), { quiet: true }).problems, ["demo: out.txt missing after `gen`"]);
    assert.deepEqual(drift(driftRepo("fresh", { ".gitignore": "out.txt\n" }), { quiet: true }).problems, ["demo: out.txt is gitignored, so its drift can't be seen"]);
  });

  it("throws when git can't answer, and reports when nothing is declared", () => {
    const root = mkdtempSync(join(tmpdir(), "stack-nogit-"));
    writeFiles(root, {
      "stacks/demo/pack.json": { name: "demo", kind: "language", generated: [{ script: "gen", files: ["out.txt"] }] },
      "package.json": { scripts: { gen: "node -e \"require('fs').writeFileSync('out.txt','x')\"" } },
    });
    assert.throws(() => drift(root, { quiet: true }), /git/);
    const empty = fixtureRepo({ "stacks/demo/pack.json": { name: "demo", kind: "language" } });
    assert.deepEqual(drift(empty), { declared: 0, problems: [] });
    assert.match(stackCli(empty, "drift").stdout, /no generated files declared/);
  });
});

// check-edited.mjs is a harness file a project may skip (habit does: its tsc is too slow for the hook).
describe("check-edited dispatch", { skip: existsSync(CHECK_EDITED) ? false : "scripts/check-edited.mjs not in this project" }, () => {
  const root = fixtureRepo({
    ...editPack("one", [".x"], 'console.log("one: bad " + process.argv[2]);'),
    ...editPack("two", [".x"], 'console.log("two: bad");'),
    ...editPack("crash", [".z"], 'console.error("boom"); process.exit(3);'),
    // Claims one config by name, whose extension (.json) is too common to claim.
    "stacks/cfg/pack.json": { name: "cfg", kind: "language", editCheck: { extensions: [".cfgx"], files: ["conf/layers.json"], run: "stacks/cfg/check.mjs" } },
    "stacks/cfg/check.mjs": 'console.log("cfg: bad " + process.argv[2]);',
  });
  // Runs the hook as Claude Code would, for an edit to `file`; returns its stdout.
  const hook = (file) =>
    spawnSync(process.execPath, [CHECK_EDITED, "claude"], { input: JSON.stringify({ tool_input: { file_path: join(root, file) } }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: "utf8" }).stdout;

  it("runs every pack that claims the extension", () => {
    const context = JSON.parse(hook("a.x")).hookSpecificOutput.additionalContext;
    assert.match(context, /\[one\]\none: bad a\.x/);
    assert.match(context, /\[two\]\ntwo: bad/);
  });

  it("stays silent for an extension no pack claims", () => {
    assert.equal(hook("a.y"), "");
  });

  // PR #21 round-3 nit: `M.SQL` is a migration to the lint, so the edit hook must claim it too.
  it("matches a claimed extension in any case", () => {
    assert.match(JSON.parse(hook("A.X")).hookSpecificOutput.additionalContext, /\[one\]\none: bad A\.X/);
  });

  it("runs a pack on a file it claims by exact path, and not on others with that extension", () => {
    assert.match(JSON.parse(hook("conf/layers.json")).hookSpecificOutput.additionalContext, /\[cfg\]\ncfg: bad conf\/layers\.json/);
    assert.equal(hook("conf/other.json"), "");
  });

  it("reports a crashed check instead of reading it as clean", () => {
    assert.match(JSON.parse(hook("a.z")).hookSpecificOutput.additionalContext, /\[crash\] edit check failed: boom/);
  });

  // `Dockerfile.prod` has the extension `.prod`, so only a basename pattern can claim it.
  it("runs a pack that claims the file by basename pattern (the infra pack's Dockerfile spellings)", { skip: unlessPresent("infra") }, () => {
    const { names } = JSON.parse(readFileSync(join(REPO, "stacks/infra/pack.json"), "utf8")).editCheck;
    const named = fixtureRepo({
      "stacks/named/pack.json": { name: "named", kind: "add-on", editCheck: { extensions: [".tf"], names, run: "stacks/named/check.mjs" } },
      "stacks/named/check.mjs": 'console.log("named: " + process.argv[2]);',
    });
    const edit = (file) =>
      spawnSync(process.execPath, [CHECK_EDITED, "claude"], { input: JSON.stringify({ tool_input: { file_path: join(named, file) } }), env: { ...process.env, CLAUDE_PROJECT_DIR: named }, encoding: "utf8" }).stdout;
    for (const file of ["Dockerfile", "app/Dockerfile.prod", "Containerfile.dev", "api.Dockerfile", "main.tf"]) assert.match(edit(file), /named: /, file);
    for (const file of ["Makefile", "Dockerfiles", "docs/Dockerfile.md.txt/x", ".dockerignore"]) assert.equal(edit(file), "", file);
  });
});

// Runs bootstrap-repo.sh in a fixture holding `files`, against a stand-in `gh` that records each call
// (and each ruleset body it is sent) and a local bare origin with a dev branch. `GH_MISSING` names a
// gh path the stand-in answers 404 for (a branch the repo lacks); `HARNESS_UPSTREAM_URL` defaults to
// a path that doesn't exist, so no test reaches the network. `prepare(root)` runs before bootstrap.
// Returns { result, root, log, output }.
const runBootstrap = (files, env = {}, prepare = () => {}) => {
  const root = fixtureRepo({ "harness.project.json": { base: "", skip: {} }, "harness.json": { upstream: "o/whippletree", ref: "dev" }, ...files });
  for (const path of ["scripts/bootstrap-repo.sh", "scripts/install-git-hooks.sh", "scripts/stack.mjs", "scripts/sync-claude-rules.mjs", ".githooks/pre-push"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path));
  }
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "scripts");
  git(root, "branch", "dev");
  const origin = mkdtempSync(join(tmpdir(), "stack-origin-"));
  git(tmpdir(), "clone", "--quiet", "--bare", root, origin);
  git(root, "remote", "add", "origin", origin);
  prepare(root);
  const bin = mkdtempSync(join(tmpdir(), "stack-gh-"));
  const log = join(bin, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\ncase "$*" in\n  *"$GH_MISSING"*) [ -n "$GH_MISSING" ] && exit 1 ;;\nesac\ncase "$*" in\n  "repo view"*) echo "o/r" ;;\n  *"/git/ref/heads/"*) echo "abc123" ;;\n  *"-X POST"*) cat >> "${log}"; echo >> "${log}" ;;\nesac\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["scripts/bootstrap-repo.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH ?? ""}`, GH_MISSING: "", HARNESS_UPSTREAM_URL: join(bin, "no-upstream"), ...env },
  });
  return { result, root, log: existsSync(log) ? readFileSync(log, "utf8") : "", output: `${result.stdout}${result.stderr}` };
};

// runBootstrap over `packFiles`: the gh log; with `status` set, asserts that exit status instead of 0 and returns { log, output }.
const bootstrap = (packFiles, env = {}, status) => {
  const { result, log, output } = runBootstrap(packFiles, env);
  assert.equal(result.status, status ?? 0, output);
  return status === undefined ? log : { log, output };
};

// The ruleset body sent for `name`, parsed: from its first line to the next gh call (bodies span lines).
const rulesetBody = (log, name) => {
  const start = log.indexOf(`{"name":${JSON.stringify(name)}`);
  const end = log.indexOf("\ngh ", start);
  return start === -1 ? null : JSON.parse(log.slice(start, end === -1 ? undefined : end));
};

// The required check names in the ruleset body sent for `name`.
const contexts = (log, name) => {
  const body = log.split("\n").find((line) => line.includes(`"name":"${name}"`)) ?? "";
  const start = log.indexOf(body);
  const json = log.slice(start, log.indexOf("gh ", start + 1) === -1 ? undefined : log.indexOf("gh ", start + 1));
  return [...json.matchAll(/\{"context":"([^"]+)"\}/g)].map((match) => match[1]);
};

describe("required checks (pack.json requiredChecks)", () => {
  const packs = {
    "stacks/lang/pack.json": { name: "lang", kind: "language", requiredChecks: ["Lang tests", "Shared check"] },
    "stacks/other/pack.json": { name: "other", kind: "language", requiredChecks: ["Shared check"] },
  };

  it("lists each present pack's once, in pack order", () => {
    assert.deepEqual(requiredChecksOf([{ requiredChecks: ["A", "B"] }, {}, { requiredChecks: ["B", "C"] }]), ["A", "B", "C"]);
    assert.equal(stackCli(fixtureRepo(packs), "required-checks").stdout, "Lang tests,Shared check\n");
    assert.equal(stackCli(fixtureRepo({ "stacks/plain/pack.json": { name: "plain", kind: "language" } }), "required-checks").stdout, "\n");
  });

  it("stack:remove says to drop a removed pack's check from the rulesets, but not one a kept pack still requires", () => {
    const root = fixtureRepo(packs);
    const result = stackCli(root, "remove", "lang");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /drop the required check "Lang tests" from the 'main: production' and 'dev: PR and checks' rulesets/);
    assert.doesNotMatch(result.stdout, /"Shared check"/);
    assert.deepEqual(removePack(fixtureRepo(packs), "other", { lockfile: false }).requiredChecks, []);
  });

  it("bootstrap-repo.sh requires a present pack's checks on both PR rulesets", { skip: process.platform === "win32" }, () => {
    const log = bootstrap(packs);
    assert.deepEqual(contexts(log, "dev: PR and checks"), ["Checks", "Build", "Lang tests", "Shared check"]);
    assert.deepEqual(contexts(log, "main: production"), ["Checks", "Build", "Lang tests", "Shared check", "Only dev merges to main"]);
  });

  it("bootstrap-repo.sh requires only the template's checks when no pack declares one, and REQUIRED_CHECKS still wins", { skip: process.platform === "win32" }, () => {
    assert.deepEqual(contexts(bootstrap({ "stacks/plain/pack.json": { name: "plain", kind: "language" } }), "dev: PR and checks"), ["Checks", "Build"]);
    assert.deepEqual(contexts(bootstrap(packs, { REQUIRED_CHECKS: "Checks" }), "dev: PR and checks"), ["Checks"]);
  });

  it("refuses a pack check name holding a quote or a comma, and bootstrap-repo.sh sends no ruleset for it", { skip: process.platform === "win32" }, () => {
    const bad = { "stacks/lang/pack.json": { name: "lang", kind: "language", requiredChecks: ['Lang "tests", macOS'] } };
    assert.throws(() => requiredChecksOf([bad["stacks/lang/pack.json"]]), /requiredChecks has "Lang \\"tests\\", macOS"/);
    const { log, output } = bootstrap(bad, {}, 1);
    assert.match(output, /a check name is letters, digits, spaces/);
    assert.doesNotMatch(log, /rulesets/);
  });

  it("bootstrap-repo.sh builds valid JSON for a REQUIRED_CHECKS name holding a quote", { skip: process.platform === "win32" }, () => {
    const log = bootstrap({ "stacks/plain/pack.json": { name: "plain", kind: "language" } }, { REQUIRED_CHECKS: 'Checks,Say "hi" \\ there' });
    const rule = rulesetBody(log, "dev: PR and checks")?.rules.find((entry) => entry.type === "required_status_checks");
    assert.deepEqual(rule?.parameters.required_status_checks, [{ context: "Checks" }, { context: 'Say "hi" \\ there' }]);
  });

  it("bootstrap-repo.sh reads no pack when REQUIRED_CHECKS is set, so a broken pack.json can't block the override", { skip: process.platform === "win32" }, () => {
    const broken = { "stacks/lang/pack.json": { name: "not-lang", kind: "language" } };
    assert.deepEqual(contexts(bootstrap(broken, { REQUIRED_CHECKS: "Checks" }), "dev: PR and checks"), ["Checks"]);
  });
});

// A fixture's harness.project.json, parsed.
const readProject = (root) => JSON.parse(readFileSync(join(root, "harness.project.json"), "utf8"));

describe("bootstrap-repo.sh: branches and the harness base", { skip: process.platform === "win32" }, () => {
  it("creates main from dev when the template copy has only dev", () => {
    const { result, log, output } = runBootstrap({}, { GH_MISSING: "branches/main" });
    assert.equal(result.status, 0, output);
    assert.match(log, /gh api repos\/o\/r\/git\/refs -f ref=refs\/heads\/main -f sha=abc123/);
    assert.match(output, /main: created from dev/);
  });

  it("records the upstream commit whose tree the project's first commit copied, not upstream's tip, and keeps the rest of the file", () => {
    const upstream = mkdtempSync(join(tmpdir(), "stack-upstream-"));
    git(tmpdir(), "init", "--quiet", "--bare", upstream);
    let copied = "";
    const { result, root, output } = runBootstrap({ "harness.project.json": { base: "", skip: {}, removedStacks: ["swift"] } }, { HARNESS_UPSTREAM_URL: upstream }, (project) => {
      // Upstream's history shares no commit with the copy: same first tree, different commit, then a newer tip.
      const firstTree = git(project, "rev-parse", `${git(project, "rev-list", "--max-parents=0", "HEAD").trim()}^{tree}`).trim();
      copied = git(project, "commit-tree", firstTree, "-m", "upstream: the commit the template copied").trim();
      const tip = git(project, "commit-tree", git(project, "rev-parse", "HEAD^{tree}").trim(), "-p", copied, "-m", "upstream: later").trim();
      git(project, "push", "--quiet", upstream, `${tip}:refs/heads/dev`);
    });
    assert.equal(result.status, 0, output);
    assert.deepEqual(readProject(root), { base: copied, skip: {}, removedStacks: ["swift"] });
    assert.match(output, /Commit it on dev/);
  });

  it("an unreadable upstream leaves base empty, says how to finish, and still installs the hooks; a recorded base is never moved", () => {
    const { result, root, output } = runBootstrap({});
    assert.equal(result.status, 0, output);
    assert.match(output, /could not read o\/whippletree/);
    assert.equal(readProject(root).base, "");
    assert.ok(existsSync(join(git(root, "rev-parse", "--path-format=absolute", "--git-path", "hooks").trim(), "pre-push")), "hooks not installed");
    const kept = runBootstrap({ "harness.project.json": { base: "f00d", skip: {} } });
    assert.equal(kept.result.status, 0, kept.output);
    assert.equal(readProject(kept.root).base, "f00d");
    assert.match(kept.output, /already recorded/);
  });
});

describe("removing a pack from a copy of this repo", () => {
  it("react: no rule scoped to .tsx is left, and typescript stays", { skip: unlessPresent("react") }, () => {
    const root = copyOfRepo();
    const before = presentPacks(root).map((pack) => pack.name);
    const removedBefore = removedStacksOf(root);
    const result = removePack(root, "react", { lockfile: false });
    assert.deepEqual(result.removed, ["react"]);
    assert.ok(!existsSync(join(root, "stacks/react")));
    const ruleFiles = trackedFiles(root).filter((path) => path.startsWith(".cursor/rules/") || path.startsWith(".claude/rules/"));
    // A rule that loads only for `.tsx` files: its globs/paths name .tsx and no other extension.
    const tsxOnly = ruleFiles.filter((path) => /^(globs:|\s+-) *"?\*\*\/\*\.tsx"?\s*$/m.test(readFileSync(join(root, path), "utf8")));
    assert.deepEqual(tsxOnly, []);
    assert.deepEqual(filesWithFence(root, "react"), []);
    // Exactly: every other pack survives, and only react joins the removed list.
    assert.deepEqual(presentPacks(root).map((pack) => pack.name).toSorted(byName), before.filter((name) => name !== "react").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "react"])].toSorted(byName));
  });

  it("infra: its files, fences, scripts, and permissions go; the other packs and the guard's infra rules stay", { skip: unlessPresent("infra") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/infra/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    const result = removePack(root, "infra", { lockfile: false });
    assert.deepEqual(result.removed, ["infra"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/infra"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "infra"), []);
    // No infra: script and no permission for its tools is left.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("infra:")), []);
    const allow = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions.allow;
    assert.deepEqual(allow.filter((entry) => /infra:|terraform|tflint|hadolint/.test(entry)), []);
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "infra").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "infra"])].toSorted(byName));
    // The guard is harness: its refusal of apply/destroy is core.mdc's, so it outlives the pack.
    assert.match(readFileSync(join(root, "scripts/command-guard.mjs"), "utf8"), /const IAC_CLI = /);
    // Removing the pack never makes a secret committable, and keeps the Docker build context's ignore file.
    const ignored = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    for (const line of ["*.tfstate", "*.tfstate.*", "*.tfvars", "*.tfvars.json", "*.tfplan", ".terraform/"]) assert.ok(ignored.includes(line), `.gitignore lost ${line}`);
    // As git reads it: real values and state ignored, the example still committable (exit 0 = ignored, 1 = not).
    const isIgnored = (path) => spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", path]).status === 0;
    for (const path of ["terraform.tfvars", "infra/prod/prod.auto.tfvars", "infra/x.tfvars.json", "infra/terraform.tfstate.backup"]) assert.ok(isIgnored(path), `${path} is committable`);
    assert.ok(!isIgnored("infra/terraform.tfvars.example"), "terraform.tfvars.example is ignored");
    assert.ok(existsSync(join(root, ".dockerignore")));
  });

  it("typescript: its files, CI checks, scripts, and dependents go; harness:status is clean; harness:pull doesn't restore it", { skip: unlessPresent("typescript") }, () => {
    const upstream = copyOfRepo();
    const project = mkdtempSync(join(tmpdir(), "stack-project-"));
    git(tmpdir(), "clone", "--quiet", upstream, project);
    // The project last took upstream's current commit, as bootstrap records it.
    writeFileSync(join(project, "harness.project.json"), `${JSON.stringify({ base: git(upstream, "rev-parse", "HEAD").trim(), skip: {} }, null, 2)}\n`);
    const pack = JSON.parse(readFileSync(join(project, "stacks/typescript/pack.json"), "utf8"));
    const ciBefore = readFileSync(join(project, ".github/workflows/ci.yml"), "utf8");

    const before = presentPacks(project).map((other) => other.name);
    const removedBefore = removedStacksOf(project);
    const result = removePack(project, "typescript", { lockfile: false });
    // Whatever requires it goes first.
    assert.equal(result.removed.at(-1), "typescript");
    // Exactly the removed packs are gone (rust … stays), and exactly they join the removed list.
    assert.deepEqual(presentPacks(project).map((other) => other.name).toSorted(byName), before.filter((name) => !result.removed.includes(name)).toSorted(byName));
    assert.deepEqual(removedStacksOf(project), [...new Set([...removedBefore, ...result.removed])].toSorted(byName));
    // Every file the pack lists, and its directory, is gone.
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/typescript"]) assert.ok(!existsSync(join(project, path)), `${path} still exists`);
    // CI reads pack checks from pack.json, so no step names one; the harness's own steps stay.
    const ci = readFileSync(join(project, ".github/workflows/ci.yml"), "utf8");
    for (const step of pack.checks) assert.ok(!ci.includes(`pnpm ${step.script}\n`), `ci.yml runs pnpm ${step.script} directly`);
    for (const command of ["pnpm rules:check", "pnpm plans:check", "pnpm test:harness", "pnpm stack:drift", "stack.mjs check --packs"]) assert.ok(ciBefore.includes(command) && ci.includes(command), `ci.yml lost ${command}`);
    assert.deepEqual(filesWithFence(project, "typescript"), []);
    // Nothing left links to a file the pack took with it (its decision record included); the
    // language-neutral ports-and-adapters decision stays.
    const gone = [...pack.docs, ...pack.code, ...pack.owns];
    const dangling = trackedFiles(project).flatMap((file) => {
      const text = readFileSync(join(project, file), "utf8");
      return gone.filter((path) => text.includes(path)).map((path) => `${file} → ${path}`);
    });
    assert.deepEqual(dangling, []);
    assert.ok(existsSync(join(project, "docs/decisions/0003-ports-and-adapters.md")));
    // package.json keeps none of its scripts or dependencies.
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    for (const script of pack.packageJson.scripts) assert.equal(pkg.scripts[script], undefined);
    // Another pack's dependencies (an add-on's linter) may stay; none of this pack's do.
    for (const dependency of pack.packageJson.devDependencies) assert.equal(pkg.devDependencies?.[dependency], undefined);

    // Nothing upstream ships for the packs this project has differs, so status is clean; the rest are announced.
    const status = harnessSync(project, upstream, "status");
    assert.equal(status.status, 0, status.output);
    assert.match(status.output, /in step/);
    assert.match(status.output, /upstream ships pack typescript, not installed/);

    // Upstream moves a pack file and a core file; pull takes the core one and leaves the pack out.
    writeFileSync(join(upstream, pack.docs[0]), `${readFileSync(join(upstream, pack.docs[0]), "utf8")}\nupstream edit\n`);
    writeFileSync(join(upstream, "docs/decisions/_template.md"), `${readFileSync(join(upstream, "docs/decisions/_template.md"), "utf8")}\nupstream edit\n`);
    git(upstream, "commit", "--quiet", "-am", "upstream moves");
    const pull = harnessSync(project, upstream, "pull");
    assert.equal(pull.status, 0, pull.output);
    assert.ok(readFileSync(join(project, "docs/decisions/_template.md"), "utf8").includes("upstream edit"));
    for (const path of [...pack.docs, ...pack.code, "stacks/typescript/pack.json"]) assert.ok(!existsSync(join(project, path)), `pull restored ${path}`);
    assert.equal(harnessSync(project, upstream, "status").status, 0);
  });

  it("sql-migrations: its files, fences, script, linter, and permissions go; nothing names them after; the other packs stay", { skip: unlessPresent("sql-migrations") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/sql-migrations/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    const result = removePack(root, "sql-migrations", { lockfile: false });
    // An add-on nothing requires goes alone.
    assert.deepEqual(result.removed, ["sql-migrations"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/sql-migrations", ".claude/rules/migrations.md"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "sql-migrations"), []);
    // No tracked file still points at a file the pack took (the guard's own database rules are core and stay).
    const gone = [...pack.docs, ...pack.code, ...pack.owns, "migrations:lint", "squawk"];
    const dangling = trackedFiles(root).flatMap((file) => gone.filter((name) => readFileSync(join(root, file), "utf8").includes(name)).map((name) => `${file} → ${name}`));
    // The changelog records history, the lockfile is refreshed by pnpm, and this test names them on purpose.
    assert.deepEqual(dangling.filter((entry) => !/^(CHANGELOG-TECHNICAL\.md|pnpm-lock\.yaml|scripts\/stack\.test\.mjs) →/.test(entry)), []);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.scripts["migrations:lint"], undefined);
    assert.equal(pkg.devDependencies?.["squawk-cli"], undefined);
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "sql-migrations").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "sql-migrations"])].toSorted(byName));
  });

  it("rust: its files, fences, scripts, and permissions go; the other packs and the ignored target/ are untouched", { skip: unlessPresent("rust") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/rust/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    // What a build and a failed proptest run leave behind: ignored output, and a regression file the pack owns.
    mkdirSync(join(root, "target/debug"), { recursive: true });
    writeFileSync(join(root, "target/debug/artifact"), "binary");
    mkdirSync(join(root, "crates/adapters/tests"), { recursive: true });
    writeFileSync(join(root, "crates/adapters/tests/note_sync_chaos.proptest-regressions"), "cc 0\n");

    const result = removePack(root, "rust", { lockfile: false });
    assert.deepEqual(result.removed, ["rust"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/rust", "crates"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "rust"), []);
    // No script, and no permission naming cargo or a rust: script, is left.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("rust:")), []);
    const allow = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions.allow;
    assert.deepEqual(allow.filter((entry) => /cargo|rust:/.test(entry)), []);
    // The other packs, and the removed list, change by exactly this pack.
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "rust").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "rust"])].toSorted(byName));
    // Build output stays ignored (its fence would have un-ignored it, and the next scan would walk it) and stays on disk.
    git(root, "add", "-A");
    assert.ok(!git(root, "status", "--porcelain", "--untracked-files=all").includes("target/"), "target/ is no longer ignored");
    assert.ok(existsSync(join(root, "target/debug/artifact")));
    assert.ok(!trackedFiles(root).some((path) => path.startsWith("target/")));
  });

  it("python: its files, fences, scripts, and settings go; typescript is untouched; no caches or un-ignored files are left", { skip: unlessPresent("python") || unlessPresent("typescript") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/python/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    // What a working checkout has: bytecode caches beside the sources, plus a venv and tool caches.
    for (const dir of ["src/app/domain", "src/app/services", "tests/chaos", "scripts/lib", "stacks/python"]) writeFiles(root, { [`${dir}/__pycache__/x.pyc`]: "x" });
    for (const dir of [".venv", ".ruff_cache", ".hypothesis"]) writeFiles(root, { [`${dir}/keep`]: "x" });

    const result = removePack(root, "python", { lockfile: false });
    assert.deepEqual(result.removed, ["python"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/python"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "python"), []);
    // The other packs, and the removed list, change by exactly this pack.
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "python").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "python"])].toSorted(byName));
    // No py:* script, no allow entry for the pack's commands, in the files that carried them.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("py:")), []);
    const settings = readFileSync(join(root, ".claude/settings.json"), "utf8");
    assert.ok(!/py:|uv run/.test(settings), "settings.json still names a python command");
    // The TypeScript pack is whole.
    const typescript = JSON.parse(readFileSync(join(root, "stacks/typescript/pack.json"), "utf8"));
    for (const path of [...typescript.docs, ...typescript.code, ...typescript.owns]) assert.ok(existsSync(join(root, path)), `${path} was taken with python`);
    // Nothing the removal left shows up as a new untracked file (the caches' ignore lines are gone with the fences).
    const untracked = git(root, "ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
    // (harness.project.json is the removal's own record, new in a copy that had none.)
    assert.deepEqual(untracked.filter((path) => path !== "harness.project.json" && !pack.leftovers.some((dir) => path.startsWith(dir))), []);
    // The things it can't delete are named for the user.
    assert.deepEqual(result.leftovers.toSorted(byName), [".hypothesis/", ".ruff_cache/", ".venv/"]);
  });

  it("go: its files, fences, scripts, permissions and plugin go; every other pack is untouched", { skip: unlessPresent("go") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/go/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    const result = removePack(root, "go", { lockfile: false });
    assert.deepEqual(result.removed, ["go"]);
    // Everything the manifest lists, and its directory.
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/go"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "go"), []);
    // No go:* script, no Go permission, no Go plugin left in the shared JSON files.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("go:")), []);
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    assert.deepEqual(settings.permissions.allow.filter((entry) => /\bgo\b|go:|golangci/.test(entry)), []);
    assert.deepEqual(Object.keys(settings.enabledPlugins ?? {}).filter((name) => name.startsWith("gopls")), []);
    // The other packs, and the removed list, change by exactly this pack.
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "go").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "go"])].toSorted(byName));
  });

  it("kotlin: its files, fences, scripts, and permissions go; the other packs and the ignored build output are untouched", { skip: unlessPresent("kotlin") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/kotlin/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    // What a Gradle build leaves behind: ignored output at the root and in a module, and the caches.
    const output = ["build/reports/report.js", "domain/build/classes/Foo.class", ".gradle/caches/x.bin", ".kotlin/errors/x.log"];
    for (const path of output) writeFiles(root, { [path]: "output" });

    const result = removePack(root, "kotlin", { lockfile: false });
    assert.deepEqual(result.removed, ["kotlin"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/kotlin"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "kotlin"), []);
    // No script, and no permission naming gradle or a kotlin: script, is left.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("kotlin:")), []);
    const allow = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions.allow;
    assert.deepEqual(allow.filter((entry) => /gradlew|kotlin:/.test(entry)), []);
    // The other packs, and the removed list, change by exactly this pack.
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "kotlin").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "kotlin"])].toSorted(byName));
    // Build output stays ignored (its fence would have un-ignored it, and a lint would walk it) and stays on disk.
    git(root, "add", "-A");
    const status = git(root, "status", "--porcelain", "--untracked-files=all");
    for (const path of output) {
      assert.ok(!status.includes(path), `${path} is no longer ignored`);
      assert.ok(existsSync(join(root, path)), `${path} was deleted`);
    }
    assert.ok(!trackedFiles(root).some((path) => /(^|\/)(build|\.gradle|\.kotlin)\//.test(path)));
  });

  it("cpp: its files, fences, scripts, and permissions go; the other packs and the ignored build trees are untouched", { skip: unlessPresent("cpp") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/cpp/pack.json"), "utf8"));
    const before = presentPacks(root).map((other) => other.name);
    const removedBefore = removedStacksOf(root);
    // What a CMake build leaves behind: a tree per preset and the gate stamp.
    const output = ["build-cpp/asan/CMakeCache.txt", "build-cpp/tsan/cpp/domain/libdomain.a", "build-cpp/gates.stamp"];
    for (const path of output) writeFiles(root, { [path]: "output" });

    const result = removePack(root, "cpp", { lockfile: false });
    assert.deepEqual(result.removed, ["cpp"]);
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/cpp", "cpp"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "cpp"), []);
    // No script, and no permission naming a C++ tool or a cpp: script, is left.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.scripts).filter((name) => name.startsWith("cpp:")), []);
    const allow = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")).permissions.allow;
    assert.deepEqual(allow.filter((entry) => /cpp:|cmake|ctest|clang-/.test(entry)), []);
    // The other packs, and the removed list, change by exactly this pack.
    assert.deepEqual(presentPacks(root).map((other) => other.name).toSorted(byName), before.filter((name) => name !== "cpp").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "cpp"])].toSorted(byName));
    // The build trees stay ignored (the .gitignore line is outside any fence on purpose) and stay on disk, named for the user.
    git(root, "add", "-A");
    const status = git(root, "status", "--porcelain", "--untracked-files=all");
    for (const path of output) {
      assert.ok(!status.includes(path), `${path} is no longer ignored`);
      assert.ok(existsSync(join(root, path)), `${path} was deleted`);
    }
    assert.deepEqual(result.leftovers, ["build-cpp/"]);
  });

  it("no pack's synced files are generic names that would make a pre-pack project adopt it by accident", () => {
    // Adoption fires when a project already holds any of a pack's `adoptOn` files, or, without one, any `docs`/`code` file (harness-sync.mjs holdsPackFiles).
    const GENERIC = ["pyproject.toml", "uv.lock", "package.json", "Cargo.toml", "go.mod", ".gitignore", "README.md", "Makefile"];
    for (const pack of presentPacks(REPO)) {
      const synced = pack.adoptOn ?? [...(pack.docs ?? []), ...(pack.code ?? [])];
      assert.deepEqual(synced.filter((path) => GENERIC.includes(path)), [], `${pack.name} syncs a generic file`);
    }
  });

  it("a pre-pack project holding a pack's files adopts it on pull and keeps syncing it", { skip: unlessPresent("typescript") }, () => {
    const { upstream, project, rule } = prePackProject();
    const status = harnessSync(project, upstream, "status");
    assert.match(status.output, /would adopt pack typescript: its files were already here/);
    const pull = harnessSync(project, upstream, "pull");
    assert.equal(pull.status, 0, pull.output);
    assert.match(pull.output, /adopted pack typescript: its files were already here/);
    assert.ok(existsSync(join(project, "stacks/typescript/pack.json")), "pull did not write the pack manifest");
    assert.ok(readFileSync(join(project, rule), "utf8").includes("upstream edit"), "pull did not sync the adopted pack's rule");
    assert.deepEqual(presentPacks(project).map((pack) => pack.name).includes("typescript"), true);
    assert.equal(harnessSync(project, upstream, "status").status, 0);
  });

  it("a pre-pack project without a pack's files leaves it available, not installed", { skip: unlessPresent("typescript") }, () => {
    const { upstream, project } = prePackProject();
    // Drop every file every pack syncs or adopts on, as a project on another stack would have.
    for (const name of readdirSync(join(upstream, "stacks"))) {
      const pack = JSON.parse(readFileSync(join(upstream, `stacks/${name}/pack.json`), "utf8"));
      for (const path of [...pack.docs, ...pack.code, ...(pack.adoptOn ?? [])]) if (existsSync(join(project, path))) git(project, "rm", "--quiet", path);
    }
    // Generic tool configs and Gradle files a project may well have without the pack: not enough to adopt it.
    for (const generic of ["rustfmt.toml", "clippy.toml", "settings.gradle.kts", "build.gradle.kts", "gradlew"]) writeFileSync(join(project, generic), "");
    const pull = harnessSync(project, upstream, "pull");
    assert.equal(pull.status, 0, pull.output);
    assert.match(pull.output, /upstream ships pack typescript, not installed/);
    assert.doesNotMatch(pull.output, /adopt/);
    assert.ok(!existsSync(join(project, "stacks")));
  });
});

describe("removing the swift pack from a copy of this repo", () => {
  it("takes its files, fences, scripts, and permissions, leaves every other pack alone, and keeps build output ignored", { skip: unlessPresent("swift") }, () => {
    const root = copyOfRepo();
    const pack = JSON.parse(readFileSync(join(root, "stacks/swift/pack.json"), "utf8"));
    // Snapshot first: exactly the other packs, byte for byte, and whatever this checkout had already removed.
    const presentBefore = presentPacks(root).map((installed) => installed.name);
    const manifestsBefore = Object.fromEntries(presentBefore.filter((name) => name !== "swift").map((name) => [name, readFileSync(join(root, `stacks/${name}/pack.json`), "utf8")]));
    const removedBefore = removedStacksOf(root);
    const pkgBefore = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Build output a developer would have lying around.
    mkdirSync(join(root, ".build/debug"), { recursive: true });
    writeFileSync(join(root, ".build/debug/artifact"), "x");

    const result = removePack(root, "swift", { lockfile: false });

    // Exactly swift went (nothing requires it, and it requires nothing).
    assert.deepEqual(result.removed, ["swift"]);
    // Its CI job is gone, so the removal says to drop its required check from the rulesets.
    assert.deepEqual(result.requiredChecks, ["Swift tests"]);
    assert.deepEqual(presentPacks(root).map((installed) => installed.name).toSorted(byName), presentBefore.filter((name) => name !== "swift").toSorted(byName));
    assert.deepEqual(removedStacksOf(root), [...new Set([...removedBefore, "swift"])].toSorted(byName));
    for (const [name, text] of Object.entries(manifestsBefore)) assert.equal(readFileSync(join(root, `stacks/${name}/pack.json`), "utf8"), text, `${name} manifest changed`);

    // Every file it lists, and its directory, is gone; no fence is left behind.
    for (const path of [...pack.docs, ...pack.code, ...pack.owns, "stacks/swift", ".claude/rules/swift.md", ".claude/rules/testing-swift.md"]) assert.ok(!existsSync(join(root, path)), `${path} still exists`);
    assert.deepEqual(filesWithFence(root, "swift"), []);

    // Nothing left names a file the pack took, and the language-neutral decision stays.
    const gone = [...pack.docs, ...pack.code, ...pack.owns];
    const dangling = trackedFiles(root).flatMap((file) => {
      const text = readFileSync(join(root, file), "utf8");
      return gone.filter((path) => text.includes(path)).map((path) => `${file} → ${path}`);
    });
    assert.deepEqual(dangling, []);
    assert.ok(existsSync(join(root, "docs/decisions/0003-ports-and-adapters.md")));

    // No script, permission, or CI job of its own is left; the other packs' scripts are.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const script of pack.packageJson.scripts) assert.equal(pkg.scripts[script], undefined, script);
    for (const script of Object.keys(pkgBefore.scripts).filter((name) => !pack.packageJson.scripts.includes(name))) assert.ok(script in pkg.scripts, `${script} was removed too`);
    const settings = readFileSync(join(root, ".claude/settings.json"), "utf8");
    for (const entry of pack.claudeSettings.allow) assert.ok(!settings.includes(JSON.stringify(entry)), `${entry} still allowed`);
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    assert.ok(!/swift/i.test(ci), "ci.yml still mentions swift");
    assert.ok(ci.includes("pnpm test:harness") && ci.includes("stack.mjs check --packs"), "ci.yml lost a core step");
    assert.ok(!/swift/i.test(readFileSync(join(root, "harness.json"), "utf8").replace(/"stacks":.*/, "")), "harness.json mentions swift outside its stacks list");

    // Build output stays ignored: the removal must not un-ignore it, so it never shows as untracked.
    assert.equal(spawnSync("git", ["check-ignore", "-q", ".build/debug/artifact"], { cwd: root }).status, 0, ".build/ is no longer ignored");
    assert.ok(!trackedFiles(root).some((path) => path.startsWith(".build/")), ".build/ shows up as a tracked or untracked file");
  });
});
