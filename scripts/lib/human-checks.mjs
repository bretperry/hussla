#!/usr/bin/env node
// Compiles every `Human checks` block in the repo into one checklist (JSON and/or markdown) the user ticks.
// In the app: nothing at runtime. The wrangler runs it at ship time; `pnpm plans:check` runs its lint half.
// Used by: wrangler.mdc → Human checks (`node scripts/lib/human-checks.mjs`), scripts/plans-status.mjs (lint).
// Uses: docs/human-checks.json (stations and gates; plans.mdc's defaults when absent), git (only with --ref); tested by scripts/lib/human-checks.test.mjs.
//
// Sources, one format (plans.mdc → Human checks): every docs/plans/*.md, docs/human-checks.md, and
// every docs/runbooks/*.md (a runbook scenario *is* a check). `_`-prefixed files are templates.
// Each block item is
//   - `id` · where · time · gate[ · waits X] — text
// and indented lines under it are notes on it.
//
// Why a script and not a careful hand compile: habit's first hand compile silently dropped 7 checks
// after an indented note line, and split a title inside a `code` span. So this prints per-source
// counts (a short count is a dropped block) and fails on a duplicate id, an unknown gate or where,
// an unparsed item, a misspelled block header, or an item outside any block.
//
//   node scripts/lib/human-checks.mjs [--ref <git ref>] [--config <file>] [--ticks <dir>]
//                                     [--json <out.json>] [--md <out.md>] [--root <dir>]
//
// --ref reads the docs from a git ref (e.g. origin/dev) instead of the working tree, so a ship
// compiles what landed, not what is lying around locally. --ticks reads `<dir>/checks/<id>.json`
// (`{ done }` or `{ data: { done } }`, the shape an artifact database export has) and marks those archived.

// Node builtins only, so it runs in any project and before `pnpm install`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The project's stations (where you need to be) and gates (what a check blocks); project-owned.
const CONFIG_FILE = "docs/human-checks.json";

// Used when the project has no config file: the values plans.mdc → Human checks lists. A config
// file replaces it whole. Why a fallback: harness:pull never delivers a project-owned file, so a
// project that predates the config would otherwise go red on its next pull.
const DEFAULT_CONFIG = {
  gates: ["deploy", "ios-release", "desktop-release", "none"],
  stations: [
    { id: "prod", name: "Prod, right after a deploy", note: "Do these within about 10 minutes of a ship landing.", where: ["prod"] },
    { id: "mobile", name: "Phone and watch", note: "Real devices. These gate a mobile release, not a server deploy.", where: ["iPhone", "Watch"] },
    { id: "desktop", name: "Desktop bench", note: "These gate a desktop release.", where: ["Mac", "Windows", "Linux"] },
    { id: "decision", name: "Decisions only a human can make", note: "No hardware needed. Just a call.", where: ["decision"] },
  ],
};

// Where checks live, relative to the repo root.
const PLANS_DIR = "docs/plans";
const RUNBOOKS_DIR = "docs/runbooks";
const LOOSE_CHECKS = "docs/human-checks.md";

