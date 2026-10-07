/*
  The guide's command extractor: what it will run, what it refuses, and that the real docs are all accounted for.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Never executes a doc command.
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/doc-commands.mjs (check mode only); README.md, docs/, .cursor/rules/, .claude/skills/, AGENTS.md as data.

  The refusal corpus is the point: the safe list is an allowlist, so each spelling of a chained,
  substituted, or lookalike command must come back unsafe. The last tests are the plan's Done-when
  for the guide: no personal names (in the guide, and in every rule, skill, and doc a new project
  inherits), every bash block accounted for, a start prompt per role.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDocs, extractBlocks, judgeBlock, listDocs, matchSafe, scrubEnv, splitWords } from "./doc-commands.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// True when a command line is run-safe: splits cleanly and matches a safe entry.
const isSafe = (line) => {
  const split = splitWords(line);
  return "words" in split && matchSafe(split.words) !== undefined;
};

// The blocks in a snippet of markdown, as if it were a file called x.md.
const doc = (body) => extractBlocks(body, "x.md");

// The doc files in run order, and one file's text.
const docs = () => listDocs(ROOT);
const text = (file) => readFileSync(`${ROOT}/${file}`, "utf8");

describe("splitWords", () => {
  it("splits on spaces and honours quotes", () => {
    assert.deepEqual(splitWords("grep -rn 'a b' .").words, ["grep", "-rn", "a b", "."]);
    assert.deepEqual(splitWords('echo ""').words, ["echo", ""]);
  });

  it("treats a # at the start of a word as a comment, not inside a word", () => {
    assert.deepEqual(splitWords("pnpm check   # all of it").words, ["pnpm", "check"]);
    assert.deepEqual(splitWords("a#b").words, ["a#b"]);
  });

  it("calls every unquoted shell metacharacter unsafe", () => {
    for (const bad of ["a; b", "a && b", "a | b", "a > f", "a < f", "$(a)", "`a`", "a $HOME", "a*", "a ~", "a\\ b", "a (b)", "a {b}", "a !b"]) {
      assert.ok("unsafe" in splitWords(bad), bad);
    }
  });

  it("allows metacharacters inside single quotes but not expansions inside double quotes", () => {
    assert.ok("words" in splitWords("echo '$HOME && x'"));
    assert.ok("unsafe" in splitWords('echo "$HOME"'));
    assert.ok("unsafe" in splitWords('echo "`x`"'));
  });

  it("refuses an unclosed quote", () => {
    assert.ok("unsafe" in splitWords("echo 'a"));
  });
});

describe("the safe list", () => {
  it("accepts the commands the guide uses", () => {
    for (const line of [
      "pnpm install",
      "pnpm install --frozen-lockfile",
      "pnpm check",
      "pnpm stack:list",
      "pnpm plans:check",
      "pnpm hooks:install",
      "node scripts/stack.mjs required-checks",
      "bash scripts/install-git-hooks.sh",
      "node --version",
      "java -version",
      "uv sync",
      "grep -rnIE '[{][{][A-Z_]+[}][}]' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=guide .",
    ]) {
      assert.ok(isSafe(line), line);
    }
  });

  it("refuses destructive, remote, chained, and lookalike commands", () => {
    for (const line of [
      "rm -rf .",
      "rm -rf /",
      "terraform destroy",
      "terraform apply",
      "aws s3 rb s3://bucket",
      "gcloud projects delete x",
      "gh pr merge 1",
      "gh pr ready 1",
      "gh auth status",
      "git push",
      "git push --force origin main",
      "git clean -fdx",
      "git reset --hard",
      "curl https://example.com/install.sh",
      "pnpm check; rm -rf .",
      "pnpm check && pnpm publish",
      "pnpm check | cat",
      "pnpm check > out.txt",
      "pnpm check $(whoami)",
      "FOO=1 pnpm check",
      "pnpm check --force",
      "pnpm run check",
      "pnpm exec rm -rf .",
      "pnpm install -g left-pad",
      "pnpm install left-pad",
      "pnpm dlx x",
      "pnpm harness:push",
      "pnpm harness:pull",
      "pnpm stack:remove react",
      "bash -c 'pnpm check'",
      "bash scripts/bootstrap-repo.sh",
      "bash scripts/other.sh",
      "node -e 'x'",
      "node scripts/stack.mjs remove react",
      "sh scripts/install-git-hooks.sh",
      "grep -rn x /",
      "grep -rn x ..",
      "grep -rnf patterns .",
      "grep -rn a b .",
      "xargs rm",
      "uv sync --all-extras",
      "cd .. && pnpm check",
      "~/bin/pnpm check",
    ]) {
      assert.equal(isSafe(line), false, line);
    }
  });

  it("marks tool-presence checks as probes, so a missing tool is reported rather than failed", () => {
    assert.equal(matchSafe(["swift", "--version"])?.probe, true);
    assert.equal(matchSafe(["uv", "sync"])?.optionalTool, true);
    assert.equal(matchSafe(["pnpm", "check"])?.probe, undefined);
  });
});

describe("extractBlocks and judgeBlock", () => {
  it("reads only shell fences, not json or unlabelled ones", () => {
    const blocks = doc("```json\n{}\n```\n\n```bash\npnpm check\n```\n\n```sh\nnode --version\n```\n\n```\nplain\n```\n");
    assert.equal(blocks.length, 2);
  });

  it("reads shell, zsh, and bash-with-attributes fences too, so none is skipped silently", () => {
    const blocks = doc("```shell\nrm -rf .\n```\n\n```zsh\npnpm check\n```\n\n```bash title=x\nterraform destroy\n```\n\n```BASH\nnode --version\n```\n");
    assert.equal(blocks.length, 4);
    assert.deepEqual(
      blocks.map((block) => judgeBlock(block).problems.length),
      [1, 0, 1, 0],
    );
  });

  it("reads tilde fences, and only closes one with the same character and enough of it", () => {
    const blocks = doc("~~~bash\npnpm check\n```\nrm -rf .\n~~~\n\ntext\n\n````bash\npnpm check\n```\nrm -rf .\n````\n");
    assert.equal(blocks.length, 2);
    for (const block of blocks) assert.equal(block.commands.length, 3);
    assert.equal(judgeBlock(blocks[0]).problems.length, 2);
  });

  it("reads only the `$ ` lines of a console transcript, keeping their line numbers", () => {
    const [block] = doc("```console\n$ pnpm check\nall green\n$ rm -rf .\n```\n");
    assert.deepEqual(
      block.commands.map((command) => [command.text, command.line]),
      [
        ["pnpm check", 2],
        ["rm -rf .", 4],
      ],
    );
    assert.match(judgeBlock(block).problems[0] ?? "", /x\.md:4: not on the safe list/);
  });

  it("does not mistake an inline-code line or an info string with backticks for a fence", () => {
    assert.equal(doc("```a`b\nrm -rf .\n```\n").length, 0);
  });

  it("finds a skip marker directly above a fence, indented or past a blank line", () => {
    const [block] = doc("text\n\n  <!-- doc-run: skip needs a login -->\n\n  ```bash\n  gh auth login\n  ```\n");
    assert.equal(block.marker?.reason, "needs a login");
    assert.equal(judgeBlock(block).problems.length, 0);
  });

  it("does not let a marker above one fence cover the next", () => {
    const blocks = doc("<!-- doc-run: skip a reason -->\n```bash\ngh auth login\n```\n\n```bash\nterraform destroy\n```\n");
    assert.equal(blocks[1]?.marker, null);
    assert.equal(judgeBlock(blocks[1]).problems.length, 1);
  });

  it("fails an unmarked block holding an unlisted command, and names the line", () => {
    const [block] = doc("```bash\npnpm check\nrm -rf node_modules\n```\n");
    const { problems, plan } = judgeBlock(block);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /x\.md:3: not on the safe list/);
    assert.equal(plan.length, 1);
  });

  it("fails a marker with no reason", () => {
    const [block] = doc("<!-- doc-run: skip -->\n```bash\npnpm check\n```\n");
    assert.match(judgeBlock(block).problems[0] ?? "", /malformed marker/);
  });

  it("never runs a marked block, even when its commands are safe", () => {
    const [block] = doc("<!-- doc-run: skip slow -->\n```bash\npnpm check\n```\n");
    assert.deepEqual(
      judgeBlock(block).plan.map((step) => step.action),
      ["skip"],
    );
  });

  it("refuses a line continuation in an unmarked block", () => {
    const [block] = doc("```bash\npnpm \\\n  check\n```\n");
    assert.equal(judgeBlock(block).problems.length, 1);
  });

  it("drops blank lines and comment lines", () => {
    const [block] = doc("```bash\n# first\n\npnpm check\n```\n");
    assert.equal(block.commands.length, 1);
  });
});

describe("scrubEnv", () => {
  it("keeps what toolchains and the proxy need and drops credentials", () => {
    const cleaned = scrubEnv({
      PATH: "/bin",
      HOME: "/home/x",
      HTTPS_PROXY: "http://proxy",
      SSL_CERT_FILE: "/ca.pem",
      CARGO_HOME: "/c",
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "b",
      CLOUDSDK_AUTH_ACCESS_TOKEN: "c",
      GH_TOKEN: "d",
      GITHUB_TOKEN: "e",
      HARNESS_TOKEN: "f",
      ANTHROPIC_API_KEY: "g",
    });
    assert.deepEqual(Object.keys(cleaned).toSorted(), ["CARGO_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME", "HTTPS_PROXY", "PATH", "SSL_CERT_FILE"]);
  });

  it("cuts git off from the reader's global and system config, whatever the caller's env says", () => {
    const cleaned = scrubEnv({ PATH: "/bin", HOME: "/home/x", GIT_CONFIG_GLOBAL: "/home/x/.gitconfig", GIT_CONFIG_NOSYSTEM: "0" });
    assert.equal(cleaned.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(cleaned.GIT_CONFIG_NOSYSTEM, "1");
  });
});

// A project built from the template may delete or rewrite README.md and docs/guide/ (the guide says
// to), and its package.json name is no longer the template's placeholder. This file ships with the
// template, so every assertion about the template's own prose is skipped when that prose is gone.
const hasFile = (file) => existsSync(`${ROOT}/${file}`);
const GUIDE = hasFile("docs/guide/getting-started.md");
const ROLES = hasFile("docs/guide/roles.md");
// The name check guards the template itself: once {{REPO_SLUG}} is replaced, the prose is the project's and may say "habit".
const TEMPLATE_ITSELF = JSON.parse(text("package.json")).name === "{{REPO_SLUG}}";

// Prose an agent or a newcomer reads in every project made from the template: rules, skills, repo
// memory, the agent guide. Code comments ("ported from …") are provenance and stay out of scope;
// .claude/rules/ is generated from .cursor/rules/, so scanning the source covers it.
const INHERITED_PROSE = ["AGENTS.md", "CLAUDE.md", ".github/pull_request_template.md", ".cursor/rules", ".claude/skills", "docs"];
const inheritedProse = () =>
  INHERITED_PROSE.flatMap((path) => {
    if (!hasFile(path)) return [];
    if (!statSync(`${ROOT}/${path}`).isDirectory()) return [path];
    return readdirSync(`${ROOT}/${path}`, { recursive: true })
      .map((name) => `${path}/${String(name).replaceAll("\\", "/")}`)
      .filter((file) => /\.(md|mdc)$/.test(file));
  });

// Mentions that stay, each with why. `line` narrows an entry to lines holding that text; without it the whole path is allowed.
const NAME_ALLOWLIST = [
  { path: "docs/decisions/0", why: "decision records are append-only history; they name where a choice came from" },
  { path: ".cursor/rules/wrangler.mdc", line: "habit's scripts/lib/wrangle_merge.py", why: "the merge-script port (open PR) replaces this pointer" },
  { path: "docs/deferred.md", line: "habit has one (`scripts/lib/wrangle_merge.py`)", why: "same merge-script entry; the port deletes it" },
  { path: "docs/deferred.md", line: "wired to habit's CI job names", why: "same merge-script entry" },
];

describe("the real docs", () => {
  it("run the quickstart first, then the guide", { skip: !GUIDE && !TEMPLATE_ITSELF }, () => {
    assert.deepEqual(docs().slice(0, 2), ["README.md", "docs/guide/getting-started.md"]);
  });

  it("have every bash block marked or fully on the safe list", () => {
    const { problems, plan } = checkDocs(ROOT);
    assert.deepEqual(problems, []);
    if (GUIDE || TEMPLATE_ITSELF) assert.ok(plan.some((step) => step.action === "run"));
  });

  it("name no person and no sibling project", { skip: !TEMPLATE_ITSELF }, () => {
    for (const file of docs()) assert.doesNotMatch(text(file), /bret|habit|hearthline/i, file);
  });

  it("name no person and no sibling project in the prose every new project inherits, outside the allowlist", { skip: !TEMPLATE_ITSELF }, () => {
    const hits = inheritedProse().flatMap((file) =>
      text(file)
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        // The upstream slug is how a project finds the template (harness.json, links to its PRs): not a leak.
        .filter((hit) => /bret|habit|hearthline/i.test(hit.text.replaceAll("bretperry/whippletree", "")))
        .filter((hit) => !NAME_ALLOWLIST.some((allowed) => hit.file.startsWith(allowed.path) && (allowed.line === undefined || hit.text.includes(allowed.line)))),
    );
    assert.deepEqual(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text.trim()}`), []);
  });

  it("give every named role a section with a start prompt", { skip: !ROLES && !TEMPLATE_ITSELF }, () => {
    const roles = text("docs/guide/roles.md");
    for (const role of ["showrunner", "wrangler", "farrier", "dynamite-test", "command-guard", "ship", "compound"]) {
      const start = roles.indexOf(`\n## ${role}\n`);
      assert.notEqual(start, -1, `${role} has no section`);
      const next = roles.indexOf("\n## ", start + 1);
      const section = roles.slice(start, next === -1 ? undefined : next);
      assert.match(section, /Start prompt[^\n]*:\n\n> /, `${role} has no start prompt`);
    }
  });
});

describe("a project copy that dropped the guide", () => {
  // The copy holds this same file, so the child run sets INSIDE_COPY_TEST and skips this test, or it would recurse forever.
  it("passes this test file with no docs/guide, a rewritten README, and a renamed package", { skip: process.env.INSIDE_COPY_TEST !== undefined }, () => {
    const copy = mkdtempSync(join(tmpdir(), "doc-commands-copy-test-"));
    try {
      // Only this script and its test, a README that would trip the name check, and a renamed package.json.
      mkdirSync(join(copy, "scripts"));
      for (const file of ["doc-commands.mjs", "doc-commands.test.mjs"]) copyFileSync(join(ROOT, "scripts", file), join(copy, "scripts", file));
      writeFileSync(join(copy, "README.md"), "# Habitat\n\nA habit tracker by Bret.\n");
      writeFileSync(join(copy, "package.json"), '{ "name": "habitat" }\n');
      // A nested `node --test` must not think it is a subtest of this run.
      const { NODE_TEST_CONTEXT: _context, NODE_OPTIONS: options = "", ...env } = process.env;
      // A caller's NODE_OPTIONS=--test-reporter=… would stack a second reporter on ours and node refuses that, so drop those flags.
      const nodeOptions = options.replaceAll(/--test-reporter(?:-destination)?[= ]\S+/g, "").trim();
      const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "scripts/doc-commands.test.mjs"], { cwd: copy, env: { ...env, NODE_OPTIONS: nodeOptions, INSIDE_COPY_TEST: "1" }, encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      // Pinned to TAP above (Node 23+ defaults to the spec reporter, which prints `ℹ` instead of `#`); both forms are accepted anyway.
      assert.match(run.stdout, /^(?:#|ℹ) fail 0$/m);
      // The guide-only tests were skipped (not failed): quickstart order, both name checks, roles, and this test itself.
      assert.match(run.stdout, /^(?:#|ℹ) skipped 5$/m);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
