/*
  Fault injection (tier 2, testing.mdc) for migrations: killed or failing partway, a migration leaves the old schema or the new one, never one between.
  In the app: nothing at runtime; runs in `pnpm test:harness` (so `pnpm check` and CI) while the sql-migrations pack is installed.
  Used by: node:test (`node --test`), with node:assert.
  Uses: a throwaway Postgres cluster on 127.0.0.1 (initdb, postgres, psql); fixtures/kill-partway/*.sql; lint.mjs → splitStatements.

  Each fixture migration is fed to psql one statement at a time, with an \echo marker after each, so
  the test knows exactly which statements have run when it strikes; it strikes after every one.
  Fault kinds: the runner killed (a cancelled deploy), the connection dropped, the server crashing
  (an immediate shutdown, so the restart runs crash recovery), and a statement failing (a backfill
  that collides with existing rows). After each, the schema and every row must match a reference
  database built at the old migration or the new one. Each kind also runs the same migration with
  its BEGIN/COMMIT stripped and must find a state between the two: proof the test can see one, so it
  goes red the day a migration stops being atomic.

  The far side here is a real Postgres, not a model: what is under test is Postgres's own
  transactional DDL and crash recovery, and a model of those would only test the model.

  Postgres server binaries come from PG_BIN, PATH, or the usual install dirs. Without them the
  test skips and says so on stderr; under CI it fails instead, so a runner without Postgres can't
  pass by skipping. It only ever touches the cluster it created: its own temp dir, 127.0.0.1, a
  free port, deleted after (also when it fails to start), with every PG* variable removed from
  the environment so none can redirect a client. Run as root (a container), it runs the server as PG_TEST_USER or
  `postgres`, since Postgres refuses root.
*/
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { splitStatements } from "./lint.mjs";

// The fixture migrations: 0001 makes a table with rows, 0002 is killed partway, 0003 fails partway.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kill-partway");
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

// Knob: how long the server gets to start or recover, and any one query to finish.
const READY_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 20_000;

// Under CI a missing Postgres fails the run; locally it skips loudly.
const UNDER_CI = !["", "0", "false"].includes(String(process.env.CI ?? "").toLowerCase());

// Version-named subdirectories of `parent` holding `bin`, newest first; none when `parent` doesn't exist.
const versions = (parent, pattern, bin = "bin") => {
  try {
    return readdirSync(parent)
      .filter((name) => pattern.test(name))
      .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(parent, name, bin));
  } catch {
    return [];
  }
};

// Directories that may hold initdb + postgres, most specific first; the newest version wins in each
// family. PG_BIN, when set, is the only one: an explicit choice never falls back to another install.
const candidateBinDirs = () =>
  process.env.PG_BIN !== undefined && process.env.PG_BIN !== "" ? [process.env.PG_BIN] : [
    ...(process.env.PATH ?? "").split(delimiter),
    ...versions("/usr/lib/postgresql", /^\d+$/),
    ...versions("/opt/homebrew/opt", /^postgresql(@\d+)?$/),
    ...versions("/usr/local/opt", /^postgresql(@\d+)?$/),
    "/Applications/Postgres.app/Contents/Versions/latest/bin",
    "/usr/local/pgsql/bin",
  ].filter((dir) => dir !== "");

// Where the server binaries and psql are, and who runs the server; or why there's no Postgres to use.
const findPostgres = () => {
  const bin = candidateBinDirs().find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")));
  if (bin === undefined) return { why: `no Postgres server binaries (initdb, postgres) in ${process.env.PG_BIN ? `PG_BIN=${process.env.PG_BIN}` : "PATH, /usr/lib/postgresql/*/bin, or Homebrew"}. Install them (apt install postgresql, brew install postgresql@17) or set PG_BIN.` };
  const psql = existsSync(join(bin, "psql")) ? join(bin, "psql") : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "psql")).find((path) => existsSync(path));
  if (psql === undefined) return { why: `found ${bin} but no psql` };
  // Postgres won't run as root; a container running tests as root lends the server to another user.
  if (process.getuid?.() !== 0) return { bin, psql, owner: {} };
  const user = process.env.PG_TEST_USER ?? "postgres";
  const uid = Number(spawnSync("id", ["-u", user], { encoding: "utf8" }).stdout.trim());
  const gid = Number(spawnSync("id", ["-g", user], { encoding: "utf8" }).stdout.trim());
  if (!Number.isInteger(uid) || uid <= 0) return { why: `running as root, and there's no user '${user}' to run the server as (set PG_TEST_USER)` };
  return { bin, psql, owner: { uid, gid } };
};

