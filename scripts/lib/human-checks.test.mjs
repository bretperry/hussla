/*
  The Human checks compiler: block parsing, title split, config routing, ticks, and the problems that fail it.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/lib/human-checks.mjs.

  Ported from habit's meatbag_compile_test.py; the two regressions it locks (a note line ending a
  block, a title split inside a code span) are the reason the compiler exists.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { collect, compile, parseBlocks, readConfig, readSources, readTicks, scanVisible, splitTitle, toMarkdown, visibleLines } from "./human-checks.mjs";

const SCRIPT = new URL("./human-checks.mjs", import.meta.url).pathname;

const PLAN = `# Plan

## Phase 9 — Encryption

**Human checks**
- \`security-p9-approve-kms\` · decision · 5 min · none — Approve Phase 9: a new KMS key.
  **Approved 2026-09-19** (user, via the wrangler).
- \`security-p9-tf-apply\` · decision · 10 min · deploy · waits #190 — Run \`terraform apply\`, then add the secret.
- \`desktop-decide-first-dispatch\` · Mac · 2 min · none — Approve the first \`desktop.yml\` dispatch (\`platforms: linux-windows\`, ~$0.20). The run gives the first Windows build.

Prose after the block ends it.
`;

const CONFIG = {
  gates: ["deploy", "none"],
  stations: [
    { id: "prod", name: "Prod", where: ["prod"] },
    { id: "bench", name: "Bench", where: ["Mac"] },
    { id: "brain", name: "Decisions", where: ["decision"] },
  ],
};

// A scratch repo root holding the given files.
const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "human-checks-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe("parseBlocks", () => {
  it("an indented note doesn't end the block (habit regression: 7 checks lost)", () => {
    const { items, problems } = parseBlocks("docs/plans/security.md", PLAN);
    assert.deepEqual(items.map((i) => i.id), ["security-p9-approve-kms", "security-p9-tf-apply", "desktop-decide-first-dispatch"]);
    assert.deepEqual(items[0].notes, ["**Approved 2026-09-19** (user, via the wrangler)."]);
    assert.deepEqual(problems, []);
  });

  it("reads every field, the phase, and the line", () => {
    const tf = parseBlocks("x.md", PLAN).items[1];
    assert.deepEqual([tf.where, tf.time, tf.gate, tf.waits, tf.phase, tf.line], ["decision", "10 min", "deploy", "#190", "Phase 9", 8]);
  });

  it("reports what it can't use instead of dropping it", () => {
    const text = [
      "**Human checks**",
      "- `bad-id` · prod — missing fields",
      "",
      "Prose.",
      "- `stray-check` · prod · 1 min · deploy — outside any block.",
      "**Human Checks:**",
      "- `after-misspelled-header` · prod · 1 min · deploy — whose header is wrong.",
    ].join("\n");
    assert.deepEqual(parseBlocks("x.md", text).problems.map((p) => [p.line, p.message.split(" ").slice(0, 2).join(" ")]), [
      [2, "unparsed check"],
      [5, "check item"],
      [6, "`**Human Checks:**`"],
      [7, "check item"],
    ]);
  });

  it("ignores examples in HTML comments and code fences", () => {
    const text = ["<!-- **Human checks**", "- `in-comment` · prod · 1 min · deploy — no. -->", "```", "**Human checks**", "- `in-fence` · prod · 1 min · deploy — no.", "```"].join("\n");
    assert.deepEqual(parseBlocks("x.md", text), { items: [], problems: [] });
    assert.deepEqual(visibleLines("a <!-- b --> c\nd"), ["a  c", "d"]);
  });
});

// The first word of each problem, per line, for compact assertions.
const lint = (...lines) => parseBlocks("x.md", lines.join("\n")).problems.map((p) => [p.line, p.message.split(" ").slice(0, 2).join(" ")]);

describe("parseBlocks: nothing dropped quietly", () => {
  it("reads an indented block inside a list (habit security-plan.md:34, the 135th check)", () => {
    const text = [
      "- **#184** (landed): open redirect.",
      "  **Human checks**",
      "  - `security-184-open-redirect` · prod · 2 min · deploy — Open the login redirect: it stays on site.",
      "    **Passed 2026-09-19** (by wrangler).",
      "- Deferred from reviews: more.",
    ].join("\n");
    const { items, problems } = parseBlocks("x.md", text);
    assert.deepEqual([items.map((i) => [i.id, i.notes]), problems], [[["security-184-open-redirect", ["**Passed 2026-09-19** (by wrangler)."]]], []]);
  });

  it("scopes notes to their block, and reports a check indented under another", () => {
    const text = [
      "**Human checks**",
      "- `a-one` · prod · 1 min · deploy — One.",
      "  - `a-two` · prod · 1 min · deploy — Nested.",
      "",
      "**Human checks**",
      "  note with no item above it in this block",
      "- `a-three` · prod · 1 min · deploy — Three.",
    ].join("\n");
    const { items, problems } = parseBlocks("x.md", text);
    assert.deepEqual(items.map((i) => [i.id, i.notes]), [["a-one", []], ["a-three", []]]);
    assert.deepEqual(problems.map((p) => [p.line, p.message.split(" ").slice(0, 3).join(" ")]), [
      [3, "check item indented"],
      [6, "indented line has"],
    ]);
  });

  it("reports every malformed or other-format item in a block, and a block with no items", () => {
    assert.deepEqual(
      lint("**Human checks**", "- `x` - iPhone · 1 min · none — A.", "- `x`· iPhone · 1 min · none — A.", "- x · iPhone", "* `y` · prod · 1 min · deploy — B.", "+ `y` · prod · 1 min · deploy — B.", "1. `y` · prod · 1 min · deploy — B."),
      [2, 3, 4, 5, 6, 7].map((line) => [line, "unparsed check"]),
    );
    assert.deepEqual(lint("**Human checks**", "- `a-one` · prod · 1 min · deploy — One.", "", "* `y` · prod · 1 min · deploy — After a blank, still check-shaped."), [[4, "unparsed check"]]);
    assert.deepEqual(lint("**Human checks**", "- `a-one` · prod · 1 min · deploy — One.", "", "1. A runbook step after the block."), []);
    assert.deepEqual(lint("**Human checks**", "", "Prose instead of items."), [[1, "`**Human checks**`"]]);
    assert.deepEqual(lint("**Human checks**"), [[1, "`**Human checks**`"]]);
  });

  it("reports a wrapped line that lost its indent, and ends a block at a heading or `---`", () => {
    assert.deepEqual(lint("**Human checks**", "- `a-one` · prod · 1 min · deploy — One that wraps", "onto an unindented line."), [[3, "line right"]]);
    const text = ["**Human checks**", "- `a-one` · prod · 1 min · deploy — One.", "---", "- `stray` · prod · 1 min · deploy — After the rule.", "## Next", "- `stray-2` · prod · 1 min · deploy — After the heading."];
    assert.deepEqual(lint(...text), [[4, "check item"], [6, "check item"]]);
  });
});

describe("scanVisible", () => {
  it("reports a fence or comment that never closes instead of hiding the rest", () => {
    assert.deepEqual(scanVisible("a\n```\n**Human checks**").problems, [{ line: 2, message: "code fence opened here never closes; it hides every line after it" }]);
    assert.deepEqual(scanVisible("a\n<!-- x\nb").problems, [{ line: 2, message: "HTML comment opened here never closes; it hides every line after it" }]);
    const { items, problems } = parseBlocks("x.md", "~~~\n**Human checks**\n- `a-one` · prod · 1 min · deploy — One.");
    assert.deepEqual([items, problems.map((p) => p.line)], [[], [1]]);
  });

  it("hides ~~~ fences, and closes a fence only on the same character at least as long", () => {
    assert.deepEqual(visibleLines("~~~\n- `x`\n~~~\nshown"), ["", "", "", "shown"]);
    assert.deepEqual(visibleLines("````\n```\nhidden\n~~~~\nhidden\n`````\nshown"), ["", "", "", "", "", "", "shown"]);
  });

  it("treats `<!--` inside a code span as text", () => {
    assert.deepEqual(scanVisible("write `<!--` to open one\nstill here"), { lines: ["write `<!--` to open one", "still here"], problems: [] });
  });
});

describe("splitTitle", () => {
  it("never splits inside a code span (habit regression)", () => {
    const { title, body } = splitTitle("Approve the first `desktop.yml` dispatch (`platforms: linux-windows`, ~$0.20). The run gives the build.");
    assert.ok(title.endsWith("~$0.20)"), title);
    assert.equal(body, "The run gives the build.");
  });

  it("keeps the whole text as the title when there's no sentence break", () => {
    assert.deepEqual(splitTitle("Sign out and back in."), { title: "Sign out and back in", body: "" });
  });
});

describe("collect", () => {
  it("counts every source, zeros included, and fails a duplicate id, unknown gate, and unknown where", () => {
    const sources = [
      { source: "docs/plans/a.md", text: PLAN },
      { source: "docs/plans/b.md", text: "# No checks\n" },
      { source: "docs/human-checks.md", text: "**Human checks**\n- `security-p9-tf-apply` · iPad · 1 min · ios-release — Again.\n" },
    ];
    const { perSource, problems } = collect(sources, CONFIG);
    assert.deepEqual(perSource, { "docs/plans/a.md": 3, "docs/plans/b.md": 0, "docs/human-checks.md": 1 });
    assert.deepEqual(problems.map((p) => p.message.split(":")[0].split(" `")[0]), ["duplicate check id", "`security-p9-tf-apply`", "`security-p9-tf-apply`"]);
    assert.match(problems[1].message, /unknown gate `ios-release`/);
    assert.match(problems[2].message, /unknown where `iPad`/);
  });
});

describe("compile and toMarkdown", () => {
  it("routes by where, archives ticked ids, and keeps notes", () => {
    const { items } = collect([{ source: "docs/plans/a.md", text: PLAN }], CONFIG);
    const stations = compile(items, CONFIG, new Set(["security-p9-approve-kms"]));
    assert.deepEqual(stations.map((s) => [s.id, s.items.map((i) => i.id)]), [
      ["prod", []],
      ["bench", ["desktop-decide-first-dispatch"]],
      ["brain", ["security-p9-approve-kms", "security-p9-tf-apply"]],
    ]);
    const kms = stations[2].items[0];
    assert.deepEqual([kms.title, kms.archived, stations[2].items[1].archived], ["Approve Phase 9:", true, false]);
    const md = toMarkdown(stations);
    assert.match(md, /- \[x\] \*\*Approve Phase 9:\*\* a new KMS key\./);
    assert.match(md, /security-p9-tf-apply · decision · 10 min · deploy · waits #190 · docs\/plans\/a\.md/);
    assert.match(md, /_Nothing here\._/);
    assert.doesNotMatch(md, /\n\n\n/);
  });
});

describe("readConfig", () => {
  it("falls back to plans.mdc's defaults without a file, and refuses a malformed or ambiguous one", () => {
    const fallback = readConfig(repo({}));
    assert.deepEqual([fallback.problems, fallback.config.gates], [[], ["deploy", "ios-release", "desktop-release", "none"]]);
    assert.match(readConfig(repo({}), { path: "nope.json" }).problems[0].message, /doesn't exist/);
    assert.match(readConfig(repo({ "docs/human-checks.json": "{" })).problems[0].message, /isn't JSON/);
    assert.match(readConfig(repo({ "docs/human-checks.json": JSON.stringify({ gates: [], stations: [] }) })).problems[0].message, /needs `gates`/);
    const twice = { gates: ["none"], stations: [{ id: "a", name: "A", where: ["Mac"] }, { id: "b", name: "B", where: ["Mac"] }] };
    assert.match(readConfig(repo({ "docs/human-checks.json": JSON.stringify(twice) })).problems[0].message, /more than one station/);
    assert.deepEqual(readConfig(repo({ "docs/human-checks.json": JSON.stringify(CONFIG) })), { config: CONFIG, problems: [] });
  });
});

describe("readSources and readTicks", () => {
  it("reads plans, runbooks, and the loose file, never a `_` template; a nested runbook is a problem", () => {
    const root = repo({
      "docs/plans/a.md": "a",
      "docs/plans/_template.md": "t",
      "docs/runbooks/ios.md": "r",
      "docs/runbooks/_template.md": "t",
      "docs/runbooks/watch/pairing.md": "n",
      "docs/human-checks.md": "h",
    });
    const { sources, problems } = readSources(root);
    assert.deepEqual(sources.map((s) => s.source), ["docs/plans/a.md", "docs/runbooks/ios.md", "docs/human-checks.md"]);
    assert.deepEqual(problems.map((p) => p.file), ["docs/runbooks/watch"]);
  });

  it("reads done ticks in either shape an export has", () => {
    const root = repo({
      "checks/a.json": JSON.stringify({ id: "a", data: { done: true } }),
      "checks/b.json": JSON.stringify({ id: "b", data: { done: false } }),
      "checks/c.json": JSON.stringify({ done: true, na: true }),
    });
    assert.deepEqual(readTicks(root), new Set(["a", "c"]));
  });
});

// Runs the compiler in `root`; returns its exit code and output.
const cli = (root, ...args) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
// git in `root`, quiet, with an identity so commits work anywhere.
const git = (root, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });

describe("the CLI", () => {
  it("--ref compiles the ref's checks with the ref's config, not the working tree's", () => {
    const config = { gates: ["deploy"], stations: [{ id: "lab", name: "Lab", where: ["lab"] }] };
    const root = repo({
      "docs/human-checks.json": JSON.stringify(config),
      "docs/plans/p.md": "**Human checks**\n- `p-one` · lab · 1 min · deploy — In the ref.\n",
    });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "ref");
    // The working tree drifts: an unknown where, and no config.
    writeFileSync(join(root, "docs/plans/p.md"), "**Human checks**\n- `p-two` · moon · 1 min · deploy — Local only.\n");
    writeFileSync(join(root, "docs/human-checks.json"), "{");
    const { code, err } = cli(root, "--ref", "HEAD", "--json", "out.json");
    assert.equal(code, 0, err);
    const out = JSON.parse(readFileSync(join(root, "out.json"), "utf8"));
    assert.deepEqual(out.stations.map((s) => [s.id, s.items.map((i) => i.id)]), [["lab", ["p-one"]]]);
  });

  it("a bad ref is one clean line, exit 2", () => {
    const root = repo({ "docs/plans/p.md": "x" });
    git(root, "init", "-q");
    const { code, err } = cli(root, "--ref", "no-such-ref");
    assert.equal(code, 2);
    assert.match(err, /^git couldn't read that: /);
    assert.doesNotMatch(err, /at .*\.mjs:\d+/);
  });

  it("writes nothing when there are problems", () => {
    const root = repo({ "docs/plans/p.md": "**Human checks**\n- `p-one` · moon · 1 min · deploy — Unknown where.\n" });
    const { code, err } = cli(root, "--json", "out.json", "--md", "out.md");
    assert.equal(code, 1);
    assert.match(err, /unknown where `moon`/);
    assert.deepEqual([existsSync(join(root, "out.json")), existsSync(join(root, "out.md"))], [false, false]);
  });
});
