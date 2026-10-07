#!/usr/bin/env node
// The sql-migrations pack's lint: squawk plus atomic-file and data-loss checks over every migration, or over one edited file.
// In the app: nothing at runtime; `pnpm migrations:lint` (so `pnpm check` and CI) and the edit hook run it.
// Used by: package.json `migrations:lint`; scripts/check-edited.mjs through pack.json `editCheck`; lint.test.mjs, kill-partway.test.mjs (splitStatements).
// Uses: squawk (node_modules/.bin, else PATH), .squawk.toml, git ls-files / ls-tree / diff against origin/dev (fetched under CI when absent).
//
//   node stacks/sql-migrations/lint.mjs          every migration git tracks; exit 1 on any problem
//   node stacks/sql-migrations/lint.mjs <file>   the edit-hook contract: print one file's problems, or nothing
//
// A migration is a `*.sql` / `*.pgsql` file (any case) under a directory named in MIGRATION_DIRS
// (`migrations`: Prisma, sqlx, goose, golang-migrate, dbmate; `migration`: Flyway); `*.down.sql` is
// skipped, since it only runs on a rollback, and so is a goose or dbmate Down section. squawk
// catches what locks or breaks a live table (a plain CREATE INDEX, a NOT NULL column with no
// default, a dropped column). The atomic check catches what squawk can't: a file with several
// statements that the tool runs one by one, outside a transaction, so a deploy killed between two
// of them leaves the database between schemas (migrations.mdc → Atomic). The data-loss check wants
// a `-- data-loss: <id>` marker in the Up section of any file that deletes rows.

// Node builtins only: the lint must run in a project with no Node stack.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The project's squawk config, at the repo root.
const CONFIG = ".squawk.toml";

// Keys squawk 2.x reads (top level, and the [upload_to_github] table); anything else is a typo it would ignore.
const CONFIG_KEYS = new Set(["excluded_rules", "included_rules", "excluded_paths", "pg_version", "assume_in_transaction", "upload_to_github", "upload_to_github.fail_on_violations"]);

// Statements that only set session state (SET LOCAL lock_timeout …): they change no schema, so they
// don't count toward "more than one statement".
const SESSION_ONLY = /^(set|reset)\b/i;

// A runner's own opt-out of its transaction, for a file that can't run in one (CREATE INDEX
// CONCURRENTLY): goose's, sqlx's, and dbmate's `-- migrate:up transaction:false`.
const NO_TRANSACTION_MARKER = /^\s*--\s*(\+goose\s+NO\s+TRANSACTION|no-transaction|migrate:up\b.*\btransaction:false)\s*$/im;

// Knob: directory names (any case) that hold migrations. `migrations`: Prisma, sqlx, goose,
// golang-migrate, dbmate; `migration`: Flyway's `db/migration`.
export const MIGRATION_DIRS = ["migrations", "migration"];

// Knob: file extensions (any case) read as SQL migrations.
export const MIGRATION_EXTENSIONS = [".sql", ".pgsql"];

