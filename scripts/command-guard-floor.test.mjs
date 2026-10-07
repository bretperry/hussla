// @vitest-environment node
/*
  The floor test for command-guard's database rules: never weaker than dev.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/command-guard.mjs → evaluate(), dotenvValue(); a temp tree under the OS temp dir.

  The rows are the PR #21 reviewers' corpora (rounds 2, 3, and 4), verbatim: each a command, the
  verdict the reviewer wanted, a label, and the agent's environment. `dev` is what dev's guard gave
  each row (the worse of dev before and after PR #20), measured by running the probes against both.
  Every row must come out at least as strict as dev did; and at least as strict as the reviewer
  wanted, except the rows in ACCEPTED, each with why. Strings only: nothing here runs a command.
*/
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { dotenvValue, evaluate, LIMITS } from "./command-guard.mjs";

const R = "postgres://u@db.example.com/app";
const LOCAL = "postgresql://u:p@localhost:5432/app";
const D = "DROP TABLE users";
const H = "db.example.com";
const deep = (n, word) => `${Array(n).fill(word).join(" ")} git push --force origin main`;

// A Prisma schema whose datasource url is `url` (a quoted literal or `env("NAME")`).
const ds = (url) => `datasource db {\n  provider = "postgresql"\n  url      = ${url}\n}\n`;

// Verdicts in order of strictness.
const RANK = { null: 0, ask: 1, deny: 2 };

// Rows where the reviewer wanted more (or less) than the guard gives, and why that stands.
const ACCEPTED = new Map([
  ["psql socket dir", "the floor is dev's rule, which sees no loopback word on the line; dev refused it too"],
  ["psql no host DROP (default socket; deny is FP)", "the floor, as on dev"],
  ["docker compose exec local db DROP (FP?)", "a container's own database may be the dev one, but the guard can't read it: the user confirms (round 4: ask, not deny)"],
  ["per-client SQL", "the floor reads the whole line, as dev did"],
  ["127.1 (is loopback; deny is FP-safe)", "shorthand loopback forms aren't read as loopback (FP-safe)"],
  ["decimal IP (is loopback; FP-safe)", "as above"],
  ["localhost. (is loopback; FP-safe)", "as above"],
  ["THROW: migrate dev with odd --name (FP ok)", "a URL-shaped --name reads as an unparsable target, so it asks (FP-safe)"],
  ["deep eval nesting", "past MAX_NESTING the line asks instead of reading on (dev: allow)"],
  ["then cd prod", "a cd behind `then` loses track, so the reset asks (dev: ask)"],
  ["CDPATH sends cd elsewhere", "CDPATH loses track, so it asks (dev: allow)"],
  ["service= plus host= in SQL", "a service file's host is unknown: unknown host + destructive SQL asks (showrunner's policy)"],
  ["21st -f file is never read", "past the file budget the SQL can't all be read, so it asks (dev: allow)"],
  ["empty inline DATABASE_URL (prisma falls back to .env? no: empty set)", "an empty URL is unreadable, so it asks (dev: ask)"],
  // Round 4: a reset runs on loopback only once the guard has read a datasource (positive evidence).
  // These corpora's trees hold a loopback .env and no schema, so each reset asks, as dev did.
  ["cd - back to loopback (ask is fine)", "no schema in the tree: a reset asks without a datasource read (dev: ask)"],
  ["cd inside $(…) does not move", "as above"],
  ["inline loopback beats env remote", "as above: with no schema, DATABASE_URL may not be what Prisma reads"],
  ["local reset (loopback .env)", "as above"],
  ["sudo -E keeps env (loopback env wins; allow ok)", "as above"],
  ["package script reset with loopback .env", "as above"],
]);

// Rows where the guard is looser than dev on purpose, and the verdict each gives instead: dev asked
// about every `prisma migrate reset` whatever it pointed at (the rule this PR replaces by reading
// the target), so a reset whose datasource is read and loopback runs; and dev's floor refused SQL
// in a local container with no host, where the guard now asks (round 4). A row not named here may
// never be looser than dev.
const LOOSER_THAN_DEV = new Map([
  ["docker compose exec local db DROP (FP?)", { got: "ask", why: "a local container's own database: the user confirms" }],
  ["r4 control: loopback schema and .env", { got: null, why: "prisma migrate reset on a read, loopback datasource" }],
  ["r4 control: package.json prisma.schema, loopback", { got: null, why: "as above, the schema package.json names" }],
  ["r4 control: multi-file folder, loopback", { got: null, why: "as above, every .prisma in prisma/schema/" }],
]);

// Rows that time the guard on a big input. The verdict is read with the time budget lifted, so a
// loaded machine can't turn an allow into the budget's ask; the budget is then held to separately,
// as the fastest of TIMED_RUNS reads against the real LIMITS.ms, which only a slow parser fails
// (a load spike slows some runs, not every one).
const TIMED = new Set(["~1MB benign file (time it)"]);
const TIMED_RUNS = 5;