// A TCP port nothing is listening on right now, on 127.0.0.1.
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

// The environment every Postgres binary here runs with: this process's, minus every PG* variable.
// libpq reads them over the command line (PGHOSTADDR beats -h, PGSERVICE pulls a host from a file,
// PGDATABASE/PGUSER pick another target), so one left in a developer's shell could send the
// destructive strikes to a real database.
const clusterEnv = (base) => ({
  ...Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("PG"))),
  // A query never waits forever on a lock a dying session still holds.
  PGOPTIONS: `-c statement_timeout=${QUERY_TIMEOUT_MS}`,
  PGCONNECT_TIMEOUT: "5",
});

// One throwaway cluster: start, crash, restart, query, and remove it. `serverArgs` add server
// settings (the cleanup test passes a bad one). A cluster that fails to start is stopped and its
// temp dir removed before the error (which carries `root`) is rethrown.
const cluster = async ({ bin, psql, owner }, serverArgs = []) => {
  const root = mkdtempSync(join(tmpdir(), "migrations-kill-partway-"));
  const data = join(root, "data");
  const env = clusterEnv(process.env);
  let server = null;
  let log = "";
  // Stops the server with `signal` and waits for it: SIGQUIT is an immediate shutdown (a crash), SIGINT
  // a clean one. A server that ignores it is killed after READY_TIMEOUT_MS, so nothing waits forever.
  const stop = async (signal) => {
    const running = server;
    if (running === null || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill(signal);
    const timer = setTimeout(() => running.kill("SIGKILL"), READY_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };
  try {
    // The server user must own its directory.
    if (owner.uid !== undefined) chownSync(root, owner.uid, owner.gid);
    const init = spawnSync(join(bin, "initdb"), ["-D", data, "--auth=trust", "-U", "postgres", "--no-sync", "-E", "UTF8", "--locale=C"], { ...owner, env, encoding: "utf8" });
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { root });
  }
  const port = String(await freePort());
  // Loopback TCP only, no socket file; fsync off is safe because a "crash" here is the server's, not the machine's.
  const args = ["-D", data, "-p", port, "-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=", "-c", "fsync=off", ...serverArgs];
  // psql's connection flags for one database; every client goes to 127.0.0.1 only.
  const connect = (db) => ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", port, "-U", "postgres", "-d", db];
  // Runs SQL in `db` and returns its output; throws with psql's error when it fails.
  const query = (db, sql) => {
    const result = spawnSync(psql, [...connect(db), "-c", sql], { encoding: "utf8", env, timeout: QUERY_TIMEOUT_MS * 2 });
    if (result.status !== 0) throw new Error(`psql failed in ${db}: ${result.stderr}${result.error?.message ?? ""}`);
    return result.stdout.trim();
  };
  // Starts the server and waits until it answers (after a crash, that includes recovery).
  const start = async () => {
    server = spawn(join(bin, "postgres"), args, { ...owner, env, stdio: ["ignore", "ignore", "pipe"] });
    server.stderr.on("data", (chunk) => (log = `${log}${String(chunk)}`.slice(-4000)));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (spawnSync(psql, [...connect("postgres"), "-c", "SELECT 1"], { env, encoding: "utf8" }).status === 0) return;
      if (server.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`postgres didn't start:\n${log}`);
  };
  // A server that doesn't come up is stopped and its directory removed, so a failed run leaves nothing behind.
  try {
    await start();
  } catch (error) {
    await stop("SIGQUIT");
    rmSync(root, { recursive: true, force: true });
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { root });
  }
  return {
    connect,
    env,
    psql,
    query,
    start,
    crash: () => stop("SIGQUIT"),
    remove: async () => {
      await stop("SIGINT");
      rmSync(root, { recursive: true, force: true });
    },
  };
};

