#!/usr/bin/env node
// Reads every plan's phase table and says where each phase stands: landed, running, ready to start, or waiting.
// In the app: nothing at runtime; `pnpm plans:check` in CI and pre-push, `pnpm plans:board` by the plan-board skill.
// Used by: package.json, .claude/skills/plan-board/SKILL.md.
// Uses: docs/plans/*.md (the table shape plans.mdc defines), docs/runbooks/*.md, scripts/plan-board.html (the board page),
//   scripts/lib/human-checks.mjs (the Human checks parser), gh (only with --gh); tested by scripts/plans-status.test.mjs.
//
// The phase table is the one place a plan's progress lives, so this parser *is* the table spec:
// anything it can't read is a lint error, never a guess. `check` fails on those; `json` and `board`
// still emit what they could read, with the problems listed, so one bad plan never blanks the board.
//
//   check            lint every plan (table, `→ verify:` on each Done-when item), every runbook
//                    (one check id per scenario), and every Human checks item; exits 1 on any problem
//   json [--gh]      the board data on stdout
//   board [--gh] --out <file.html>
//                    the board page with the data inlined, ready to publish as an artifact
//
// --gh cross-checks every `#N` in a State cell against GitHub, so a merged PR on a phase that
// isn't `landed` (or an open one on a phase that is) shows up as stale instead of hiding.

// Node builtins only, so it runs before `pnpm install` and in a bare CI job.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collect, parseBlocks, readConfig, readSources, visibleLines } from "./lib/human-checks.mjs";

const PLANS_DIR = "docs/plans";
const RUNBOOKS_DIR = "docs/runbooks";

// What every Done-when item must carry, exactly; plans.mdc → "Every Done-when item carries its check".
const VERIFY = "→ verify:";
const DONE_WHEN = "**Done when:**";

// The only header a phase table may have; plans.mdc shows it.
const HEADER = ["Phase", "What", "After", "Model", "State"];

// Phase ids: a number, optionally a letter prefix (`R0`) and a letter suffix (`4a`, `R0a`).
const PHASE_ID = /^[A-Z]?\d+[a-z]?$/;

// State words, in the order a phase moves through them (showrunner.mdc).
export const STATUSES = ["", "running", "QA passed", "landed", "blocked", "dropped"];

// Model cell: `<tier> (<level>)`, optionally `· <lineage>` (plans.mdc → Model tiers), or
// `— (human)` for a person's phase.
const MODEL = /^(.+?) \((low|medium|high|xhigh)\)( · \S+)?$/;
const HUMAN_MODEL = "— (human)";

// Cells meaning "nothing here".
const NONE = new Set(["", "—", "-", "–"]);

// Splits a table row into trimmed cells; `\|` stays inside a cell.
export const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));

