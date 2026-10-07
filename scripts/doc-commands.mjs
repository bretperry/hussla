#!/usr/bin/env node
// Extracts the fenced bash blocks from README.md and docs/guide/, and runs the safe ones in a fresh copy of the repo.
// In the app: nothing at runtime; `pnpm docs:commands` (check) and `pnpm docs:run` (execute) by hand, the check half also in `pnpm test:harness`.
// Used by: package.json (`docs:commands`, `docs:run`); tested by scripts/doc-commands.test.mjs.
// Uses: git (archive, init), tar; no shell is ever started, every command runs as an argv.
//
// Why: a guide whose commands rot is worse than no guide. This proves every command a newcomer is
// told to type either runs as written, or says out loud why it is not run here.
//
// The convention (the doc side): a fenced shell block (`bash`, `sh`, `shell`, `zsh`, a `console`, `sh-session`, or `shell-session` transcript's `$ ` lines; backtick or tilde fences) is run when every command in it
// matches the SAFE list below. A block with anything else must have, on the line directly above
// the fence, an HTML comment `<!-- doc-run: skip <reason> -->` (needs the network, a login, a
// remote, a global install, or rewrites the tree). The reason is required. An unmarked block with
// an unlisted command is an error, so a new command cannot slip into the guide unreviewed.
//
// The safety model: the SAFE list is an allowlist of whole argv shapes, not a denylist of bad
// words. A line is split into words the way a shell would for quotes only; any unquoted shell
// metacharacter (pipe, chain, redirect, substitution, glob, variable) makes it unsafe, so a
// chained or substituted command can never ride in on a safe one. Nothing is passed to a shell.
// Commands run inside a throwaway copy made by `git archive`, with an environment cut down to
// what the toolchains and the proxy need: cloud credentials, tokens, and the rest are not passed.
//
// Modes:
//   (none)   check: every block is marked or fully safe; prints the plan; exit 1 on a problem
//   --run    check, then run the safe blocks in order in a fresh copy of HEAD (committed files only)
//   --keep   with --run: leave the copy on disk and print its path

// Node builtins only, so it runs before `pnpm install`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The marker a doc puts above a block it does not want run, with the reason.
const MARKER_PREFIX = "<!-- doc-run:";

// Run order: the quickstart first (it installs), then the rest of the guide alphabetically.
const FIRST = ["README.md", "docs/guide/getting-started.md"];

// Fence languages this script reads; other fences (json, text, markdown) are never commands.
// `console` blocks are transcripts: only their `$ `-prefixed lines are commands, the rest is output.
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "sh-session", "shell-session"]);
// Transcript fences: only their `$ `-prefixed lines are commands.
const TRANSCRIPT_LANGS = new Set(["console", "sh-session", "shell-session"]);

// Shell metacharacters that make a word unsafe when unquoted: chains, pipes, redirects,
// substitution, variables, globs, groups, history, home expansion, and backslash escapes.
const UNSAFE_UNQUOTED = new Set([";", "&", "|", "<", ">", "(", ")", "{", "}", "$", "`", "*", "?", "[", "]", "~", "!", "\\"]);

// Environment names a run may inherit. Everything else (AWS_*, CLOUDSDK_*, tokens) stays out.
const ENV_ALLOW = [
  /^(PATH|HOME|USER|LOGNAME|LANG|TERM|TMPDIR|SHELL|CI)$/,
  /^LC_/,
  /^(CARGO_HOME|RUSTUP_HOME|GOPATH|GOCACHE|GOMODCACHE|GOFLAGS|GOROOT|JAVA_HOME|GRADLE_USER_HOME)$/,
  /^(UV_|PNPM_|npm_config_|NPM_CONFIG_|XDG_)/,
  /^(https?_proxy|no_proxy|all_proxy)$/i,
  /^(SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|CARGO_HTTP_CAINFO)$/,
];

// Builds an exact-argv safe entry: the command must be these words and no others.
const exact = (argv, options = {}) => ({ describe: argv.join(" "), matches: (words) => words.length === argv.length && words.every((word, index) => word === argv[index]), ...options });

// A tool-presence check: any failure, including "not installed", is reported as absent, never as a failed doc.
const probe = (argv) => exact(argv, { probe: true });

// package.json scripts the guide may tell a reader to run; each is local to the copy.
const SAFE_SCRIPTS = ["stack:list", "models", "overrides", "stack:drift", "rules:check", "rules:sync", "plans:check", "test:harness", "hooks:install", "typecheck", "lint", "boundaries", "knip", "test"];

