/*
  The sql-migrations lint: statement splitting, the atomic-file check, the config check, and squawk on the red-on-purpose fixture.
  In the app: nothing at runtime; runs in `pnpm test:harness` while the sql-migrations pack is installed.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/sql-migrations/lint.mjs; scripts/lib/ci-change-scope.mjs; fixtures/; squawk from node_modules (skips loudly without it, fails under CI); temp git repos.

  The fixture tests are the "fails CI" proof: the same lint() that `pnpm migrations:lint` runs in
  the Stack pack checks step must refuse a plain CREATE INDEX on a table that already exists, and
  pass the fixtures the kill-partway test runs, which follow every rule.
*/
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { classify, packPatterns } from "../../scripts/lib/ci-change-scope.mjs";
import { atomicProblem, dataLossProblem, excludedCounts, isMigration, lint, NO_SQUAWK, readConfig, splitStatements, strayFiles, upSection } from "./lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LINT = join(HERE, "lint.mjs");
const SQUAWK = join(REPO, "node_modules", ".bin", "squawk");
const UNDER_CI = !["", "0", "false"].includes(String(process.env.CI ?? "").toLowerCase());

// Temp repos, removed after the run.
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A temp git repo holding `files` ({ path: text }) and this repo's .squawk.toml.
const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "migrations-lint-"));
  roots.push(root);
  copyFileSync(join(REPO, ".squawk.toml"), join(root, ".squawk.toml"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
};

const fixture = (path) => readFileSync(join(HERE, "fixtures", path), "utf8");

// git in `cwd`, with an identity so a commit works on a bare CI machine.
const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

describe("splitStatements", () => {
  it("splits on ; outside comments, strings, quoted names, and dollar-quoted bodies", () => {
    const sql = [
      "-- a comment; not a statement",
      "BEGIN;",
      "/* block; /* nested; */ still */ SELECT 'a;b', \"odd;name\", E'it\\'s;';",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "COMMIT",
    ].join("\n");
    const statements = splitStatements(sql);
    assert.deepEqual(
      statements.map((statement) => statement.code.split(/\s+/)[0]),
      ["BEGIN;", "SELECT", "CREATE", "DO", "COMMIT"],
    );
    // Lines point at where each statement's code starts, past comments.
    assert.deepEqual(statements.map((statement) => statement.line), [2, 3, 4, 5, 6]);
  });

  it("drops comment-only and empty statements", () => {
    assert.deepEqual(splitStatements("-- nothing\n;\n/* still nothing */;"), []);
  });
});

describe("atomicProblem", () => {
  const doesNotWrap = { runnerWraps: false };
  const wraps = { runnerWraps: true };

  it("passes a lone statement, and SET lines don't count", () => {
    assert.equal(atomicProblem("CREATE TABLE t (id bigint);", doesNotWrap), null);
    assert.equal(atomicProblem("SET lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (c);", doesNotWrap), null);
  });

  it("passes several statements between BEGIN and COMMIT", () => {
    assert.equal(atomicProblem(fixture("kill-partway/0002_tag.sql"), doesNotWrap), null);
  });

  it("refuses several statements with no transaction, or one that ends early", () => {
    assert.match(atomicProblem("CREATE TABLE a (id bigint);\nCREATE TABLE b (id bigint);", doesNotWrap)?.message ?? "", /2 statements run outside one transaction/);
    assert.equal(atomicProblem("BEGIN;\nCREATE TABLE a (id bigint);\nCOMMIT;\nCREATE TABLE b (id bigint);", doesNotWrap)?.line, 3);
    assert.notEqual(atomicProblem("BEGIN;\nCREATE TABLE a (id bigint);", doesNotWrap), null);
  });

  it("leaves a wrapping runner's files to it, except one that opts out of the wrap", () => {
    assert.equal(atomicProblem("CREATE TABLE a (id bigint);\nCREATE TABLE b (id bigint);", wraps), null);
    assert.notEqual(atomicProblem("-- +goose NO TRANSACTION\nCREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);", wraps), null);
    assert.equal(atomicProblem("-- no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);", wraps), null);
  });

  it("reads only goose's Up section", () => {
    const goose = "-- +goose Up\nCREATE TABLE a (id bigint);\n-- +goose Down\nDROP TABLE a;\n";
    assert.equal(atomicProblem(goose, doesNotWrap), null);
  });

  it("reads dbmate's sections, and its transaction:false opt-out", () => {
    const dbmate = "-- migrate:up\nCREATE TABLE a (id bigint);\n-- migrate:down\nDROP TABLE a;\nDROP TABLE b;\n";
    assert.equal(atomicProblem(dbmate, doesNotWrap), null);
    const optOut = "-- migrate:up transaction:false\nCREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\n-- migrate:down\n";
    assert.equal(atomicProblem(optOut, wraps)?.line, 3);
  });

  it("ROLLBACK TO SAVEPOINT stays inside the transaction; a bare ROLLBACK ends it", () => {
    const savepoint = "BEGIN;\nSAVEPOINT s;\nCREATE TABLE a (id bigint);\nROLLBACK TO SAVEPOINT s;\nCREATE TABLE b (id bigint);\nCOMMIT;\n";
    assert.equal(atomicProblem(savepoint, doesNotWrap), null);
    assert.equal(atomicProblem(savepoint.replace("ROLLBACK TO SAVEPOINT s", "ROLLBACK"), doesNotWrap)?.line, 4);
  });
});

describe("upSection", () => {
  it("blanks what isn't Up and keeps line numbers", () => {
    const sql = "-- header\n-- migrate:up\nCREATE TABLE a (id bigint);\n-- migrate:down\nDROP TABLE a;\n";
    const up = upSection(sql);
    assert.equal(up.split("\n").length, sql.split("\n").length);
    assert.equal(up.split("\n")[2], "CREATE TABLE a (id bigint);");
    assert.ok(!up.includes("DROP"));
    assert.equal(upSection("CREATE TABLE a (id bigint);\n"), "CREATE TABLE a (id bigint);\n");
  });
});

describe("dataLossProblem", () => {
  it("wants a data-loss marker on DELETE, TRUNCATE, and a clearing UPDATE", () => {
    for (const statement of ["DELETE FROM note WHERE id < 10;", "TRUNCATE note;", "UPDATE note SET body = NULL;", "update note set title = 'x', body = null where id = 1;"]) {
      assert.equal(dataLossProblem(`BEGIN;\n${statement}\nCOMMIT;\n`)?.line, 2, statement);
      assert.equal(dataLossProblem(`-- data-loss: H-12\nBEGIN;\n${statement}\nCOMMIT;\n`), null, statement);
    }
  });

  it("passes updates that keep data, comments, and a Down section", () => {
    assert.equal(dataLossProblem("UPDATE note SET slug = lower(title);"), null);
    assert.equal(dataLossProblem("-- DELETE FROM note;\nCREATE TABLE a (id bigint);"), null);
    assert.equal(dataLossProblem("-- +goose Up\nCREATE TABLE a (id bigint);\n-- +goose Down\nDELETE FROM a;\n"), null);
  });

  // QA round 2: deletes a leading-keyword match missed, and markers that sign off nothing.
  it("wants a marker on a CTE delete, a DO-block delete, and MERGE … THEN DELETE", () => {
    for (const sql of [
      "BEGIN;\nWITH gone AS (DELETE FROM note RETURNING id) SELECT count(*) FROM gone;\nCOMMIT;\n",
      "DO $$ BEGIN DELETE FROM note; END $$;\n",
      "BEGIN;\nMERGE INTO note n USING x ON n.id = x.id WHEN MATCHED THEN DELETE;\nCOMMIT;\n",
      "INSERT INTO archive SELECT * FROM note;\nWITH x AS (UPDATE note SET body = NULL RETURNING id) SELECT 1;\n",
    ]) {
      assert.notEqual(dataLossProblem(sql), null, sql);
      assert.equal(dataLossProblem(`-- data-loss: HC-2d-1\n${sql}`), null, sql);
    }
  });

  it("counts a marker only as a comment in the Up section naming a real id", () => {
    const deletes = "BEGIN;\nDELETE FROM note;\nCOMMIT;\n";
    assert.notEqual(dataLossProblem(`-- +goose Up\n${deletes}-- +goose Down\n-- data-loss: HC-1\n`), null);
    assert.notEqual(dataLossProblem(`BEGIN;\nSELECT '\n-- data-loss: HC-1\n';\nDELETE FROM note;\nCOMMIT;\n`), null);
    for (const id of ["TODO", "tbd", "?", "<human-check-id>", "...", "n/a"]) assert.match(dataLossProblem(`-- data-loss: ${id}\n${deletes}`)?.message ?? "", /placeholder/, id);
    assert.equal(dataLossProblem(`-- +goose Up\n-- data-loss: HC-1\n${deletes}`), null);
  });

  it("passes code that only mentions a delete: a function body, quoted text", () => {
    assert.equal(dataLossProblem("CREATE OR REPLACE FUNCTION purge() RETURNS void AS $$ DELETE FROM note; $$ LANGUAGE sql;\n"), null);
    assert.equal(dataLossProblem("INSERT INTO log (msg) VALUES ('delete from note; truncate');\n"), null);
    assert.equal(dataLossProblem("ALTER TABLE tag ADD CONSTRAINT fk FOREIGN KEY (note_id) REFERENCES note ON DELETE CASCADE;\n"), null);
  });

  it("reads 1 MB of adversarial SQL in under 2 s", () => {
    for (const unit of ["update the row set it to done\n", "delete a , ", "' ", "/* ", "select 1;\n", "$$ -- ' ", "E'\\' "]) {
      const started = Date.now();
      dataLossProblem(unit.repeat(Math.floor(1_000_000 / unit.length)));
      assert.ok(Date.now() - started < 2000, `${unit.trim()}: ${Date.now() - started} ms`);
    }
  });

  // QA round 3 (S7): an apostrophe in a comment inside a dollar-quoted body opened a "string"
  // running to the next apostrophe, which blanked the DELETE between them.
  it("reads a DO body's comments as comments, so an apostrophe in one hides nothing", () => {
    assert.notEqual(dataLossProblem("DO $$\nBEGIN\n  -- don't keep orphans\n  DELETE FROM users WHERE id < 0;\n  -- that's it\nEND\n$$;\n"), null);
    assert.notEqual(dataLossProblem("DO $$\nBEGIN\n  /* don't */ DELETE FROM users; /* it's */\nEND\n$$;\n"), null);
    assert.notEqual(dataLossProblem("SELECT E'it\\'s';\nDELETE FROM users;\n"), null);
    assert.equal(dataLossProblem("DO $$ BEGIN RAISE NOTICE 'delete from users'; END $$;\n"), null);
  });

  // QA round 3 (S6, ported to the guard too): the tuple form clears columns as surely as `= NULL`.
  it("wants a marker on UPDATE … SET (a, b) = (NULL, NULL) and ROW(NULL, …)", () => {
    assert.notEqual(dataLossProblem("UPDATE users SET (email, name) = (NULL, NULL);\n"), null);
    assert.notEqual(dataLossProblem("UPDATE users SET (email, name) = ROW(NULL, 'x');\n"), null);
    assert.equal(dataLossProblem("UPDATE users SET (email, name) = (lower(email), name);\n"), null);
  });

  // QA round 3 nit: a placeholder with punctuation (`TODO:`) is still a placeholder.
  it("reads an id that isn't kebab-case as a placeholder", () => {
    const deletes = "DELETE FROM note;\n";
    for (const id of ["TODO:", "tbd.", "HC-?", "HC-", "-HC", "id:"]) assert.match(dataLossProblem(`-- data-loss: ${id}\n${deletes}`)?.message ?? "", /placeholder/, id);
    for (const id of ["HC-3", "sync-p2-offline", "prod-still-signed-in"]) assert.equal(dataLossProblem(`-- data-loss: ${id}\n${deletes}`), null, id);
  });
});

describe("config and file selection", () => {
  it("reads keys, arrays across lines, and tables", () => {
    const keys = readConfig('# c\nexcluded_rules = [\n  "a", # why\n  "b",\n]\nassume_in_transaction = true\n[upload_to_github]\nfail_on_violations = true\n');
    assert.equal(keys.get("assume_in_transaction"), "true");
    assert.match(keys.get("excluded_rules") ?? "", /"a",\s+"b"/);
    assert.equal(keys.get("upload_to_github.fail_on_violations"), "true");
  });

  it("refuses a key squawk would silently ignore", () => {
    const root = repoWith({ "db/migrations/0001.sql": "CREATE TABLE t (id bigint);" });
    writeFileSync(join(root, ".squawk.toml"), "exclude_rules = []\n");
    assert.throws(() => lint(root, ["db/migrations/0001.sql"], { squawk: "unused" }), /unknown key 'exclude_rules'/);
  });

  it("picks .sql under a migrations directory, never a rollback-only .down.sql", () => {
    assert.equal(isMigration("prisma/migrations/20260101_x/migration.sql"), true);
    assert.equal(isMigration("migrations/0001_x.up.sql"), true);
    assert.equal(isMigration("migrations/0001_x.down.sql"), false);
    assert.equal(isMigration("stacks/sql-migrations/fixtures/nonconcurrent-index.sql"), false);
    assert.equal(isMigration("docs/migrations.sql"), false);
  });

  it("matches the directory and extension in any case, Flyway's db/migration, and .pgsql", () => {
    for (const path of ["db/MIGRATIONS/1.sql", "db/migration/V1__x.sql", "migrations/1.SQL", "migrations/1.pgsql"]) assert.equal(isMigration(path), true, path);
    assert.equal(isMigration("migrations/1.DOWN.SQL"), false);
  });

  it("names SQL files outside every migrations directory", () => {
    const root = repoWith({ "migrations/1.sql": "SELECT 1;", "sql/seed.sql": "SELECT 1;", "migrations/1.down.sql": "SELECT 1;" });
    assert.deepEqual(strayFiles(root), ["sql/seed.sql"]);
  });

  it("skips excluded_paths in its own check too", () => {
    const root = repoWith({ "migrations/old/0001.sql": "CREATE TABLE a (id bigint);\nCREATE TABLE b (id bigint);" });
    writeFileSync(join(root, ".squawk.toml"), 'excluded_paths = ["migrations/old/**"]\n');
    assert.deepEqual(lint(root, ["migrations/old/0001.sql"], { squawk: "unused", ci: false }), []);
    assert.deepEqual(excludedCounts(root, ["migrations/old/0001.sql", "migrations/0002.sql"]), [{ glob: "migrations/old/**", count: 1 }]);
  });

  it("refuses an excluded_paths entry that skips a file origin/dev doesn't have yet", () => {
    const root = repoWith({ "migrations/old/0001.sql": "CREATE TABLE a (id bigint);" });
    const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root });
    git("add", ".");
    git("commit", "--quiet", "-m", "history");
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    mkdirSync(join(root, "migrations/new"), { recursive: true });
    writeFileSync(join(root, "migrations/new/0002.sql"), "CREATE TABLE b (id bigint);");
    writeFileSync(join(root, ".squawk.toml"), 'excluded_paths = ["migrations/**"]\n');
    const problems = lint(root, ["migrations/old/0001.sql", "migrations/new/0002.sql"], { squawk: "unused" });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0] ?? "", /^migrations\/new\/0002\.sql:1:0: error: excluded-path .*origin\/dev doesn't have it/);
  });

  // QA round 2: the Checks job's shallow clone has no origin/dev, which switched the check off.
  it("under CI, fetches origin/dev when the clone lacks it, and fails when it can't", () => {
    const upstream = repoWith({ "migrations/old/0001.sql": "CREATE TABLE a (id bigint);" });
    gitIn(upstream, "checkout", "--quiet", "-b", "dev");
    gitIn(upstream, "add", ".");
    gitIn(upstream, "commit", "--quiet", "-m", "history");
    const clone = mkdtempSync(join(tmpdir(), "migrations-lint-clone-"));
    roots.push(clone);
    gitIn(tmpdir(), "clone", "--quiet", "--depth=1", "--no-single-branch", `file://${upstream}`, clone);
    gitIn(clone, "update-ref", "-d", "refs/remotes/origin/dev");
    mkdirSync(join(clone, "migrations/new"), { recursive: true });
    writeFileSync(join(clone, "migrations/new/0002.sql"), "CREATE TABLE b (id bigint);");
    writeFileSync(join(clone, ".squawk.toml"), 'excluded_paths = ["**"]\n');
    const files = ["migrations/old/0001.sql", "migrations/new/0002.sql"];
    // Locally the check can't run without origin/dev; under CI the lint fetches it and refuses the new file.
    assert.deepEqual(lint(clone, files, { squawk: "unused", ci: false }), []);
    const problems = lint(clone, files, { squawk: "unused", ci: true });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0] ?? "", /^migrations\/new\/0002\.sql:1:0: error: excluded-path /);
    // No remote to fetch from: a failure, never a silent pass.
    const orphan = repoWith({ "migrations/0003.sql": "CREATE TABLE c (id bigint);" });
    writeFileSync(join(orphan, ".squawk.toml"), 'excluded_paths = ["**"]\n');
    assert.throws(() => lint(orphan, ["migrations/0003.sql"], { squawk: "unused", ci: true }), /origin\/dev isn't in this clone/);
  });

  // QA round 3 nit: `--depth=1` on a full clone made it shallow, which breaks later history reads.
  it("under CI, fetches origin/dev without --depth into a clone that isn't shallow", () => {
    const upstream = repoWith({ "migrations/old/0001.sql": "CREATE TABLE a (id bigint);" });
    gitIn(upstream, "checkout", "--quiet", "-b", "dev");
    gitIn(upstream, "add", ".");
    gitIn(upstream, "commit", "--quiet", "-m", "history");
    const clone = mkdtempSync(join(tmpdir(), "migrations-lint-full-"));
    roots.push(clone);
    gitIn(tmpdir(), "clone", "--quiet", `file://${upstream}`, clone);
    gitIn(clone, "update-ref", "-d", "refs/remotes/origin/dev");
    writeFileSync(join(clone, ".squawk.toml"), 'excluded_paths = ["migrations/old/**"]\n');
    assert.deepEqual(lint(clone, ["migrations/old/0001.sql"], { squawk: "unused", ci: true }), []);
    assert.equal(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: clone, encoding: "utf8" }).trim(), "false");
  });

  // QA round 3 nit: excluded_paths is for history; a file dev has but this branch edited is new SQL.
  it("refuses an excluded_paths entry that skips a file changed since origin/dev", () => {
    const root = repoWith({ "migrations/old/0001.sql": "CREATE TABLE a (id bigint);" });
    gitIn(root, "add", ".");
    gitIn(root, "commit", "--quiet", "-m", "history");
    gitIn(root, "update-ref", "refs/remotes/origin/dev", "HEAD");
    writeFileSync(join(root, ".squawk.toml"), 'excluded_paths = ["migrations/old/**"]\n');
    assert.deepEqual(lint(root, ["migrations/old/0001.sql"], { squawk: "unused" }), []);
    writeFileSync(join(root, "migrations/old/0001.sql"), "CREATE TABLE a (id bigint);\nDELETE FROM a;\n");
    const problems = lint(root, ["migrations/old/0001.sql"], { squawk: "unused" });
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0] ?? "", /^migrations\/old\/0001\.sql:1:0: error: excluded-path .*differs from origin\/dev/);
  });

  // QA round 3 nit: `pnpm exec squawk *` also allowed `squawk upload-to-github`, which posts to GitHub.
  // [harness]
  // Agent permissions and the edit hook's claim: harness-only, so `pnpm harness:eject` drops both tests.
  it("allows no squawk command line beyond --version without a prompt", () => {
    const pack = JSON.parse(readFileSync(join(REPO, "stacks/sql-migrations/pack.json"), "utf8"));
    const settings = JSON.parse(readFileSync(join(REPO, ".claude/settings.json"), "utf8"));
    for (const entry of [...pack.claudeSettings.allow, ...settings.permissions.allow].filter((each) => /squawk/.test(each))) {
      assert.ok(!entry.includes("*"), entry);
    }
    assert.ok(settings.permissions.allow.includes("Bash(pnpm exec squawk --version)"));
  });

  // QA round 3 nit: the edit hook claims what the lint reads: .pgsql too.
  it("claims every extension the lint reads", () => {
    const pack = JSON.parse(readFileSync(join(REPO, "stacks/sql-migrations/pack.json"), "utf8"));
    assert.deepEqual(pack.editCheck.extensions.toSorted((a, b) => a.localeCompare(b)), [".pgsql", ".sql"]);
  });
  // [/harness]

  it("without squawk, the atomic and data-loss checks still run, plus one line saying so", () => {
    const root = repoWith({ "migrations/1.sql": "CREATE TABLE a (id bigint);\nDELETE FROM a;\n" });
    const problems = lint(root, ["migrations/1.sql"], { squawk: "" });
    assert.deepEqual(problems.map((line) => /error: ([\w-]+)/.exec(line)?.[1] ?? line), ["atomic-migration", "data-loss-marker", NO_SQUAWK]);
  });

  it("CLI: no migrations is a pass that says so; a missing squawk is a failure, not a pass", () => {
    // PATH without any squawk (`pnpm` puts node_modules/.bin on it), but with git.
    const PATH = (process.env.PATH ?? "").split(delimiter).filter((dir) => !existsSync(join(dir, "squawk"))).join(delimiter);
    const empty = repoWith({});
    const none = spawnSync(process.execPath, [LINT], { cwd: empty, encoding: "utf8", env: { ...process.env, PATH } });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no migration files/);
    const some = repoWith({ "migrations/0001.sql": "CREATE TABLE a (id bigint);" });
    const missing = spawnSync(process.execPath, [LINT], { cwd: some, encoding: "utf8", env: { ...process.env, PATH } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /squawk is not installed/);
    // The edit hook still reports the atomic check before `pnpm install`.
    const two = repoWith({ "migrations/0002.sql": "CREATE TABLE a (id bigint);\nCREATE TABLE b (id bigint);" });
    const edited = spawnSync(process.execPath, [LINT, "migrations/0002.sql"], { cwd: two, encoding: "utf8", env: { ...process.env, PATH } });
    assert.equal(edited.status, 0);
    assert.match(edited.stdout, /atomic-migration[\s\S]*squawk is not installed/);
  });
});

