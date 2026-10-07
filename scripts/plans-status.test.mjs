/*
  The plan table spec: what parses, what is a lint error, and where each phase lands on the board.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/plans-status.mjs → parsePlan(), parseAfter(), parseState(), summarize(), staleFlags().

  The board is only as honest as this parser: a phase read as "ready" that is really blocked sends a
  worker off to build on sand, and a lint that lets a new State word through lets the tables drift again.
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checklistProblems, parseAfter, parsePlan, parseState, runbookProblems, splitRow, staleFlags, summarize } from "./plans-status.mjs";

// Asserts the keys `expected` names, and ignores the rest of `actual`.
const assertPartial = (actual, expected) =>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])), expected);

// A plan with these table rows and, for each row, a section whose Done-when item carries its check.
const plan = (rows, header = "| Phase | What | After | Model | State |") => {
  const sections = rows.flatMap((row) => [`## Phase ${splitRow(row)[0]} — x`, "", "**Done when:**", "- it works → verify: a test", ""]);
  return parsePlan("docs/plans/x.md", ["# X plan", "", "Why.", "", header, "|---|---|---|---|---|", ...rows, "", ...sections].join("\n"));
};

// A one-phase plan (phase 0, not started) with this section body; `problems` are what the lint said.
const section = (...body) => {
  const text = ["# X", "", "| Phase | What | After | Model | State |", "|---|---|---|---|---|", "| 0 | a | — | quick (low) | |", "| 1 | b | 0 | — (human) | |", "", "## Phase 0 — a", "", ...body, "", "## Phase 1 — b", ""].join("\n");
  return parsePlan("docs/plans/x.md", text).problems.map((p) => [p.line, p.message]);
};

// A scratch repo root holding the given files.
const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "plans-status-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

describe("splitRow", () => {
  it("keeps an escaped pipe inside its cell", () => {
    assert.deepEqual(splitRow("| 0 | a \\| b | — | quick (low) | |"), ["0", "a | b", "—", "quick (low)", ""]);
  });
});

describe("parseState", () => {
  it("reads status, PRs, and the human-check count", () => {
    assertPartial(parseState("landed (#186, includes #185); 3 human checks open"), {
      status: "landed",
      prs: [186, 185],
      checksOpen: 3,
    });
    assert.equal(parseState("landed (#279); human checks open").checksOpen, 1);
    assertPartial(parseState(""), { status: "", prs: [], notes: [] });
    assertPartial(parseState("blocked; `DATABASE_URL` unparseable"), { status: "blocked", notes: ["`DATABASE_URL` unparseable"] });
  });
});

describe("parseAfter", () => {
  const ids = ["0", "1", "2", "4a", "4b", "5"];

  it("expands ranges and a bare number over its lettered phases", () => {
    assert.deepEqual(parseAfter("1–2", ids).deps, ["1", "2"]);
    assert.deepEqual(parseAfter("4", ids).deps, ["4a", "4b"]);
  });

  it("splits gates off after `;` and knows a cleared one", () => {
    assert.deepEqual(parseAfter("0; enrollment (cleared 2026-09-19); a Mac", ids), {
      deps: ["0"],
      gates: [
        { text: "enrollment (cleared 2026-09-19)", cleared: true },
        { text: "a Mac", cleared: false },
      ],
      unknown: [],
    });
  });

  it("returns what it can't resolve instead of guessing", () => {
    assert.deepEqual(parseAfter("R5 + R6", ids).unknown, ["R5 + R6"]);
    assert.deepEqual(parseAfter("—", ids), { deps: [], gates: [], unknown: [] });
  });
});

describe("parsePlan", () => {
  it("a clean table has no problems and the right board statuses", () => {
    const { plan: p, problems } = plan([
      "| 0 | setup | — | quick (low) | landed (#1) |",
      "| 1 | core | 0 | workhorse (medium) | QA passed (#2) |",
      "| 2 | side | 0 | workhorse (medium) | |",
      "| 3 | after core | 1 | deep (high) | |",
      "| 4 | gated | 0; enrollment | — (human) | |",
      "| 5 | old | — | deep | landed |",
      "| 6 | cut | — | deep (low) | dropped; not needed |",
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(p.phases.map((ph) => [ph.id, ph.board]), [
      ["0", "landed"],
      ["1", "review"],
      ["2", "ready"],
      ["3", "waiting"],
      ["4", "gated"],
      ["5", "landed"],
      ["6", "dropped"],
    ]);
  });

  it("names every off-spec cell with its line", () => {
    const { problems } = plan([
      "| 0 | a | — | deep | |",
      "| 1 (optional) | b | 0 | deep (high) | |",
      "| 2 | c | 9 | deep (high) | done |",
      "| 3 | d | — | deep (high) | blocked |",
      "| 4 | e | — | deep (high) | QA passed |",
    ]);
    assert.deepEqual(problems.map((p) => [p.line, p.message.split(" ").slice(0, 2).join(" ")]), [
      [7, "Model `deep`"],
      [8, "phase id"],
      [9, "After `9`"],
      [9, "State `done`"],
      [10, "State `blocked`"],
      [11, "State `QA"],
    ]);
  });

  it("accepts a lineage after the level, and nothing else there", () => {
    const { problems } = plan(["| 0 | a | — | deep (xhigh) · rival | |", "| 1 | b | 0 | deep (xhigh) rival | |"]);
    assert.deepEqual(problems.map((p) => p.line), [8]);
  });

  it("refuses a Stage table or missing columns rather than reading it", () => {
    assert.match(plan([], "| Stage | What | After | Model | State |").problems[0].message, /must be/);
    assert.match(plan([], "| Phase | What | State |").problems[0].message, /must be/);
    assert.match(parsePlan("docs/plans/ref.md", "# Just notes\n").problems[0].message, /no phase table/);
  });
});

describe("Done when", () => {
  it("passes when every item carries `→ verify:`, inline, wrapped, or on the header line", () => {
    assert.deepEqual(section("**Done when:**", "- one → verify: `pnpm test`", "- two, wrapped", "  over a line → verify: the board"), []);
    assert.deepEqual(section("**Done when:** it ships → verify: prod"), []);
  });

  it("fails an item without its check, red on purpose", () => {
    assert.deepEqual(section("**Done when:**", "- one → verify: a test", "- two, unchecked"), [[12, "Done-when item has no `→ verify:`: say how anyone checks it"]]);
  });

  it("names a misspelling instead of passing on no match", () => {
    const problems = section("**Done When:**", "- one -> verify: a test");
    assert.deepEqual(problems.map(([line, message]) => [line, message.split(";")[0]]), [
      [10, "`**Done When:**` looks like a Done-when header"],
      [5, "phase 0 has no `**Done when:**` block"],
    ]);
    assert.match(section("**Done when:**", "- one -> Verify: a test")[0][1], /spells its check oddly/);
    assert.match(section("**Done when:**", "- one →verify: x")[0][1], /spells its check oddly/);
  });

  it("fails a phase still to run with no section or no block; settled and human phases are exempt", () => {
    assert.match(section("**Goal:** no done-when here.")[0][1], /phase 0 has no `\*\*Done when:\*\*` block/);
    const { problems } = parsePlan("docs/plans/x.md", ["# X", "", "| Phase | What | After | Model | State |", "|---|---|---|---|---|", "| 0 | a | — | quick (low) | |", "| 1 | b | — | deep | landed |", "| 2 | c | — | — (human) | |"].join("\n"));
    assert.deepEqual(problems.map((p) => p.message), ["phase 0 has no `## Phase 0` section"]);
  });

  it("doesn't let a phase borrow a nested `### Phase` block", () => {
    const text = ["# X", "", "| Phase | What | After | Model | State |", "|---|---|---|---|---|", "| 1 | a | — | quick (low) | |", "| 2 | b | — | quick (low) | |", "", "## Phase 1 — a", "", "**Goal:** a.", "", "### Phase 2 — b", "", "**Done when:**", "- x → verify: y"].join("\n");
    assert.deepEqual(parsePlan("docs/plans/x.md", text).problems.map((p) => p.message), ["phase 1 has no `**Done when:**` block"]);
  });

  it("keeps checking items after a paragraph interrupts the list", () => {
    assert.deepEqual(section("**Done when:**", "- one → verify: a", "A paragraph in the middle.", "- two, unchecked").map(([line]) => line), [13]);
  });

  it("fails an empty or placeholder verify", () => {
    for (const bad of ["→ verify:", "→ verify: TBD", "→ verify: todo", "→ verify: ?", "→ verify: <command>"]) {
      assert.match(section("**Done when:**", `- one ${bad}`)[0]?.[1] ?? "", /empty or a placeholder/, bad);
    }
  });

  it("needs a verify on each sub-bullet, not the parent's", () => {
    assert.deepEqual(section("**Done when:**", "- parent → verify: a", "  - child, unchecked", "  - child → verify: b").map(([line]) => line), [12]);
  });

  it("ignores a Done-when block inside an HTML comment", () => {
    assert.match(section("<!--", "**Done when:**", "- x → verify: y", "-->")[0][1], /no `\*\*Done when:\*\*` block/);
  });
});

// A runbook scenario's lines, with `check` as its Human checks block.
const scenario = (n, check) => [`## ${n}. Scenario ${n}`, "", "**Not testable because:** a real radio.", "", ...check, "", "1. Do it.", "", "**Expected:** it works.", ""];
// A Human checks block holding one item.
const item = (id) => ["**Human checks**", `- \`${id}\` · iPhone · 10 min · ios-release — Run scenario: it passes.`];

describe("runbookProblems", () => {
  it("passes a runbook whose every scenario has exactly one check id", () => {
    const text = ["# iOS runbook", "", "## Why these are not tests", "", ...scenario(1, item("ios-rb-one")), ...scenario(2, item("ios-rb-two")), "## Recording what you find"].join("\n");
    assert.deepEqual(runbookProblems("docs/runbooks/ios.md", text), []);
  });

  it("fails a scenario without a check id, red on purpose", () => {
    const text = ["# iOS runbook", "", ...scenario(1, item("ios-rb-one")), ...scenario(2, [])].join("\n");
    assert.deepEqual(runbookProblems("docs/runbooks/ios.md", text).map((p) => [p.line, p.message.split(";")[0]]), [[14, "scenario `2. Scenario 2` has 0 Human check ids"]]);
  });

  it("fails two ids in one scenario, a misspelled block, a misnumbered heading, and a runbook with no scenarios", () => {
    const two = runbookProblems("r.md", scenario(1, [...item("a-one"), "- `a-two` · iPhone · 1 min · none — Also."]).join("\n"));
    assert.match(two[0].message, /has 2 Human check ids/);
    const misspelled = runbookProblems("r.md", scenario(1, ["**Human check**", "- `a-one` · iPhone · 1 min · none — X."]).join("\n"));
    assert.match(misspelled[0].message, /has 0 Human check ids/);
    assert.match(runbookProblems("r.md", ["## 1 Missing dot", ...scenario(2, item("a-two"))].join("\n"))[0].message, /isn't a scenario/);
    assert.match(runbookProblems("r.md", "# Empty\n\nJust prose.\n")[0].message, /no numbered scenarios/);
  });
});

describe("runbookProblems: scenarios the lint would never see", () => {
  it("fails a ### scenario swallowed into the one above, and an unnumbered heading with steps", () => {
    const nested = ["## 1. One", "", ...item("a-one"), "", "### 2. Two", "", "1. Do it.", "**Expected:** x."].join("\n");
    assert.deepEqual(runbookProblems("r.md", nested).map((p) => p.line), [6]);
    const unnumbered = [...scenario(1, item("a-one")), "## Pairing two phones", "", "1. Pair them.", "", "**Expected:** paired."].join("\n");
    assert.match(runbookProblems("r.md", unnumbered)[0].message, /heading `## Pairing two phones` isn't a scenario/);
  });

  it("accepts the template's own sections", () => {
    const text = ["# R", "## Why these are not tests", ...scenario(1, item("a-one")), "## Recording what you find"].join("\n");
    assert.deepEqual(runbookProblems("r.md", text), []);
  });
});

describe("checklistProblems", () => {
  const config = JSON.stringify({ gates: ["deploy", "none"], stations: [{ id: "prod", name: "Prod", where: ["prod"] }] });

  it("without a config uses plans.mdc's defaults, as the compiler does; a config replaces them", () => {
    assert.deepEqual(checklistProblems(repo({ "docs/human-checks.md": "# None\n" })), []);
    const loose = "**Human checks**\n- `prod-a` · prod · 1 min · deploy — A.\n- `lab-a` · lab · 1 min · none — B.\n";
    assert.deepEqual(checklistProblems(repo({ "docs/human-checks.md": loose })).map((p) => p.message.split(" (")[0]), ["`lab-a`: unknown where `lab`"]);
    const lab = JSON.stringify({ gates: ["deploy", "none"], stations: [{ id: "prod", name: "Prod", where: ["prod", "lab"] }] });
    assert.deepEqual(checklistProblems(repo({ "docs/human-checks.md": loose, "docs/human-checks.json": lab })), []);
    assert.match(checklistProblems(repo({ "docs/human-checks.md": loose, "docs/human-checks.json": "{" }))[0].message, /isn't JSON/);
  });

  it("flags a runbook nested under docs/runbooks/", () => {
    assert.match(checklistProblems(repo({ "docs/runbooks/ios/a.md": "## 1. x\n" }))[0].message, /runbooks live directly in docs\/runbooks/);
  });

  it("fails a duplicate across a plan and a runbook, and an unknown gate", () => {
    const root = repo({
      "docs/human-checks.json": config,
      "docs/plans/p.md": "**Human checks**\n- `x-one` · prod · 1 min · deploy — A.\n",
      "docs/runbooks/r.md": "## 1. S\n\n**Human checks**\n- `x-one` · prod · 1 min · ios-release — B.\n",
    });
    assert.deepEqual(checklistProblems(root).map((p) => p.message.split(" (")[0]), ["duplicate check id `x-one`", "`x-one`: unknown gate `ios-release`"]);
  });
});

describe("summarize", () => {
  it("counts progress without dropped phases and lists what can start", () => {
    const { plan: p } = plan([
      "| 0 | a | — | quick (low) | landed (#1); 2 human checks open |",
      "| 1 | b | 0 | quick (low) | running |",
      "| 2 | c | 0 | quick (low) | |",
      "| 3 | d | — | quick (low) | dropped |",
    ]);
    assertPartial(summarize(p), { landed: 1, total: 3, checksOpen: 2, next: ["2"], active: ["1"], status: "active" });
  });
});

describe("staleFlags", () => {
  it("flags a merged PR on an unlanded phase, and an open one on a landed phase", () => {
    const { plan: p } = plan([
      "| 0 | a | — | quick (low) | QA passed (#10) |",
      "| 1 | b | — | quick (low) | landed (#11) |",
      "| 2 | c | — | quick (low) | landed (#12) |",
    ]);
    const flags = staleFlags([p], new Map([[10, "MERGED"], [11, "OPEN"], [12, "MERGED"]]));
    assert.deepEqual(flags.map((f) => f.message), [
      "phase 0: #10 merged but State is `QA passed`",
      "phase 1: State is `landed` but #11 is still open",
    ]);
  });
});