// One item, matched on the trimmed line: `id` · where · time · gate[ · waits X] — text. Ids are kebab-case.
const ITEM = /^- `([a-z0-9-]+)` · ([^·]+?) · ([^·]+?) · ([a-z-]+)(?: · waits ([^—]+?))? — (.+)$/;
// Any list item (`-`, `*`, `+`, `1.`, `1)`), at any indent.
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
// A list item that leads with a backticked id and a `·`: a check, wherever it sits.
const CHECK_LIKE = /^\s*(?:[-*+]|\d+[.)])\s+`[^`]*`\s*·/;
// The block header, exactly (any indent); anything close to it is a misspelling, reported rather than skipped.
const HEADER = "**Human checks**";
const HEADER_LIKE = /^\*\*\s*human[\s-]*checks?\b/i;
// Phase headings, so each check knows which phase it came from; any heading ends a block.
const PHASE = /^#{2,3} (Phase|Stage) ([A-Z]?\d+[a-z]?)\b/;
// A heading or a thematic break (`---`) ends a block the way a section does.
const HEADING = /^(#{1,6} |\s{0,3}([-*_])(\s*\2){2,}\s*$)/;

// The text with HTML comments and fenced code blanked out (line count kept), and anything left open.
//
// Line numbers must survive (problems cite them), so each hidden line becomes an empty line. A
// fence is ``` or ~~~ (three or more) and closes only on a run of the same character at least
// as long. `<!--` inside an inline code span is text, not a comment. A fence or comment that
// never closes is a problem: it would otherwise hide every check after it.
export const scanVisible = (text) => {
  const problems = [];
  /** @type {number | null} the line the open comment started on */
  let comment = null;
  /** @type {{ char: string, length: number, line: number } | null} the open fence */
  let fence = null;
  const lines = text.split("\n").map((line, index) => {
    const lineNo = index + 1;
    // Inside a fence: only its closing run ends it.
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return "";
    }
    // A fence opens only outside a comment.
    const open = comment === null && line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0], length: open[1].length, line: lineNo };
      return "";
    }
    // Strip comments, skipping code spans so `<!--` written as code stays text.
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (comment !== null) {
        const end = line.indexOf("-->", i);
        if (end === -1) return out;
        comment = null;
        i = end + 3;
        continue;
      }
      // A run of backticks opens a code span when the same run closes it later on the line.
      if (line[i] === "`") {
        const run = line.slice(i).match(/^`+/)[0];
        const close = line.indexOf(run, i + run.length);
        if (close !== -1) {
          out += line.slice(i, close + run.length);
          i = close + run.length;
          continue;
        }
        out += run;
        i += run.length;
        continue;
      }
      if (line.startsWith("<!--", i)) {
        comment = lineNo;
        i += 4;
        continue;
      }
      out += line[i];
      i++;
    }
    return out;
  });
  // Read back through their declared types: the map callback assigned them, which a checker
  // narrowing from the `null` initialisers can't see.
  const openFence = /** @type {{ line: number } | null} */ (fence);
  const openComment = /** @type {number | null} */ (comment);
  if (openFence !== null) problems.push({ line: openFence.line, message: `code fence opened here never closes; it hides every line after it` });
  if (openComment !== null) problems.push({ line: openComment, message: `HTML comment opened here never closes; it hides every line after it` });
  return { lines, problems };
};

// The visible lines alone (comments and fences blanked), for callers that lint something else.
export const visibleLines = (text) => scanVisible(text).lines;

// Every Human checks item in one markdown file, plus every line that should have been one and wasn't.
//
// Returns { items, problems }. A block is the header, then its items at one indent. A line indented
// past an item is a note on it (habit's lesson: a note must not end the block), except a check
// item, which is reported: it can't be a note and can't be its own check. Everything else is loud:
// a list item that isn't a check (right under the block, or check-shaped anywhere), a
// non-indented line right under an item, a block with no items, a check outside any block. A
// non-check list after a blank line ends the block, so a runbook's steps can follow it. Prose after a blank line, a heading, a `---`, or a line left
// of the block's indent ends the block.
export const parseBlocks = (source, text) => {
  const items = [];
  const scanned = scanVisible(text);
  const problems = scanned.problems.map((p) => ({ file: source, ...p }));
  const problem = (line, message) => problems.push({ file: source, line, message });
  /** @type {{ line: number, indent: number, count: number } | null} the open block */
  let block = null;
  /** @type {{ item: { notes: string[] }, indent: number } | null} the block's latest item; notes attach here */
  let last = null;
  let afterBlank = false;
  let phase = null;
  // Ends the current block; one with no items is a problem (its header promised checks).
  const close = () => {
    if (block !== null && block.count === 0) problem(block.line, `\`${HEADER}\` block has no items`);
    block = null;
    last = null;
  };
  for (const [index, line] of scanned.lines.entries()) {
    const lineNo = index + 1;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    // Track the phase heading the next items belong to.
    const heading = line.match(PHASE);
    if (heading) phase = `${heading[1]} ${heading[2]}`;
    // The header opens a block (closing any before it, so notes never cross blocks).
    if (trimmed === HEADER) {
      close();
      block = { line: lineNo, indent, count: 0 };
      afterBlank = false;
      continue;
    }
    // A near miss is a problem, because its items would vanish.
    if (HEADER_LIKE.test(trimmed)) {
      problem(lineNo, `\`${trimmed}\` looks like a Human checks header; write it exactly \`${HEADER}\` on its own line`);
      continue;
    }
    if (trimmed === "") {
      afterBlank = true;
      continue;
    }
    const blank = afterBlank;
    afterBlank = false;
    // Leaving the block: a heading or `---`, or a line left of the block's indent (back in a parent list).
    if (block !== null && (HEADING.test(line) || indent < block.indent)) close();
    // Outside any block, a check-shaped item would be dropped silently.
    if (block === null) {
      if (CHECK_LIKE.test(line)) problem(lineNo, `check item outside a \`${HEADER}\` block: ${trimmed.slice(0, 80)}`);
      continue;
    }
    // Deeper than the latest item: a note on it, unless it is itself a check.
    if (last !== null && indent > last.indent) {
      if (CHECK_LIKE.test(line)) problem(lineNo, `check item indented under another item; put it at the block's indent: ${trimmed.slice(0, 80)}`);
      else last.item.notes.push(trimmed);
      continue;
    }
    // Indented under the header with no check yet: a note that belongs to nothing.
    if (last === null && indent > block.indent && !LIST.test(line)) {
      problem(lineNo, `indented line has no check above it in this block; a note goes under its check`);
      continue;
    }
    // After a blank line, a list that isn't check-shaped is the next thing (a scenario's steps): the block is over.
    if (blank && LIST.test(line) && !CHECK_LIKE.test(line)) {
      close();
      continue;
    }
    // A list item at the block's level must be a check.
    if (LIST.test(line)) {
      const match = trimmed.match(ITEM);
      if (!match) {
        problem(lineNo, `unparsed check item (the shape is: - \`id\` · where · time · gate[ · waits X] — text): ${trimmed.slice(0, 80)}`);
        // Its notes go nowhere rather than onto the check before it.
        last = { item: { notes: [] }, indent };
        block.count++;
        continue;
      }
      const [, id, where, time, gate, waits, body] = match;
      const item = { id, where: where.trim(), time: time.trim(), gate, waits: waits?.trim() || null, text: body.trim(), source, phase, line: lineNo, notes: [] };
      items.push(item);
      last = { item, indent };
      block.count++;
      continue;
    }
    // Prose right under an item, not indented: a wrapped line that lost its indent would be cut.
    if (!blank && last !== null) {
      problem(lineNo, `line right under a check isn't indented: indent it to make it a note, or leave a blank line before prose`);
      continue;
    }
    close();
  }
  close();
  return { items, problems };
};