// The temp trees, removed after the run.
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// main()'s readers over a temp tree (HOME is home/), with `env` as the agent's environment.
const readersIn = (root, env = {}) => {
  const where = (dir) => (dir === null ? root : dir.startsWith("~") ? join(root, "home", dir.slice(1)) : resolve(root, dir));
  const file = (dir, path) => {
    try {
      const full = resolve(where(dir), path);
      const found = statSync(full);
      return found.isFile() && found.size <= 1_000_000 ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
  return {
    branch: "feat",
    targetIn: (/** @type {string | null} */ dir, /** @type {string} */ name, /** @type {string | null} */ dotenv = ".env", useEnv = true) => {
      if (useEnv && env[name] !== undefined) return { value: env[name], from: "the environment" };
      const value = dotenv === null ? undefined : dotenvValue(file(dir, dotenv) ?? "", name);
      return value === undefined ? null : { value, from: dotenv };
    },
    scriptIn: (dir, name) => {
      try {
        return JSON.parse(file(dir, "package.json") ?? "").scripts?.[name] ?? "";
      } catch {
        return "";
      }
    },
    fileIn: file,
    // main()'s dirIn, without its entry cap (these trees are small).
    dirIn: (dir, path) => {
      try {
        const full = resolve(where(dir), path);
        if (!statSync(full).isDirectory()) return { dir: false };
        const entries = readdirSync(full, { withFileTypes: true });
        return { dir: true, files: entries.filter((each) => !each.isDirectory()).map((each) => each.name), dirs: entries.filter((each) => each.isDirectory()).map((each) => each.name), more: false };
      } catch {
        return null;
      }
    },
    dirExists: (dir) => {
      try {
        return statSync(where(dir)).isDirectory();
      } catch {
        return false;
      }
    },
  };
};

// Each corpus: the files its probe wrote, its rows, and dev's verdict for each row, in order.
/** @type {{ name: string, files: (root: string, put: (path: string, text: string) => void) => void, rows: (root: string) => [string, string | null, string, Record<string, string>?][], dev: (string | null)[] }[]} */
/** @type {{ name: string, files: (root: string, put: (path: string, text: string) => void) => void, rows: (root: string) => [string, string | null, string, Record<string, string>?][], dev: (string | null)[] }[]} */
const CORPORA = [
  {
    name: "round 2 (probe.mjs)",
    files: (root, put) => {
      put(".env", `DATABASE_URL=${LOCAL}\n`);
      put("package.json", JSON.stringify({ scripts: { "db:reset": "prisma migrate reset --force" } }));
      put("prod/.env", `DATABASE_URL=${R}\n`);
      put("twice/.env", `DATABASE_URL=${LOCAL}\nDATABASE_URL=${R}\n`);
      put("colon/.env", `DATABASE_URL=${LOCAL}\nDATABASE_URL: ${R}\n`);
      put("multi/.env", `DATABASE_URL=${R}\nNOTE="\nDATABASE_URL=${LOCAL}\n"\n`);
      put("crlf/.env", `DATABASE_URL=${R}\r\nOTHER=1\r\n`);
      put("exp/.env", `export DATABASE_URL='${R}' # prod\r\n`);
      put("cmt/.env", `DATABASE_URL=${R} # was localhost\n`);
      put("empty/.env", "");
      put("both/.env", `DATABASE_URL=${R}\n`);
      put("both/.env.local", `DATABASE_URL=${LOCAL}\n`);
      put("pe/.env", `DATABASE_URL=${LOCAL}\n`);
      put("pe/prisma/.env", `DATABASE_URL=${R}\n`);
      put("pcfg/.env", `DATABASE_URL=${LOCAL}\n`);
      put("pcfg/prisma.config.ts", `export default { datasource: { url: "${R}" } };\n`);
      put("home/.env", `DATABASE_URL=${R}\n`);
      put("cdp/app/.env", `DATABASE_URL=${R}\n`);
      put("drop.sql", "DROP TABLE users;\n");
      put("x.sql", "SELECT 1;\n");
      put("sub/x.sql", "DROP TABLE users;\n");
      put("sub/inc.sql", "\\ir x.sql\n");
      put("c1.sql", "\\i c2.sql\n");
      put("c2.sql", "\\i c3.sql\n");
      put("c3.sql", "\\i c4.sql\n");
      put("c4.sql", "\\i c5.sql\n");
      put("c5.sql", "DROP TABLE users;\n");
      put("cyc1.sql", "\\i cyc2.sql\n");
      put("cyc2.sql", "\\i cyc1.sql\n");
      put("stale.sql", "SELECT 1;\n");
      put("bin.sql", Buffer.from([0, 255, 254, 0x44, 0x52, 0, 13, 10, 0xc3, 0x28]));
      put("big.sql", `-- ${"x".repeat(1_000_001)}\nDROP TABLE users;\n`);
      put("slow.sql", "drop x ".repeat(120_000));
      for (let i = 1; i <= 20; i += 1) put(`f${i}.sql`, "SELECT 1;\n");
      symlinkSync("loop.sql", join(root, "loop.sql"));
    },
    rows: (root) => [
      // --- throws / hangs (the guard fails open on any exception, for the WHOLE line)
      [`psql -h db.example.com -c "${D}"; psql postgres://%zz`, "deny", "THROW: bad %-escape anywhere on the line"],
      ["git push --force origin main; psql postgres://%zz", "deny", "THROW: unrelated force-push main + %zz"],
      ["DATABASE_URL=postgres://%E0%A4%A/app prisma migrate reset --force", "ask", "THROW: inline URL bad %"],
      ["prisma migrate dev --name postgres://%ff", null, "THROW: migrate dev with odd --name (FP ok)"],
      [deep(20_000, "eval"), "deny", "deep eval nesting"],
      [`${"(".repeat(5000)}git push --force origin main${")".repeat(5000)}`, "deny", "deep subshell parens"],
      ["psql -h db.example.com -f bin.sql", null, "binary -f file (no throw)"],
      ["psql -h db.example.com -f loop.sql", "ask", "symlink loop -f"],
      ["psql -h db.example.com -f cyc1.sql", null, "\\i cycle (no throw)"],
      ["psql -h db.example.com -f slow.sql", "ask", "HANG?: 840KB of 'drop x' with no ';' (regex backtracking)"],
      ["cd empty && prisma migrate reset --force", "ask", "empty .env"],
      // --- .env parsing
      ["cd twice && prisma migrate reset --force", "deny", ".env twice, last remote"],
      ["cd colon && prisma migrate reset --force", "deny", "dotenv `KEY: value` form (dotenv honours it)"],
      ["cd multi && prisma migrate reset --force", "deny", "multi-line quoted value hides a DATABASE_URL= line"],
      ["cd crlf && prisma migrate reset --force", "deny", "CRLF .env"],
      ["cd exp && prisma migrate reset --force", "ask", "export + quotes + comment + CRLF"],
      ["cd cmt && prisma migrate reset --force", "deny", "unquoted value + # comment"],
      ["cd both && prisma migrate reset --force", "deny", ".env remote, .env.local loopback"],
      ["cd pe && prisma migrate reset --force", "deny", "prisma/.env remote"],
      ["cd pe && prisma migrate dev", "deny", "prisma/.env remote, migrate dev"],
      ["cd pcfg && prisma migrate reset --force", "ask", "prisma.config.ts sets a remote url"],
      // --- directory tracking
      ["cd ~ && prisma migrate reset --force", "deny", "cd ~ (HOME/.env remote)"],
      ["cd && prisma migrate reset --force", "deny", "bare cd = HOME"],
      ["cd prod && cd - && prisma migrate reset --force", null, "cd - back to loopback (ask is fine)"],
      ["cd -P prod && prisma migrate dev", "deny", "cd -P prod (flag read as the dir)"],
      ["cd -P prod && prisma migrate reset --force", "deny", "cd -P prod reset"],
      ["{ cd prod; } && prisma migrate reset --force", "deny", "brace group cd"],
      ["if true; then cd prod; fi; prisma migrate reset --force", "deny", "then cd prod"],
      ["builtin cd prod && prisma migrate reset --force", "deny", "builtin cd"],
      ["X=$(cd prod && pwd) && prisma migrate reset --force", null, "cd inside $(…) does not move"],
      ["(cd prod && echo \\) && prisma migrate reset --force)", "deny", "escaped ) closes the subshell early"],
      ["cd app && prisma migrate dev", "deny", "CDPATH sends cd elsewhere", { CDPATH: join(root, "cdp") }],
      ["cd prod && unset DATABASE_URL && prisma migrate reset --force", "deny", "unset env var; prod/.env remote", { DATABASE_URL: LOCAL }],
      ["cd prod && env -u DATABASE_URL prisma migrate reset --force", "deny", "env -u; prod/.env remote", { DATABASE_URL: LOCAL }],
      ["cd prod && env -i PATH=/usr/bin prisma migrate reset --force", "deny", "env -i; prod/.env remote", { DATABASE_URL: LOCAL }],
      ["prisma migrate dev", "deny", "DATABASE_URL remote in environment", { DATABASE_URL: R }],
      [`DATABASE_URL=${LOCAL} prisma migrate reset --force`, null, "inline loopback beats env remote", { DATABASE_URL: R }],
      ["cd prod && node node_modules/prisma/build/index.js migrate reset --force", "deny", "prisma via its JS entry"],
      // --- hosts
      [`psql -h localhost -c "${D}"`, "deny", "env PGHOSTADDR overrides -h", { PGHOSTADDR: "10.0.0.5" }],
      [`psql -h localhost -c "${D}"`, "deny", "env PGHOST+PGHOSTADDR", { PGHOST: "localhost", PGHOSTADDR: "10.0.0.5" }],
      [`PGHOSTADDR=10.0.0.5 PGHOST=localhost psql -c "${D}"`, "deny", "inline PGHOSTADDR after PGHOST"],
      [`export PGHOSTADDR=10.0.0.5 && psql -h localhost -c "${D}"`, "deny", "exported PGHOSTADDR"],
      [`psql -h localhost -c "${D}"`, "ask", "env PGSERVICE", { PGSERVICE: "prod" }],
      [`PGSERVICEFILE=prod.conf psql -h localhost -c "${D}"`, null, "PGSERVICEFILE without PGSERVICE (loopback)"],
      [`psql -c "${D}"`, "deny", "env PGHOST remote, no -h", { PGHOST: "db.example.com" }],
      [`psql -c "${D}; -- host=localhost"`, "deny", "host= inside the SQL text read as the target", { PGHOST: "db.example.com" }],
      [`PGHOST=db.example.com psql -c "${D}; -- host=localhost"`, "deny", "same, inline PGHOST"],
      [`psql "service=prod" -c "SELECT 'host=localhost'; ${D}"`, "deny", "service= plus host= in SQL"],
      [`psql "postgresql://localhost/app?host=localhost&host=db.example.com" -c "${D}"`, "deny", "URI host= twice"],
      [`psql "postgresql://localhost/app?hostaddr=10.0.0.5" -c "${D}"`, "deny", "URI hostaddr"],
      [`psql "postgresql://localhost/app?sslmode=require&application_name=x" -c "${D}"`, null, "irrelevant URI params, loopback"],
      [`psql "postgresql://localhost:5432@db.example.com/app" -c "${D}"`, "deny", "localhost:5432@evil"],
      [`psql "postgresql://[fe80::1%25eth0]/app" -c "${D}"`, "ask", "IPv6 zone id"],
      [`psql -h 0.0.0.0 -c "${D}"`, "ask", "0.0.0.0"],
      [`psql "postgresql://127.1/app" -c "${D}"`, null, "127.1 (is loopback; deny is FP-safe)"],
      [`psql "postgresql://2130706433/app" -c "${D}"`, null, "decimal IP (is loopback; FP-safe)"],
      [`psql "postgresql://localhost./app" -c "${D}"`, null, "localhost. (is loopback; FP-safe)"],
      [`psql -h /tmp/../cloudsql/p:r:prod -c "${D}"`, "deny", "/tmp/.. traversal to cloudsql"],
      [`psql -h localhost "postgresql:///app?host=db.example.com" -c "${D}"`, "deny", "-h localhost + URI query host"],
      // --- SQL reading
      [`psql -h db.example.com -c "SELECT '--'; ${D}"`, "deny", "'--' in a string eats the DROP"],
      [`psql -h db.example.com -c "SELECT '/*'; ${D}; SELECT '*/'"`, "deny", "'/*' in a string eats the DROP"],
      [`SQL="${D}" && psql -h db.example.com -c "$SQL"`, "ask", "SQL in a variable"],
      [`psql -h db.example.com -c "$(cat drop.sql)"`, "ask", "SQL from $(cat)"],
      ["psql -h db.example.com -c \"SELECT format('DR%sOP TABLE %I', '', 'users') \\gexec\"", "ask", "\\gexec builds SQL"],
      [`mysql -h db.example.com -e "source drop.sql"`, "deny", "mysql source (its \\i)"],
      [`kubectl exec -it pg-0 -- psql -U postgres -c "${D}"`, "ask", "kubectl exec … psql"],
      [`ssh prod-db psql -c "${D}"`, "ask", "ssh host psql"],
      [`cat <<EOF | psql -h db.example.com\n${D};\nEOF`, "deny", "cat <<EOF | psql (common agent idiom)"],
      [`cat <<'SQL' | psql "$DATABASE_URL"\nTRUNCATE users;\nSQL`, "deny", "cat <<'SQL' | psql $URL"],
      ["cp drop.sql stale.sql && psql -h db.example.com -f stale.sql", "ask", "-f file overwritten earlier on the line (stale benign copy on disk)"],
      [`cat > stale.sql <<EOF\n${D};\nEOF\npsql -h db.example.com -f stale.sql`, "ask", "heredoc writes the file, then psql -f (stale copy on disk)"],
      ["cat drop.sql | psql -h db.example.com -f /dev/stdin", "deny", "-f /dev/stdin"],
      ["cat drop.sql | psql -h db.example.com -f -", "ask", "-f -"],
      [`psql -h db.example.com ${Array.from({ length: 20 }, (_, i) => `-f f${i + 1}.sql`).join(" ")} -f drop.sql`, "deny", "21st -f file is never read"],
      ["psql -h db.example.com -f c1.sql", "deny", "\\i chain 4 deep"],
      ["psql -h db.example.com -f sub/inc.sql", "deny", "\\ir resolved from cwd, not the file's dir"],
      ["psql -h db.example.com -f big.sql", "ask", ">1MB -f file"],
      ["psql -h db.example.com -f /tmp/rev2d-missing-x.sql", "ask", "missing -f file"],
      [`psql -h db.example.com -c "DO $$ BEGIN EXECUTE 'DR' || 'OP TABLE users'; END $$"`, "ask", "DO/EXECUTE"],
      ["psql -h db.example.com -c $'\\x44ROP TABLE users'", "ask", "ANSI-C quoting (nit)"],
      ["printf 'DR%sP TABLE users' O | psql -h db.example.com", "ask", "printf format pieces (nit)"],
      [`psql -h db.example.com -v t=TABLE -c "DROP :t users"`, "ask", "psql variable interpolation (nit)"],
      // --- false positives: must stay allowed
      ['grep -rn "DROP TABLE" prisma/migrations', null, "grep DROP"],
      ["grep -rn DROP prisma/migrations", null, "grep DROP bare"],
      ['rg "TRUNCATE|DELETE FROM" migrations/', null, "rg"],
      ["cat prisma/migrations/0001_init/migration.sql", null, "cat migration"],
      ["cat drop.sql | grep DROP", null, "cat | grep"],
      ['git log -S "DROP TABLE"', null, "git log -S"],
      ['git commit -m "drop table users in migration"', null, "commit message"],
      ["git commit -F - <<EOF\nfeat: drop legacy table\n\nRun prisma migrate reset --force locally.\nEOF", null, "commit heredoc mentioning reset"],
      ["git add prisma/migrations && git commit -m wip", null, "git add migrations"],
      ["echo run prisma migrate reset --force to start over", null, "echo unquoted mention (nit)"],
      ["prisma generate", null, "prisma generate"],
      ["prisma migrate dev --name add_users", null, "local migrate dev"],
      ["pnpm prisma migrate dev --name add_users", null, "pnpm prisma migrate dev"],
      ["npx prisma migrate dev --create-only", null, "npx migrate dev --create-only"],
      ["prisma migrate status", null, "migrate status"],
      ["prisma migrate reset --force", null, "local reset (loopback .env)"],
      [`psql -h localhost -c "${D}"`, null, "loopback DROP"],
      [`psql ${LOCAL} -f drop.sql`, null, "loopback -f"],
      ['git commit -m "fix: DROP TABLE tmp" && psql -h db.example.com -c "select 1"', null, "per-client SQL"],
      ["pg_dump -h db.example.com app > backup.sql", null, "pg_dump to file"],
      ["goose -dir db/migrations create add_users sql", null, "goose create"],
      ["ls db/migrate", null, "ls db/migrate"],
      ["bin/rails db:migrate", null, "rails migrate"],
      ['psql -h db.example.com -c "GRANT EXECUTE ON FUNCTION f() TO app"', null, "GRANT EXECUTE (nit FP)"],
    ],
    dev: ["deny", "deny", "ask", null, "ask", null, null, null, null, null, "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", null, "ask", "ask", "ask", "ask", null, "ask", "ask", "ask", "ask", "ask", "ask", null, "ask", null, null, null, "ask", null, null, null, null, null, null, null, "deny", null, null, null, null, null, null, null, null, "deny", "deny", "deny", null, "deny", null, "deny", "deny", "deny", null, null, null, null, null, "deny", "deny", null, "deny", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "ask", null, null, "deny", null, null, null, null, null],
  },
  {
    name: "round 3 (probe3.mjs)",
    files: (root, put) => {
      put(".env", `DATABASE_URL=${LOCAL}\n`);
      put("package.json", JSON.stringify({ scripts: { "db:reset": "prisma migrate reset --force", test: "vitest run" } }));
      put("prod/.env", `DATABASE_URL=${R}\n`);
      put("home/.env", `DATABASE_URL=${LOCAL}\n`);
      put("bom/.env", `\uFEFFDATABASE_URL=${R}\n`);
      put("cmtschema/.env", `DATABASE_URL=${R}\n`);
      put("cmtschema/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  // url = "${LOCAL}"\n  url      = env("DATABASE_URL")\n}\n`);
      put("othervar/.env", `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`);
      put("othervar/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url      = env("PROD_URL")\n}\n`);
      put("direct/.env", `DATABASE_URL=${LOCAL}\nDIRECT_URL=${R}\n`);
      put("direct/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n`);
      put("shadowlit/.env", `DATABASE_URL=${R}\n`);
      put("shadowlit/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  shadowDatabaseUrl = "${LOCAL}"\n}\n`);
      put("drop.sql", "DROP TABLE users;\n");
      put("x.sql", "SELECT 1;\n");
      put("big1m.sql", `${"select 1 from t where a = 'x'; ".repeat(31_000)}\n`);
      put("bigq.sql", `select '${"a".repeat(999_000)}';\n`);
    },
    rows: (root) => [
      // --- psql flag shapes
      [`psql -h ${H} -c"${D}"`, "deny", "glued -c\"…\""],
      [`psql -h ${H} -tAc "${D}"`, "deny", "bundled -tAc (common idiom)"],
      [`psql -h ${H} -Xqc "${D}"`, "deny", "bundled -Xqc"],
      [`psql -h ${H} -qf drop.sql`, "deny", "bundled -qf file"],
      [`mysql -h ${H} -e"${D}"`, "deny", "mysql glued -e"],
      [`mysql -h ${H} -Be "${D}"`, "deny", "mysql bundled -Be"],
      [`psql -h ${H} <<<"${D}"`, "deny", "glued here-string"],
      [`psql -h ${H} <<< "${D}"`, "deny", "spaced here-string"],
      [`psql -h ${H} --command "${D}"`, "deny", "--command spaced"],
      [`psql --host ${H} -c "${D}"`, "deny", "--host spaced"],
      [`psql -h ${H} -c "${D}" -c "SELECT 1"`, "deny", "two -c"],
      // --- heredoc delimiters #21's opener regex doesn't read
      [`cat <<'END-SQL' | psql -h ${H}\n${D};\nEND-SQL`, "deny", "cat <<'END-SQL' (dash in delimiter)"],
      [`cat <<\\EOF | psql -h ${H}\n${D};\nEOF`, "deny", "cat <<\\EOF"],
      [`psql -h ${H} <<'END-SQL'\n${D};\nEND-SQL`, "deny", "psql <<'END-SQL'"],
      [`psql -h ${H} <<\\EOF\n${D};\nEOF`, "deny", "psql <<\\EOF"],
      [`psql -h ${H} <<"E.O.F"\n${D};\nE.O.F`, "deny", "psql <<\"E.O.F\""],
      [`psql -h ${H} <<EOF\n${D};\nEOF`, "deny", "psql <<EOF plain"],
      [`psql -h ${H} <<-EOF\n\t${D};\n\tEOF`, "deny", "psql <<-EOF tabs"],
      [`cat <<EOF\nEOF \n: <<'X'\nEOF\ngit push --force origin main\nX`, "deny", "EOF<space> is a body line (pre-existing; #20 fixes)"],
      // --- functions, aliases, conditionals, background
      ["f() { cd prod; }; f && prisma migrate reset --force", "ask", "function body cd, called"],
      ["function f { cd prod; }; f; prisma migrate reset --force", "ask", "function keyword"],
      ["cd prod & prisma migrate reset --force", null, "cd in background (ask/deny ok)"],
      ["cd prod\nprisma migrate reset --force", "deny", "newline after cd"],
      ["cd prod || exit 1; prisma migrate reset --force", "deny", "cd || exit"],
      ["pushd prod >/dev/null && prisma migrate reset --force", "ask", "pushd with redirect"],
      ["cd prod 2>/dev/null && prisma migrate reset --force", "ask", "cd with redirect"],
      ["[ -d prod ] && cd prod && prisma migrate reset --force", "deny", "test && cd"],
      ["case x in x) cd prod;; esac; prisma migrate reset --force", "ask", "cd in case arm"],
      ["for d in prod; do cd $d; done; prisma migrate reset --force", "ask", "cd in for loop var"],
      ["while false; do :; done; cd prod && prisma migrate reset --force", "deny", "cd after loop"],
      ["export HOME=" + join(root, "prod") + " && cd ~ && prisma migrate reset --force", "ask", "export HOME then cd ~"],
      ["HOME=" + join(root, "prod") + "; cd && prisma migrate reset --force", "ask", "HOME= then bare cd"],
      // --- env / wrappers
      ["cd prod && sudo prisma migrate reset --force", "deny", "sudo resets env (env loopback, prod/.env remote)", { DATABASE_URL: LOCAL }],
      ["cd prod && sudo -E prisma migrate reset --force", null, "sudo -E keeps env (loopback env wins; allow ok)", { DATABASE_URL: LOCAL }],
      ["cd prod && sudo -u postgres prisma migrate reset --force", "deny", "sudo -u (env reset)", { DATABASE_URL: LOCAL }],
      ["cd prod && su app -c 'prisma migrate reset --force'", "ask", "su -c", { DATABASE_URL: LOCAL }],
      ["cd prod && env - PATH=/usr/bin prisma migrate reset --force", "deny", "env - (clears)", { DATABASE_URL: LOCAL }],
      ["cd prod && env --ignore-environment prisma migrate reset --force", "deny", "env --ignore-environment", { DATABASE_URL: LOCAL }],
      ["cd prod && env -iPATH=/x prisma migrate reset --force", "ask", "env -i glued (odd)", { DATABASE_URL: LOCAL }],
      ["cd prod && env -S 'prisma migrate reset --force'", "ask", "env -S string", { DATABASE_URL: LOCAL }],
      ["cd prod && nohup prisma migrate reset --force &", "deny", "nohup &"],
      ["cd prod && timeout -s KILL 60 prisma migrate reset --force", "deny", "timeout -s KILL 60"],
      ["cd prod && nice -n 10 npx --yes prisma@6 migrate reset --force", "deny", "nice npx@ver"],
      ["cd prod && npx -p prisma prisma migrate reset --force", "deny", "npx -p pkg"],
      ["cd prod && pnpm exec prisma migrate reset --force", "deny", "pnpm exec"],
      ["cd prod && yarn prisma migrate reset --force", "deny", "yarn prisma"],
      ["cd prod && bunx prisma migrate reset --force", "deny", "bunx"],
      ["cd prod && npm exec -- prisma migrate reset --force", "deny", "npm exec --"],
      ["cd prod && node ./node_modules/.bin/prisma migrate reset --force", "deny", "node .bin/prisma"],
      ["cd prod && command prisma migrate reset --force", "deny", "command prefix"],
      ["cd prod && exec prisma migrate reset --force", "deny", "exec prefix"],
      ["cd prod && \\prisma migrate reset --force", "deny", "backslash-escaped command word"],
      ["cd prod && 'prisma' migrate reset --force", "deny", "quoted command word"],
      ["cd prod && pri''sma migrate reset --force", "deny", "split-quoted command word"],
      ["cd prod && prisma migrate 'reset' --force", "deny", "quoted subcommand"],
      ["cd prod && prisma migrate re''set --force", "deny", "split-quoted subcommand"],
      ["cd prod && prisma  migrate   reset --force", "deny", "extra spaces"],
      ["cd prod && prisma\tmigrate\treset --force", "deny", "tabs"],
      ["cd prod && prisma migrate reset -f", "deny", "-f short"],
      ["cd prod && PRISMA_X=1 prisma migrate reset --force", "deny", "unrelated inline var"],
      // --- .env / prisma config
      ["cd bom && prisma migrate dev", "deny", "BOM .env remote, migrate dev"],
      ["cd bom && prisma migrate reset --force", "ask", "BOM .env remote, reset"],
      ["cd cmtschema && prisma migrate reset --force", "deny", "schema has commented-out loopback url literal; real url env remote"],
      ["cd othervar && prisma migrate reset --force", "ask", "schema url = env(\"PROD_URL\"), not DATABASE_URL"],
      ["cd direct && prisma migrate reset --force", "ask", "directUrl remote (migrate uses directUrl)"],
      ["cd shadowlit && prisma migrate reset --force", "deny", "shadowDatabaseUrl literal loopback, url env remote"],
      // --- SQL readability / size
      [`psql -h ${H} -f big1m.sql`, null, "~1MB benign file (time it)"],
      [`psql -h ${H} -f bigq.sql`, "ask", "1MB single statement (too long → ask)"],
      // --- false positives on everyday commands
      ["git status", null, "git status"],
      ["git fetch origin dev && git rebase origin/dev", null, "git rebase"],
      ["git push -u origin feat/x", null, "push feature"],
      ["pnpm check", null, "pnpm check"],
      ["pnpm test", null, "pnpm test (script)"],
      ["pnpm install", null, "pnpm install"],
      ["pnpm -C packages/api test", null, "pnpm -C test"],
      ["pnpm --filter api build", null, "pnpm --filter build"],
      ["gh pr view 21 --json title", null, "gh pr view"],
      ["gh pr create --draft --title 'drop table cleanup' --body 'DROP TABLE x'", null, "gh pr create mentioning DROP"],
      ["gh api repos/o/r/pulls/21/comments", null, "gh api read"],
      [`psql -h localhost -U postgres -c "${D}"`, null, "psql localhost DROP"],
      [`psql -h 127.0.0.1 -p 5433 -d app -tAc "${D}"`, null, "psql loopback -tAc"],
      [`psql postgres://postgres@localhost:5432/test -f drop.sql`, null, "psql loopback URL -f"],
      [`psql -h /var/run/postgresql -c "${D}"`, null, "psql socket dir"],
      [`psql -c "SELECT 1"`, null, "psql no host SELECT"],
      [`psql -c "${D}"`, null, "psql no host DROP (default socket; deny is FP)"],
      [`docker compose exec db psql -U postgres -c "${D}"`, null, "docker compose exec local db DROP (FP?)"],
      [`docker compose exec db psql -U postgres -c "SELECT 1"`, null, "docker compose exec SELECT"],
      ["prisma migrate dev --name init", null, "local migrate dev"],
      ["pnpm db:reset", null, "package script reset with loopback .env"],
      ["npx prisma studio", null, "prisma studio"],
      ["echo 'DROP TABLE users' > notes.txt", null, "echo into file"],
      ["cat drop.sql", null, "cat sql"],
      ["git diff -- prisma/migrations | psql -h localhost", null, "pipe into local psql"],
      ["ssh build-box 'ls /var/log'", null, "ssh benign"],
      ["kubectl get pods", null, "kubectl get"],
      ["docker ps", null, "docker ps"],
    ],
    dev: ["deny", "deny", "deny", null, "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "deny", "ask", "ask", null, "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", "ask", null, null, null, null, null, null, null, null, null, null, null, "ask", "ask", "ask", null, null, "ask", "ask", null, "ask", null, "ask", null, "ask", "ask", "ask", "ask", null, "ask", "ask", "ask", "ask", "ask", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, "deny", null, "deny", null, null, null, null, null, null, null, null, null, null, null],
  },
  {
    name: "round 3, wrappers and SQL (probe4.mjs)",
    files: (root, put) => {
      put(".env", `DATABASE_URL=${LOCAL}\n`);
      put("package.json", JSON.stringify({ scripts: { "db:reset": "prisma migrate reset --force", test: "vitest run" } }));
      put("prod/.env", `DATABASE_URL=${R}\n`);
      put("home/.env", `DATABASE_URL=${LOCAL}\n`);
      put("bom/.env", `\uFEFFDATABASE_URL=${R}\n`);
      put("cmtschema/.env", `DATABASE_URL=${R}\n`);
      put("cmtschema/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  // url = "${LOCAL}"\n  url      = env("DATABASE_URL")\n}\n`);
      put("othervar/.env", `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`);
      put("othervar/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url      = env("PROD_URL")\n}\n`);
      put("direct/.env", `DATABASE_URL=${LOCAL}\nDIRECT_URL=${R}\n`);
      put("direct/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n`);
      put("shadowlit/.env", `DATABASE_URL=${R}\n`);
      put("shadowlit/prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n  shadowDatabaseUrl = "${LOCAL}"\n}\n`);
      put("drop.sql", "DROP TABLE users;\n");
      put("x.sql", "SELECT 1;\n");
      put("big1m.sql", `${"select 1 from t where a = 'x'; ".repeat(31_000)}\n`);
      put("bigq.sql", `select '${"a".repeat(999_000)}';\n`);
    },
    rows: (_root) => [
      [`bash -lc 'psql -h ${H} -c "${D}"'`, "deny", "bash -lc"],
      [`sh -ec 'psql -h ${H} -c "${D}"'`, "deny", "sh -ec"],
      [`bash -c 'cd prod && prisma migrate reset --force'`, "deny", "bash -c cd prod reset"],
      [`echo users | xargs -I{} psql -h ${H} -c "DROP TABLE {}"`, "deny", "xargs psql"],
      [`find . -name '*.sql' -exec psql -h ${H} -f {} \\;`, "ask", "find -exec psql -f {}"],
      [`watch -n 5 psql -h ${H} -c "${D}"`, "deny", "watch psql"],
      [`time psql -h ${H} -c "${D}"`, "deny", "time psql"],
      [`PGPASSWORD=x psql -h ${H} -c "${D}"`, "deny", "PGPASSWORD prefix"],
      [`sudo -u postgres psql -h ${H} -c "${D}"`, "deny", "sudo -u postgres psql"],
      [`psql -h ${H} -c "MERGE INTO users u USING x ON true WHEN MATCHED THEN DELETE"`, "deny", "MERGE … THEN DELETE (lint has it; guard?)"],
      [`psql -h ${H} -c "UPDATE users SET email = ''"`, "ask", "UPDATE SET col = '' (clears; fixer noted)"],
      [`psql -h ${H} -c "UPDATE users SET (a, b) = (NULL, NULL)"`, "deny", "tuple UPDATE = NULL"],
      [`sqlcmd -S ${H} -Q "DELETE users"`, "deny", "T-SQL DELETE without FROM"],
      [`psql -h ${H} -c "SELECT lo_unlink(oid) FROM pg_largeobject_metadata"`, null, "lo_unlink (nit)"],
      [`psql -h ${H} -c "CREATE FUNCTION w() RETURNS void AS 'DELETE FROM users' LANGUAGE sql; SELECT w()"`, "deny", "function w/ DELETE string (raw text has it)"],
      [`mysql -h ${H} -e "DROP TABLE users" # comment`, "deny", "mysql with shell comment"],
      [`mysql -h ${H} -e "SELECT 1 # ; DROP TABLE users"`, "ask", "mysql # comment (DROP is commented: allow is right; FP ok)"],
      [`mysql -h ${H} -e "SELECT 1; # x\nDROP TABLE users"`, "deny", "mysql # comment then DROP next line"],
      [`psql -h ${H} -c "DROP TABLE users" --single-transaction`, "deny", "trailing flag"],
      [`psql --host=${H} --command="${D}"`, "deny", "--host= --command="],
      [`psql -d "host=${H} dbname=app" -c "${D}"`, "deny", "-d conninfo"],
      [`psql "host=localhost host=${H}" -c "${D}"`, "deny", "two host= in conninfo"],
      [`psql "postgres://localhost,${H}/app" -c "${D}"`, "deny", "multi-host URI"],
      [`psql -h localhost,${H} -c "${D}"`, "deny", "multi-host -h"],
      [`prisma db execute --url ${R} --stdin <<EOF\n${D};\nEOF`, "deny", "prisma db execute --stdin heredoc"],
      [`prisma db execute --url ${R} --file drop.sql`, "deny", "prisma db execute --file"],
      [`echo "${D}" | prisma db execute --url ${R} --stdin`, "deny", "echo | prisma db execute --stdin"],
      [`npm --prefix prod run db:reset`, "ask", "npm --prefix (no script there → falls back)"],
      [`make db-reset`, null, "make (unmodelled; allow on dev too)"],
      ["cd prod && DATABASE_URL= prisma migrate reset --force", "deny", "empty inline DATABASE_URL (prisma falls back to .env? no: empty set)"],
      ["cd prod && prisma migrate reset --force --schema prisma/schema.prisma", "deny", "--schema in-dir"],
      ["cd prod && prisma migrate reset --force --schema=./schema.prisma", "deny", "--schema=./"],
    ],
    dev: [null, null, "ask", null, null, null, "deny", "deny", null, null, null, null, null, null, "deny", "deny", "deny", "deny", "deny", "deny", "deny", null, null, null, "deny", null, "deny", null, null, "ask", "ask", "ask"],
  },
  {
    // Round 4 (resetprobe.mjs): a schema the guard didn't read let a loopback .env allow a reset.
    name: "round 4, where the schema is (resetprobe.mjs)",
    files: (_root, put) => {
      put("pj/.env", `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`);
      put("pj/package.json", JSON.stringify({ prisma: { schema: "db/schema.prisma" } }));
      put("pj/db/schema.prisma", ds('env("PROD_URL")'));
      put("pjlit/.env", `DATABASE_URL=${LOCAL}\n`);
      put("pjlit/package.json", JSON.stringify({ prisma: { schema: "db/schema.prisma" } }));
      put("pjlit/db/schema.prisma", ds(`"${R}"`));
      put("multi/.env", `DATABASE_URL=${LOCAL}\n`);
      put("multi/prisma/schema/db.prisma", ds(`"${R}"`));
      put("multi/prisma/schema/models.prisma", "model A { id Int @id }\n");
      put("mysock/.env", "DATABASE_URL=mysql://root@localhost/app?socket=/cloudsql/p:r:i\n");
      // The controls: every datasource read, every URL loopback.
      put("loc/.env", `DATABASE_URL=${LOCAL}\n`);
      put("loc/prisma/schema.prisma", ds('env("DATABASE_URL")'));
      put("loc/package.json", JSON.stringify({ scripts: { "db:reset": "prisma migrate reset --force" } }));
      put("pjloc/.env", `DATABASE_URL=${LOCAL}\n`);
      put("pjloc/package.json", JSON.stringify({ prisma: { schema: "db/schema.prisma" } }));
      put("pjloc/db/schema.prisma", ds('env("DATABASE_URL")'));
      put("multiloc/.env", `DATABASE_URL=${LOCAL}\n`);
      put("multiloc/prisma/schema/db.prisma", ds('env("DATABASE_URL")'));
      put("multiloc/prisma/schema/models/a.prisma", "model A { id Int @id }\n");
    },
    rows: (_root) => [
      ["cd pj && prisma migrate reset --force", "ask", "package.json prisma.schema → env(PROD_URL)"],
      ["cd pjlit && prisma migrate reset --force", "ask", "package.json prisma.schema → literal remote url"],
      ["cd multi && prisma migrate reset --force", "ask", "multi-file prisma/schema/ folder, literal remote"],
      ["cd multi && prisma migrate reset --force --schema prisma/schema", "ask", "--schema prisma/schema (folder), literal remote"],
      ["cd mysock && prisma migrate reset --force", "ask", "mysql ?socket=/cloudsql (Cloud SQL socket)"],
      ["cd loc && prisma migrate reset --force", null, "r4 control: loopback schema and .env"],
      ["cd loc && pnpm db:reset", null, "r4 control: pnpm script, loopback schema"],
      ["cd pjloc && prisma migrate reset --force", null, "r4 control: package.json prisma.schema, loopback"],
      ["cd multiloc && prisma migrate reset --force", null, "r4 control: multi-file folder, loopback"],
    ],
    dev: ["ask", "ask", "ask", "ask", "ask", "ask", null, "ask", "ask"],
  },
];

for (const corpus of CORPORA) {
  describe(`command-guard never weaker than dev: ${corpus.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "guard-floor-"));
    roots.push(root);
    const put = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    corpus.files(root, put);
    // Each row: [command, wanted verdict, label, the agent's environment].
    const rows = corpus.rows(root);
    assert.equal(rows.length, corpus.dev.length);
    rows.forEach(([command, want, label, env], index) => {
      const dev = corpus.dev[index] ?? null;
      const looser = LOOSER_THAN_DEV.get(label);
      const floor = looser === undefined ? `at least ${String(dev)} (dev)` : `${String(looser.got)} (looser than dev's ${String(dev)} on purpose)`;
      const readers = TIMED.has(label) ? { ...readersIn(root, env ?? {}), limits: { ...LIMITS, ms: Number.POSITIVE_INFINITY } } : readersIn(root, env ?? {});
      if (TIMED.has(label)) {
        it(`${label}: read inside the ${String(LIMITS.ms)} ms budget (fastest of ${String(TIMED_RUNS)})`, () => {
          let fastest = Number.POSITIVE_INFINITY;
          for (let run = 0; run < TIMED_RUNS; run += 1) {
            const started = performance.now();
            evaluate(command, readers);
            fastest = Math.min(fastest, performance.now() - started);
          }
          assert.ok(fastest < LIMITS.ms, `${label}: fastest ${Math.round(fastest)} ms`);
        });
      }
      it(`${label}: ${floor}${ACCEPTED.has(label) ? "" : `, at least ${String(want)} (wanted)`}`, () => {
        const got = evaluate(command, readers)?.decision ?? null;
        if (looser !== undefined) assert.equal(got, looser.got, `${label}: ${String(got)}`);
        else assert.ok(RANK[String(got)] >= RANK[String(dev)], `${label}: ${String(got)}, dev gave ${String(dev)}`);
        if (ACCEPTED.has(label)) return;
        // null wanted: must be allowed; otherwise at least as strict as wanted.
        if (want === null) assert.equal(got, null, `${label}: ${String(got)}, wanted an allow`);
        else assert.ok(RANK[String(got)] >= RANK[want], `${label}: ${String(got)}, wanted ${want}`);
      });
    });
  });
}