// Statements that delete rows: each needs a `-- data-loss: <human-check-id>` marker in its Up
// section, naming the plan's Human check (core.mdc). Read from code with comments removed, quoted
// text blanked, and lowercased, anywhere in the statement: a CTE (`WITH g AS (DELETE …)`), a
// `DO $$ … $$` body, and `MERGE … THEN DELETE` delete rows as surely as a bare DELETE. Each rule is
// patterns that must appear in order, each searched from where the last ended, so a long statement
// can't make one backtrack.
const DATA_LOSS = [
  { patterns: [/\bdelete\s+(?:\w+(?:\s*,\s*\w+){0,15}\s+)?from\b/], what: "DELETE" },
  { patterns: [/\bthen\s+delete\b/], what: "MERGE … THEN DELETE" },
  { patterns: [/\btruncate\b/], what: "TRUNCATE" },
  // `SET a = NULL`, and the tuple forms `SET (a, b) = (NULL, …)` / `= ROW(NULL, …)`.
  { patterns: [/\bupdate\b/, /\bset\b/, /=\s*(?:row\s*)?\(?\s*null\b/], what: "UPDATE … = NULL" },
];

// A statement that only defines code (a function, procedure, trigger, or rule) deletes nothing when the migration runs.
const DEFINES_CODE = /^create\s+(or\s+replace\s+)?(function|procedure|trigger|rule)\b/;

// The marker that says a human signed off on a migration's data loss, read from a real comment.
const DATA_LOSS_MARKER = /^--\s*data-loss:\s*(\S+)/i;

// Marker ids that name no Human check yet: a placeholder is not a sign-off.
const PLACEHOLDER_ID = /^(todo|tbd|tba|fixme|xxx+|n\/?a|none|id|human-check-id|\?+|<.*>|\.{3}|…|-+)$/i;

// A Human check id's shape (plans.mdc → Human checks: kebab-case, letters and digits). Anything
// else — `TODO:`, `tbd.`, `HC-?` — is a placeholder with punctuation, not an id.
const HUMAN_CHECK_ID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

// What dataLossProblem() blanks in a statement's code: a comment (left inside a dollar-quoted
// body), an E'' string with backslash escapes, a plain string, or a quoted identifier.
const QUOTED_OR_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\/|\b[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"/g;

// Splits SQL into statements the way Postgres reads it: `;` ends one unless it sits in a comment,
// a quoted string or identifier, or a dollar-quoted body. Returns { text, code, line } each:
// `text` as written (comments kept, for feeding to psql), `code` without comments, `line` where its code starts.
export const splitStatements = (sql) => scan(sql).statements;

// splitStatements()' reader, which also returns each `--` comment outside quoted text ({ text, line }).
const scan = (sql) => {
  const statements = [];
  const comments = [];
  let start = 0;
  let code = "";
  let line = 1;
  let codeLine = 0;
  // Ends the statement at `end` (exclusive), keeping it only when it has code.
  const cut = (end) => {
    if (code.replace(/;\s*$/, "").trim() !== "") statements.push({ text: sql.slice(start, end).trim(), code: code.trim(), line: codeLine });
    start = end;
    code = "";
    codeLine = 0;
  };
  // Appends a run of code, noting the line the statement's code starts on.
  const keep = (text) => {
    if (codeLine === 0 && text.trim() !== "") codeLine = line + (text.slice(0, text.search(/\S/)).match(/\n/g)?.length ?? 0);
    code += text;
  };
  let i = 0;
  while (i < sql.length) {
    const char = sql[i] ?? "";
    const rest = sql.slice(i);
    let end = i + 1;
    // `-- comment` to the end of the line (the newline itself is ordinary whitespace).
    if (rest.startsWith("--")) {
      end = sql.indexOf("\n", i);
      if (end === -1) end = sql.length;
      comments.push({ text: sql.slice(i, end), line });
      code += " ";
    } else if (rest.startsWith("/*")) {
      // `/* … */`, which Postgres lets nest.
      let depth = 0;
      end = i;
      do {
        if (sql.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (sql.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else end += 1;
      } while (depth > 0 && end < sql.length);
      code += " ";
    } else if (char === "'" || char === '"') {
      // A string or quoted identifier; a doubled quote is an escaped one. E'…' also escapes with a backslash.
      const escapes = char === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      end = i + 1;
      while (end < sql.length) {
        if (escapes && sql[end] === "\\") end += 2;
        else if (sql[end] === char && sql[end + 1] === char) end += 2;
        else if (sql[end] === char) break;
        else end += 1;
      }
      end = Math.min(end + 1, sql.length);
      keep(sql.slice(i, end));
    } else if (char === "$" && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(rest) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      // `$tag$ … $tag$`: a function body or a string with no escapes at all.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)?.[0] ?? "$$";
      const close = sql.indexOf(tag, i + tag.length);
      end = close === -1 ? sql.length : close + tag.length;
      keep(sql.slice(i, end));
    } else if (char === ";") {
      // The end of a statement (a lone `;` is no statement at all).
      code += ";";
      cut(i + 1);
    } else {
      keep(char);
    }
    line += (sql.slice(i, end).match(/\n/g) ?? []).length;
    i = end;
  }
  cut(sql.length);
  return { statements, comments };
};

// The part of a migration that runs on the way up: goose (`-- +goose Up/Down`) and dbmate
// (`-- migrate:up/down`) keep both in one file. Lines outside it are blanked, not cut, so line
// numbers still point into the file.
export const upSection = (sql) => {
  const lines = sql.split("\n");
  const up = lines.findIndex((line) => /^\s*--\s*(\+goose\s+Up|migrate:up)\b/i.test(line));
  if (up === -1) return sql;
  const down = lines.findIndex((line, index) => index > up && /^\s*--\s*(\+goose\s+Down|migrate:down)\b/i.test(line));
  return lines.map((line, index) => (index < up || (down !== -1 && index >= down) ? "" : line)).join("\n");
};

// The atomic-file problem in one migration, or null. `runnerWraps` is .squawk.toml's assume_in_transaction.
//
// A tool that wraps each file makes it atomic, and squawk's transaction-nesting rule refuses a BEGIN
// inside it; only a file that opts out of the wrap is checked here. A tool that doesn't wrap runs the
// statements one at a time, so more than one needs BEGIN first and COMMIT last, with nothing between
// that ends the transaction early.
export const atomicProblem = (sql, { runnerWraps }) => {
  if (runnerWraps && !NO_TRANSACTION_MARKER.test(sql)) return null;
  const statements = splitStatements(upSection(sql)).filter((statement) => !SESSION_ONLY.test(statement.code));
  if (statements.length <= 1) return null;
  const opens = /^(begin|start\s+transaction)\b/i.test(statements[0]?.code ?? "");
  const closes = /^(commit|end)\b/i.test(statements.at(-1)?.code ?? "");
  // ROLLBACK TO SAVEPOINT stays inside the transaction; a bare ROLLBACK ends it.
  const endsEarly = statements.slice(1, -1).find((statement) => /^(begin|start\s+transaction|commit|end|abort)\b|^rollback\b(?!\s+(work\s+|transaction\s+)?to\b)/i.test(statement.code));
  if (opens && closes && endsEarly === undefined) return null;
  const at = endsEarly ?? statements[1] ?? statements[0];
  return {
    line: at?.line ?? 1,
    message: `${statements.length} statements run outside one transaction, so a deploy killed between them leaves the database between schemas. Open the file with BEGIN; and end it with COMMIT;, or split it (migrations.mdc → Atomic).`,
  };
};

// The data-loss problem in one migration, or null: a statement that deletes rows with no
// `-- data-loss: <id>` marker naming a real id, as a comment in the Up section (a marker in a
// Down section or inside a string signs off nothing) (migrations.mdc → Live tables).
export const dataLossProblem = (sql) => {
  const { statements, comments } = scan(upSection(sql));
  const ids = comments.map((comment) => DATA_LOSS_MARKER.exec(comment.text.trim())?.[1]).filter((id) => id !== undefined);
  if (ids.some((id) => HUMAN_CHECK_ID.test(id) && !PLACEHOLDER_ID.test(id))) return null;
  for (const statement of statements) {
    // Quoted text blanked, so `INSERT … VALUES ('delete from')` deletes nothing. Comments are
    // matched first: scan() removed those outside quotes, but a `DO $$ … $$` body keeps its own,
    // and an apostrophe in one (`-- don't`) would otherwise open a string that hides the DELETE.
    const code = statement.code.replace(QUOTED_OR_COMMENT, (match) => (match.startsWith("--") || match.startsWith("/*") ? " " : "''")).toLowerCase();
    if (DEFINES_CODE.test(code)) continue;
    const found = DATA_LOSS.find((rule) => inOrder(code, rule.patterns));
    if (found === undefined) continue;
    const placeholder = ids.length > 0 ? ` (\`${ids[0]}\` is a placeholder, not a Human check id)` : "";
    return { line: statement.line, message: `${found.what} deletes rows: add \`-- data-loss: <human-check-id>\` in the Up section naming the plan's Human check for it${placeholder} (core.mdc → Deleting data, migrations.mdc).` };
  }
  return null;
};

// True when each pattern matches in order, each searched from where the one before it ended.
const inOrder = (text, patterns) => {
  let at = 0;
  for (const pattern of patterns) {
    const found = pattern.exec(at === 0 ? text : text.slice(at));
    if (found === null) return false;
    at += found.index + found[0].length;
  }
  return true;
};

// Reads .squawk.toml's keys as a flat map ("table.key" inside a [table]); enough to validate it and read two values.
export const readConfig = (text) => {
  const keys = new Map();
  let table = "";
  // Comments go first; a `#` inside a quoted string is rare enough in this file to ignore.
  const lines = text.split("\n").map((line) => line.replace(/\s+#.*$|^#.*$/, ""));
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      keys.set(table, "");
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`${CONFIG} line ${index + 1}: can't read \`${line}\``);
    let value = pair[2];
    // An array may span lines: read to its closing bracket.
    while (value.startsWith("[") && !value.trimEnd().endsWith("]") && index + 1 < lines.length) {
      index += 1;
      value += ` ${(lines[index] ?? "").trim()}`;
    }
    keys.set(table === "" ? pair[1] : `${table}.${pair[1]}`, value.trim());
  }
  return keys;
};

// Lists every migration file git tracks or would track, repo-relative.
export const migrationFiles = (root) => trackedFiles(root).filter(isMigration);

// Every file git tracks or would track that still exists, repo-relative.
const trackedFiles = (root) => {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  // git failing must fail the lint: "no files" would read as a pass.
  if (result.status !== 0) throw new Error(`git ls-files failed: ${(result.stderr ?? "").trim() || "not a git repository?"}`);
  return result.stdout.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));
};

// SQL files outside every migrations directory: never linted, so the full run names them.
export const strayFiles = (root) => trackedFiles(root).filter((path) => isSql(path) && !isMigration(path) && !/\.down\.[^./]+$/i.test(path));

// A file with a migration extension, in any case.
const isSql = (path) => MIGRATION_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

// A migration: a SQL file under a MIGRATION_DIRS directory (any case), not a rollback-only `.down.sql`.
export const isMigration = (path) =>
  isSql(path) && !/\.down\.[^./]+$/i.test(path) && path.split("/").slice(0, -1).some((dir) => MIGRATION_DIRS.includes(dir.toLowerCase()));

// A glob from excluded_paths as a regex: `**` any depth, `*` and `?` within one segment.
const globRegex = (glob) =>
  new RegExp(
    `^${glob
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );

// The squawk binary: the pinned npm one, else one on PATH (a project without a Node stack); "" when neither.
const squawkBinary = (root) => {
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "squawk.cmd" : "squawk");
  if (existsSync(local)) return local;
  const found = spawnSync("squawk", ["--version"], { encoding: "utf8" });
  return found.status === 0 ? "squawk" : "";
};

// The squawk-missing line: the atomic and data-loss checks still ran, squawk's didn't.
export const NO_SQUAWK = "squawk is not installed, so only the atomic and data-loss checks ran: run `pnpm install` (the pack pins squawk-cli), or put squawk on PATH.";

// .squawk.toml's excluded_paths, each as { glob, pattern }.
const excludedPaths = (config) => [...(config.get("excluded_paths") ?? "").matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => ({ glob: match[1] ?? match[2] ?? "", pattern: globRegex(match[1] ?? match[2] ?? "") }));

// Files on `origin/dev`, or null when this clone doesn't have it (a shallow CI checkout, a new repo).
const onDev = (root) => {
  const result = spawnSync("git", ["ls-tree", "-r", "-z", "--name-only", "origin/dev"], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? new Set(result.stdout.split("\0")) : null;
};

// How long one git call may take before the lint gives up on it (a hung `git fetch` fails, never hangs).
const GIT_TIMEOUT_MS = 30_000;

// Of `paths` (all on origin/dev), the ones whose working copy differs from origin/dev's: an
// excluded file that was edited is a new migration under an old name. null when git can't say.
const changedFromDev = (root, paths) => {
  const result = spawnSync("git", ["diff", "--name-only", "-z", "origin/dev", "--", ...paths], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? new Set(result.stdout.split("\0").filter((path) => path !== "")) : null;
};

// True under CI (`CI` set to anything but "", "0", or "false").
const underCi = () => !["", "0", "false"].includes(String(process.env.CI ?? "").toLowerCase());

// Files on `origin/dev`. Under CI a clone without it (the Checks job's shallow checkout) fetches
// that one branch, and still none is a failure: a skipped check would let `**` silence every new migration.
// Locally, null: the full run still prints how many files each entry skips.
const devFiles = (root, { ci }) => {
  const files = onDev(root);
  if (files !== null || !ci) return files;
  // `--depth=1` only in a clone that is already shallow: in a full one it would make it shallow.
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS }).stdout?.trim() === "true";
  // Bounded, so a hung remote fails the lint (below) instead of hanging the job or the edit hook.
  spawnSync("git", ["fetch", "--quiet", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", "+refs/heads/dev:refs/remotes/origin/dev"], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  const fetched = onDev(root);
  if (fetched === null) throw new Error(`${CONFIG} excluded_paths skips files, and origin/dev isn't in this clone even after \`git fetch origin dev\`, so the excluded_paths check can't run: fetch dev in the job, or narrow excluded_paths (migrations.mdc → Live tables).`);
  return fetched;
};

// How many of `files` each excluded_paths entry skips, for the full run to print.
export const excludedCounts = (root, files) => {
  const configPath = join(root, CONFIG);
  const config = existsSync(configPath) ? readConfig(readFileSync(configPath, "utf8")) : new Map();
  return excludedPaths(config).map(({ glob, pattern }) => ({ glob, count: files.filter((path) => pattern.test(path)).length }));
};

// Lints `files` (repo-relative); returns problem lines (`path:line:col: message`), or throws when it can't lint at all.
//
// excluded_paths is for history already applied in production, so an entry that skips a file
// `origin/dev` doesn't have yet is refused: a glob like `**` would otherwise silence every new
// migration. Without `origin/dev` in the clone, `ci` fetches it or fails (devFiles); locally the
// check can't run, and the full run still prints how many files each entry skips.
export const lint = (root, files, { squawk = squawkBinary(root), ci = underCi() } = {}) => {
  const configPath = join(root, CONFIG);
  const config = existsSync(configPath) ? readConfig(readFileSync(configPath, "utf8")) : new Map();
  // A key squawk doesn't know is a setting that silently does nothing; refuse it.
  for (const key of config.keys()) if (!CONFIG_KEYS.has(key)) throw new Error(`${CONFIG}: unknown key '${key}'. squawk would ignore it; fix the name or remove it.`);
  const runnerWraps = config.get("assume_in_transaction") === "true";
  // excluded_paths applies to every check; squawk is only handed files that aren't excluded.
  const excluded = excludedPaths(config);
  const isExcluded = (path) => excluded.some(({ pattern }) => pattern.test(path));
  const problems = [];
  const skipped = files.filter(isExcluded);
  const history = skipped.length > 0 ? devFiles(root, { ci }) : null;
  for (const path of skipped) {
    if (history !== null && !history.has(path)) problems.push(`${path}:1:0: error: excluded-path ${CONFIG} excluded_paths skips this file, but origin/dev doesn't have it yet: excluded_paths is only for migrations already applied in production. Narrow the entry (migrations.mdc → Live tables).`);
  }
  // A file dev has, edited here, is no longer the history production applied: it gets checked.
  const onDevAlready = history === null ? [] : skipped.filter((path) => history.has(path));
  const changed = onDevAlready.length > 0 ? changedFromDev(root, onDevAlready) : new Set();
  if (changed === null) throw new Error(`${CONFIG} excluded_paths skips files, and \`git diff origin/dev\` failed, so the check that they're unchanged since dev can't run.`);
  for (const path of onDevAlready) {
    if (changed.has(path)) problems.push(`${path}:1:0: error: excluded-path ${CONFIG} excluded_paths skips this file, but it differs from origin/dev: an applied migration is never edited. Revert it and add a new migration (migrations.mdc → Live tables).`);
  }
  const checked = files.filter((path) => !isExcluded(path));
  for (const path of checked) {
    const sql = readFileSync(join(root, path), "utf8");
    // Atomic files and data-loss markers, one file at a time.
    const atomic = atomicProblem(sql, { runnerWraps });
    if (atomic !== null) problems.push(`${path}:${atomic.line}:0: error: atomic-migration ${atomic.message}`);
    const loss = dataLossProblem(sql);
    if (loss !== null) problems.push(`${path}:${loss.line}:0: error: data-loss-marker ${loss.message}`);
  }
  if (checked.length === 0) return problems;
  if (squawk === "") return [...problems, NO_SQUAWK];
  // squawk on each file's Up section only (a Down section's DROP is the rollback, not the deploy),
  // fed on stdin under the file's own name, in its one-line format.
  for (const path of checked) {
    const args = ["--reporter", "gcc", ...(existsSync(configPath) ? ["--config", configPath] : []), "--stdin-filepath", path];
    const result = spawnSync(squawk, args, { cwd: root, encoding: "utf8", input: upSection(readFileSync(join(root, path), "utf8")), env: { ...process.env, SQUAWK_DISABLE_GITHUB_ANNOTATIONS: "true" } });
    // 0 clean, 1 findings; anything else (a crash, a bad flag) is a failure to lint, not a pass.
    if (result.status !== 0 && result.status !== 1) throw new Error(`squawk failed on ${path} (exit ${String(result.status ?? result.signal)}): ${`${result.stderr ?? ""}${result.stdout ?? ""}`.trim()}`);
    const findings = (result.stdout ?? "").split("\n").filter((line) => /^\S.*:\d+:\d+: /.test(line));
    // squawk said "found something" but printed nothing we could read: report its raw output rather than pass.
    if (result.status === 1 && findings.length === 0) findings.push(`squawk exited 1 on ${path}: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`);
    problems.push(...findings);
  }
  return problems;
};

// CLI: every migration (exit 1 on a problem), or one edited file (print its problems; the hook reads stdout).
const main = () => {
  const root = process.cwd();
  const edited = process.argv[2];
  // Edit hook: only migration files. Before `pnpm install` brings squawk, the other checks still run and one line says so.
  if (edited !== undefined) {
    if (!isMigration(edited)) return 0;
    const problems = lint(root, [edited]);
    if (problems.length > 0) process.stdout.write(`${problems.join("\n")}\nRules and fixes: .cursor/rules/migrations.mdc, https://squawkhq.com/docs/rules`);
    return 0;
  }
  // SQL that no check reads, named so a misplaced migration can't pass by not being found.
  const strays = strayFiles(root);
  if (strays.length > 0) process.stdout.write(`migrations:lint: ${strays.length} SQL file(s) outside a ${MIGRATION_DIRS.join("/")} directory, not linted: ${strays.join(", ")}\n`);
  const files = migrationFiles(root);
  // Nothing to lint is a pass, said out loud so an empty run can't pass for a checked one.
  if (files.length === 0) {
    process.stdout.write(`migrations:lint: no migration files (${MIGRATION_EXTENSIONS.join("/")} under a ${MIGRATION_DIRS.join("/")} directory); nothing to check.\n`);
    return 0;
  }
  // Each excluded_paths entry and how much it hides, so a too-wide glob shows.
  for (const { glob, count } of excludedCounts(root, files)) process.stdout.write(`migrations:lint: excluded_paths "${glob}" skips ${count} file(s).\n`);
  const problems = lint(root, files);
  if (problems.length === 0) {
    process.stdout.write(`migrations:lint: ${files.length} migration file(s) clean.\n`);
    return 0;
  }
  process.stderr.write(`${problems.join("\n")}\n✗ migrations:lint: ${problems.length} problem(s). Rules and fixes: .cursor/rules/migrations.mdc, https://squawkhq.com/docs/rules\n`);
  return 1;
};

// Run only as a script, so the tests can import the parts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A lint that can't run (no squawk, bad config, git failing) is a failure with one line, never a pass.
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`migrations:lint: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