// Title = the first sentence (8–90 chars) ending in . : ! or ?, never inside a `code` span.
//
// habit's lesson: "platforms: linux-windows" inside backticks used to become the title break.
export const splitTitle = (text) => {
  let ticks = 0;
  // Scan characters, counting backticks so a break inside a code span is skipped.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "`") ticks++;
    else if (".:!?".includes(ch) && ticks % 2 === 0 && i >= 8 && i < 90 && text[i + 1] === " ") {
      return { title: text.slice(0, i + 1).replace(/\.$/, ""), body: text.slice(i + 2) };
    }
  }
  return { title: text.replace(/\.$/, ""), body: "" };
};

// Validates a parsed config: { gates: string[], stations: [{ id, name, note?, where: string[] }] }.
const validConfig = (config, path) => {
  const problem = (message) => ({ config: null, problems: [{ file: path, line: 1, message }] });
  // Shape check: anything off here would mis-route every check, so refuse rather than guess.
  const okGates = Array.isArray(config?.gates) && config.gates.length > 0 && config.gates.every((g) => typeof g === "string");
  const okStations =
    Array.isArray(config?.stations) &&
    config.stations.length > 0 &&
    config.stations.every((s) => typeof s?.id === "string" && typeof s.name === "string" && Array.isArray(s.where) && s.where.length > 0);
  if (!okGates || !okStations) return problem(`${path} needs \`gates\` (strings) and \`stations\` ([{ id, name, where: [...] }])`);
  // A where in two stations would route a check to whichever came first.
  const wheres = config.stations.flatMap((s) => s.where);
  const twice = [...new Set(wheres.filter((w, i) => wheres.indexOf(w) !== i))];
  if (twice.length > 0) return problem(`${path}: where \`${twice.join("`, `")}\` is in more than one station`);
  return { config, problems: [] };
};

// The config to route checks with, and any problem reading it.
//
// `path` (from --config) must exist. Without it, docs/human-checks.json is read from the ref when
// there is one (so a ship compiles with the config that landed) or the tree, and its absence means
// DEFAULT_CONFIG. A malformed file is always a problem; it is never silently replaced.
/** @param {string} root @param {{ path?: string | null, ref?: string | null }} [options] */
export const readConfig = (root, { path = null, ref = null } = {}) => {
  const name = path ?? CONFIG_FILE;
  let text;
  if (path !== null) {
    if (!existsSync(resolve(root, path))) return { config: null, problems: [{ file: path, line: 1, message: `${path} doesn't exist` }] };
    text = readFileSync(resolve(root, path), "utf8");
  } else if (ref !== null) {
    if (git(root, ["ls-tree", "--name-only", ref, CONFIG_FILE]).trim() === "") return { config: DEFAULT_CONFIG, problems: [] };
    text = git(root, ["show", `${ref}:${CONFIG_FILE}`]);
  } else {
    if (!existsSync(join(root, CONFIG_FILE))) return { config: DEFAULT_CONFIG, problems: [] };
    text = readFileSync(join(root, CONFIG_FILE), "utf8");
  }
  try {
    return validConfig(JSON.parse(text), name);
  } catch (error) {
    return { config: null, problems: [{ file: name, line: 1, message: `${name} isn't JSON: ${error.message}` }] };
  }
};