// Parses the State cell: `<status>[ (<PRs and notes>)][; <note>]...`.
export const parseState = (raw) => {
  const [head, ...notes] = raw.split(";").map((part) => part.trim());
  const match = head.match(/^([^()]*?)\s*(?:\((.*)\))?$/);
  const status = match ? match[1].trim() : head;
  const paren = match?.[2] ?? "";
  const prs = [...`${paren} ${notes.join(" ")}`.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  // "3 human checks open", or an uncounted "human checks open", which counts as one so the plan never reads done.
  const checks = notes.map((note) => note.match(/^(\d+ )?human checks? open\b/)).find(Boolean);
  return { raw, status, prs: [...new Set(prs)], notes: notes.filter(Boolean), checksOpen: checks ? Number(checks[1] ?? 1) : 0 };
};

// Parses the After cell: phase deps, then `;`-separated gates. `1–5` is a range; `4` covers `4a`–`4c`
// when there is no bare `4`. Returns unresolved tokens so check can name them.
export const parseAfter = (raw, ids) => {
  const [depPart, ...gateParts] = raw.split(";").map((part) => part.trim());
  const deps = [];
  const unknown = [];
  if (!NONE.has(depPart)) {
    for (const token of depPart.split(",").map((t) => t.trim()).filter(Boolean)) {
      const range = token.match(/^([A-Z]?\d+[a-z]?)\s*[–-]\s*([A-Z]?\d+[a-z]?)$/);
      if (range && ids.includes(range[1]) && ids.includes(range[2])) {
        deps.push(...ids.slice(ids.indexOf(range[1]), ids.indexOf(range[2]) + 1));
      } else if (ids.includes(token)) {
        deps.push(token);
      } else if (PHASE_ID.test(token) && ids.some((id) => id.startsWith(token) && /^[a-z]$/.test(id.slice(token.length)))) {
        deps.push(...ids.filter((id) => id.startsWith(token) && /^[a-z]$/.test(id.slice(token.length))));
      } else {
        unknown.push(token);
      }
    }
  }
  const gates = gateParts.filter(Boolean).map((text) => ({ text, cleared: /\bcleared\b/i.test(text) }));
  return { deps: [...new Set(deps)], gates, unknown };
};

// Where a phase stands on the board, from its own State and its prerequisites'.
//   landed · dropped · review (QA passed) · running · blocked · ready (can start now)
//   gated (prereqs landed, a non-phase gate still open) · waiting (a prereq hasn't landed)
export const boardStatus = (phase, byId) => {
  const { status } = phase.state;
  if (status === "landed") return "landed";
  if (status === "dropped") return "dropped";
  if (status === "QA passed") return "review";
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  const depsDone = phase.after.deps.every((id) => ["landed", "dropped"].includes(byId.get(id)?.state.status));
  if (!depsDone) return "waiting";
  return phase.after.gates.every((gate) => gate.cleared) ? "ready" : "gated";
};

// Reads one plan file. Returns the plan plus every problem found, each with its line number.
export const parsePlan = (file, text) => {
  const lines = text.split("\n");
  const problems = [];
  const problem = (line, message) => problems.push({ file, line, message });
  const title = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? basename(file, ".md");
  const plan = { file, slug: basename(file, ".md"), title, phases: [] };

  // The phase table is the first table whose first column is Phase (or Stage, which it must not be).
  const start = lines.findIndex((l) => /^\|\s*(Phase|Stage)\s*\|/.test(l));
  if (start === -1) {
    problem(1, "no phase table (`| Phase | What | After | Model | State |`); reference material belongs outside docs/plans/");
    return { plan, problems };
  }
  const header = splitRow(lines[start]);
  if (header.join("|") !== HEADER.join("|")) {
    problem(start + 1, `phase table header is \`| ${header.join(" | ")} |\`; must be \`| ${HEADER.join(" | ")} |\``);
    return { plan, problems };
  }

  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push({ line: i + 1, cells: splitRow(lines[i]) });
  const ids = rows.map((row) => row.cells[0]);

  for (const { line, cells } of rows) {
    if (cells.length !== HEADER.length) {
      problem(line, `row has ${cells.length} cells, needs ${HEADER.length}`);
      continue;
    }
    const [id, what, afterRaw, model, stateRaw] = cells;
    if (!PHASE_ID.test(id)) problem(line, `phase id \`${id}\` isn't a number with an optional letter prefix/suffix (0, 4a, R0a); put words in What`);
    if (ids.indexOf(id) !== ids.lastIndexOf(id)) problem(line, `phase id \`${id}\` appears twice`);

    const after = parseAfter(afterRaw, ids);
    for (const token of after.unknown) problem(line, `After \`${token}\` isn't a phase in this table; a non-phase gate goes after a \`;\``);
    if (after.deps.includes(id)) problem(line, `phase ${id} lists itself in After`);

    const state = parseState(stateRaw);
    if (!STATUSES.includes(state.status)) problem(line, `State \`${state.status}\` isn't one of: blank, ${STATUSES.slice(1).join(", ")}; notes go after a \`;\``);
    if (state.status === "blocked" && state.notes.length === 0) problem(line, "State `blocked` needs a reason after a `;`");
    if (state.status === "" && stateRaw.trim() !== "") problem(line, "State has notes but no status; start with one");
    // QA passed is a live PR waiting on a click; without its number nobody can find it. Landed history may omit it.
    if (state.status === "QA passed" && state.prs.length === 0) problem(line, "State `QA passed` needs its PR, `QA passed (#N)`");

    // Every phase still to run needs its thinking level; landed history may keep a bare tier, or `—` when nobody recorded one.
    const settled = ["landed", "dropped"].includes(state.status);
    if (model !== HUMAN_MODEL && !MODEL.test(model) && !settled)
      problem(line, `Model \`${model}\` needs \`<tier> (<low|medium|high|xhigh>)\` or \`${HUMAN_MODEL}\``);

    plan.phases.push({ id, what, after: { deps: after.deps, gates: after.gates }, model, state, line });
  }
  if (plan.phases.length === 0) problem(start + 1, "phase table has no rows");
  for (const p of doneWhenProblems(file, lines, plan.phases)) problems.push(p);

  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));
  for (const phase of plan.phases) phase.board = boardStatus(phase, byId);
  return { plan, problems };
};