describe("ciHeavy", () => {
  it("a migration anywhere wakes the heavy tier (e2e applies it); a doc named migrations doesn't", () => {
    const patterns = packPatterns(REPO);
    assert.equal(classify(["db/migrations/0001_tag.sql"], patterns), true);
    assert.equal(classify(["migrations/0001_tag.sql"], patterns), true);
    assert.equal(classify(["docs/migrations.md"], patterns), false);
  });
});

describe("squawk on the fixtures", () => {
  // squawk comes from `pnpm install`; without it, say so (and fail under CI, where it is always installed).
  if (!existsSync(SQUAWK)) {
    if (UNDER_CI) {
      it("needs squawk under CI", () => assert.fail(`no squawk at ${SQUAWK}: did pnpm install run?`));
      return;
    }
    process.stderr.write(`\n⚠ SKIPPED squawk fixture tests in stacks/sql-migrations/lint.test.mjs: no ${SQUAWK}. Run pnpm install.\n\n`);
    it("needs squawk", { skip: "squawk not installed" }, () => {});
    return;
  }

  it("a plain CREATE INDEX on an existing table fails the lint (red on purpose)", () => {
    const root = repoWith({ "db/migrations/0002_note_title_idx.sql": fixture("nonconcurrent-index.sql") });
    const problems = lint(root, ["db/migrations/0002_note_title_idx.sql"], { squawk: SQUAWK });
    assert.ok(problems.some((line) => line.includes("require-concurrent-index-creation")), problems.join("\n"));
  });

  it("squawk reads only the Up section, and finds migrations by any-case dir and extension", () => {
    const down = "-- migrate:up\nSET lock_timeout = '5s';\nCREATE TABLE IF NOT EXISTS a (id bigint);\n-- migrate:down\nDROP TABLE a;\n";
    const files = { "db/migrations/0001_a.sql": down, "db/MIGRATIONS/0002_idx.SQL": fixture("nonconcurrent-index.sql") };
    const root = repoWith(files);
    const problems = lint(root, Object.keys(files), { squawk: SQUAWK });
    assert.ok(!problems.some((line) => line.startsWith("db/migrations/0001_a.sql")), problems.join("\n"));
    assert.ok(problems.some((line) => line.startsWith("db/MIGRATIONS/0002_idx.SQL") && line.includes("require-concurrent-index-creation")), problems.join("\n"));
    // The same file without its section markers: squawk sees the DROP, so the test can tell.
    const flat = repoWith({ "db/migrations/0001_a.sql": down.replace(/-- migrate:(up|down)\n/g, "") });
    assert.ok(lint(flat, ["db/migrations/0001_a.sql"], { squawk: SQUAWK }).length > 0);
  });

  it("the kill-partway fixtures pass: atomic, lock_timeout set, constraints NOT VALID", () => {
    const files = { "db/migrations/0001_note.sql": fixture("kill-partway/0001_note.sql"), "db/migrations/0002_tag.sql": fixture("kill-partway/0002_tag.sql"), "db/migrations/0003_note_slug.sql": fixture("kill-partway/0003_note_slug.sql") };
    const root = repoWith(files);
    assert.deepEqual(lint(root, Object.keys(files), { squawk: SQUAWK }), []);
  });
});