// A database's schema and rows as one sorted text: tables, columns, constraints (and whether
// validated), indexes (and whether valid), then every row of every table. Two databases with the
// same fingerprint are the same as far as a deploy can tell.
const fingerprint = (pg, db) => {
  const schema = pg.query(
    db,
    `SELECT coalesce(string_agg(item, E'\\n' ORDER BY item), '') FROM (
      SELECT format('table %s %s', c.relkind, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      UNION ALL SELECT format('column %s.%s %s notnull=%s default=%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL SELECT format('constraint %s %s %s validated=%s', conrelid::regclass, conname, pg_get_constraintdef(oid), convalidated) FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION ALL SELECT format('index %s valid=%s %s', i.indexrelid::regclass, i.indisvalid, pg_get_indexdef(i.indexrelid))
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
    ) AS s(item)`,
  );
  const tables = pg.query(db, `SELECT coalesce(string_agg(quote_ident(relname), ' ' ORDER BY relname), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  const rows = tables === "" ? "" : pg.query(db, tables.split(" ").map((table) => `SELECT ${literal(table)} || ': ' || coalesce((SELECT string_agg(t::text, ' | ' ORDER BY t::text) FROM ${table} t), '')`).join(" UNION ALL "));
  return `${schema}\n${rows}`;
};

// A SQL string literal.
const literal = (text) => `'${text.replaceAll("'", "''")}'`;

// Makes a fresh database holding the base fixture (0001), the state every migration starts from.
const freshDatabase = (pg, name) => {
  pg.query("postgres", `CREATE DATABASE ${name}`);
  runFile(pg, name, fixture("0001_note.sql"));
};

// Runs a whole migration through psql's stdin, as a deploy would; returns psql's exit status.
const runFile = (pg, db, sql) => spawnSync(pg.psql, pg.connect(db), { input: sql, encoding: "utf8", env: pg.env }).status;

// Feeds `statements` to one psql session, one at a time, and resolves once the first `count` have
// run (or psql exits first, as it does on an error): { session, ran, exited }. The next statement
// is only written after the last one's marker comes back, so nothing beyond `count` has been read.
const runStatements = (pg, db, statements, count) =>
  new Promise((resolve, reject) => {
    const session = spawn(pg.psql, pg.connect(db), { env: pg.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let sent = 0;
    // Writes the next statement and the marker psql prints once that statement has finished.
    const send = () => {
      session.stdin.write(`${statements[sent]?.text ?? ""}\n\\echo __ran_${sent}__\n`);
      sent += 1;
    };
    session.once("error", reject);
    // Exited before reaching `count` (an error with ON_ERROR_STOP): report how far it got.
    session.once("exit", (code) => resolve({ session, ran: sent - 1, exited: code }));
    // Starts with the backend pid, for the "connection dropped" fault.
    session.stdin.write("SELECT 'pid:' || pg_backend_pid();\n");
    session.stdout.on("data", (chunk) => {
      output += String(chunk);
      // Each marker back means one more statement ran; stop feeding at `count`.
      const ran = output.match(/__ran_\d+__/g)?.length ?? 0;
      if (ran >= count) {
        session.removeAllListeners("exit");
        resolve({ session, ran, exited: null, pid: /pid:(\d+)/.exec(output)?.[1] ?? "" });
      } else if (ran === sent && sent < statements.length) send();
    });
    send();
  });

// Waits for a child process to be gone.
const gone = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)));

// The faults, each struck after some statements have run and before the next is sent.
const FAULTS = {
  // A cancelled deploy: the migration runner is killed outright.
  "runner killed": async (_pg, run) => {
    run.session.kill("SIGKILL");
    await gone(run.session);
  },
  // The network or the database ends the session (a failover, an idle timeout, pg_terminate_backend).
  "connection dropped": async (pg, run) => {
    pg.query("postgres", `SELECT pg_terminate_backend(${run.pid})`);
    run.session.stdin.end();
    await gone(run.session);
  },
  // The database server dies mid-migration: an immediate shutdown, then a restart that runs crash recovery.
  "server crash": async (pg, run) => {
    await pg.crash();
    run.session.kill("SIGKILL");
    await gone(run.session);
    await pg.start();
  },
};

// The migration without its own transaction: what it would be if its runner didn't wrap it.
const withoutTransaction = (statements) => statements.filter((statement) => !/^(begin|commit)\b/i.test(statement.code));

const postgres = findPostgres();

describe("the throwaway cluster's environment", () => {
  it("drops every PG* variable, so nothing but -h 127.0.0.1 picks the server", () => {
    const env = clusterEnv({ PATH: "/bin", PGHOSTADDR: "10.1.2.3", PGSERVICE: "prod", PGHOST: "db.example.com", PGDATABASE: "app", PGPASSWORD: "x", PGOPTIONS: "-c x=1" });
    assert.deepEqual(Object.keys(env).toSorted(), ["PATH", "PGCONNECT_TIMEOUT", "PGOPTIONS"]);
    assert.equal(env.PGOPTIONS, `-c statement_timeout=${QUERY_TIMEOUT_MS}`);
  });
});

describe("migrations killed partway (tier 2, loopback Postgres)", { timeout: 300_000 }, () => {
  // No Postgres: say so loudly, and under CI turn the skip into a failure.
  if (postgres.why !== undefined) {
    if (UNDER_CI) {
      it("needs Postgres server binaries under CI", () => assert.fail(`kill-partway: ${postgres.why}`));
      return;
    }
    process.stderr.write(`\n⚠ SKIPPED stacks/sql-migrations/kill-partway.test.mjs: ${postgres.why}\n  The migration fault tests did not run; CI runs them.\n\n`);
    it("needs Postgres server binaries", { skip: postgres.why }, () => {});
    return;
  }

  let pg = null;
  // The two acceptable end states for 0002: before it ran, and after it committed.
  let old = "";
  let next = "";
  // Databases are named per test, so every strike starts from a fresh copy.
  let databases = 0;
  const fresh = () => {
    databases += 1;
    const name = `strike_${databases}`;
    freshDatabase(pg, name);
    return name;
  };

  before(async () => {
    pg = await cluster(postgres);
    const before0002 = fresh();
    old = fingerprint(pg, before0002);
    const after0002 = fresh();
    assert.equal(runFile(pg, after0002, fixture("0002_tag.sql")), 0, "0002 applies cleanly when nothing interrupts it");
    next = fingerprint(pg, after0002);
    // The references must differ, or "old or new" would accept anything.
    assert.notEqual(old, next);
  });

  after(async () => {
    await pg?.remove();
  });

  const statements = splitStatements(fixture("0002_tag.sql"));

  for (const [kind, strike] of Object.entries(FAULTS)) {
    it(`${kind}: after any statement of 0002, the database is at the old schema or the new one`, async () => {
      const seen = new Set();
      // Strike after statement 1, 2, … and after the last (COMMIT), which must land on the new state.
      for (let count = 1; count <= statements.length; count += 1) {
        const db = fresh();
        const run = await runStatements(pg, db, statements, count);
        assert.equal(run.exited, null, `0002 stopped by itself after ${run.ran} statement(s)`);
        await strike(pg, run);
        const state = fingerprint(pg, db);
        assert.ok(state === old || state === next, `${kind} after statement ${count} (${statements[count - 1]?.code.split("\n")[0]}): the database is between schemas:\n${state}`);
        seen.add(state === old ? "old" : "new");
      }
      // Struck before COMMIT it rolled back; after COMMIT it held.
      assert.deepEqual([...seen].toSorted((a, b) => a.localeCompare(b)), ["new", "old"]);
    });

    it(`${kind}: the same migration without BEGIN/COMMIT is caught between schemas`, async () => {
      const bare = withoutTransaction(statements);
      let between = 0;
      for (let count = 1; count < bare.length; count += 1) {
        const db = fresh();
        const run = await runStatements(pg, db, bare, count);
        await strike(pg, run);
        const state = fingerprint(pg, db);
        if (state !== old && state !== next) between += 1;
      }
      assert.ok(between > 0, "no strike found a state between: the test can't tell an atomic migration from one that isn't");
    });
  }

  it("a cluster that fails to start is stopped and removed, and the error says so", async () => {
    // A setting postgres refuses makes the server exit at once, as a bad install would.
    const failed = await cluster(postgres, ["-c", "no_such_setting_for_this_test=1"]).then(
      () => null,
      (error) => error,
    );
    assert.ok(failed instanceof Error, "the cluster started with a bad setting");
    assert.match(failed.message, /postgres didn't start/);
    assert.equal(existsSync(failed.root), false, `left ${String(failed.root)} behind`);
  });

  it("statement fails: 0003's backfill collides with existing rows, and the database stays at the old schema", () => {
    const db = fresh();
    const status = runFile(pg, db, fixture("0003_note_slug.sql"));
    assert.notEqual(status, 0, "0003 is meant to fail on the rows 0001 wrote");
    assert.equal(fingerprint(pg, db), old);
  });

  it("statement fails: without BEGIN/COMMIT, 0003 leaves its new table behind", () => {
    const db = fresh();
    const bare = withoutTransaction(splitStatements(fixture("0003_note_slug.sql")))
      .map((statement) => statement.text)
      .join("\n");
    assert.notEqual(runFile(pg, db, bare), 0);
    assert.notEqual(fingerprint(pg, db), old);
  });
});