// The lines of phase `id`'s section (`## Phase <id> …`), as [{ line, text }], or null when it has none.
//
// The section runs to the next heading at its own level or above, so `###` subsections stay
// inside, and also stops at any other phase's heading, so a nested `### Phase 2` is never
// borrowed by the phase around it.
const phaseSection = (lines, id) => {
  const start = lines.findIndex((l) => new RegExp(`^#{2,3} Phase ${id}(?![0-9A-Za-z])`).test(l));
  if (start === -1) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const heading = lines[i].match(/^(#+) /);
    if (heading && (heading[1].length <= level || /^#{2,3} (Phase|Stage) /.test(lines[i]))) break;
    out.push({ line: i + 1, text: lines[i] });
  }
  return out;
};

// A verify that says nothing: empty, a placeholder word, or a `<template slot>`.
const PLACEHOLDER = /^(|tbd|todo|tba|n\/a|\?+|…|\.{3}|[-–—]|<[^>]*>)\.?$/i;

// A list item at any indent (`-`, `*`, `+`, `1.`).
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

// Every Done-when problem in a plan: each phase still to run needs a section, a Done-when block,
// and a real `→ verify:` on every item. Settled (landed, dropped) and human phases are left alone.
//
// Fails loudly rather than passing on no matches: a misspelled `**Done When**` or `-> verify`
// is named, a phase with no block at all is a problem, a sub-bullet needs its own verify, and
// a paragraph between items doesn't end the list (items after it are still checked). The block
// ends at the next `**Field:**` line or the end of the section.
export const doneWhenProblems = (file, rawLines, phases) => {
  const problems = [];
  const problem = (line, message) => problems.push({ file, line, message });
  // Comments and code fences hidden, so a commented-out example neither passes nor fails a phase.
  const lines = visibleLines(rawLines.join("\n"));
  for (const phase of phases) {
    // A malformed id is already a table problem, and can't name a heading.
    if (!PHASE_ID.test(phase.id) || ["landed", "dropped"].includes(phase.state.status) || phase.model === HUMAN_MODEL) continue;
    const section = phaseSection(lines, phase.id);
    if (section === null) {
      problem(phase.line, `phase ${phase.id} has no \`## Phase ${phase.id}\` section`);
      continue;
    }
    // Find the block header; a near miss is reported, not skipped.
    const headerAt = section.findIndex(({ text }) => text.trim().startsWith(DONE_WHEN));
    for (const { line, text } of section) {
      if (/^\*\*\s*done[\s-]*when\b/i.test(text.trim()) && !text.trim().startsWith(DONE_WHEN)) {
        problem(line, `\`${text.trim().slice(0, 30)}\` looks like a Done-when header; write it exactly \`${DONE_WHEN}\``);
      }
    }
    if (headerAt === -1) {
      problem(phase.line, `phase ${phase.id} has no \`${DONE_WHEN}\` block`);
      continue;
    }
    // Collect the items: text on the header line itself, then every list item (sub-bullets
    // included, each its own item), with indented non-list lines continuing the latest one.
    const items = [];
    const inline = section[headerAt].text.trim().slice(DONE_WHEN.length).trim();
    if (inline) items.push({ line: section[headerAt].line, text: inline });
    let latest = null;
    for (const { line, text } of section.slice(headerAt + 1)) {
      // The next field (`**Human checks**`, `**Tests:**`) ends the block.
      if (text.startsWith("**")) break;
      if (LIST_ITEM.test(text)) {
        latest = { line, text: text.trim() };
        items.push(latest);
      } else if (/^[ \t]/.test(text) && text.trim() && latest !== null) {
        latest.text += ` ${text.trim()}`;
      } else if (text.trim()) {
        // An unindented paragraph: not an item, and it doesn't stop the scan.
        latest = null;
      }
    }
    if (items.length === 0) problem(section[headerAt].line, `phase ${phase.id}: \`${DONE_WHEN}\` has no items`);
    // Each item needs the arrow, the word, the colon, and something real after it.
    for (const item of items) {
      const at = item.text.indexOf(VERIFY);
      if (at === -1) {
        const nearMiss = /verify/i.test(item.text);
        problem(item.line, nearMiss ? `Done-when item spells its check oddly; write it exactly \`${VERIFY} <command, test, or thing to look at>\`` : `Done-when item has no \`${VERIFY}\`: say how anyone checks it`);
      } else if (PLACEHOLDER.test(item.text.slice(at + VERIFY.length).trim())) {
        problem(item.line, `Done-when item's \`${VERIFY}\` is empty or a placeholder; name the command, test, or thing to look at`);
      }
    }
  }
  return problems;
};

// Headings a runbook may have besides its numbered scenarios (docs/runbooks/_template.md).
const RUNBOOK_SECTIONS = ["Why these are not tests", "Recording what you find"];

// Runbook problems: every numbered scenario (`## 1. <title>`) carries exactly one Human checks item,
// and every other `##`/`###` heading is one of the template's sections.
//
// A runbook scenario only gets run when it is on the checklist, and the checklist is built from
// check ids, so a scenario without one is a step nobody will ever be asked to do. An unnumbered
// heading (`## Pairing two phones`, `### 2. …`) would be a scenario the lint never saw.
export const runbookProblems = (file, text) => {
  const problems = [];
  const problem = (line, message) => problems.push({ file, line, message });
  const lines = visibleLines(text);
  // Sort every ##/### heading into a scenario, a known section, or a problem.
  const scenarios = [];
  for (const [index, line] of lines.entries()) {
    if (!/^#{2,3} /.test(line)) continue;
    if (/^## \d+\. \S/.test(line)) scenarios.push(index);
    else if (!RUNBOOK_SECTIONS.includes(line.replace(/^#{2,3} /, "").trim()) || line.startsWith("### ")) {
      problem(index + 1, `heading \`${line.trim()}\` isn't a scenario (\`## <n>. <title>\`) or one of: ${RUNBOOK_SECTIONS.map((h) => `\`## ${h}\``).join(", ")}`);
    }
  }
  if (scenarios.length === 0) problem(1, "runbook has no numbered scenarios (`## 1. <title>`); docs/runbooks/_template.md has the shape");
  // Each scenario runs to the next ##/### heading; parse its Human checks with the checklist's own parser.
  for (const start of scenarios) {
    const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
    const body = lines.slice(start, end === -1 ? lines.length : end);
    const { items } = parseBlocks(file, body.join("\n"));
    if (items.length !== 1) {
      problem(start + 1, `scenario \`${lines[start].slice(3).trim()}\` has ${items.length} Human check ids; it needs exactly one (its \`**Human checks**\` block)`);
    }
  }
  return problems;
};

// Every runbook directly under docs/runbooks/ (`_template.md` excluded) and its problems; a nested one is flagged by readSources.
export const readRunbooks = (root) => {
  const dir = join(root, RUNBOOKS_DIR);
  if (!existsSync(dir)) return { runbooks: [], problems: [] };
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .toSorted();
  const problems = files.flatMap((f) => runbookProblems(`${RUNBOOKS_DIR}/${f}`, readFileSync(join(dir, f), "utf8")));
  return { runbooks: files, problems };
};

// Human checks problems across plans, runbooks, and docs/human-checks.md: unparsed, duplicate,
// unknown gate or where, a broken config. No config file means plans.mdc's defaults, so a project
// with no checks (or one that predates the file) needs none: the compiler reads it the same way.
export const checklistProblems = (root) => {
  const { sources, problems: sourceProblems } = readSources(root);
  const { config, problems: configProblems } = readConfig(root);
  return [...sourceProblems, ...configProblems, ...collect(sources, config).problems];
};

// Sums a plan up for the board: progress, what can start next, what is in flight.
export const summarize = (plan) => {
  const counted = plan.phases.filter((p) => p.board !== "dropped");
  const landed = counted.filter((p) => p.board === "landed").length;
  const checksOpen = plan.phases.reduce((n, p) => n + p.state.checksOpen, 0);
  const pick = (...statuses) => plan.phases.filter((p) => statuses.includes(p.board)).map((p) => p.id);
  const done = counted.length > 0 && landed === counted.length;
  return {
    landed,
    total: counted.length,
    checksOpen,
    next: pick("ready"),
    active: pick("running", "review"),
    blocked: pick("blocked", "gated"),
    status: done ? (checksOpen ? "landed-checks" : "done") : pick("running", "review").length ? "active" : pick("ready").length ? "ready" : "stuck",
  };
};

// Every `#N` in any State against GitHub's view of it; flags the pairs that disagree.
export const staleFlags = (plans, prState) => {
  const flags = [];
  for (const plan of plans) {
    for (const phase of plan.phases) {
      const states = phase.state.prs.map((n) => [n, prState.get(n)]).filter(([, s]) => s);
      const merged = states.filter(([, s]) => s === "MERGED").map(([n]) => n);
      const open = states.filter(([, s]) => s === "OPEN").map(([n]) => n);
      if (["", "running", "QA passed"].includes(phase.state.status) && merged.length && !open.length)
        flags.push({ file: plan.file, line: phase.line, message: `phase ${phase.id}: #${merged.join(", #")} merged but State is \`${phase.state.status || "blank"}\`` });
      if (phase.state.status === "landed" && open.length && !merged.length)
        flags.push({ file: plan.file, line: phase.line, message: `phase ${phase.id}: State is \`landed\` but #${open.join(", #")} is still open` });
    }
  }
  return flags;
};

// One `gh` call for every PR state; the board only needs number → OPEN | MERGED | CLOSED.
const fetchPrStates = (root) => {
  const out = execFileSync("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state"], { cwd: root, encoding: "utf8" });
  return new Map(JSON.parse(out).map((pr) => [pr.number, pr.state]));
};

// Reads every plan under root; `_`-prefixed files (the template) aren't plans.
export const readPlans = (root) => {
  const dir = join(root, PLANS_DIR);
  if (!existsSync(dir)) return { plans: [], problems: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).toSorted();
  const plans = [];
  const problems = [];
  for (const f of files) {
    const file = `${PLANS_DIR}/${f}`;
    const result = parsePlan(file, readFileSync(join(root, file), "utf8"));
    plans.push({ ...result.plan, summary: summarize(result.plan) });
    problems.push(...result.problems);
  }
  return { plans, problems };
};

// The board data: every plan, its phases, and anything wrong with them.
export const boardData = (root, { gh = false, now = new Date() } = {}) => {
  const { plans, problems } = readPlans(root);
  const stale = gh ? staleFlags(plans, fetchPrStates(root)) : [];
  return { generatedAt: now.toISOString(), repo: basename(root), plans, problems, stale };
};

const main = (argv) => {
  const root = process.cwd();
  const [command, ...rest] = argv;
  const gh = rest.includes("--gh");
  if (command === "check") {
    const { plans, problems: planProblems } = readPlans(root);
    const { runbooks, problems: runbookLint } = readRunbooks(root);
    const problems = [...planProblems, ...runbookLint, ...checklistProblems(root)];
    for (const p of problems) console.error(`${p.file}:${p.line}  ${p.message}`);
    const counted = `${plans.length} plans, ${runbooks.length} runbooks`;
    console.error(problems.length ? `\n${problems.length} problem(s) in ${counted} (plans.mdc has the spec)` : `${counted} ok`);
    return problems.length ? 1 : 0;
  }
  if (command === "json") {
    process.stdout.write(`${JSON.stringify(boardData(root, { gh }), null, 2)}\n`);
    return 0;
  }
  if (command === "board") {
    const out = rest[rest.indexOf("--out") + 1];
    if (!rest.includes("--out") || !out) return console.error("board needs --out <file.html>"), 2;
    const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "plan-board.html"), "utf8");
    // `<` escaped so a plan's text can never close the script tag.
    const data = JSON.stringify(boardData(root, { gh })).replaceAll("<", "\\u003c");
    writeFileSync(out, template.replace("/*BOARD_DATA*/null", data));
    console.error(`wrote ${out}`);
    return 0;
  }
  console.error("usage: plans-status.mjs check | json [--gh] | board [--gh] --out <file.html>");
  return 2;
};

// exitCode, not exit(): exit() drops whatever stdout hasn't flushed yet, which truncates `json` into a pipe.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