// The markdown files that hold checks, as { sources: [{ source, text }], problems }, from the tree or a git ref.
//
// Runbooks live directly in docs/runbooks/; anything nested there is a problem, because neither
// this nor the runbook lint would read it.
/** @param {string} root @param {{ ref?: string | null }} [options] */
export const readSources = (root, { ref = null } = {}) => {
  const problems = [];
  // One directory's entries as [name, isDir], from the tree or the ref.
  const entries = (dir) => {
    if (ref) {
      return git(root, ["ls-tree", ref, `${dir}/`])
        .split("\n")
        .filter(Boolean)
        .map((row) => [basename(row.split("\t")[1]), row.split(" ")[1] === "tree"]);
    }
    if (!existsSync(join(root, dir))) return [];
    return readdirSync(join(root, dir), { withFileTypes: true }).map((e) => [e.name, e.isDirectory()]);
  };
  // A directory's .md files (minus `_` templates); a subdirectory is reported, not read.
  const list = (dir, nested) => {
    const all = entries(dir);
    if (nested) for (const [name] of all.filter(([, isDir]) => isDir)) problems.push({ file: `${dir}/${name}`, line: 1, message: `runbooks live directly in ${dir}/; nothing in a subdirectory is read` });
    return all
      .filter(([name, isDir]) => !isDir && name.endsWith(".md") && !name.startsWith("_"))
      .map(([name]) => name)
      .toSorted()
      .map((name) => `${dir}/${name}`);
  };
  // Read one file, from the tree or the ref.
  const read = (file) => (ref ? git(root, ["show", `${ref}:${file}`]) : readFileSync(join(root, file), "utf8"));
  const paths = [...list(PLANS_DIR, false), ...list(RUNBOOKS_DIR, true)];
  // The loose-checks file is optional.
  const loose = ref ? git(root, ["ls-tree", "--name-only", ref, LOOSE_CHECKS]).trim() !== "" : existsSync(join(root, LOOSE_CHECKS));
  if (loose) paths.push(LOOSE_CHECKS);
  return { sources: paths.map((source) => ({ source, text: read(source) })), problems };
};

// git, from root, stdout as text; throws on failure so a bad ref is loud (main turns it into one line).
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Ids whose tick has `done: true` (an n/a tick is stored as done), from `<dir>/checks/<id>.json`.
export const readTicks = (dir) => {
  const checks = join(dir, "checks");
  if (!existsSync(checks)) return new Set();
  const done = new Set();
  for (const name of readdirSync(checks).filter((n) => n.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(checks, name), "utf8"));
    if ((doc.data ?? doc).done) done.add(name.slice(0, -".json".length));
  }
  return done;
};

// Parses every source and validates every item against the config. The lint half; no output files.
//
// Returns { items, problems, perSource }. perSource counts every source, zeros included, so a
// plan whose block was lost shows 0 instead of disappearing from the list.
export const collect = (sources, config) => {
  const items = [];
  const problems = [];
  const perSource = {};
  // Parse each file and keep its count.
  for (const { source, text } of sources) {
    const parsed = parseBlocks(source, text);
    items.push(...parsed.items);
    problems.push(...parsed.problems);
    perSource[source] = parsed.items.length;
  }
  // Ids key the ticks, so a duplicate would tick two checks at once.
  const seen = new Map();
  for (const item of items) {
    const first = seen.get(item.id);
    if (first) problems.push({ file: item.source, line: item.line, message: `duplicate check id \`${item.id}\` (first at ${first.source}:${first.line})` });
    else seen.set(item.id, item);
  }
  // Gates and wheres come from the config; without one, every item is unroutable.
  if (config) {
    const wheres = new Set(config.stations.flatMap((s) => s.where));
    for (const item of items) {
      if (!config.gates.includes(item.gate)) problems.push({ file: item.source, line: item.line, message: `\`${item.id}\`: unknown gate \`${item.gate}\` (${CONFIG_FILE} → gates: ${config.gates.join(", ")})` });
      if (!wheres.has(item.where)) problems.push({ file: item.source, line: item.line, message: `\`${item.id}\`: unknown where \`${item.where}\` (${CONFIG_FILE} → stations[].where)` });
    }
  }
  return { items, problems, perSource };
};