// The allowlist. Every entry is something that only reads, or only writes inside the throwaway copy.
export const SAFE = [
  ...[
    ["node", "--version"],
    ["pnpm", "--version"],
    ["git", "--version"],
    ["gh", "--version"],
    ["rustc", "--version"],
    ["cargo", "--version"],
    ["cargo", "nextest", "--version"],
    ["cargo", "deny", "--version"],
    ["uv", "--version"],
    ["python3", "--version"],
    ["go", "version"],
    ["golangci-lint", "--version"],
    ["swift", "--version"],
    ["java", "-version"],
    ["clang++", "--version"],
    ["clang-tidy", "--version"],
    ["clang-format", "--version"],
    ["cmake", "--version"],
    ["ninja", "--version"],
    ["terraform", "version"],
    ["tflint", "--version"],
    ["hadolint", "--version"],
  ].map(probe),
  exact(["pnpm", "install"], { timeoutMs: 300_000 }),
  exact(["pnpm", "install", "--frozen-lockfile"], { timeoutMs: 300_000 }),
  exact(["pnpm", "check"], { timeoutMs: 1_200_000 }),
  ...SAFE_SCRIPTS.map((script) => exact(["pnpm", script])),
  exact(["pnpm", "models", "catalog"]),
  exact(["node", "scripts/stack.mjs", "required-checks"]),
  exact(["bash", "scripts/install-git-hooks.sh"]),
  exact(["git", "status", "--short"]),
  exact(["git", "branch", "--show-current"]),
  // `uv sync` makes .venv inside the copy; with no uv installed it is absent, not a doc failure.
  exact(["uv", "sync"], { timeoutMs: 300_000, optionalTool: true }),
  {
    // The placeholder search: recursive, line numbers, a quoted pattern, excluded dirs, ending at ".". Exit 1 means no match.
    describe: "grep -rn '<pattern>' --exclude-dir=<name> .",
    matches: (words) =>
      words[0] === "grep" &&
      words.length >= 4 &&
      words.at(-1) === "." &&
      words.slice(1, -1).every((word) => /^-[rnIilE]+$/.test(word) || /^--exclude-dir=[\w.-]+$/.test(word) || !word.startsWith("-")) &&
      words.slice(1, -1).filter((word) => !word.startsWith("-")).length === 1,
    okCodes: [0, 1],
  },
];

// Splits one command line into words honouring quotes, or says why it is unsafe to split.
// Returns { words } or { unsafe }. A `#` at the start of a word ends the line (a trailing comment).
export const splitWords = (line) => {
  // Words so far, the word being built, whether a word is open (so '' counts), and the open quote.
  const words = [];
  let current = "";
  let open = false;
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    // Inside quotes: the closing quote ends it; double quotes still refuse expansion characters.
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (quote === '"' && (char === "$" || char === "`" || char === "\\")) return { unsafe: `"${char}" inside double quotes expands in a shell` };
      else current += char;
      continue;
    }
    // A quote opens a word (even an empty one).
    if (char === "'" || char === '"') {
      quote = char;
      open = true;
      continue;
    }
    // Whitespace closes the word being built.
    if (char === " " || char === "\t") {
      if (open) words.push(current);
      current = "";
      open = false;
      continue;
    }
    // A comment starts only at the start of a word; the rest of the line is prose.
    if (char === "#" && !open) break;
    // Any other shell metacharacter makes the whole line unsafe.
    if (UNSAFE_UNQUOTED.has(char)) return { unsafe: `unquoted "${char}" is shell syntax` };
    current += char;
    open = true;
  }
  // An unclosed quote means the line continues somewhere we do not read.
  if (quote !== null) return { unsafe: "unclosed quote" };
  if (open) words.push(current);
  return { words };
};

// The safe entry a command matches, or undefined. A leading VAR=value word is not a program, so it never matches.
export const matchSafe = (words) => SAFE.find((entry) => entry.matches(words));

// Reads a marker line: { reason } for a valid skip, { error } for a malformed one, null for no marker.
const readMarker = (line) => {
  const text = line.trim();
  if (!text.startsWith(MARKER_PREFIX)) return null;
  const match = /^<!-- doc-run: skip (.+?) -->$/.exec(text);
  return match?.[1] === undefined ? { error: `malformed marker "${text}" (want: <!-- doc-run: skip <reason> -->)` } : { reason: match[1] };
};