// The checklist: one entry per station, each check with its title split off and archived when ticked.
export const compile = (items, config, done = new Set()) => {
  const stations = config.stations.map((s) => ({ id: s.id, name: s.name, note: s.note ?? "", items: [] }));
  const stationOf = new Map(config.stations.flatMap((s) => s.where.map((w) => [w, s.id])));
  for (const item of items) {
    const { title, body } = splitTitle(item.text);
    const station = stations.find((s) => s.id === stationOf.get(item.where));
    // An unknown where is already a lint problem; it still lands somewhere visible rather than vanishing.
    (station ?? stations.at(-1)).items.push({
      id: item.id,
      title,
      body,
      notes: item.notes,
      where: item.where,
      time: item.time,
      gate: item.gate,
      waits: item.waits,
      source: item.source,
      phase: item.phase,
      archived: done.has(item.id),
    });
  }
  return stations;
};

// The checklist as markdown: a section per station, a task-list line per check, ticked when archived.
export const toMarkdown = (stations) => {
  const lines = ["# Human checks", ""];
  for (const station of stations) {
    lines.push(`## ${station.name}`, "");
    if (station.note) lines.push(station.note, "");
    if (station.items.length === 0) lines.push("_Nothing here._");
    for (const item of station.items) {
      const meta = [item.id, item.where, item.time, item.gate, item.waits && `waits ${item.waits}`, item.source].filter(Boolean).join(" · ");
      lines.push(`- [${item.archived ? "x" : " "}] **${item.title}** ${item.body}`.trimEnd(), `  ${meta}`);
      for (const note of item.notes) lines.push(`  ${note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

// Value of `--flag <value>` in argv, or null.
const flag = (argv, name) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? null) : null);

// Compiles and reports; returns the exit code (0 clean, 1 problems, 2 git couldn't read the ref).
const run = (argv) => {
  // Where to read from, and the optional outputs.
  const root = flag(argv, "--root") ?? process.cwd();
  const ref = flag(argv, "--ref");
  const { config, problems: configProblems } = readConfig(root, { path: flag(argv, "--config"), ref });
  const { sources, problems: sourceProblems } = readSources(root, { ref });
  const { items, problems, perSource } = collect(sources, config);
  const all = [...configProblems, ...sourceProblems, ...problems];
  // Per-source counts first: a 0 next to a plan you know has checks is a dropped block.
  console.log("per source:");
  for (const [source, count] of Object.entries(perSource)) console.log(`  ${String(count).padStart(3)}  ${source}`);
  const byGate = Object.groupBy(items, (item) => item.gate);
  console.log(`${items.length} checks; by gate: ${Object.entries(byGate).map(([gate, list]) => `${gate} ${list.length}`).join(", ") || "none"}`);
  // Write the outputs only from a clean compile, so a half-parsed list never replaces a whole one.
  if (all.length === 0 && config) {
    const stations = compile(items, config, flag(argv, "--ticks") ? readTicks(flag(argv, "--ticks")) : new Set());
    console.log(`archived ${stations.reduce((n, s) => n + s.items.filter((i) => i.archived).length, 0)}`);
    const json = flag(argv, "--json");
    if (json) writeFileSync(json, `${JSON.stringify({ generatedAt: new Date().toISOString(), ref, perSource, stations }, null, 2)}\n`);
    const md = flag(argv, "--md");
    if (md) writeFileSync(md, `${toMarkdown(stations)}\n`);
  }
  // Every problem, then the verdict.
  for (const p of all) console.error(`${p.file}:${p.line}  ${p.message}`);
  if (all.length > 0) console.error(`\n${all.length} problem(s); nothing written (plans.mdc → Human checks has the format)`);
  return all.length > 0 ? 1 : 0;
};

const main = (argv) => {
  try {
    return run(argv);
  } catch (error) {
    // A git failure (bad ref, not a repo) is the user's input, not a bug: one line, no stack.
    if (error?.stderr !== undefined) {
      console.error(`git couldn't read that: ${String(error.stderr).trim().split("\n")[0] || error.message}`);
      return 2;
    }
    throw error;
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