// Joins `\`-continued lines into one logical command, keeping the line number of its first line.
// Backslash is unsafe to the splitter, so a continued command is only ever joined to be refused or marked skip.
const logicalLines = (lines, firstLine) => {
  // Finished commands; `text` is the command being joined, `line` where it began, `continued` whether it spans lines.
  const out = [];
  let text = "";
  let line = 0;
  let continued = false;
  for (const [offset, raw] of lines.entries()) {
    const trimmed = raw.trim();
    // Blank lines and comment lines between commands are prose.
    if (!continued && (trimmed === "" || trimmed.startsWith("#"))) continue;
    if (!continued) line = firstLine + offset;
    // A trailing backslash joins the next line to this one.
    const more = trimmed.endsWith("\\");
    const piece = more ? trimmed.slice(0, -1).trim() : trimmed;
    text = continued ? `${text} ${piece}` : piece;
    if (more) {
      continued = true;
    } else {
      out.push({ text, line, continued: line !== firstLine + offset });
      continued = false;
    }
  }
  // A backslash on the last line leaves a half command; keep it so it is refused rather than dropped.
  if (continued) out.push({ text, line, continued: true });
  return out;
};

// Finds every fenced shell block in one markdown file's text, with its marker and its commands.
export const extractBlocks = (text, file) => {
  const blocks = [];
  // The open fence, or null; `last` is the most recent non-blank line outside any fence (the marker slot).
  let fence = null;
  let last = null;
  for (const [index, raw] of text.split("\n").entries()) {
    const trimmed = raw.trim();
    if (fence === null) {
      // A fence opens with three or more backticks or tildes; the language is the first word of the info
      // string, so "```bash title=x" is still a bash block. A backtick fence's info string has no backtick.
      const open = /^(`{3,}(?=[^`]*$)|~{3,})\s*(\S*)[^\n]*$/.exec(trimmed);
      if (open === null) {
        if (trimmed !== "") last = raw;
      } else {
        fence = { ticks: open[1], lang: open[2].toLowerCase(), line: index + 1, body: [], marker: last === null ? null : readMarker(last) };
      }
      continue;
    }
    // Closing fence: the same character, at least as many, and nothing else on the line.
    if (/^(`{3,}|~{3,})$/.test(trimmed) && trimmed[0] === fence.ticks[0] && trimmed.length >= fence.ticks.length) {
      // A console transcript keeps only its `$ ` lines (prompt stripped); everything else is output.
      const body = TRANSCRIPT_LANGS.has(fence.lang) ? fence.body.map((row) => (row.trim().startsWith("$ ") ? row.trim().slice(2) : "")) : fence.body;
      if (SHELL_LANGS.has(fence.lang)) blocks.push({ file, line: fence.line, marker: fence.marker, commands: logicalLines(body, fence.line + 1) });
      fence = null;
      last = null;
      continue;
    }
    fence.body.push(raw);
  }
  return blocks;
};

// Judges one block: what happens to each of its commands. Returns { problems, plan }.
export const judgeBlock = (block) => {
  const problems = [];
  const plan = [];
  const where = `${block.file}:${block.line}`;
  if (block.marker !== null && "error" in block.marker) problems.push(`${where}: ${block.marker.error}`);
  const skipping = block.marker !== null && "reason" in block.marker;
  for (const command of block.commands) {
    const at = `${block.file}:${command.line}`;
    // A marked block is never run; its commands are listed with the reason.
    if (skipping) {
      plan.push({ at, text: command.text, action: "skip", reason: block.marker?.reason ?? "" });
      continue;
    }
    // Continuations are refused outright: a joined line is no longer the line a reader sees.
    if (command.continued) {
      problems.push(`${at}: line continuation in an unmarked block; put it on one line or mark the block skip: ${command.text}`);
      continue;
    }
    const split = splitWords(command.text);
    if ("unsafe" in split) {
      problems.push(`${at}: not run-safe (${split.unsafe}) and the block has no skip marker: ${command.text}`);
      continue;
    }
    const entry = matchSafe(split.words);
    if (entry === undefined) {
      problems.push(`${at}: not on the safe list and the block has no skip marker: ${command.text}`);
      continue;
    }
    plan.push({ at, text: command.text, action: "run", words: split.words, entry });
  }
  return { problems, plan };
};

// Where a file sorts: the named first files in their order, then everything else.
const runRank = (file) => (FIRST.includes(file) ? FIRST.indexOf(file) : FIRST.length);

// The doc files, in run order. A guide file not named in FIRST sorts after them by name.
export const listDocs = (root) => {
  const guide = join(root, "docs", "guide");
  const names = existsSync(guide) ? readdirSync(guide).filter((name) => name.endsWith(".md")) : [];
  const files = ["README.md", ...names.map((name) => `docs/guide/${name}`)].filter((file) => existsSync(join(root, file)));
  return files.toSorted((a, b) => runRank(a) - runRank(b) || a.localeCompare(b));
};

// Reads every doc and judges every block; the whole plan plus every problem.
export const checkDocs = (root) => {
  const problems = [];
  const plan = [];
  for (const file of listDocs(root)) {
    for (const block of extractBlocks(readFileSync(join(root, file), "utf8"), file)) {
      const judged = judgeBlock(block);
      problems.push(...judged.problems);
      plan.push(...judged.plan);
    }
  }
  return { problems, plan };
};

// The environment a command inherits: only names on the allowlist, so a cloud key or token never reaches it.
//
// Git's own config is cut off too: HOME stays (toolchains need it), but a reader's global
// `core.hooksPath` would otherwise send `hooks:install` outside the copy. The copy's own commit passes `-c user.*`.
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export const scrubEnv = (env) => ({ ...Object.fromEntries(Object.entries(env).filter(([name]) => ENV_ALLOW.some((pattern) => pattern.test(name)))), ...GIT_ISOLATION });

// Runs git (or tar) with no shell; throws with the tool's stderr on failure.
const tool = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
};

// Makes the throwaway copy: `git archive HEAD` unpacked into a temp dir, then `git init` + one commit, as a fresh clone would be.
const makeCopy = (root, env) => {
  const dir = mkdtempSync(join(tmpdir(), "doc-commands-"));
  tool("git", ["archive", "--format=tar", "-o", join(dir, "..", `${basename(dir)}.tar`), "HEAD"], root, env);
  tool("tar", ["-xf", join(dir, "..", `${basename(dir)}.tar`), "-C", dir], root, env);
  rmSync(join(dir, "..", `${basename(dir)}.tar`), { force: true });
  tool("git", ["init", "-q", "-b", "dev"], dir, env);
  tool("git", ["add", "-A"], dir, env);
  tool("git", ["-c", "user.name=docs", "-c", "user.email=docs@example.invalid", "commit", "-q", "-m", "copy"], dir, env);
  return dir;
};

// Removes the copy, but only a directory this script made: under the temp dir, with our prefix.
const removeCopy = (dir) => {
  if (dirnameOf(dir) !== resolve(tmpdir()) || !basename(dir).startsWith("doc-commands-")) throw new Error(`refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true });
};

// The parent directory of a path, for the removal guard.
const dirnameOf = (path) => resolve(path, "..");

// Runs the plan's safe commands in the copy, in order. Returns one result per command.
const runPlan = (plan, cwd, env) => {
  const results = [];
  for (const step of plan) {
    if (step.action === "skip") {
      results.push({ ...step, status: "skipped" });
      continue;
    }
    const [program = "", ...args] = step.words;
    const started = Date.now();
    const run = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: step.entry.timeoutMs ?? 120_000, maxBuffer: 256 * 1024 * 1024 });
    const seconds = Math.round((Date.now() - started) / 1000);
    const missing = run.error !== undefined && "code" in run.error && run.error.code === "ENOENT";
    const okCodes = step.entry.okCodes ?? [0];
    let status = "ok";
    if (missing && (step.entry.probe === true || step.entry.optionalTool === true)) status = "absent";
    else if (step.entry.probe === true && run.status !== 0) status = "absent";
    else if (run.status === null || !okCodes.includes(run.status)) status = "FAILED";
    results.push({ ...step, status, seconds, tail: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n") });
  }
  return results;
};

// The CLI: check, and with --run, execute. Skipped when imported by a test.
const main = () => {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const flags = new Set(process.argv.slice(2));
  const { problems, plan } = checkDocs(root);
  const counts = { run: plan.filter((step) => step.action === "run").length, skip: plan.filter((step) => step.action === "skip").length };
  console.log(`doc-commands: ${counts.run} runnable and ${counts.skip} skipped commands in ${listDocs(root).length} files.`);
  for (const problem of problems) console.error(`  PROBLEM ${problem}`);
  if (problems.length > 0) process.exit(1);
  if (!flags.has("--run")) {
    for (const step of plan.filter((item) => item.action === "skip")) console.log(`  skip ${step.at}  ${step.text}  [${step.reason}]`);
    return;
  }
  const env = scrubEnv(process.env);
  const dir = makeCopy(root, env);
  console.log(`doc-commands: running in a fresh copy of HEAD at ${dir}`);
  let failed = 0;
  try {
    for (const result of runPlan(plan, dir, env)) {
      const label = result.status.padEnd(7);
      console.log(`  ${label} ${result.at}  ${result.text}${result.status === "skipped" ? `  [${result.reason}]` : ` (${result.seconds}s)`}`);
      if (result.status === "FAILED") {
        failed += 1;
        console.log(`${result.tail}`.replaceAll(/^/gm, "    | "));
      }
    }
  } finally {
    if (flags.has("--keep")) console.log(`doc-commands: kept ${dir}`);
    else removeCopy(dir);
  }
  console.log(failed === 0 ? "doc-commands: every runnable command passed." : `doc-commands: ${failed} command(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
};

// Run only as a script, not when a test imports the helpers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
