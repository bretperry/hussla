// @vitest-environment node
/*
  Table test for command-guard's verdicts: what is refused, what asks the user, what runs.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/command-guard.mjs → evaluate(), loadRules(); temp repos under the OS temp dir.

  The allowed rows matter as much as the refused ones: a guard that blocks everyday commands
  gets switched off, and then it guards nothing. The project-rule tests lock the two ways a rule
  file could fail silently: a broken file read as "no rules", and an exemption that covers more
  than the one command it names.
*/
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { destroysSql, dotenvValue, evaluate, LIMITS, loadRules, targetOf, WATCHDOG_MS, words } from "./command-guard.mjs";

// Both budgets lifted, so a timing test measures one parser path rather than the gate in front of it.
const UNBOUNDED = { chars: Number.POSITIVE_INFINITY, ms: Number.POSITIVE_INFINITY };

// A Prisma schema whose datasource is DATABASE_URL: a reset is judged loopback only once the guard
// has read a datasource like this one (positive evidence), so a loopback project carries one.
const SCHEMA = 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n';

// Branches of the directories a test command `cd`s or `git -C`s into.
const DIRS = { "../habit": "dev", "~/Dev/habit": "dev", "../feat-wt": "feat/x", "../x": "feat/x" };

// [command, branch checked out where the hook runs, expected decision or null]
const cases = [
  // Ready needs the user's OK; back to draft never happens.
  ["gh pr ready 12", "feat", "ask"],
  ["gh pr ready 12 --undo", "feat", "deny"],
  ["gh pr ready --undo 12", "feat", "deny"],
  ["gh pr create --draft --base dev", "feat", null],
  // Merges and ships need the user in the loop.
  ["gh pr merge 12 --merge --match-head-commit abc", "dev", "ask"],
  ["git push origin main", "dev", "ask"],
  ["git push origin dev:main", "dev", "ask"],
  ["git push", "main", "ask"],
  ["git push origin", "main", "ask"],
  // Force on dev/main is refused; on your own branch it is normal after a rebase.
  ["git push --force origin dev", "feat", "deny"],
  ["git push -f", "main", "deny"],
  ["git push origin +main", "feat", "deny"],
  ["git push --force-with-lease origin feat/x", "feat/x", null],
  ["git push -u origin claude/fix-thing", "claude/fix-thing", null],
  // A chained command is judged per push, not by any word on the line.
  ["git push -u origin feat && git checkout main", "feat", null],
  ["git push origin feat/dev-tools", "feat/dev-tools", null],
  // Bypassing the pre-push hook is the user's call.
  ["git push --no-verify origin feat", "feat", "deny"],
  ["WHIPPLETREE_SKIP_CHECKS=1 git push origin feat", "feat", "deny"],
  // [skip ci] only on dev.
  ['git commit -m "docs: tweak [skip ci]"', "dev", null],
  ['git commit -m "fix: thing [skip ci]"', "feat", "deny"],
  ["git commit -m \"$(cat <<'EOF'\ndocs; notes\n\n[skip ci]\nEOF\n)\"", "feat", "deny"],
  // CI reruns.
  ["gh run rerun 123", "feat", "deny"],
  ["gh run rerun 123 --failed", "feat", null],
  ["gh workflow run ci.yml", "feat", "ask"],
  // Deleting data.
  ['psql "$PROD_URL" -c "DROP TABLE users"', "feat", "deny"],
  ["psql -h db.example.com <<SQL\nDELETE FROM users;\nSQL", "feat", "deny"],
  ['psql postgres://me@localhost:5432/app -c "TRUNCATE entries"', "feat", null],
  ["pnpm prisma migrate reset", "feat", "ask"],
  ["neonctl branches delete preview-12", "feat", "deny"],
  ["aws s3 rb s3://user-uploads --force", "feat", "deny"],
  ["terraform destroy", "feat", "deny"],
  // The branch is read where the commit or push runs, not where the hook runs.
  ['cd ~/Dev/habit && git commit -m "docs: notes [skip ci]"', "feat/x", null],
  ['cd ../habit && git add docs && git commit -m "docs: notes [skip ci]"', "feat/x", null],
  ['git -C ../x commit -m "fix: thing [skip ci]"', "dev", "deny"],
  ['cd ../nowhere && git commit -m "docs [skip ci]"', "dev", "ask"],
  ["cd ../habit && git push --force", "feat/x", "deny"],
  // A bare remote doesn't hide the current branch; flag clusters and other spellings count.
  ["git push --force origin", "dev", "deny"],
  ["git push -f origin", "main", "deny"],
  ["git push origin HEAD", "main", "ask"],
  ["git push -uf origin dev", "feat", "deny"],
  ["git push -fu origin dev", "feat", "deny"],
  ['git push origin "main"', "feat", "ask"],
  ["git push --all --force", "feat", "deny"],
  ["git push --delete origin dev", "feat", "deny"],
  ["git push origin :dev", "feat", "deny"],
  ["sh -c 'git push -f origin main'", "feat", "deny"],
  ['bash -c "git push origin main"', "feat", "ask"],
  ["env FOO=1 bash -c 'git push -f origin main'", "feat", "deny"],
  ['bash -c "git push -f origin \\"main\\""', "feat", "deny"],
  ["sudo sh -c 'terraform destroy'", "feat", "deny"],
  ["git push --all", "feat", "ask"],
  ["git push origin --delete feat/old", "feat", null],
  // Other roads to a merge or a draft flip.
  ["python3 scripts/lib/wrangle_merge.py 165 166", "dev", "ask"],
  ["python3 scripts/lib/wrangle_merge.py 287 --ship", "dev", "ask"],
  ["python3 scripts/lib/wrangle_merge.py 165 --dry-run", "dev", null],
  ["node scripts/lib/wrangle-merge.mjs 165 166", "dev", "ask"],
  ["node scripts/lib/wrangle-merge.mjs 287 --ship", "dev", "ask"],
  ["node scripts/lib/wrangle-merge.mjs 165 --dry-run", "dev", null],
  ["gh api -X PUT repos/o/r/pulls/12/merge", "feat", "ask"],
  ["gh api repos/o/r/pulls/12", "feat", null],
  ["gh api graphql -f query='mutation { convertPullRequestToDraft(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "feat", "deny"],
  // A destructive word in a search, a file, or a message is not a delete.
  ['grep -rn "terraform destroy" docs', "feat", null],
  ["rg dropdb", "feat", null],
  ['git commit -m "docs: never run dropdb; use neonctl branches reset by hand"', "feat", null],
  ['git commit -m "docs: never terraform destroy" -m "ok"', "feat", null],
  ["cat <<EOF > notes.md\nrun terraform destroy only by hand\nEOF", "feat", null],
  ['echo "DROP TABLE users" | psql "$PROD_URL"', "feat", "deny"],
  ["pnpm exec prisma migrate reset", "feat", "ask"],
  ["sudo terraform destroy", "feat", "deny"],
  // Everyday commands pass untouched.
  ['grep -rn "DELETE FROM" src', "feat", null],
  ["pnpm test && pnpm lint", "feat", null],
  ["git status", "main", null],
];

describe("command-guard evaluate", () => {
  for (const [command, branch, expected] of cases) {
    it(`${String(command)} (on ${String(branch)}) → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch, branchIn: (dir) => DIRS[dir] ?? "" })?.decision ?? null, expected);
    });
  }
});

// Temp repo roots, removed after the run.
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A throwaway repo root holding `files` ({ path: object → JSON, or string → as is }).
const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "command-guard-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return root;
};

// The decision for `command` under `rules`, on a feature branch.
const decide = (command, rules) => evaluate(command, { branch: "feat", branchIn: (dir) => DIRS[dir] ?? "", rules })?.decision ?? null;

describe("project rules: an absent file", () => {
  const rules = loadRules(repoWith({}));

  it("loads as no rules", () => {
    assert.equal(rules.error, "");
  });

  for (const [command, branch, expected] of cases) {
    it(`${String(command)} (on ${String(branch)}) → ${String(expected)}, as without the file`, () => {
      assert.equal(evaluate(command, { branch, branchIn: (dir) => DIRS[dir] ?? "", rules })?.decision ?? null, expected);
    });
  }
});

describe("project rules: a file that is present but doesn't load refuses every command", () => {
  const PROJECT = "command-guard.project.json";
  const PACK = "scripts/command-guard.d/infra.json";
  const rule = { match: "^make\\s+deploy\\b", reason: "Deploys go through CI." };
  // [what is wrong, files, the file and error the refusal must name]
  const broken = [
    ["malformed JSON", { [PROJECT]: '{ "deny": [ }' }, /^command-guard\.project\.json didn't load \(.*JSON/],
    ["an empty file", { [PROJECT]: "" }, /^command-guard\.project\.json didn't load \(.*JSON/],
    ["a regex that doesn't compile", { [PROJECT]: { deny: [{ ...rule, match: "^(make" }] } }, /deny\[0\]\.match: Invalid regular expression/],
    ["an `unless` that doesn't compile", { [PROJECT]: { ask: [{ ...rule, unless: "[" }] } }, /ask\[0\]\.unless: Invalid regular expression/],
    ["a misspelled kind", { [PROJECT]: { denny: [rule] } }, /unknown key "denny"/],
    ["a misspelled field", { [PROJECT]: { deny: [{ ...rule, resaon: "x" }] } }, /deny\[0\] has an unknown key "resaon"/],
    ["a missing reason", { [PROJECT]: { deny: [{ match: rule.match }] } }, /deny\[0\]\.reason must be a non-empty string/],
    ["a stateful regex flag", { [PROJECT]: { deny: [{ ...rule, flags: "g" }] } }, /deny\[0\]\.flags may only be "i"/],
    ["a kind that isn't a list", { [PROJECT]: { ask: rule } }, /"ask" must be an array/],
    ["a top level that isn't an object", { [PROJECT]: [] }, /the top level must be an object/],
    ["a kind given twice (JSON keeps only the last)", { [PROJECT]: '{ "deny": [], "deny": [] }' }, /"deny" appears twice in one object/],
    ["a field given twice in one rule", { [PROJECT]: '{ "deny": [{ "match": "^a", "match": "^b", "reason": "x" }] }' }, /"match" appears twice in one object/],
    ["an exemption that expands a variable", { [PROJECT]: { allow: [{ command: "dropdb $DB", reason: "x" }] } }, /allow\[0\]\.command must be one plain command/],
    ["an exemption that chains a second command", { [PROJECT]: { allow: [{ command: "dropdb a && dropdb b", reason: "x" }] } }, /allow\[0\]\.command must be one plain command/],
    ...["dropdb app_*", "dropdb app_?", "dropdb [ab]", "dropdb app_{a,b}", "dropdb ~/db"].map((command) => [`an exemption with a glob, brace, or ~: ${command}`, { [PROJECT]: { allow: [{ command, reason: "x" }] } }, /allow\[0\]\.command must be one plain command/]),
    // An exemption may lift only a data-delete deny; one that meets any other built-in rule is a broken file.
    ...[
      "git push --force origin main",
      "gh pr ready 5 --undo",
      "git push --no-verify",
      "WHIPPLETREE_SKIP_CHECKS=1 git push",
      "bash -c 'git push --force origin main'",
      "git push --force",
      "gh pr ready 12",
      'psql -h db.example.com -c "DROP TABLE t"',
      "prisma migrate reset --force",
      "DATABASE_URL=postgres://db.example.com/app prisma migrate dev",
    ].map((command) => [`an exemption for a rule it can't lift: ${command}`, { [PROJECT]: { allow: [{ command, reason: "x" }] } }, /allow\[0\]\.command meets a built-in rule an exemption can't lift/]),
    ["a pack that exempts", { [PACK]: { allow: [{ command: "terraform destroy", reason: "x" }] } }, /^scripts\/command-guard\.d\/infra\.json didn't load \(.*unknown key "allow"/],
    ["a pack that doesn't parse", { [PACK]: "{" }, /^scripts\/command-guard\.d\/infra\.json didn't load/],
  ];

  for (const [label, files, names] of broken) {
    it(typeof label === "string" ? label : "broken rule file", () => {
      const rules = loadRules(repoWith(files));
      assert.match(rules.error, names);
      // The agent is sent to the user, not invited to edit its own guard rules.
      assert.match(rules.error, /Stop and tell the user/);
      for (const command of ["git status", "ls", "pnpm test", ""]) {
        assert.deepEqual(evaluate(command, { rules }), { decision: "deny", reason: rules.error });
      }
    });
  }

  it("a directory where the file should be", () => {
    const root = repoWith({});
    mkdirSync(join(root, PROJECT));
    assert.equal(decide("ls", loadRules(root)), "deny");
  });

  it("a symlink to a file that isn't there", () => {
    const root = repoWith({});
    symlinkSync(join(root, "gone.json"), join(root, PROJECT));
    assert.match(loadRules(root).error, /^command-guard\.project\.json didn't load/);
  });

  it("files in the pack directory that aren't .json are ignored", () => {
    assert.equal(loadRules(repoWith({ "scripts/command-guard.d/README.md": "# packs" })).error, "");
  });
});

describe("project rules: deny, ask, and exemptions", () => {
  const rules = loadRules(
    repoWith({
      "command-guard.project.json": {
        $comment: "Neutral examples: a deny, a deny with unless, an ask, and exemptions.",
        deny: [
          { match: "^make\\s+deploy\\b", reason: "Deploys go through CI." },
          { match: "^db-reseed\\b", unless: "DATABASE_URL=postgres://localhost(:\\d+)?/\\w+ ", reason: "Reseeds only a loopback database." },
          { match: "^dropdb\\s+app_keep\\b", reason: "Never this one." },
        ],
        ask: [{ match: "^npm\\s+publish\\b", reason: "Publishing is the user's call." }],
        allow: [
          { command: "dropdb app_test", reason: "The throwaway test database." },
          { command: 'dropdb "app test"', reason: "A quoted name with a space is one word." },
          { command: "dropdb app_keep", reason: "Lifts the built-in deny; the project's own deny still stands." },
          { command: "pulumi up --stack scratch", reason: "Lifts a pack deny." },
        ],
      },
      "scripts/command-guard.d/iac.json": { deny: [{ match: "^pulumi\\s+up\\b", reason: "Applies go through CI." }] },
    }),
  );

  // [command, expected decision]
  const rows = [
    // A deny reads the command in command position.
    ["make deploy", "deny"],
    ["make test", null],
    ['grep -rn "make deploy" docs', null],
    // Chains, prefixes, quoting, and `bash -c` get no bypass.
    ["pnpm test && make deploy", "deny"],
    ["git status; make deploy", "deny"],
    ["make test || make deploy", "deny"],
    ["FOO=1 make deploy", "deny"],
    ["env FOO=1 make deploy", "deny"],
    ["sudo make deploy", "deny"],
    ['"make" deploy', "deny"],
    ["bash -c 'make deploy'", "deny"],
    ['sh -c "pnpm test && make deploy"', "deny"],
    ["env FOO=1 bash -c 'make deploy'", "deny"],
    // Ask, and deny beats ask.
    ["npm publish", "ask"],
    ["npm publish && make deploy", "deny"],
    // `unless` sees the inline assignment that `match` doesn't, and reads from the first word.
    ["db-reseed", "deny"],
    ["DATABASE_URL=postgres://localhost:5432/app db-reseed", null],
    ["DATABASE_URL=postgres://db.example.com/app db-reseed", "deny"],
    // The shell uses a variable's last assignment, and so does `unless`.
    ["DATABASE_URL=postgres://localhost:5432/app DATABASE_URL=postgres://db.example.com/app db-reseed", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app DATABASE_URL=postgres://localhost:5432/app db-reseed", null],
    ["db-reseed --note DATABASE_URL=postgres://localhost/app now", "deny"],
    // An exemption lifts the built-in deny of exactly that command, quotes and spacing aside.
    ["dropdb app_test", null],
    ['dropdb "app_test"', null],
    ["dropdb  app_test", null],
    ["bash -c 'dropdb app_test'", null],
    ['dropdb "app test"', null],
    // Anything more or different stays refused: another name, an extra argument, a prefix that can retarget it.
    ["dropdb app_test2", "deny"],
    ["dropdb app_test other_db", "deny"],
    ["dropdb other", "deny"],
    ["PGHOST=db.example.com dropdb app_test", "deny"],
    ["sudo dropdb app_test", "deny"],
    ["dropdb app_test > /dev/null", "deny"],
    ["dropdb app_test && dropdb app", "deny"],
    ["dropdb app_test & dropdb app", "deny"],
    ["dropdb app test", "deny"],
    // The project's own deny beats its exemption.
    ["dropdb app_keep", "deny"],
    // Pack rules load from the pack directory, and an exemption can lift one.
    ["pulumi up", "deny"],
    ["pulumi up --stack scratch", null],
    ["pulumi preview", null],
  ];

  it("loads", () => {
    assert.equal(rules.error, "");
  });

  for (const [command, expected] of rows) {
    it(`${String(command)} → ${String(expected)}`, () => {
      assert.equal(decide(command, rules), expected);
    });
  }

  it("names the file a refusal came from", () => {
    assert.equal(evaluate("make deploy", { rules })?.reason, "Deploys go through CI. (command-guard.project.json)");
    assert.equal(evaluate("pulumi up", { rules })?.reason, "Applies go through CI. (scripts/command-guard.d/iac.json)");
  });
});

// A temp repo with a copy of the guard in scripts/, so the run finds rule files where a project keeps them.
const guardIn = (files) => {
  const root = repoWith(files);
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("./command-guard.mjs", import.meta.url)), join(root, "scripts", "command-guard.mjs"));
  return root;
};

// Runs the hook as a host would, from a cwd outside the repo (or `cwd`), with the off switch and database URLs unset.
const run = (root, host, command, cwd = tmpdir(), extraEnv = {}) => {
  const env = { ...process.env };
  for (const name of ["WHIPPLETREE_GUARD", "DATABASE_URL", "GOOSE_DBSTRING", "PGHOSTADDR", "PGSERVICE", "PGHOST", "CDPATH"]) delete env[name];
  return execFileSync(process.execPath, [join(root, "scripts", "command-guard.mjs"), host], { input: JSON.stringify({ tool_input: { command }, command, cwd }), env: { ...env, ...extraEnv }, encoding: "utf8" });
};

// Rules exempting `command`, built by hand to skip loadRules' check; the key is the command's words, as the guard stores it.
const exempting = (command) => ({ deny: [], ask: [], allow: new Set([JSON.stringify(words(command))]), error: "" });

describe("project rules: an exemption that got past the schema still lifts only a data-delete deny", () => {
  // [command, exempted command, branch, expected]
  const rows = [
    ["git push --force origin main", "git push --force origin main", "feat", "deny"],
    ["gh pr ready 5 --undo", "gh pr ready 5 --undo", "feat", "deny"],
    ["git push --no-verify", "git push --no-verify", "feat", "deny"],
    ["WHIPPLETREE_SKIP_CHECKS=1 git push", "WHIPPLETREE_SKIP_CHECKS=1 git push", "feat", "deny"],
    ["bash -c 'git push --force origin main'", "git push --force origin main", "feat", "deny"],
    ["git push --force", "git push --force", "main", "deny"],
    ["gh pr ready 12", "gh pr ready 12", "feat", "ask"],
    ['psql -h db.example.com -c "DROP TABLE t"', 'psql -h db.example.com -c "DROP TABLE t"', "feat", "deny"],
    ["dropdb app_test", "dropdb app_test", "feat", null],
  ];

  for (const [command, exempted, branch, expected] of rows) {
    it(`${String(command)} (exempting ${String(exempted)}, on ${String(branch)}) → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch, rules: exempting(exempted) })?.decision ?? null, expected);
    });
  }
});

describe("databases: migration tools and SQL clients, judged by where they point", () => {
  // What the disk holds where a command runs: `.env` database URLs, package.json scripts, SQL files.
  const LOCAL_URL = "postgresql://habit:habit@localhost:5432/habit?schema=public";
  const REMOTE_URL = "postgresql://u:secret@ep-quiet-1.us-east-2.aws.neon.tech/app";
  const ENV_FILES = { local: { DATABASE_URL: LOCAL_URL }, prod: { DATABASE_URL: REMOTE_URL } };
  const SCRIPTS = { "db:reset": "prisma migrate reset --force", "db:migrate": "prisma migrate dev", "db:push": "prisma db push", "db:deploy": "prisma migrate deploy", nuke: "dropdb app", self: "pnpm self", test: "vitest run" };
  const FILES = { "drop.sql": "BEGIN;\nDROP TABLE users;\nCOMMIT;\n", "add.sql": "CREATE TABLE tag (id int);\n" };
  const options = {
    branch: "feat",
    targetIn: (dir, name) => {
      const value = ENV_FILES[dir ?? "."]?.[name];
      return value === undefined ? null : { value, from: ".env" };
    },
    scriptIn: (_dir, name) => SCRIPTS[name] ?? "",
    // local/ and prod/ hold a schema whose datasource names DATABASE_URL: a reset runs only once the guard has read one.
    fileIn: (dir, path) => (path === "prisma/schema.prisma" ? (dir !== null && dir in ENV_FILES ? SCHEMA : null) : (FILES[path] ?? null)),
  };

  // [command, expected decision]
  const rows = [
    // Each destructive migrate spelling is refused against a non-loopback database, however the URL arrives.
    ["DATABASE_URL=postgres://u:p@db.example.com/app pnpm prisma migrate reset", "deny"],
    ["cd prod && pnpm prisma migrate reset --force", "deny"],
    ["cd prod && pnpm db:reset", "deny"],
    ["cd prod && npm run db:reset", "deny"],
    ["cd prod && pnpm db:push --accept-data-loss", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app npx prisma db push --force-reset", "deny"],
    ["export DATABASE_URL=postgres://db.example.com/app && prisma migrate reset", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app; prisma migrate reset", "deny"],
    ['bash -c "cd prod && pnpm db:reset"', "deny"],
    ["cd prod && pnpm nuke", "deny"],
    ["sqlx database reset --database-url postgres://db.example.com/app", "deny"],
    ["sqlx migrate revert -D postgres://db.example.com/app", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app sqlx database drop -y", "deny"],
    ["diesel database reset --database-url=postgres://db.example.com/app", "deny"],
    ['goose -dir db/migrations postgres "host=db.example.com dbname=app" down', "deny"],
    ['GOOSE_DBSTRING="host=db.example.com dbname=app" goose -dir db/migrations reset', "deny"],
    ['GOOSE_DBSTRING="host=localhost dbname=app host=db.example.com" goose -dir db/migrations reset', "deny"],
    ['GOOSE_DBSTRING="host=localhost dbname=app" goose -dir db/migrations reset', null],
    ["migrate -path db/migrations -database postgres://db.example.com/app drop -f", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app alembic downgrade -1", "deny"],
    // A loopback-looking URL that isn't: a query host wins, a lookalike name, a multi-host list.
    ['DATABASE_URL="postgres://localhost/app?host=db.example.com" prisma migrate reset', "deny"],
    ["DATABASE_URL=postgres://localhost.example.com/app prisma migrate reset", "deny"],
    ["DATABASE_URL=postgres://localhost,db.example.com/app prisma migrate reset", "deny"],
    // The line's own setting wins over .env, as the shell and dotenv decide it.
    ["cd local && DATABASE_URL=postgres://db.example.com/app pnpm db:reset", "deny"],
    ["cd prod && DATABASE_URL=postgres://127.0.0.1/app pnpm db:reset", null],
    // On loopback (or a SQLite file, or a socket) they are the agent's to run.
    ["cd local && pnpm db:reset", null],
    ["cd local && DATABASE_URL=postgres://me@127.0.0.1:5432/app pnpm prisma migrate reset --force", null],
    ['cd prod && DATABASE_URL="postgres://u@%2Fvar%2Frun%2Fpostgresql/app" prisma migrate reset', null],
    ["sqlx database reset -D sqlite://dev.db -y", null],
    ['goose -dir db/migrations postgres "host=localhost dbname=app" down', null],
    ["migrate -path db/migrations -database postgres://[::1]:5432/app down 1", null],
    // Can't see where it points: the user confirms.
    ["prisma migrate reset", "ask"],
    ["DATABASE_URL=$PROD_URL prisma migrate reset", "ask"],
    ["cd local && doppler run -- prisma migrate reset", "ask"],
    ["cd local && dotenv -e .env.production -- pnpm prisma migrate reset", "ask"],
    ["cd local && source .env.production && prisma migrate reset", "ask"],
    ["alembic -c prod.ini downgrade base", "ask"],
    // `migrate dev` is refused only against a real database: it offers a reset when history differs.
    ["cd prod && pnpm db:migrate", "deny"],
    ["DATABASE_URL=postgres://db.example.com/app prisma migrate dev", "deny"],
    // The everyday flows habit depends on run untouched.
    ["cd local && pnpm db:migrate", null],
    ["DATABASE_URL=postgresql://habit:habit@localhost:5432/habit pnpm exec prisma migrate dev --name add_tag", null],
    ["DATABASE_URL=postgres://127.0.0.1:5432/app npx prisma migrate dev --create-only", null],
    ["pnpm prisma migrate dev", null],
    ["pnpm prisma migrate deploy", null],
    ["pnpm exec prisma migrate deploy", null],
    ["cd local && pnpm db:deploy", null],
    ["cd prod && pnpm prisma migrate status", null],
    ["cd local && pnpm db:push", null],
    ["pnpm test", null],
    ["pnpm self", null],
    // Applying to a real database is the user's or CI's: the user confirms.
    ["cd prod && pnpm db:deploy", "ask"],
    ["sqlx migrate run --database-url postgres://db.example.com/app", "ask"],
    // SQL clients: the host is parsed, not searched for, and a file they run is read.
    ['psql -h db.example.com -c "DROP TABLE users -- localhost"', "deny"],
    // A host the guard can't read (`$VAR`) with readable destructive SQL asks; a known remote host is refused.
    ['psql -h localhost "$PROD_URL" -c "DROP TABLE users"', "ask"],
    ['psql "postgresql://localhost/app?host=db.example.com" -c "DROP TABLE t"', "deny"],
    ['psql postgres://me@localhost.example.com/app -c "TRUNCATE t"', "deny"],
    ['psql "$PROD_URL" -f drop.sql', "ask"],
    ['psql "$PROD_URL" --file=drop.sql', "ask"],
    ['psql "$PROD_URL" < drop.sql', "ask"],
    ["prisma db execute --file drop.sql", "ask"],
    ["psql -h db.example.com -f drop.sql", "deny"],
    ['psql -h localhost -c "DROP TABLE users"', null],
    // The floor (dev's whole-line rule) sees no loopback word in `-hlocalhost`, so it refuses as dev did.
    ['psql -hlocalhost -c "TRUNCATE t"', "deny"],
    ['psql -hlocalhost -c "SELECT 1"', null],
    ['psql -h 127.0.0.1 -c "DELETE FROM t WHERE id = $ID"', null],
    ["psql -h localhost -f drop.sql", null],
    ['psql "$PROD_URL" -f add.sql', null],
    // Words about these commands are not the commands.
    ['grep -rn "prisma migrate reset" docs', null],
    ['git commit -m "docs: never prisma migrate reset prod"', null],
  ];

  for (const [command, expected] of rows) {
    it(`${String(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, options)?.decision ?? null, expected);
    });
  }

  it("never echoes the URL, which can hold a password", () => {
    const reason = evaluate("cd prod && pnpm db:reset", options)?.reason ?? "";
    assert.match(reason, /non-loopback database \(DATABASE_URL from \.env\)/);
    assert.ok(!reason.includes("secret") && !reason.includes("neon.tech"), reason);
  });
});

// QA round 1 on PR #21: each row was a bypass or a false positive. Strings only; nothing here runs.
describe("databases: what the resolver doesn't model asks, and never allows", () => {
  const REMOTE = "postgresql://u:secret@ep-quiet-1.us-east-2.aws.neon.tech/app";
  const LOCAL = "postgresql://u:p@localhost:5432/app";
  const R = "postgres://u@db.example.com/app";
  // A project tree read the way the hook reads it: cwd has a loopback .env; prod/ a remote one;
  // twice/ sets DATABASE_URL twice (the last wins); withprisma/ hides a remote URL in prisma/.env.
  const root = repoWith({
    ".env": `DATABASE_URL=${LOCAL}\nGOOSE_DBSTRING="host=localhost dbname=app"\n`,
    "prisma/schema.prisma": SCHEMA,
    "prod/.env": `DATABASE_URL=${REMOTE}\n`,
    "prod/prisma/schema.prisma": SCHEMA,
    "twice/.env": `DATABASE_URL=${LOCAL}\nDATABASE_URL=${REMOTE}\n`,
    "withprisma/.env": `DATABASE_URL=${LOCAL}\n`,
    "withprisma/prisma/.env": `DATABASE_URL=${REMOTE}\n`,
    "big.sql": `-- ${"x".repeat(1_000_001)}\nDROP TABLE users;\n`,
    "drop.sql": "DROP TABLE users;\n",
    "select.sql": "SELECT 1;\n",
    "package.json": { scripts: { "db:reset": "prisma migrate reset --force" } },
  });
  // The hook's readers (main()), over the temp tree and an empty environment.
  const at = (dir, path) => join(dir === null ? root : join(root, dir), path);
  const text = (dir, path) => {
    try {
      const full = at(dir, path);
      return statSync(full).size <= 1_000_000 ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
  const options = {
    branch: "feat",
    targetIn: (/** @type {string | null} */ dir, /** @type {string} */ name, /** @type {string | null} */ file = ".env") => {
      const value = file === null ? undefined : dotenvValue(text(dir, file) ?? "", name);
      return value === undefined ? null : { value, from: file };
    },
    scriptIn: (dir, name) => {
      try {
        return JSON.parse(text(dir, "package.json") ?? "").scripts?.[name] ?? "";
      } catch {
        return "";
      }
    },
    fileIn: text,
  };

  // [command, expected decision]
  const rows = [
    // B1: target resolution. dotenv keeps the last of two; Prisma loads prisma/.env; --schema elsewhere is unseen.
    ["cd twice && prisma migrate reset --force", "deny"],
    [`DATABASE_URL=${LOCAL} DATABASE_URL=${R} prisma migrate reset --force`, "deny"],
    ["cd withprisma && prisma migrate dev", "deny"],
    ["cd withprisma && prisma migrate deploy", "ask"],
    ["prisma migrate reset --force --schema prod/schema.prisma", "ask"],
    ["prisma migrate dev --config ../other/prisma.config.ts", "ask"],
    ["prisma migrate dev --schema prisma/schema.prisma", null],
    ["pushd prod && prisma migrate reset --force", "deny"],
    ["pushd prod && popd && prisma migrate reset --force", null],
    ["(cd prod && prisma migrate reset --force)", "deny"],
    ["(cd prod && ls) && prisma migrate reset --force", null],
    ["cd $DIR && prisma migrate dev", "ask"],
    ['eval "$(cat .env.production)" && prisma migrate reset --force', "ask"],
    ['eval "$(cat .env.production)" && prisma migrate dev', "ask"],
    ["read -r DATABASE_URL < prod.url && prisma migrate reset --force", "ask"],
    ["export $(cat .env.production | xargs) && prisma migrate reset --force", "ask"],
    ["export $(cat .env.production | xargs) && prisma migrate deploy", "ask"],
    ["env $(cat .env.production) prisma migrate reset --force", "ask"],
    ["set -a && . ./.env.production && prisma migrate reset --force", "ask"],
    ["source .env.production && DATABASE_URL=postgres://127.0.0.1/app prisma migrate reset", null],
    ["export DATABASE_URL=postgres://127.0.0.1/app && source .env.production && prisma migrate reset", "ask"],
    // B2: a wrapper or a path in front of the tool.
    [`cross-env DATABASE_URL=${R} prisma migrate reset --force`, "deny"],
    ["env-cmd -f .env.production prisma migrate reset --force", "ask"],
    ["railway run npx prisma migrate reset --force", "ask"],
    ['doppler run --command "prisma migrate reset --force"', "ask"],
    ["dotenv -e .env.production prisma migrate reset", "ask"],
    ["cd prod && pnpm --filter api prisma migrate reset --force", "deny"],
    ["pnpm --filter api prisma migrate reset --force", "ask"],
    ["pnpm -r db:reset", "ask"],
    ["pnpm -C prod exec prisma migrate reset --force", "deny"],
    ["pnpm --dir prod db:reset", "deny"],
    ["cd prod && npx --yes prisma migrate reset --force", "deny"],
    ["cd prod && npx prisma@6 migrate reset --force", "deny"],
    ["cd prod && pnpm dlx prisma migrate reset --force", "deny"],
    ["cd prod && ./node_modules/.bin/prisma migrate reset --force", "deny"],
    ["cd prod && node_modules/.bin/prisma migrate reset --force", "deny"],
    ["cd prod && timeout 600 prisma migrate reset --force", "deny"],
    ["cd prod && nohup prisma migrate reset --force", "deny"],
    ["cd prod && nice -n 5 prisma migrate reset --force", "deny"],
    ["cd prod && sudo -E prisma migrate reset --force", "deny"],
    ["cd prod && env -u FOO prisma migrate reset --force", "deny"],
    ["DATABASE_URL=$(cat prod.url) prisma migrate reset --force", "ask"],
    ["docker compose exec app prisma migrate reset --force", "ask"],
    ["./node_modules/.bin/prisma migrate reset --force", null],
    ["timeout 600 pnpm exec prisma migrate dev", null],
    // S1: a secrets loader makes every effect ask, not only the destructive ones.
    ["dotenv -e .env.production -- prisma migrate dev", "ask"],
    ["dotenv -e .env.production -- prisma migrate deploy", "ask"],
    ["doppler run -- sqlx migrate run", "ask"],
    // B3: hosts.
    ['PGHOSTADDR=10.1.2.3 psql -h localhost -c "DROP TABLE users"', "deny"],
    ['PGHOSTADDR=127.0.0.1 psql -h localhost -c "DROP TABLE users"', null],
    ['PGSERVICE=prod psql -h localhost -c "DROP TABLE users"', "ask"],
    ['export PGHOSTADDR=10.1.2.3 && psql -h localhost -c "TRUNCATE t"', "deny"],
    ['psql "host=localhost hostaddr=10.1.2.3" -c "DROP TABLE users"', "deny"],
    ['psql -h /cloudsql/proj:us-east1:prod -c "DROP TABLE users"', "deny"],
    // Loopback sockets, but the floor (dev's rule: no loopback word on the line) refuses as dev did.
    ['psql -h /var/run/postgresql -c "DROP TABLE users"', "deny"],
    ['psql -h /tmp -c "DROP TABLE users"', "deny"],
    ['psql -h /tmp -c "SELECT 1"', null],
    ['psql -h 127.999.0.1 -c "DROP TABLE users"', "deny"],
    ['psql -h 127.0.0.256 -c "DROP TABLE users"', "deny"],
    // S2: SQL the guard can't read asks; SQL it can read through a pipe, `\i`, or a file is judged.
    ['psql -h db.example.com -c "\\i drop.sql"', "deny"],
    ['psql -h db.example.com -c "\\i missing.sql"', "ask"],
    ["psql -h db.example.com -f drop.sql", "deny"],
    ["psql -h db.example.com -f select.sql", null],
    ["psql -h db.example.com -f big.sql", "ask"],
    ["cp drop.sql /tmp/x.sql && psql -h db.example.com -f /tmp/x.sql", "ask"],
    ["cat drop.sql | psql -h db.example.com", "deny"],
    ["cat select.sql | psql -h db.example.com", null],
    ["curl -s https://example.com/x.sql | psql -h db.example.com", "ask"],
    ['echo "TRUNCATE users" | psql -h db.example.com', "deny"],
    ["psql -h db.example.com < drop.sql", "deny"],
    ["psql -h db.example.com <<EOF\nDROP TABLE users;\nEOF", "deny"],
    ["pg_dump --clean -h localhost app | psql -h db.example.com app", "deny"],
    ["pg_dump -h localhost app | psql -h db.example.com app", null],
    ["pg_restore --clean -d postgres://db.example.com/app dump.bin", "deny"],
    ["pg_restore -c -h db.example.com -d app dump.bin", "deny"],
    ["pg_restore -h db.example.com -d app dump.bin", null],
    ["pg_restore --clean -h localhost -d app dump.bin", null],
    ['cat drop.sql | psql -h localhost', null],
    // S3: destructive SQL read with comments removed, more shapes, and SQL built at run time.
    ['psql -h db.example.com -c "DROP/**/TABLE users"', "deny"],
    ['psql -h db.example.com -c "DROP -- x\nTABLE users"', "deny"],
    ['psql -h db.example.com -c "ALTER TABLE users DROP email"', "deny"],
    ['psql -h db.example.com -c "ALTER TABLE users DROP CONSTRAINT users_email_key"', null],
    ['psql -h db.example.com -c "UPDATE users SET email = NULL"', "deny"],
    ['psql -h db.example.com -c "UPDATE users SET email = lower(email)"', null],
    ['mysql -h db.example.com -e "DELETE u FROM users u"', "deny"],
    ['psql -h db.example.com -c "DROP TYPE mood CASCADE"', "deny"],
    ['psql -h db.example.com -c "DO $$ BEGIN EXECUTE \'DR\' || \'OP TABLE users\'; END $$"', "ask"],
    ['psql -h db.example.com -c "EXECUTE purge_all"', "ask"],
    ['psql -h localhost -c "DO $$ BEGIN EXECUTE \'x\'; END $$"', null],
    // S4: more tools and spellings.
    [`sqlx db drop -y -D ${R}`, "deny"],
    [`sqlx db reset -D ${R}`, "deny"],
    [`sqlx mig revert -D ${R}`, "deny"],
    [`sqlx mig run -D ${R}`, "ask"],
    [`migrate -path m -database ${R} goto 1`, "deny"],
    [`DATABASE_URL=${R} dbmate drop`, "deny"],
    [`DATABASE_URL=${R} dbmate rollback`, "deny"],
    [`dbmate -u ${R} down`, "deny"],
    ["dbmate --env-file .env.production rollback", "ask"],
    ["dbmate rollback", null],
    ["dbmate up", null],
    [`DATABASE_URL=${R} knex migrate:rollback --all`, "deny"],
    ["knex migrate:rollback", "ask"],
    [`DATABASE_URL=${R} drizzle-kit push --force`, "deny"],
    ["supabase db reset --linked", "deny"],
    [`supabase db reset --db-url ${R}`, "deny"],
    ["supabase db reset", null],
    [`DATABASE_URL=${R} alembic downgrade base`, "deny"],
    ["cd . && alembic downgrade base", "ask"],
    ["alembic upgrade head", null],
    ["goose -dir m create down sql", null],
    // Nit: SQL is judged per client, not against the whole line; the floor (dev's whole-line rule)
    // still refuses a remote client on a line that says DROP TABLE anywhere, as dev did.
    ['git commit -m "fix: DROP TABLE tmp" && psql -h db.example.com -c "select 1"', "deny"],
    ["psql -h db.example.com -c 'select 1' && psql -h localhost -c 'DROP TABLE t'", null],
    ["psql -h localhost -c 'DROP TABLE t' && psql -h db.example.com -c 'select 1'", null],
    // Words about these tools are not the tools.
    ['grep -rn "DROP TABLE" prisma/migrations', null],
    ["cat prisma/migrations/0001/migration.sql", null],
    ["which psql", null],
    ["git commit -F- <<EOF\nnever prisma migrate reset prod\nEOF", null],
    ["prisma migrate status", null],
    ["cd prod && prisma migrate status", null],
  ];

  for (const [command, expected] of rows) {
    it(`${JSON.stringify(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, options)?.decision ?? null, expected);
    });
  }

  it("dotenvValue keeps the last of two, as dotenv does", () => {
    assert.equal(dotenvValue("A=1\nexport A='2'\nB=3\n", "A"), "2");
    assert.equal(dotenvValue("B=3\n", "A"), undefined);
  });
});

// QA round 2 on PR #21: each row was a bypass, a throw, or a false positive. Strings only; nothing here runs.
describe("databases: QA round 2 — parsing the line, the SQL, and where it runs", () => {
  const LOCAL = "postgresql://u:p@localhost:5432/app";
  const R = "postgres://u@db.example.com/app";
  const D = "DROP TABLE users";
  // cwd has a loopback .env; prod/ a remote one; the rest each hide a remote URL a different way.
  const root = repoWith({
    ".env": `DATABASE_URL=${LOCAL}\n`,
    "prisma/schema.prisma": SCHEMA,
    "package.json": { scripts: { "db:reset": "prisma migrate reset --force" } },
    "prod/.env": `DATABASE_URL=${R}\n`,
    "prod/prisma/schema.prisma": SCHEMA,
    "colon/.env": `DATABASE_URL=${LOCAL}\nDATABASE_URL: ${R}\n`,
    "multi/.env": `DATABASE_URL=${R}\nNOTE="\nDATABASE_URL=${LOCAL}\n"\n`,
    "crlf/.env": `DATABASE_URL=${R}\r\nOTHER=1\r\n`,
    "cmt/.env": `DATABASE_URL=${R} # was localhost\n`,
    "pcfg/.env": `DATABASE_URL=${LOCAL}\n`,
    "pcfg/prisma.config.ts": `export default { datasource: { url: env("DATABASE_URL") } };\n`,
    "plit/.env": `DATABASE_URL=${LOCAL}\n`,
    "plit/prisma/schema.prisma": `datasource db {\n  provider = "postgresql"\n  url      = "${R}"\n}\n`,
    "pfine/.env": `DATABASE_URL=${LOCAL}\n`,
    "pfine/prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
    "home/.env": `DATABASE_URL=${R}\n`,
    "drop.sql": `${D};\n`,
    "select.sql": "SELECT 1;\n",
    "stale.sql": "SELECT 1;\n",
    "sub/x.sql": `${D};\n`,
    "sub/inc.sql": "\\ir x.sql\n",
    "c1.sql": "\\i c2.sql\n",
    "c2.sql": "\\i c3.sql\n",
    "c3.sql": "\\i c4.sql\n",
    "c4.sql": "\\i c5.sql\n",
    "c5.sql": `${D};\n`,
    "cyc1.sql": "\\i cyc2.sql\n",
    "cyc2.sql": "\\i cyc1.sql\n",
    ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index + 1}.sql`, "SELECT 1;\n"])),
  });
  // A command's directory in the temp tree (HOME is home/).
  const where = (dir) => (dir === null ? root : dir.startsWith("~") ? join(root, "home", dir.slice(1)) : resolve(root, dir));
  // A file's text as main() reads it: a regular file up to 1 MB, else null.
  const file = (dir, path) => {
    try {
      const full = resolve(where(dir), path);
      const found = statSync(full);
      return found.isFile() && found.size <= 1_000_000 ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
  // main()'s readers over the temp tree, with `env` as the agent's environment.
  const readersFor = (env = {}) => {
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
      dirExists: (dir) => {
        try {
          return statSync(where(dir)).isDirectory();
        } catch {
          return false;
        }
      },
    };
  };
  const decision = (command, env) => evaluate(command, readersFor(env))?.decision ?? null;

  // [command, expected decision, the agent's environment]
  /** @type {[string, string | null, Record<string, string>?][]} */
  const rows = [
    // B1: a malformed `%` escape never throws (a throw skipped the guard for the whole line).
    [`git push --force origin main; psql postgres://%zz`, "deny"],
    [`psql -h db.example.com -c "${D}"; psql postgres://%zz`, "deny"],
    ["DATABASE_URL=postgres://%E0%A4%A/app prisma migrate reset --force", "ask"],
    // B2: a heredoc fed through a pipe is the client's SQL.
    [`cat <<EOF | psql -h db.example.com\n${D};\nEOF`, "deny"],
    [`cat <<'SQL' | psql "$DATABASE_URL"\nTRUNCATE users;\nSQL`, "deny"],
    ["cat <<EOF | psql -h db.example.com\nSELECT 1;\nEOF", null],
    ["cat <<EOF | psql -h db.example.com\nSELECT $X;\nEOF", "ask"],
    [`cat <<EOF | psql -h localhost\n${D};\nEOF`, null],
    ["git commit -F - <<EOF\nfeat: drop legacy table\n\nRun prisma migrate reset --force locally.\nEOF", null],
    // S5: directory forms the guard can't follow lose track; the ones it can, it follows.
    ["cd && prisma migrate reset --force", "deny"],
    ["cd ~ && prisma migrate reset --force", "deny"],
    ["cd -P prod && prisma migrate dev", "deny"],
    ["cd -P prod && prisma migrate reset --force", "deny"],
    ["cd -- prod && prisma migrate reset --force", "deny"],
    ["{ cd prod; } && prisma migrate reset --force", "deny"],
    ["builtin cd prod && prisma migrate reset --force", "deny"],
    ["(cd prod && echo \\) && prisma migrate reset --force)", "deny"],
    ['(cd prod && echo ")" && prisma migrate reset --force)', "deny"],
    ["if true; then cd prod; fi; prisma migrate reset --force", "ask"],
    ["if true; then git push --force origin main; fi", "deny"],
    ["cd prod && cd - && prisma migrate reset --force", null],
    ["cd - && prisma migrate reset --force", "ask"],
    ["cd nowhere && prisma migrate reset --force", "ask"],
    ["cd app && prisma migrate dev", "ask", { CDPATH: join(root, "prod") }],
    ["cd ./prod && prisma migrate reset --force", "deny", { CDPATH: join(root, "home") }],
    ["X=$(cd prod && pwd) && prisma migrate reset --force", null],
    // S6: a variable the line removes is read from the .env the tool then loads, not the environment.
    ["cd prod && unset DATABASE_URL && prisma migrate reset --force", "deny", { DATABASE_URL: LOCAL }],
    ["cd prod && env -u DATABASE_URL prisma migrate reset --force", "deny", { DATABASE_URL: LOCAL }],
    ["cd prod && env --unset=DATABASE_URL prisma migrate reset --force", "deny", { DATABASE_URL: LOCAL }],
    ["cd prod && env -i PATH=/usr/bin prisma migrate reset --force", "deny", { DATABASE_URL: LOCAL }],
    ["cd prod && prisma migrate reset --force", null, { DATABASE_URL: LOCAL }],
    [`DATABASE_URL=${LOCAL} prisma migrate reset --force`, null, { DATABASE_URL: R }],
    ["prisma migrate dev", "deny", { DATABASE_URL: R }],
    // S7: `host=` inside the SQL is not where it connects.
    [`PGHOST=db.example.com psql -c "${D}; -- host=localhost"`, "deny"],
    [`psql -c "${D}; -- host=localhost"`, "deny", { PGHOST: "db.example.com" }],
    [`psql "service=prod" -c "SELECT 'host=localhost'; ${D}"`, "ask"],
    [`psql --command="${D} -- host=localhost"`, "ask"],
    // S8: quotes don't hide SQL, SQL the shell builds asks, and every include is followed.
    [`psql -h db.example.com -c "SELECT '--'; ${D}"`, "deny"],
    [`psql -h db.example.com -c "SELECT '/*'; ${D}; SELECT '*/'"`, "deny"],
    // The floor reads the whole line, so the SQL in the variable is refused, as on dev.
    [`SQL="${D}" && psql -h db.example.com -c "$SQL"`, "deny"],
    ['psql -h db.example.com -c "$SQL"', "ask"],
    ['psql -h db.example.com -c "$(cat drop.sql)"', "ask"],
    ["psql -h db.example.com -c $'\\x44ROP TABLE users'", "ask"],
    ['echo "$SQL" | psql -h db.example.com', "ask"],
    ["psql -h db.example.com -c \"SELECT format('DR%sOP TABLE %I', '', 'users') \\gexec\"", "ask"],
    ['mysql -h db.example.com -e "source drop.sql"', "deny"],
    ['mysql -h db.example.com -e "\\. drop.sql"', "deny"],
    ["cp drop.sql stale.sql && psql -h db.example.com -f stale.sql", "ask"],
    ["cat drop.sql > stale.sql; psql -h db.example.com -f stale.sql", "ask"],
    ["cat drop.sql | tee stale.sql && psql -h db.example.com -f stale.sql", "ask"],
    ["cp drop.sql sub && psql -h db.example.com -f sub/drop.sql", "ask"],
    // The heredoc body is on the line, so the floor refuses it, as on dev.
    [`cat > stale.sql <<EOF\n${D};\nEOF\npsql -h db.example.com -f stale.sql`, "deny"],
    [`cat > stale.sql <<EOF\nSELECT 1;\nEOF\npsql -h db.example.com -f stale.sql`, "ask"],
    ["cp select.sql other.sql && psql -h db.example.com -f stale.sql", null],
    [`psql -h db.example.com ${Array.from({ length: 20 }, (_, index) => `-f f${index + 1}.sql`).join(" ")} -f drop.sql`, "ask"],
    [`psql -h db.example.com ${Array.from({ length: 20 }, (_, index) => `-f f${index + 1}.sql`).join(" ")}`, null],
    ["psql -h db.example.com -f c1.sql", "deny"],
    ["psql -h db.example.com -f sub/inc.sql", "deny"],
    ["psql -h db.example.com -f cyc1.sql", null],
    ["cat drop.sql | psql -h db.example.com -f /dev/stdin", "deny"],
    ["cat drop.sql | psql -h db.example.com -f -", "deny"],
    ["cat select.sql | psql -h db.example.com -f -", null],
    ["psql -h db.example.com -f /dev/stdin", "ask"],
    // S9: a SQL client behind a remote shell or another wrapper is still judged.
    [`kubectl exec -it pg-0 -- psql -U postgres -c "${D}"`, "deny"],
    [`ssh prod-db psql -c "${D}"`, "deny"],
    [`ssh prod-db "psql -c '${D}'"`, "deny"],
    // In a container, no host or its localhost is the container's own database: the target is
    // unknown, so the user decides (round 4: the floor asks there too, rather than refusing).
    [`docker exec db psql -U postgres -c "${D}"`, "ask"],
    [`docker compose exec db psql -h localhost -c "${D}"`, "ask"],
    [`kubectl exec pg-0 -- sh -c "psql -c '${D}'"`, "deny"],
    [`su postgres -c "psql -c '${D}'"`, "deny"],
    [`watch psql -h db.example.com -c "${D}"`, "deny"],
    ["ssh prod-db psql -f drop.sql", "ask"],
    ['docker exec db psql -c "SELECT 1"', null],
    ['echo psql -c "DROP TABLE users"', null],
    // S10: dotenv's `KEY: value` form, multi-line quoted values, CRLF, and comments.
    ["cd colon && prisma migrate reset --force", "deny"],
    ["cd multi && prisma migrate reset --force", "deny"],
    ["cd crlf && prisma migrate reset --force", "deny"],
    ["cd cmt && prisma migrate reset --force", "deny"],
    // S11: a Prisma config file means a loopback .env proves nothing; a URL written in the schema wins.
    ["cd pcfg && prisma migrate reset --force", "ask"],
    ["cd plit && prisma migrate reset --force", "deny"],
    ["cd plit && prisma migrate dev", "deny"],
    ["cd pfine && prisma migrate reset --force", null],
    // S12: the tool through its own JS entry point.
    ["cd prod && node node_modules/prisma/build/index.js migrate reset --force", "deny"],
    ["cd prod && node ./node_modules/.pnpm/prisma@6.1.0/node_modules/prisma/build/index.js migrate reset --force", "deny"],
    ["node --env-file=.env.production node_modules/prisma/build/index.js migrate reset --force", "ask"],
    // Nits: nesting, obfuscation, and false positives.
    ["printf 'DR%sP TABLE users' O | psql -h db.example.com", "ask"],
    ["printf 'DROP TABLE users;\\n' | psql -h db.example.com", "deny"],
    [`psql -h db.example.com -v t=TABLE -c "DROP :t users"`, "ask"],
    ['psql -h db.example.com -v ON_ERROR_STOP=1 -c "SELECT 1::int"', null],
    ['psql -h db.example.com -c "GRANT EXECUTE ON FUNCTION f() TO app"', null],
    ['psql -h db.example.com -c "EXECUTE purge_all"', "ask"],
    ["echo run prisma migrate reset --force to start over", null],
    ["grep -rn prisma migrate reset docs", null],
    [`${"eval ".repeat(20)}git status`, "ask"],
    [`${"eval ".repeat(3)}git push --force origin main`, "deny"],
  ];

  for (const [command, expected, env] of rows) {
    it(`${JSON.stringify(command)}${env ? ` with ${Object.keys(env).join(", ")} set` : ""} → ${String(expected)}`, () => {
      assert.equal(decision(command, env), expected);
    });
  }

  it("dotenvValue reads `KEY: value`, skips a key inside a quoted value, and keeps the last", () => {
    assert.equal(dotenvValue("A=1\nA: 2\n", "A"), "2");
    assert.equal(dotenvValue('A=1\nB="\nA=2\n"\n', "A"), "1");
    assert.equal(dotenvValue("export A='x y' # c\r\n", "A"), "x y");
    assert.equal(dotenvValue("A=x # c\n", "A"), "x");
    assert.equal(dotenvValue('A="never closed\n', "A"), '"never closed');
  });
});

// Timing: the hook times out at 10 s and a timed-out hook lets the command run, so every reader
// here must stay linear. Each input was over 10 s (or a hang) before round 2; the bounds leave CI headroom.
describe("databases: adversarial input stays far inside the hook's timeout", () => {
  const MB = 990_000;
  const fill = (unit) => unit.repeat(Math.floor(MB / unit.length));
  // [label, SQL file text a remote `psql -f big.sql` reads]
  const files = [
    ["no `;`, many `drop`", fill("drop x ")],
    ["no `;`, many `update … set`", fill("update the row set it to done\n")],
    ["no `;`, many `alter table`", fill("alter table t ")],
    ["unclosed block comments", fill("/* ")],
    ["unclosed quotes", fill("' ")],
    ["dollar tags", fill("$a$ ")],
    ["a long multi-table delete list", fill("delete a , ")],
    ["a million includes", fill("\\i ")],
    ["psql variables", fill(":a ")],
  ];
  for (const [label, text] of files) {
    it(`${label}: under 2 s`, () => {
      const started = Date.now();
      const verdict = evaluate("psql -h db.example.com -v x=1 -f big.sql", { fileIn: () => text });
      assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
      assert.equal(verdict?.decision, "ask");
    });
  }

  it("20,000 nested `eval`s ask, under 4 s", () => {
    const started = Date.now();
    assert.equal(evaluate(`${"eval ".repeat(20_000)}git push --force origin main`, {})?.decision, "ask");
    assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
  });

  it("a 1 MB .env of quotes and backslashes, under 1 s", () => {
    const started = Date.now();
    dotenvValue(fill("A='\\'"), "A");
    dotenvValue(fill('A="x\n'), "A");
    assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  });
});

describe("hook entry point", () => {
  it("refuses everything when the project file is broken, for both hosts", () => {
    const root = guardIn({ "command-guard.project.json": "{ nope" });
    const output = JSON.parse(run(root, "claude", "ls")).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.ok(output.permissionDecisionReason.includes("command-guard.project.json didn't load"));
    assert.equal(JSON.parse(run(root, "cursor", "ls")).permission, "deny");
  });

  it("applies the project's rules", () => {
    const root = guardIn({ "command-guard.project.json": { deny: [{ match: "^make\\s+deploy\\b", reason: "Deploys go through CI." }] } });
    assert.equal(JSON.parse(run(root, "claude", "make deploy")).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(run(root, "claude", "make test"), "");
  });

  it("without a project file, behaves as before", () => {
    const root = guardIn({});
    assert.equal(run(root, "claude", "ls"), "");
    assert.equal(JSON.parse(run(root, "cursor", "ls")).permission, "allow");
  });

  it("reads .env and package.json where the command runs", () => {
    const root = guardIn({});
    const project = repoWith({ "package.json": { scripts: { "db:reset": "prisma migrate reset --force" } }, "prisma/schema.prisma": SCHEMA, ".env": "# local\nDATABASE_URL=\"postgresql://u:p@db.example.com:5432/app\"\n" });
    assert.equal(JSON.parse(run(root, "claude", "pnpm db:reset", project)).hookSpecificOutput.permissionDecision, "deny");
    writeFileSync(join(project, ".env"), "export DATABASE_URL='postgresql://u:p@localhost:5432/app'\n");
    assert.equal(run(root, "claude", "pnpm db:reset", project), "");
    assert.equal(run(root, "claude", "pnpm exec prisma migrate dev", project), "");
  });

  it("reads .env as dotenv does (last wins), prisma/.env too, and SQL files it can't read ask", () => {
    const root = guardIn({});
    const decision = (command, cwd) => {
      const output = run(root, "claude", command, cwd);
      return output === "" ? null : JSON.parse(output).hookSpecificOutput.permissionDecision;
    };
    const twice = repoWith({ ".env": "DATABASE_URL=postgresql://localhost/app\nDATABASE_URL=postgresql://db.example.com/app\n" });
    assert.equal(decision("prisma migrate reset --force", twice), "deny");
    const nested = repoWith({ ".env": "DATABASE_URL=postgresql://localhost/app\n", "prisma/.env": "DATABASE_URL=postgresql://db.example.com/app\n" });
    assert.equal(decision("prisma migrate dev", nested), "deny");
    const files = repoWith({ "big.sql": `-- ${"x".repeat(1_000_001)}\nSELECT 1;\n`, "ok.sql": "SELECT 1;\n" });
    assert.equal(decision("psql -h db.example.com -f big.sql", files), "ask");
    assert.equal(decision("psql -h db.example.com -f missing.sql", files), "ask");
    assert.equal(decision("psql -h db.example.com -f ok.sql", files), null);
  });

  it("QA round 2 through the real readers: env, HOME, CDPATH, symlinks, /dev/stdin, no throws", () => {
    const root = guardIn({});
    const LOCAL = "postgresql://u:p@localhost:5432/app";
    const project = repoWith({
      ".env": `DATABASE_URL=${LOCAL}\n`,
      "prisma/schema.prisma": SCHEMA,
      "prod/.env": "DATABASE_URL=postgres://u@db.example.com/app\n",
      "home/.env": "DATABASE_URL=postgres://u@db.example.com/app\n",
      "cfg/.env": `DATABASE_URL=${LOCAL}\n`,
      "cfg/prisma.config.ts": 'export default { datasource: { url: env("DATABASE_URL") } };\n',
      "big.sql": `SELECT 1;\n-- ${"x".repeat(1_000_001)}\n`,
      "drop.sql": "DROP TABLE users;\n",
    });
    symlinkSync(join(project, "big.sql"), join(project, "link.sql"));
    const decision = (command, env = {}) => {
      const output = run(root, "claude", command, project, { HOME: join(project, "home"), ...env });
      return output === "" ? null : JSON.parse(output).hookSpecificOutput.permissionDecision;
    };
    // A bad `%` escape no longer throws (a throw skipped the whole line, the force-push too).
    assert.equal(decision("git push --force origin main; psql postgres://%zz"), "deny");
    // stat, not lstat: a link can't carry a file past the 1 MB cap; /dev/stdin is not a file.
    assert.equal(decision("psql -h db.example.com -f link.sql"), "ask");
    assert.equal(decision("psql -h db.example.com -f /dev/stdin"), "ask");
    assert.equal(decision("cat drop.sql | psql -h db.example.com -f /dev/stdin"), "deny");
    // A removed variable is read from the .env the tool loads, not the agent's environment.
    assert.equal(decision("cd prod && env -u DATABASE_URL prisma migrate reset --force", { DATABASE_URL: LOCAL }), "deny");
    assert.equal(decision("cd prod && unset DATABASE_URL && prisma migrate reset --force", { DATABASE_URL: LOCAL }), "deny");
    // Bare `cd` is HOME; a directory that isn't there, or CDPATH, loses track.
    assert.equal(decision("cd && prisma migrate reset --force"), "deny");
    assert.equal(decision("cd nowhere && prisma migrate reset --force"), "ask");
    assert.equal(decision("cd prod && prisma migrate reset --force", { CDPATH: join(project, "home") }), "ask");
    assert.equal(decision("cd cfg && prisma migrate reset --force"), "ask");
    assert.equal(decision("prisma migrate reset --force"), null);
  });

  it("round 4 through the real readers: package.json's prisma.schema and a multi-file schema folder", () => {
    const root = guardIn({});
    const LOCAL = "postgresql://u:p@localhost:5432/app";
    const R = "postgres://u@db.example.com/app";
    const remote = `datasource db {\n  provider = "postgresql"\n  url      = "${R}"\n}\n`;
    const project = repoWith({
      "pj/.env": `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`,
      "pj/package.json": { prisma: { schema: "db/schema.prisma" } },
      "pj/db/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("PROD_URL")\n}\n',
      "multi/.env": `DATABASE_URL=${LOCAL}\n`,
      "multi/prisma/schema/db.prisma": remote,
      "multi/prisma/schema/models.prisma": "model A { id Int @id }\n",
      "nested/.env": `DATABASE_URL=${LOCAL}\n`,
      "nested/prisma/schema/db.prisma": SCHEMA,
      "nested/prisma/schema/more/x.prisma": remote,
      "loc/.env": `DATABASE_URL=${LOCAL}\n`,
      "loc/prisma/schema/db.prisma": SCHEMA,
      "loc/prisma/schema/models.prisma": "model A { id Int @id }\n",
      "none/.env": `DATABASE_URL=${LOCAL}\n`,
    });
    const decision = (command) => {
      const output = run(root, "claude", command, project);
      return output === "" ? null : JSON.parse(output).hookSpecificOutput.permissionDecision;
    };
    assert.equal(decision("cd pj && prisma migrate reset --force"), "deny");
    assert.equal(decision("cd multi && prisma migrate reset --force"), "deny");
    assert.equal(decision("cd multi && prisma migrate reset --force --schema prisma/schema"), "deny");
    assert.equal(decision("cd nested && prisma migrate reset --force"), "deny");
    assert.equal(decision("cd none && prisma migrate reset --force"), "ask");
    assert.equal(decision("cd loc && prisma migrate reset --force"), null);
  });

  it("an 840 KB SQL file with no `;` judges in under 5 s through the hook (it hung before)", () => {
    const root = guardIn({});
    const project = repoWith({ "slow.sql": "drop x ".repeat(120_000) });
    const started = Date.now();
    const output = run(root, "claude", "psql -h db.example.com -f slow.sql", project);
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
    assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "ask");
  });

  it("still runs when the repo is reached through a symlink", () => {
    const root = guardIn({});
    const link = join(repoWith({}), "linked");
    symlinkSync(root, link);
    assert.equal(JSON.parse(run(link, "claude", "terraform destroy")).hookSpecificOutput.permissionDecision, "deny");
  });
});

// ── Infrastructure (infra.mdc): apply, destroy, state surgery, and cloud deletes, in every spelling ──
// [command, expected decision]. Each refused row is a spelling an agent could reach for: prefixes,
// full paths, -chdir, chains, `bash -c`, wrappers that run a command later in their arguments,
// substitutions, subshells, `eval`, and a shell fed on stdin.
const infraRefused = [
  ["terraform apply", "deny"],
  ["terraform apply -auto-approve", "deny"],
  ["terraform destroy", "deny"],
  ["tofu apply", "deny"],
  ["tofu destroy -auto-approve", "deny"],
  ["terraform -chdir=infra apply", "deny"],
  ["terraform -chdir infra apply", "deny"],
  ["/usr/local/bin/terraform apply", "deny"],
  ["./terraform destroy", "deny"],
  ["TF_LOG=debug terraform apply", "deny"],
  ["env AWS_PROFILE=prod terraform apply", "deny"],
  ["sudo -u deploy terraform apply", "deny"],
  ["cd infra && terraform apply", "deny"],
  ["terraform plan -out=p && terraform apply p", "deny"],
  ["terraform plan; terraform apply", "deny"],
  ["sh -c 'terraform apply'", "deny"],
  ["bash -lc \"cd infra && terraform destroy\"", "deny"],
  ["sudo -u bob bash -c 'terraform apply'", "deny"],
  ["timeout 600 terraform apply", "deny"],
  ["nohup terraform destroy &", "deny"],
  ["aws-vault exec prod -- terraform apply", "deny"],
  ["op run -- tofu apply", "deny"],
  ["echo infra | xargs -I{} terraform -chdir={} apply", "deny"],
  ["find . -name main.tf -execdir terraform destroy \\;", "deny"],
  ["(terraform apply)", "deny"],
  ["{ terraform apply; }", "deny"],
  ["echo $(terraform apply)", "deny"],
  ["echo \"$(terraform destroy -auto-approve)\"", "deny"],
  ["x=`terraform apply`", "deny"],
  ["eval \"terraform apply\"", "deny"],
  ["eval terraform destroy", "deny"],
  ["echo \"terraform apply\" | sh", "deny"],
  ["cat <<EOF | bash\nterraform destroy\nEOF", "deny"],
  ["bash <<EOF\ncd infra\nterraform apply\nEOF", "deny"],
  ["ssh bastion 'terraform apply'", "deny"],
  ["if terraform apply; then echo ok; fi", "deny"],
  ["for d in a b; do terraform -chdir=$d destroy; done", "deny"],
  ["terraform apply -destroy", "deny"],
  ["terraform state rm aws_db_instance.main", "deny"],
  ["terraform state push old.tfstate", "deny"],
  ["terraform workspace delete staging", "deny"],
  ["terraform state mv a b", "ask"],
  ["terraform import aws_s3_bucket.x y", "ask"],
  ["terraform force-unlock 123", "ask"],
  ["terragrunt apply", "deny"],
  ["terragrunt run-all destroy", "deny"],
  ["terragrunt run --all -- apply", "deny"],
  ["terraform_1.9.8 apply", "deny"],
  ["tf apply", "deny"],
  ["pnpm exec terraform apply", "deny"],
  ["npx terraform destroy", "deny"],
  ["time terraform apply", "deny"],
  ["nice -n 10 terraform apply", "deny"],
  ["aws ec2 terminate-instances --instance-ids i-1", "deny"],
  ["aws rds delete-db-cluster --db-cluster-identifier prod", "deny"],
  ["aws s3 rm s3://bucket/key", "deny"],
  ["aws s3 sync . s3://bucket --delete", "deny"],
  ["aws --profile prod dynamodb delete-table --table-name users", "deny"],
  ["aws-vault exec prod -- aws s3 rb s3://b --force", "deny"],
  ["gcloud sql instances delete prod", "deny"],
  ["gcloud storage rm -r gs://b", "deny"],
  ["az group delete -n prod --yes", "deny"],
  ["gsutil rm gs://b/x", "deny"],
  ["\"terraform\" apply", "deny"],
  ["terraform \"apply\"", "deny"],
  ["terraform apply>log", "deny"],
];

// What an agent does with infrastructure every day, and text that only mentions a refused command.
const infraAllowed = [
  ["terraform plan", null],
  ["terraform plan -destroy", null],
  ["terraform plan -out=apply.tfplan", null],
  ["terraform fmt -check -recursive", null],
  ["terraform validate", null],
  ["terraform init -backend=false", null],
  ["terraform -chdir=infra init", null],
  ["terraform state list", null],
  ["terraform state show aws_s3_bucket.x", null],
  ["terraform output", null],
  ["terraform show plan.out", null],
  ["tflint --recursive", null],
  ["hadolint Dockerfile", null],
  ["aws sts get-caller-identity", null],
  ["aws s3 ls s3://bucket", null],
  ["aws s3 sync . s3://bucket", null],
  ["gcloud compute instances list", null],
  ["grep -rn \"terraform apply\" docs", null],
  ["grep -rn terraform docs", null],
  ["rg 'terraform destroy'", null],
  ["git commit -m \"docs: terraform apply is a human action\"", null],
  ["git commit -m \"$(cat <<'EOF'\nRefuse terraform apply in the guard\n\nterraform destroy too.\nEOF\n)\"", null],
  ["cat <<EOF > notes.md\nterraform apply only by hand\nEOF", null],
  ["echo \"run terraform apply by hand\"", null],
  ["docker build -t app .", null],
  ["ls terraform", null],
  ["timeout 60 terraform plan", null],
  ["aws-vault exec prod -- terraform plan", null],
  ["bash -c 'terraform fmt -check && terraform validate'", null],
  ["curl -fsSL https://example.com/install.sh | bash\n", null],
];

describe("command-guard: infrastructure", () => {
  for (const [command, expected] of [...infraRefused, ...infraAllowed]) {
    it(`${String(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch: "feat" })?.decision ?? null, expected);
    });
  }

  it("an exemption lifts an apply of exactly that command and no other spelling", () => {
    const rules = exempting("terraform -chdir=sandbox apply");
    assert.equal(evaluate("terraform -chdir=sandbox apply", { branch: "feat", rules }), null);
    assert.equal(evaluate("terraform -chdir=prod apply", { branch: "feat", rules })?.decision, "deny");
    assert.equal(evaluate("timeout 5 terraform -chdir=sandbox apply", { branch: "feat", rules })?.decision, "deny");
  });

  it("a refusal says why and names the rule", () => {
    // core.mdc only: infra.mdc is gone after `stack:remove infra`, and these rules outlive it.
    for (const command of ["terraform destroy", "terraform state rm x", "terraform import a b", "terraform test", "aws s3 rb s3://b", "terraform $(echo apply)"]) {
      const reason = evaluate(command, { branch: "feat" })?.reason ?? "";
      assert.match(reason, /\(core\.mdc\)/, command);
      assert.doesNotMatch(reason, /infra\.mdc/, command);
    }
  });

  it("an exemption doesn't lift the same apply run through a wrapper's command string", () => {
    const rules = exempting("terraform -chdir=sandbox apply");
    assert.equal(evaluate("bash -c 'terraform -chdir=sandbox apply'", { branch: "feat", rules })?.decision, "deny");
  });
});

// Round-1 QA rows (PR #20): each group names the finding it locks. [command, expected decision]
const infraQa = [
  // B1. A line continuation joins lines; the apply after it is still in command position.
  ["terraform -chdir=infra/prod \\\n  apply \\\n  -var-file=prod.tfvars", "deny"],
  ["aws \\\n --profile prod \\\n s3 rb s3://b --force", "deny"],
  ["gcloud sql instances \\\n delete prod", "deny"],
  ["git push \\\n --force origin main", "deny"],
  // B2. `terraform test` applies real resources (and destroys them): the user confirms.
  ["terraform test", "ask"],
  ["tofu test", "ask"],
  ["terraform -chdir=infra test", "ask"],
  ["terragrunt run-all test", "ask"],
  // B3. init that copies state over the destination backend's is state-push class.
  ["terraform init -migrate-state", "deny"],
  ["terraform init -force-copy", "deny"],
  ["terraform init -reconfigure -force-copy", "deny"],
  ["tofu -chdir=infra init -migrate-state -input=false", "deny"],
  ["terraform init -reconfigure", null],
  // S1. Backticks the shell never runs: single quotes and quoted-terminator heredoc bodies.
  ["git commit -F - <<'EOF'\nfeat: refuse `terraform apply` in the guard\nEOF", null],
  ["git commit -m 'docs: never run `terraform destroy` yourself'", null],
  ["gh pr create --draft --body \"$(cat <<'EOF'\nThe guard refuses `terraform apply`; don't run it.\nEOF\n)\"", null],
  ["cat > docs/x.md <<'EOF'\nRun `tofu destroy` by hand only.\nEOF", null],
  // …and the ones it does run: an unquoted-terminator body and double quotes expand them.
  ["cat > notes.md <<EOF\nrun `terraform apply`\nEOF", "deny"],
  ["echo \"`terraform destroy`\"", "deny"],
  // S2. Parentheses in a message are text, not a subshell.
  ["git commit -F - <<'EOF'\nfix(infra): explain terraform apply (and destroy)\nEOF", null],
  ["git commit -F - <<EOF\nfix(guard): terraform apply stays a human action\nEOF", null],
  ["git commit -m \"feat(infra): never terraform apply\"", null],
  // S3. A wrapper runs its program word; its quoted arguments are data, unless it takes a command string.
  ["env LC_ALL=C grep -rn 'terraform apply' docs", null],
  ["sudo grep -rn 'terraform destroy' /etc", null],
  ["timeout 5 grep -rn 'terraform apply' docs", null],
  ["if grep -q 'terraform apply' docs/x.md; then echo found; fi", null],
  ["find . -exec grep -l 'terraform destroy' {} +", null],
  ["xargs grep -l 'terraform apply'", null],
  ["pnpm test -- -t 'terraform destroy'", null],
  ["time rg 'aws s3 rb' docs", null],
  ["sudo -iu deploy terraform apply", "deny"],
  ["env -S 'terraform apply'", "deny"],
  ["su - deploy -c 'terraform destroy'", "deny"],
  ["watch -n 5 terraform apply", "deny"],
  ["nix-shell --run 'terraform apply'", "deny"],
  ["parallel terraform -chdir={} apply ::: a b", "deny"],
  ["terraform 2>/dev/null apply", "deny"],
  // S4. A cloud delete is the operation, not any word that starts with delete.
  ["aws lambda invoke --function-name delete-user out.json", null],
  ["aws ssm get-parameter --name delete-me", null],
  ["gcloud compute instances describe delete-me", null],
  ["gcloud functions call delete-user", null],
  ["az vm show -n delete -g g", null],
  ["gsutil cp rm gs://b/", null],
  ["aws s3 sync . s3://b --exclude delete-me", null],
  ["terragrunt plan --terragrunt-working-dir apply", null],
  ["terragrunt --terragrunt-non-interactive apply", "deny"],
  // S5. Deletes under other verbs.
  ["aws ecr batch-delete-image --repository-name r --image-ids imageTag=x", "deny"],
  ["aws sqs purge-queue --queue-url https://sqs/q", "deny"],
  ["aws ec2 deregister-image --image-id ami-1", "deny"],
  ["aws kms disable-key --key-id k", "deny"],
  ["aws --region us-east-1 kms schedule-key-deletion --key-id k", "deny"],
  ["gcloud kms keys versions destroy 1 --key k --keyring r --location l", "deny"],
  ["gcloud kms keys versions disable 1 --key k --keyring r --location l", "deny"],
  ["az keyvault purge --name v", "deny"],
  ["az keyvault key purge --vault-name v --name k", "deny"],
  ["gsutil rsync -d ./local gs://b", "deny"],
  ["gsutil -m rsync -r -d gs://a gs://b", "deny"],
  ["aws s3 mv s3://b/x ./x", "deny"],
  ["aws s3 mv --exclude '*.tmp' s3://a s3://b", "deny"],
  ["gsutil mv gs://b/x ./x", "deny"],
  ["bq rm -f -t proj:ds.table", "deny"],
  ["aws s3 mv ./x s3://b/x", null],
  ["gsutil mv ./x gs://b/x", null],
  ["gsutil rsync -r ./local gs://b", null],
  ["gcloud kms keys versions list --key k --keyring r --location l", null],
  ["gcloud services disable delete-api", null],
  ["bq ls", null],
  // S6. Words joined from quoted and bare parts, with escapes, read as the shell reads them.
  ["terraform -chdir=\"my dir\" destroy -auto-approve", "deny"],
  ["terraform -chdir='prod infra' apply", "deny"],
  ["terraform ap'p'ly", "deny"],
  ["\"terra\"form apply", "deny"],
  ["terraform a\\pply", "deny"],
  ["terraform $'apply'", "deny"],
  ["terraform $'\\x61pply'", "deny"],
  // S7. A program or verb that expands at run time, on a line about IaC: the user confirms.
  ["\"$TF\" apply", "ask"],
  ["${TERRAFORM_BIN} destroy", "ask"],
  ["$(which terraform) apply", "ask"],
  ["terraform $(echo apply)", "ask"],
  ["echo apply | xargs terraform", "ask"],
  ["\"$EDITOR\" notes.md", null],
  ["$HOME/bin/terraform apply", "deny"],
  // S8. A shell fed on stdin, through every road.
  ["echo terraform apply|bash", "deny"],
  ["bash -s <<<'terraform apply'", "deny"],
  ["echo 'terraform apply' | sudo -u x bash", "deny"],
  ["echo 'terraform apply' | busybox sh", "deny"],
  ["bash <<'EOF'\nterraform destroy\nEOF", "deny"],
  ["echo hi | bash", null],
  // Nits: help, a pipe inside quotes, case, tfenv.
  ["terraform apply -help", null],
  ["terraform destroy --help", null],
  ["terraform help apply", null],
  ["aws ec2 terminate-instances help", null],
  ["gcloud help sql instances delete", null],
  ["az group delete -h", null],
  ["gsutil -h 'Cache-Control:no-cache' rm gs://b/x", "deny"],
  ["git commit -m \"docs: never echo terraform apply | sh\"", null],
  ["TERRAFORM apply", "deny"],
  ["Terraform.exe destroy", "deny"],
  ["AWS s3 rb s3://b", "deny"],
  ["tfenv exec apply", "deny"],
  ["tofuenv exec destroy -auto-approve", "deny"],
  ["tfenv exec plan", null],
];

describe("command-guard: infrastructure, round-1 QA", () => {
  for (const [command, expected] of infraQa) {
    it(`${JSON.stringify(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch: "feat" })?.decision ?? null, expected);
    });
  }

  it("asks, rather than crashing or recursing on, nesting deeper than it reads", () => {
    assert.equal(evaluate(`echo ${"$(echo ".repeat(40)}hi${")".repeat(40)}`, { branch: "feat" })?.decision, "ask");
    assert.equal(evaluate(`${"nohup ".repeat(100)}terraform plan`, { branch: "feat" })?.decision, "ask");
  });

  // S9: a pattern that backtracks times the hook out, and a timed-out hook lets the command run.
  // Budgets lifted, so this times the parser itself, not the size gate in front of it; 1 s leaves
  // room for a machine running the suite in parallel, and a backtracking pattern takes far longer.
  it("evaluates a 200k-character heredoc, or line, in under 1 s with the budgets lifted", () => {
    const bodies = ["a".repeat(200_000), "|x".repeat(100_000), "/ |".repeat(66_667), "$(".repeat(100_000), '"a'.repeat(100_000), "`(".repeat(100_000), "<<x\n".repeat(50_000)];
    const lines = [...bodies.flatMap((body) => [`git commit -F - <<'EOF'\n${body}\nEOF`, `cat <<EOF | sh\n${body}\nEOF`]), `echo ${"x".repeat(200_000)}`, `echo ${"/x ".repeat(66_667)}`];
    for (const line of lines) {
      const started = performance.now();
      evaluate(line, { branch: "feat", limits: UNBOUNDED });
      const took = performance.now() - started;
      assert.ok(took < 1000, `${JSON.stringify(line.slice(0, 40))}… took ${Math.round(took)} ms`);
    }
  });
});

// Round-2 QA rows (PR #20): each group names the finding it locks. [command, expected decision]
const infraQa2 = [
  // B2. A function body is a command; `function` names it, it doesn't hide it.
  ["function f { terraform apply; }; f", "deny"],
  ["function f { terraform destroy -auto-approve; }", "deny"],
  ["function f() { terraform apply; }; f", "deny"],
  ["f() { terraform apply; }; f", "deny"],
  ["coproc terraform apply", "deny"],
  ["coproc tf { terraform apply; }", "deny"],
  // S3. Heredoc terminators: bash matches the whole line exactly, after quote removal of the whole word.
  ["cat <<EOF\nEOF \n: <<'X'\nEOF\nterraform apply\nX", "deny"],
  ["cat <<EOF\n  EOF\n: <<'X'\nEOF\nterraform apply\nX", "deny"],
  ["cat <<E\\OF\nEOF\nterraform apply", "deny"],
  ['cat <<"E"OF\nx\nEOF\nterraform apply\nE', "deny"],
  ["cat <<'E'OF\nx\nEOF\nterraform apply\nE", "deny"],
  ["cat <<EOF\nEOF \n: <<'X'\nEOF\ngit push --force origin main\nX", "deny"],
  ["cat <<E\\OF\nEOF\ngit push --force origin main", "deny"],
  ['cat <<"E"OF\nx\nEOF\ngit push --force origin main\nE', "deny"],
  ["cat <<'E'OF\nx\nEOF\ngit push --force origin main\nE", "deny"],
  ["cat <<EOF && git push --force origin main\nbody\nEOF", "deny"],
  ["sh <<-EOF\n\tterraform destroy\n\tEOF", "deny"],
  ["git commit -F - <<'EOF'\nfeat: x\n\n  EOF\nstill the message: terraform apply\nEOF", null],
  // S3. Substitution spans: comments, case patterns, `$'…'`, and `${…}` end where bash ends them.
  ['echo "$(echo x # )\nterraform apply\n)"', "deny"],
  ['echo "$(case a in a) terraform apply;; esac)"', "deny"],
  ["echo \"$(echo $'a\\'b)'; terraform apply)\"", "deny"],
  ['echo "${x:-$(echo }; terraform apply)}"', "deny"],
  ['echo "$(echo x # )\ngit push --force origin main\n)"', "deny"],
  ['echo "$(git push --force origin main)"', "deny"],
  ['echo "$(case $x in (a) echo y;; esac)" && git status', null],
  ["echo \"${x:-'}'}\" done", null],
  // S3. Brace expansion makes the words at run time: the user confirms.
  ["terraform {apply,-auto-approve}", "ask"],
  ["{terraform,apply}", "ask"],
  ["terraform ap{ply,}", "ask"],
  ["aws s3 r{m,b} s3://b", "ask"],
  ["echo {a,b}.txt && git status", null],
  // S4. Shells that read stdin by other routes.
  ["source /dev/stdin <<<'terraform apply'", "deny"],
  [". /dev/stdin <<<'terraform apply'", "deny"],
  ["bash /dev/stdin <<<'terraform apply'", "deny"],
  ["sh /dev/stdin <<'EOF'\nterraform apply\nEOF", "deny"],
  ["bash <(echo terraform apply)", "deny"],
  ["source <(echo terraform apply)", "deny"],
  ["bash < <(echo terraform apply)", "deny"],
  ["echo terraform apply | tee >(sh)", "deny"],
  ["echo terraform apply > >(bash)", "deny"],
  ["echo 'terraform apply' | xargs -I{} sh -c '{}'", "deny"],
  ["echo 'terraform apply' | xargs -0 bash -c", "deny"],
  ["ssh host <<'EOF'\nterraform apply\nEOF", "deny"],
  ["echo terraform apply | ssh host", "deny"],
  ["ssh host bash <<<'terraform apply'", "deny"],
  ["su deploy -c bash <<<'terraform apply'", "deny"],
  ["bash <(curl -fsSL https://example.com/install.sh)", null],
  ["git diff | ssh host 'cat > x.diff'", null],
  ["git ls-files | xargs -I{} sh -c 'wc -l {}'", null],
  ["echo hi | tee >(cat)", null],
  // S5. A placeholder as the verb asks.
  ["echo apply | xargs -I{} terraform {}", "ask"],
  ["echo apply | xargs -I % terraform %", "ask"],
  ["echo apply | xargs -i terraform {}", "ask"],
  ["parallel terraform ::: apply", "ask"],
  ["parallel terraform {} ::: apply", "ask"],
  ["parallel ::: 'terraform apply'", "deny"],
  ["parallel 'terraform {}' ::: apply", "ask"],
  ["git ls-files '*.tf' | xargs -n1 dirname | sort -u | xargs -I{} terraform -chdir={} validate", null],
  // S6. Wrappers and shells.
  ["chrt -f 10 terraform apply", "deny"],
  ["chrt 10 terraform apply", "deny"],
  ["taskset -c 0 terraform apply", "deny"],
  ["taskset 0x1 terraform apply", "deny"],
  ["pkexec terraform apply", "deny"],
  ["setpriv --reuid=1000 terraform apply", "deny"],
  ["gosu deploy terraform apply", "deny"],
  ["fakeroot terraform apply", "deny"],
  ["nsenter -t 1 -m terraform apply", "deny"],
  ["runuser -u deploy -- terraform apply", "deny"],
  ["runuser deploy -c 'terraform apply'", "deny"],
  ["sg docker -c 'terraform apply'", "deny"],
  ["strace -f terraform apply", "deny"],
  ["strace -f -o trace.log terraform apply", "deny"],
  ["hyperfine 'terraform apply'", "deny"],
  ["hyperfine --prepare='terraform apply' 'ls'", "deny"],
  ["trap 'terraform apply' EXIT", "deny"],
  ["git submodule foreach 'terraform apply'", "deny"],
  ["git submodule foreach --recursive terraform destroy", "deny"],
  ["git rebase -x 'terraform apply' main", "deny"],
  ["git bisect run terraform apply", "deny"],
  ["ash -c 'terraform apply'", "deny"],
  ["busybox ash -c 'terraform apply'", "deny"],
  ["mksh -c 'terraform apply'", "deny"],
  ["fish --command 'terraform apply'", "deny"],
  ["fish -C 'terraform apply'", "deny"],
  ["pwsh -c 'terraform apply'", "deny"],
  ["pwsh -Command 'terraform apply'", "deny"],
  ['powershell -Command "terraform apply"', "deny"],
  ["powershell terraform apply", "deny"],
  ["pwsh -EncodedCommand dABlAHIAcgBhAGYAbwByAG0A", "ask"],
  ["shopt -s expand_aliases\nalias x=terraform\nx apply", "deny"],
  ["alias tfa='terraform apply'", "deny"],
  ["alias tfa='terraform apply'\ntfa", "deny"],
  ["alias ll='ls -l'\nll", null],
  ["chrt -p 1234", null],
  ["git submodule foreach git pull", null],
  ["trap - EXIT", null],
  ["hyperfine 'pnpm test' 'pnpm lint'", null],
  // S7. Cloud deletes that got through.
  ["gcloud deploy delivery-pipelines delete p --region r", "deny"],
  ["gcloud storage mv gs://b/x ./x", "deny"],
  ["gcloud storage rsync ./d gs://b --delete-unmatched-destination-objects", "deny"],
  ["az storage remove -c c --recursive", "deny"],
  ["az storage blob sync -c c -s d --delete-destination true", "deny"],
  ["az storage blob sync -c c -s d", "ask"],
  ["az storage blob sync -c c -s d --delete-destination false", null],
  ["bq --service_account x@y rm -f ds.t", "deny"],
  ["bq query 'DROP TABLE ds.t'", "deny"],
  ["bq query --nouse_legacy_sql 'DELETE FROM ds.t WHERE true'", "deny"],
  ["gcloud spanner databases execute-sql db --sql='DROP TABLE t'", "deny"],
  ["aws rds-data execute-statement --sql 'DROP TABLE t' --resource-arn a", "deny"],
  ["cdktf deploy", "deny"],
  ["cdktf destroy", "deny"],
  ["npx cdk deploy --all", "deny"],
  ["cdk bootstrap", "ask"],
  ["terramate run terraform apply", "deny"],
  ["terramate run -- terraform destroy", "deny"],
  ["gcloud deploy releases list --delivery-pipeline p", null],
  ["gcloud storage mv ./x gs://b/x", null],
  ["gcloud storage rsync ./d gs://b", null],
  ["bq query 'SELECT 1'", null],
  ["cdk diff", null],
  ["cdktf synth", null],
  ["terramate run terraform plan", null],
  // Nits.
  ["git apply fix.patch && $HOME/bin/check", null],
  ["\"$(git rev-parse --show-toplevel)\"/scripts/check.sh && git commit -m 'apply review'", null],
  ["TF=terraform; V=apply; $TF $V", "ask"],
  ["aws s3 rb help", null],
  ["aws s3 rm help", null],
  ["env -vS 'terraform apply'", "deny"],
  ['env -S"terraform apply"', "deny"],
  ["env -iS 'terraform apply'", "deny"],
  ["env - terraform apply", "deny"],
  ["env -u HOME terraform apply", "deny"],
];

describe("command-guard: infrastructure, round-2 QA", () => {
  for (const [command, expected] of infraQa2) {
    it(`${JSON.stringify(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch: "feat" })?.decision ?? null, expected);
    });
  }

  it("an exemption doesn't lift after a cd, pushd, or popd on the same line", () => {
    const rules = exempting("terraform -chdir=sandbox apply");
    for (const command of ["cd ../prod && terraform -chdir=sandbox apply", "pushd ../prod; terraform -chdir=sandbox apply", "popd; terraform -chdir=sandbox apply"]) {
      assert.equal(evaluate(command, { branch: "feat", rules })?.decision, "deny", command);
    }
    const dropRules = exempting("dropdb app_test");
    assert.equal(evaluate("dropdb app_test", { branch: "feat", rules: dropRules }), null);
    assert.equal(evaluate("cd /srv/prod && dropdb app_test", { branch: "feat", rules: dropRules })?.decision, "deny");
  });
});

// A line wrapped in `wrap` eight times (the guard's nesting depth), starting from `seed`.
const nest = (wrap, seed) => {
  let line = seed;
  for (let k = 0; k < 8; k += 1) line = wrap(line);
  return line;
};

// The biggest `shape(n)`, n a power of two, that fits the default size budget.
const fill = (shape) => {
  let n = 1;
  while (shape(n * 2).length <= LIMITS.chars) n *= 2;
  return shape(n);
};

// Best of three timings of one evaluate().
const best = (line, limits) =>
  Math.min(
    ...[1, 2, 3].map(() => {
      const started = performance.now();
      evaluate(line, { branch: "feat", limits });
      return performance.now() - started;
    }),
  );

// Wall-clock bound for one evaluate() with the default limits: the 250 ms budget plus headroom for a
// loaded CI runner (the worst shape measured 255 ms on an idle one). The round-2 quadratics took
// 2–15 s, so this still catches them, and the hook's watchdog stays well above it.
const BOUND_MS = 1500;

describe("command-guard: budgets and failures fail closed to ask", () => {
  it("asks, without parsing, for a line over the size budget", () => {
    // "Without parsing" is proven by the reason (the size gate answers before the parser runs),
    // not by the wall clock: a 50 ms bound flaked on loaded CI runners. BOUND_MS still catches a
    // gate that parses first.
    const line = `git commit -F - <<'EOF'\n${"a".repeat(LIMITS.chars)}\nEOF`;
    const started = performance.now();
    const verdict = evaluate(line, { branch: "feat" });
    const took = performance.now() - started;
    assert.ok(took < BOUND_MS, `took ${Math.round(took)} ms`);
    assert.equal(verdict?.decision, "ask");
    assert.match(verdict?.reason ?? "", /character budget/);
  });

  it("reads a line just under the size budget", () => {
    assert.equal(evaluate(`git commit -F - <<'EOF'\n${"a ".repeat(LIMITS.chars / 2 - 30)}\nEOF`, { branch: "feat" }), null);
  });

  it("asks when the time budget is spent, and the next call has a fresh budget", () => {
    const verdict = evaluate(`${"true;".repeat(20_000)}git status`, { branch: "feat", limits: { chars: Number.POSITIVE_INFINITY, ms: 0 } });
    assert.equal(verdict?.decision, "ask");
    assert.match(verdict?.reason ?? "", /0 ms budget/);
    assert.equal(evaluate("terraform apply", { branch: "feat" })?.decision, "deny");
  });

  it("asks, naming the error, when evaluating throws", () => {
    // A rule whose matcher throws stands in for any parser bug.
    const throwing = { deny: [{ match: { test: () => { throw new Error("boom in a rule"); } }, unless: null, reason: "x", file: "f.json", project: true }], ask: [], allow: new Set(), error: "" };
    const verdict = evaluate("ls", { branch: "feat", rules: throwing });
    assert.equal(verdict?.decision, "ask");
    assert.match(verdict?.reason ?? "", /boom in a rule/);
  });

  it("the hook asks, for both hosts, when its input can't be read", () => {
    const root = guardIn({});
    const env = { ...process.env };
    delete env["WHIPPLETREE_GUARD"];
    const raw = (host) => execFileSync(process.execPath, [join(root, "scripts", "command-guard.mjs"), host], { input: "{ not json", env, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    assert.equal(JSON.parse(raw("claude")).hookSpecificOutput.permissionDecision, "ask");
    assert.equal(JSON.parse(raw("cursor")).permission, "ask");
  });

  // The round-2 quadratics, each at a size that took 2–15 s (shape(n) builds the line): ask or deny
  // in under BOUND_MS with the default limits, under the watchdog the hook relies on. With the budgets
  // lifted, the parser itself must be linear: under 1 s at n (each quadratic took 1.8 s or more
  // there), or else 4× the input in under 8× the time (a quadratic takes 16×), best of three, so a
  // busy machine running the suite in parallel can't flake it.
  const shapes = [
    { label: "a pipeline of shells (printed words built once)", size: 6000, shape: (n) => `echo hi${"|sh".repeat(n)};terraform apply` },
    { label: "assignments (asAssigned)", size: 50_000, shape: (n) => `${"A=1 ".repeat(n)}terraform apply` },
    { label: "assignments behind env", size: 70_000, shape: (n) => `env ${"A=1 ".repeat(n)}terraform apply` },
    { label: "dynamic programs (the line read once)", size: 50_000, shape: (n) => `${"$x;".repeat(n)}terraform apply` },
    { label: "xargs with no verb", size: 10_000, shape: (n) => `${"echo x|xargs terraform;".repeat(n)}terraform apply` },
  ];
  for (const { label, size, shape } of shapes) {
    it(`${label}, n=${String(size)}: ask or deny in under ${String(BOUND_MS)} ms with the default limits`, () => {
      const started = performance.now();
      const verdict = evaluate(shape(size), { branch: "feat" });
      const took = performance.now() - started;
      assert.ok(took < BOUND_MS, `${label} took ${Math.round(took)} ms`);
      assert.ok(["ask", "deny"].includes(verdict?.decision ?? ""), `${label} → ${String(verdict?.decision)}`);
    });
    it(`${label}: linear with the budgets lifted`, () => {
      const small = best(shape(size / 4), UNBOUNDED);
      const large = best(shape(size), UNBOUNDED);
      assert.equal(evaluate(shape(size), { branch: "feat", limits: UNBOUNDED })?.decision, "deny");
      assert.ok(large < 1000 || large < small * 8, `${label}: ${Math.round(small)} ms at n/4, ${Math.round(large)} ms at n`);
    });
  }

  // Shapes that are linear but heavy (nested substitutions read at each level): at the size budget
  // the default limits hold them under the hook's timeout by a wide margin.
  it(`the worst shapes at the size budget finish in under ${String(BOUND_MS)} ms with the default limits`, () => {
    const lines = [
      fill((n) => `echo hi${"|sh".repeat(n)};terraform apply`),
      fill((n) => nest((s) => `sh -c "$(${s})"`, `echo ${"y ".repeat(n)}`)),
      fill((n) => nest((s) => `bash <<<"$(${s})"`, `echo ${"y ".repeat(n)}`)),
      fill((n) => `echo terraform apply${"|tee >(sh)".repeat(n)}`),
      fill((n) => `echo $(${"case a in a) ".repeat(n)})`),
    ];
    for (const line of lines) {
      const started = performance.now();
      evaluate(line, { branch: "feat" });
      const took = performance.now() - started;
      assert.ok(took < BOUND_MS, `${JSON.stringify(line.slice(0, 30))}… took ${Math.round(took)} ms`);
    }
  });
});

// ── Round-3 QA (PR #20): bounded branch lookups, the hook's watchdog, wrappers, and the fallback ──

// Spins for `ms` on this thread, the way a git blocked on a FIFO holds up a synchronous lookup.
const busy = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

// Makes a FIFO with the system's mkfifo (Node has no API for it), with no shell in between.
const fifoAt = (path) => {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("mkfifo", [path]);
  return path;
};

// Runs the hook as Claude Code would, killed after 3× the watchdog so a hang fails the test
// instead of the suite. Returns Claude's hookSpecificOutput (null for silence) and the wall time.
const hookTimed = (root, command) => {
  const env = { ...process.env };
  delete env["WHIPPLETREE_GUARD"];
  const started = performance.now();
  const output = execFileSync(process.execPath, [join(root, "scripts", "command-guard.mjs"), "claude"], { input: JSON.stringify({ tool_input: { command }, cwd: tmpdir() }), env, encoding: "utf8", timeout: WATCHDOG_MS * 3, stdio: ["pipe", "pipe", "ignore"] });
  return { output: output === "" ? null : JSON.parse(output).hookSpecificOutput, ms: performance.now() - started };
};

describe("command-guard: branch lookups are bounded (round-3 B1)", () => {
  it("looks each directory up once, however many commits and pushes run there", () => {
    const seen = [];
    const branchIn = (dir) => {
      seen.push(dir);
      return "feat/x";
    };
    const verdict = evaluate('cd ../x && git commit -m "a [skip ci]" && git commit -m "b [skip ci]"; git push --force; git -C ../x push', { branch: "feat", branchIn });
    assert.equal(verdict?.decision, "deny");
    assert.deepEqual(seen, ["../x"]);
  });

  it("looks nothing up for a line of plain commands after a cd (5000 of them)", () => {
    // Counts the work (lookups), not the time: with the default 250 ms budget a loaded CI runner
    // spent the budget on 5000 commands and the verdict became "ask", so lift the budgets here.
    let calls = 0;
    const branchIn = () => {
      calls += 1;
      return "feat";
    };
    assert.equal(evaluate(`cd .;${"true;".repeat(5000)}git status`, { branch: "feat", branchIn, limits: UNBOUNDED }), null);
    assert.equal(calls, 0);
  });

  it("asks once a slow lookup spends the time budget, without a second lookup", () => {
    // Each lookup blocks for 2 s; on "dev" the commits would pass, so only the clock read after
    // the first lookup turns this into an ask (without it: two lookups, 4 s, and no verdict).
    let calls = 0;
    const branchIn = () => {
      calls += 1;
      busy(2000);
      return "dev";
    };
    const verdict = evaluate('cd ../a && git commit -m "x [skip ci]"; cd ../b && git commit -m "y [skip ci]"', { branch: "feat", branchIn });
    assert.equal(verdict?.decision, "ask");
    assert.match(verdict?.reason ?? "", /250 ms budget/);
    assert.equal(calls, 1);
  });

  it("the hook asks, within the watchdog, for a push in a repo whose .git/HEAD is a FIFO", () => {
    // git blocks opening the FIFO forever; the lookup's own timeout kills it. Without that, the
    // hook sits in a blocked child process the watchdog can't stop, and never answers.
    const repo = repoWith({ ".git/objects/.keep": "", ".git/refs/.keep": "" });
    fifoAt(join(repo, ".git", "HEAD"));
    const { output, ms } = hookTimed(guardIn({}), `git -C ${repo} push --force`);
    assert.equal(output?.permissionDecision, "ask");
    assert.ok(ms < WATCHDOG_MS, `took ${Math.round(ms)} ms`);
  });
});

describe("command-guard: the hook's watchdog (round-3 design)", () => {
  it("asks, naming the watchdog, when evaluation never finishes (a rule pattern that backtracks)", () => {
    // `^(a+)+$` against 40 a's and a `!` takes far longer than any hook timeout, and a regex never
    // calls tick(); only the watchdog stopping the evaluation gets an answer out.
    const root = guardIn({ "command-guard.project.json": { deny: [{ match: "^(a+)+$", reason: "Backtracks." }] } });
    const { output, ms } = hookTimed(root, `${"a".repeat(40)}!`);
    assert.equal(output?.permissionDecision, "ask");
    assert.match(output?.permissionDecisionReason ?? "", new RegExp(`${String(WATCHDOG_MS)} ms watchdog`));
    assert.ok(ms < WATCHDOG_MS * 2, `took ${Math.round(ms)} ms`);
  });

  it("refuses everything, quickly, when a rule file is a FIFO (a read that would block the hook)", () => {
    const root = guardIn({});
    fifoAt(join(root, "command-guard.project.json"));
    const { output, ms } = hookTimed(root, "ls");
    assert.equal(output?.permissionDecision, "deny");
    assert.match(output?.permissionDecisionReason ?? "", /not a regular file/);
    assert.ok(ms < WATCHDOG_MS, `took ${Math.round(ms)} ms`);
  });

  it("answers an everyday command with silence, as before", () => {
    assert.equal(hookTimed(guardIn({}), "git status").output, null);
  });
});

describe("command-guard: evaluate() forwards every option (round-3 B2)", () => {
  it("an option evaluate() doesn't name reaches the line evaluator, nested lines too", () => {
    // branchIn is called as a method of the options the line evaluator holds, so `this` shows
    // what reached it: a rule added later (#21's targetIn) relies on the same forwarding.
    const reached = [];
    const options = {
      branch: "feat",
      branchIn(dir) {
        reached.push([dir, this.probe]);
        return "feat";
      },
      probe: "forwarded",
    };
    evaluate("git -C ../top push origin HEAD; bash -c 'git -C ../nested push origin HEAD'; echo $(git -C ../sub push origin HEAD)", options);
    assert.deepEqual(reached, [
      ["../top", "forwarded"],
      ["../nested", "forwarded"],
      ["../sub", "forwarded"],
    ]);
  });
});

describe("command-guard: span scanners cap their nesting (round-3 nit)", () => {
  it("asks by design, naming the depth, rather than overflowing the stack", () => {
    const verdict = evaluate(`echo ${"${x:-$(".repeat(5000)}`, { branch: "feat" });
    assert.equal(verdict?.decision, "ask");
    assert.match(verdict?.reason ?? "", /more than \d+ levels deep/);
  });

  it("still reads ordinary nesting", () => {
    assert.equal(evaluate('echo "${x:-$(echo "${y:-$(terraform apply)}")}"', { branch: "feat" })?.decision, "deny");
  });
});

// Round-3 S1/S2 rows: wrappers that run `terraform apply`, the fallback for unknown runners, and
// the cheap object-storage and PaaS deletes. [command, expected decision]
const infraQa3 = [
  // S1. Containers and pods: the program after the container, service, or `--`.
  ["docker exec c terraform apply", "deny"],
  ["docker exec -it -e TF_LOG=1 -w /infra c terraform apply", "deny"],
  ["docker compose exec infra terraform apply", "deny"],
  ["docker compose -f ops.yml run --rm infra terraform destroy", "deny"],
  ["docker-compose run --rm infra tofu apply", "deny"],
  ["podman exec c terraform destroy", "deny"],
  ["kubectl exec pod -- terraform apply", "deny"],
  ["kubectl exec -it pod -c box -- tofu destroy", "deny"],
  ["docker exec c terraform plan", null],
  ["docker compose run --rm app pnpm test", null],
  ["kubectl exec pod -- ls", null],
  ["kubectl get pods", null],
  ["docker build -t app .", null],
  // S1. Package runners, secret and environment wrappers.
  ["bunx terraform apply", "deny"],
  ["dotenvx run -- terraform apply", "deny"],
  ["envchain prod terraform apply", "deny"],
  ["sops exec-env secrets.yaml 'terraform apply'", "deny"],
  ["sops exec-env secrets.yaml 'terraform plan'", null],
  ["sops -d secrets.yaml", null],
  // S1. Sandboxes, proxies, watchers, debuggers.
  ["firejail terraform apply", "deny"],
  ["firejail --noprofile terraform destroy", "deny"],
  ["proxychains terraform apply", "deny"],
  ["proxychains4 -q -f p.conf terraform apply", "deny"],
  ["torsocks terraform apply", "deny"],
  ["watchexec -- terraform apply", "deny"],
  ["watchexec -e tf -c terraform apply", "deny"],
  ["entr -r terraform apply <<<main.tf", "deny"],
  ["entr -s 'terraform apply' <<<main.tf", "deny"],
  ["entr -r pnpm test <<<x.ts", null],
  ["fd -e tf -x terraform apply", "deny"],
  ["fd -e tf -X terraform {}", "ask"],
  ["fd -e tf -x terraform fmt", null],
  ["gdb -batch -ex run --args terraform apply", "deny"],
  // S1. git runs core.sshCommand / GIT_SSH_COMMAND through sh when it connects.
  ["git -c core.sshCommand='terraform apply' fetch", "deny"],
  ["git -c core.sshcommand='terraform destroy' pull", "deny"],
  ["GIT_SSH_COMMAND='terraform apply' git fetch", "deny"],
  ["env GIT_SSH_COMMAND='terraform destroy' git pull", "deny"],
  ["GIT_SSH_COMMAND='ssh -i ~/.ssh/deploy' git fetch", null],
  ["git -c core.sshCommand='ssh -i key' fetch", null],
  // S1. Fallback: an unknown program given an IaC CLI word and a destructive verb asks.
  ["unshare -r terraform apply", "ask"],
  ["systemd-run --user terraform apply", "ask"],
  ["docker run --rm hashicorp/terraform apply", "ask"],
  ["make terraform destroy", "ask"],
  ["unshare -r terraform state rm x", "ask"],
  ["docker run --rm hashicorp/terraform plan", null],
  ["grep -rn terraform apply.log", null],
  ["rg terraform apply", null],
  ["git log --grep terraform apply", null],
  ["ls terraform apply", null],
  // S2. Object storage: deletes, syncs that delete, moves from a remote.
  ["rclone purge r:bucket", "deny"],
  ["rclone delete r:bucket/x", "deny"],
  ["rclone sync . r:bucket", "deny"],
  ["rclone --config c.conf sync . r:bucket", "deny"],
  ["rclone move r:bucket/x ./local", "deny"],
  ["rclone copy . r:bucket", null],
  ["rclone move ./x r:bucket", null],
  ["rclone ls r:bucket", null],
  ["s5cmd rm 's3://b/*'", "deny"],
  ["s5cmd --endpoint-url http://x rb s3://b", "deny"],
  ["s5cmd sync --delete . s3://b", "deny"],
  ["s5cmd cp x s3://b/", null],
  ["s5cmd sync . s3://b", null],
  ["mc rb --force local/b", "deny"],
  ["mc rm --recursive local/b/x", "deny"],
  ["mc mirror --remove ./site local/b", "deny"],
  ["mc ls local", null],
  ["mc mirror ./site local/b", null],
  ["s3cmd del --recursive s3://b", "deny"],
  ["s3cmd sync --delete-removed . s3://b", "deny"],
  ["s3cmd ls s3://b", null],
  ["azcopy rm https://a.blob.core.windows.net/c --recursive", "deny"],
  ["azcopy sync . https://a/c --delete-destination=true", "deny"],
  ["azcopy sync . https://a/c --delete-destination prompt", "deny"],
  ["azcopy sync . https://a/c", null],
  ["azcopy copy x https://a/c", null],
  // S2. A raw DELETE through az, and PaaS destroys.
  ["az rest --method delete --url https://management.azure.com/x", "deny"],
  ["az rest -m DELETE --url https://management.azure.com/x", "deny"],
  ["az rest --method=delete --url u", "deny"],
  ["az rest --method get --url https://management.azure.com/x", null],
  ["doctl databases delete id", "deny"],
  ["doctl compute droplet rm web-1", "deny"],
  ["doctl compute droplet list", null],
  ["flyctl apps destroy app", "deny"],
  ["fly destroy app", "deny"],
  ["fly volumes delete vol_1", "deny"],
  ["fly deploy", null],
  ["fly status", null],
  ["heroku apps:destroy app --confirm app", "deny"],
  ["heroku pg:reset DATABASE", "deny"],
  ["heroku logs --tail", null],
  ["rclone help sync", null],
];

describe("command-guard: infrastructure, round-3 QA", () => {
  for (const [command, expected] of infraQa3) {
    it(`${JSON.stringify(command)} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch: "feat" })?.decision ?? null, expected);
    });
  }
});

// Round-4 S1 rows: image references with a tag or digest, opentofu's image, and compose services
// named for their image. Each must ask or deny. [command]
const infraQa4 = [
  "docker run --rm hashicorp/terraform:1.9 apply",
  "docker run --rm hashicorp/terraform:latest destroy",
  "docker run --rm hashicorp/terraform@sha256:abc apply",
  "podman run --rm docker.io/hashicorp/terraform:1.9 apply",
  "docker run --rm ghcr.io/opentofu/opentofu:1.8 apply",
  "docker compose run --rm terraform apply",
  "docker-compose run terraform destroy",
  "docker compose run --rm tf apply",
];

describe("command-guard: infrastructure, round-4 QA", () => {
  for (const command of infraQa4) {
    it(`${JSON.stringify(command)} → ask or deny`, () => {
      assert.ok(["ask", "deny"].includes(evaluate(command, { branch: "feat" })?.decision ?? ""), command);
    });
  }

  it("the hook still answers when its stderr is closed (EPIPE on the failure note)", async () => {
    const root = guardIn({});
    const env = { ...process.env };
    delete env["WHIPPLETREE_GUARD"];
    const child = spawn(process.execPath, [join(root, "scripts", "command-guard.mjs"), "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    // Close our end of its stderr before it reads input, so its stderr write fails with EPIPE.
    await new Promise((done) => {
      child.stderr.once("close", done);
      child.stderr.destroy();
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    const exited = new Promise((done) => child.once("close", (code) => done(code)));
    // Unparseable input sends the hook down failed(), which writes the answer and the stderr note.
    child.stdin.end("{ not json");
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
  });
});

// Everyday commands an agent runs, from round-3 QA's corpus: the fallback and the new wrappers must
// leave every one alone, because a guard that blocks these gets switched off.
const longBody = Array.from({ length: 400 }, (_, i) => `- item ${String(i)}: guard refuses \`terraform apply\` and \`aws s3 rm\`; run \`terraform plan\`; destroy old cache; drop table notes`).join("\n");
const everyday = [
  "git status",
  'git add -A && git commit -m "apply review feedback; destroy old cache"',
  "git commit -m 'terraform apply is a human action'",
  "git log --oneline -5",
  "git push -u origin feat/x",
  "git push --force-with-lease origin feat/x",
  "git rebase origin/dev",
  "git apply x.patch",
  "git stash push -u -m tag",
  "git fetch origin dev && git worktree add -b b ../p origin/dev",
  "git diff origin/dev...HEAD --stat",
  "git apply fix.patch && $HOME/bin/check",
  "\"$(git rev-parse --show-toplevel)\"/scripts/check.sh && git commit -m 'apply review'",
  "pnpm check",
  "pnpm test -- --run",
  "pnpm install --frozen-lockfile",
  "pnpm exec tsc --noEmit",
  "pnpm dlx prettier --check .",
  "pnpm infra:validate",
  "pnpm --filter web build",
  "npx tsc -p .",
  "node --test scripts/command-guard.test.mjs",
  "gh pr view 20 --json title,body",
  "gh pr checks 20",
  "gh run view 123 --log-failed",
  "gh run rerun 123 --failed",
  "gh api repos/o/r/pulls/20/comments",
  'gh pr edit 20 --body "$(cat body.md)"',
  `gh pr create --draft --title "Infra: guard refuses terraform apply" --body "$(cat <<'EOF'\n## What/why\n${longBody}\nEOF\n)"`,
  `git commit -F - <<'EOF'\nInfra pack\n\n${longBody}\nEOF`,
  `cat > notes.md <<'EOF'\n${longBody}\n\`terraform apply\`\n$(terraform destroy)\nEOF`,
  "terraform plan -destroy -out p",
  "terraform output -json",
  "terraform -help",
  "terraform apply -help",
  "tflint --init && tflint",
  "rg 'aws s3 rm' -n",
  "cat docs/runbooks/_deploy.md | grep apply",
  "aws s3 cp x s3://b/x",
  "aws s3 sync s3://b ./local",
  "gcloud config list",
  "gcloud storage ls",
  "bq ls",
  "bq query 'SELECT 1'",
  "az account show",
  "az storage blob sync -c c -s . --delete-destination false",
  "git ls-files '*.ts' | xargs wc -l",
  "find . -name '*.tf' -print0 | xargs -0 terraform fmt",
  "ls | xargs -I{} echo {}",
  "xargs -I{} aws s3 cp {} s3://b/ < files.txt",
  'for f in *.tf; do terraform fmt "$f"; done',
  'while read l; do echo "$l"; done < file',
  "$EDITOR file",
  '"$PNPM" install',
  "${PYTHON:-python3} -m pytest",
  "$SHELL -c 'echo hi'",
  "cd ../whippletree-p2g && git push -u origin feat/x",
  "sh scripts/x.sh",
  "bash -c 'pnpm check'",
  "curl -fsSL https://x | jq .",
  "kubectl apply -f k8s/",
  "npx prisma migrate deploy",
  "make apply-patches",
  "patch -p1 < fix.patch",
  "git am < 0001.patch",
  "ls -la; echo $?; echo ${#arr[@]}",
  'cat <<EOF > x.sh\n#!/bin/sh\necho "$HOME"\nEOF',
  "timeout 120 pnpm test",
  "nice -n 10 pnpm check",
  "env CI=1 pnpm check",
  "sudo apt-get install -y jq",
  "docker compose up -d",
  "docker compose logs -f app",
  "docker compose run --rm web pnpm test",
  "docker compose logs terraform",
  "docker run --rm hashicorp/terraform:1.9 plan",
  "docker compose run --rm terraform plan",
  "docker exec -it db psql -U app",
  "gh pr list --search 'apply destroy'",
  "echo apply",
  "echo destroy > /dev/null",
];

describe("command-guard: everyday commands stay unblocked (round-3 S1 fallback)", () => {
  for (const command of everyday) {
    it(`${JSON.stringify(command.length > 80 ? `${command.slice(0, 80)}…` : command)} → null`, () => {
      assert.equal(evaluate(command, { branch: "feat" }), null);
    });
  }
});

// ── Round-3 QA (PR #21): each row fails without its fix. Strings only: nothing here runs a command. ──
//
// `; echo localhost` puts a loopback word on the line, which turns off dev's whole-line floor, so
// the row proves the per-client reading itself (the floor alone would deny it).
describe("databases: QA round 3 (PR #21) — flags, delimiters, Prisma, cd, wrappers, budgets", () => {
  const LOCAL = "postgresql://u:p@localhost:5432/app";
  const R = "postgres://u@db.example.com/app";
  const D = "DROP TABLE users";
  const H = "db.example.com";
  const OFF = "; echo localhost";
  const root = repoWith({
    ".env": `DATABASE_URL=${LOCAL}\n`,
    "prisma/schema.prisma": SCHEMA,
    "home/.env": `DATABASE_URL=${LOCAL}\n`,
    "home/prisma/schema.prisma": SCHEMA,
    "prod/.env": `DATABASE_URL=${R}\n`,
    "prod/prisma/schema.prisma": SCHEMA,
    "drop.sql": `${D};\n`,
    "big.sql": "SELECT 1;\n".repeat(99_000),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`s${index + 1}.sql`, "SELECT 1;\n"])),
    // B3: Prisma's datasource names its variable, or names two.
    "pvar/.env": `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`,
    "pvar/prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("PROD_URL")\n}\n',
    "pvercel/.env": `POSTGRES_PRISMA_URL=${R}\n`,
    "pvercel/prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("POSTGRES_PRISMA_URL")\n}\n',
    "pdirect/.env": `DATABASE_URL=${LOCAL}\nDIRECT_URL=${R}\n`,
    "pdirect/prisma/schema.prisma": 'datasource db {\n  provider  = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n',
    "pcomment/.env": `DATABASE_URL=${LOCAL}\n`,
    "pcomment/prisma/schema.prisma": `datasource db {\n  provider = "postgresql"\n  // url   = "${R}"\n  url      = env("DATABASE_URL")\n}\n`,
    "pconfig/.env": `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`,
    "pconfig/prisma.config.ts": "export default { datasource: { url: process.env.PROD_URL } };\n",
    // Nit: a .env saved with a byte-order mark.
    "bom/.env": `﻿DATABASE_URL=${R}\n`,
    // Round 4: the schema somewhere the guard didn't look (package.json's prisma.schema, a folder).
    "r4pj/.env": `DATABASE_URL=${LOCAL}\nPROD_URL=${R}\n`,
    "r4pj/package.json": { prisma: { schema: "db/schema.prisma" } },
    "r4pj/db/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("PROD_URL")\n}\n',
    "r4lit/.env": `DATABASE_URL=${LOCAL}\n`,
    "r4lit/package.json": { prisma: { schema: "db/schema.prisma" } },
    "r4lit/db/schema.prisma": `datasource db {\n  provider = "postgresql"\n  url      = "${R}"\n}\n`,
    "r4multi/.env": `DATABASE_URL=${LOCAL}\n`,
    "r4multi/prisma/schema/db.prisma": `datasource db {\n  provider = "postgresql"\n  url      = "${R}"\n}\n`,
    "r4multi/prisma/schema/models.prisma": "model A { id Int @id }\n",
    "r4loc/.env": `DATABASE_URL=${LOCAL}\n`,
    "r4loc/package.json": { prisma: { schema: "db/schema.prisma" } },
    "r4loc/db/schema.prisma": SCHEMA,
    "r4loc/prisma/schema/db.prisma": SCHEMA,
    "r4none/.env": `DATABASE_URL=${LOCAL}\n`,
  });
  const where = (dir) => (dir === null ? root : dir.startsWith("~") ? join(root, "home", dir.slice(1)) : resolve(root, dir));
  // How many files the guard asked for, across one evaluate().
  let reads = 0;
  const file = (dir, path) => {
    reads += 1;
    try {
      const full = resolve(where(dir), path);
      const found = statSync(full);
      return found.isFile() && found.size <= 1_000_000 ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
  const readers = {
    branch: "feat",
    targetIn: (/** @type {string | null} */ dir, /** @type {string} */ name, /** @type {string | null} */ dotenv = ".env") => {
      const value = dotenv === null ? undefined : dotenvValue(file(dir, dotenv) ?? "", name);
      return value === undefined ? null : { value, from: dotenv };
    },
    fileIn: file,
    // main()'s dirIn, without its entry cap (this tree is small).
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
  const decision = (command) => evaluate(command, readers)?.decision ?? null;
  const twelve = Array.from({ length: 12 }, (_, index) => `-f s${String(index + 1)}.sql`).join(" ");

  // [finding, command, expected decision]
  /** @type {[string, string, string | null][]} */
  const rows = [
    // B1: getopt clusters, glued values, and a glued here-string, per client.
    ["B1 psql -tAc", `psql -h ${H} -tAc "${D}"${OFF}`, "deny"],
    ["B1 psql -Xqc", `psql -h ${H} -Xqc "${D}"${OFF}`, "deny"],
    ["B1 psql -c glued", `psql -h ${H} -c"${D}"${OFF}`, "deny"],
    ["B1 psql -qf", `psql -h ${H} -qf drop.sql${OFF}`, "deny"],
    ["B1 psql -h glued", `psql -h${H} -c "${D}"${OFF}`, "deny"],
    ["B1 mysql -e glued", `mysql -h ${H} -e"${D}"${OFF}`, "deny"],
    ["B1 mysql -Be", `mysql -h ${H} -Be "${D}"${OFF}`, "deny"],
    ["B1 mysql -ppass keeps its value glued", `mysql -h ${H} -ppass -e "${D}"${OFF}`, "deny"],
    ["B1 here-string glued to its quote", `psql -h ${H} <<<"${D}"${OFF}`, "deny"],
    ["B1 here-string before the host", `psql <<<"${D}" -h ${H}${OFF}`, "deny"],
    ["B1 here-string glued to the host word fails closed", `psql -h ${H}<<<"${D}"${OFF}`, "ask"],
    ["B1 pg_restore -Fc is a format, not --clean", `pg_restore -h ${H} -Fc -d app dump.bin`, null],
    ["B1 pg_restore -c cleans", `pg_restore -h ${H} -c -d app dump.bin`, "deny"],
    // B1 fail closed: a remote client whose SQL comes from somewhere unread asks.
    ["B1 remote client, stdin unread", `psql -h ${H}`, "ask"],
    ["B1 remote client, unknown cluster", `psql -h ${H} -tAZ "${D}"${OFF}`, "ask"],
    ["B1 listing databases reads no SQL", `psql -h ${H} -l`, null],
    ["B1 stdin provably empty", `psql -h ${H} < /dev/null`, null],
    ["B1 an interactive container shell stays allowed", "docker exec -it db psql -U app", null],
    // B2: #20's heredoc reader, delimiters as bash reads them.
    ["B2 'END-SQL'", `psql -h ${H} <<'END-SQL'\n${D};\nEND-SQL\necho localhost`, "deny"],
    ["B2 \\EOF", `psql -h ${H} <<\\EOF\n${D};\nEOF\necho localhost`, "deny"],
    ["B2 \"E.O.F\"", `psql -h ${H} <<"E.O.F"\n${D};\nE.O.F\necho localhost`, "deny"],
    ["B2 a terminator with a trailing space doesn't end the body", `psql -h ${H} <<EOF\nSELECT 1;\nEOF \n${D};\nEOF\necho localhost`, "deny"],
    // B3: Prisma's datasource variables, comments stripped, worst of url and directUrl.
    ["B3 url = env(PROD_URL)", "cd pvar && prisma migrate reset --force", "deny"],
    ["B3 url = env(POSTGRES_PRISMA_URL)", "cd pvercel && prisma migrate reset --force", "deny"],
    ["B3 a remote directUrl", "cd pdirect && prisma migrate reset --force", "deny"],
    ["B3 a commented-out remote literal is not the URL", "cd pcomment && prisma migrate reset --force", null],
    ["B3 process.env.PROD_URL in prisma.config.ts", "cd pconfig && prisma migrate reset --force", "deny"],
    // S1: cd forms the guard can't follow lose track (home/ and . are loopback, so a miss allows).
    ["S1 cd inside f()", "f() { cd prod; }; f; prisma migrate reset --force", "ask"],
    ["S1 cd inside function", "function g { cd prod; }; g && prisma migrate reset --force", "ask"],
    ["S1 cd in a case arm", "case x in x) cd prod;; esac; prisma migrate reset --force", "ask"],
    ["S1 HOME= before cd", "HOME=prod cd && prisma migrate reset --force", "ask"],
    ["S1 export HOME= before cd ~", "export HOME=prod; cd ~ && prisma migrate reset --force", "ask"],
    ["S1 plain cd ~ still follows HOME", "cd ~ && prisma migrate reset --force", null],
    // S2: sudo resets the environment unless told to keep it.
    ["S2 sudo drops an inline loopback URL", `cd prod && DATABASE_URL=${LOCAL} sudo prisma migrate reset --force`, "deny"],
    ["S2 sudo -u drops it too", `cd prod && DATABASE_URL=${LOCAL} sudo -u app prisma migrate reset --force`, "deny"],
    ["S2 sudo -E keeps it", `cd prod && DATABASE_URL=${LOCAL} sudo -E prisma migrate reset --force`, null],
    ["S2 --preserve-env=NAME keeps that name", `cd prod && DATABASE_URL=${LOCAL} sudo --preserve-env=DATABASE_URL prisma migrate reset --force`, null],
    ["S2 --preserve-env=OTHER drops the URL", `cd prod && DATABASE_URL=${LOCAL} sudo --preserve-env=PGHOST prisma migrate reset --force`, "deny"],
    ["S2 --preserve-env= of the agent's own value asks", "sudo --preserve-env=DATABASE_URL prisma migrate reset --force", "ask"],
    // S3: a shell option cluster holding `c` runs its next word.
    ["S3 bash -lc", `bash -lc "psql -h ${H} -c '${D}'"${OFF}`, "deny"],
    ["S3 sh -ec", `sh -ec "psql -h ${H} -c '${D}'"${OFF}`, "deny"],
    // S4: the file budget is per line, shared by every client and every nested line.
    ["S4 one client, 12 files", `psql -h ${H} ${twelve}`, null],
    ["S4 two clients share one budget", `psql -h ${H} ${twelve}; psql -h ${H} ${twelve}`, "ask"],
    ["S4 nested lines share it too (nested runs through evaluateLine)", `bash -c "psql -h ${H} ${twelve}"; bash -c "psql -h ${H} ${twelve}"`, "ask"],
    // S5: parens with a space before the second close are a subshell in a subshell.
    ["S5 ((cmd) )", `((psql -h ${H} -c "${D}") )${OFF}`, "deny"],
    // S6: the lint's clearing forms, ported.
    ["S6 MERGE … THEN DELETE", `psql -h ${H} -c "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE"`, "deny"],
    ["S6 SET (a, b) = (NULL, NULL)", `psql -h ${H} -c "UPDATE users SET (email, name) = (NULL, NULL)"`, "deny"],
    ["S6 T-SQL DELETE without FROM", `sqlcmd -S ${H} -Q "DELETE users WHERE id = 1"`, "deny"],
    ["S6 aws rds-data reads SQL through destroysSql", "aws rds-data execute-statement --resource-arn arn:x --secret-arn arn:y --sql \"MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE\"", "deny"],
    // S10: heredoc ownership across a pipe, both directions.
    ["S10 cat <<EOF | bash runs the body (#20's row)", "cat <<EOF | bash\nterraform destroy\nEOF", "deny"],
    ["S10 cat <<EOF | psql reads the body", `cat <<EOF | psql -h ${H}\n${D};\nEOF\necho localhost`, "deny"],
    // Nits.
    ["nit .env with a BOM", "cd bom && prisma migrate dev", "deny"],
    ["nit \\prisma is prisma", "cd prod && \\prisma migrate reset --force", "deny"],
    ["nit env -S reads its string as a line", `env -S "psql -h ${H} -c '${D}'"${OFF}`, "deny"],
    ["nit env --split-string= too", `env --split-string="psql -h ${H} -c '${D}'"${OFF}`, "deny"],
    // Round 4 B: a reset runs on loopback only once a datasource is read, every URL in it loopback.
    ["r4 package.json prisma.schema → env(PROD_URL), remote in the root .env", "cd r4pj && prisma migrate reset --force", "deny"],
    ["r4 package.json prisma.schema → a literal remote URL", "cd r4lit && prisma migrate reset --force", "deny"],
    ["r4 multi-file prisma/schema/ folder, literal remote", "cd r4multi && prisma migrate reset --force", "deny"],
    ["r4 --schema prisma/schema (a folder), literal remote", "cd r4multi && prisma migrate reset --force --schema prisma/schema", "deny"],
    ["r4 no datasource read: a loopback .env alone asks", "cd r4none && prisma migrate reset --force", "ask"],
    ["r4 no datasource read: db push --force-reset asks too", "cd r4none && prisma db push --force-reset", "ask"],
    ["r4 no datasource read: a remote DATABASE_URL still refuses", "cd r4none && DATABASE_URL=postgres://u@db.example.com/app prisma migrate reset --force", "deny"],
    ["r4 no datasource read: migrate dev is unchanged", "cd r4none && prisma migrate dev", null],
    ["r4 control: package.json schema and a folder, all loopback, runs", "cd r4loc && prisma migrate reset --force", null],
    // Round 4 S: MySQL's ?socket= is judged by its directory, like postgres ?host=/dir.
    ["r4 mysql ?socket=/cloudsql/… is not this machine", "DATABASE_URL=mysql://root@localhost/app?socket=/cloudsql/p:r:i prisma migrate reset --force", "deny"],
    // Round 4 nit: a local container's own database with no host asks, rather than being refused.
    ["r4 docker compose exec psql DROP with no host asks", `docker compose exec db psql -U postgres -c "${D}"`, "ask"],
    ["r4 docker compose exec psql DROP on a remote host still refuses", `docker compose exec db psql -h ${H} -c "${D}"`, "deny"],
    ["r4 kubectl exec psql DROP with no host still refuses", `kubectl exec pg-0 -- psql -U postgres -c "${D}"`, "deny"],
  ];
  for (const [finding, command, want] of rows) {
    it(`${finding} → ${String(want)}`, () => {
      assert.equal(decision(command), want, command);
    });
  }

  // The reviewer's shape: 350 clients each reading a ~1 MB file. Per client, each read fit its own
  // cap, so the line read 350 MB; per line, the second read is over the byte budget and asks.
  it("S4: 350 clients × a 1 MB -f file asks after at most 20 reads, fast", () => {
    let sqlReads = 0;
    const big = "select 1 from t where a = 'x';\n".repeat(31_000);
    const started = performance.now();
    const verdict = evaluate(`psql -h ${H} -f a.sql; `.repeat(350), {
      branch: "feat",
      targetIn: () => null,
      fileIn: () => {
        sqlReads += 1;
        return big;
      },
    });
    const took = performance.now() - started;
    assert.equal(verdict?.decision, "ask");
    assert.ok(sqlReads <= 20, `${String(sqlReads)} reads`);
    assert.ok(took < BOUND_MS, `${Math.round(took)} ms`);
  });

  it("S6: destroysSql is exported for the cloud rules", () => {
    assert.equal(destroysSql("MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE"), true);
    assert.equal(destroysSql("UPDATE t SET (a, b) = (NULL, NULL)"), true);
    assert.equal(destroysSql("SELECT 1"), false);
  });

  it("S8: evaluate() with no file reader treats a SQL file as unreadable (ask)", () => {
    assert.equal(evaluate(`psql -h ${H} -f drop.sql`, { branch: "feat" })?.decision, "ask");
  });

  it("r4 S: MySQL's ?socket= is judged by its directory (a Cloud SQL socket is not this machine)", () => {
    assert.equal(targetOf("mysql://root@localhost/app?socket=/cloudsql/p:r:i"), "remote");
    assert.equal(targetOf("mysql://root@localhost/app?socket=/srv/sockets/mysqld.sock"), "remote");
    assert.equal(targetOf("mysql://root@localhost/app?socket=/tmp/mysql.sock"), "loopback");
    assert.equal(targetOf("mysql://root@localhost/app?socket=/var/run/mysqld/mysqld.sock"), "loopback");
    assert.equal(targetOf("mysql://root@localhost/app"), "loopback");
  });

  it("r4 B: a multi-file schema folder past the guard's bounds asks", () => {
    const many = { dir: true, files: Array.from({ length: 70 }, (_, index) => `m${String(index)}.prisma`), dirs: [], more: false };
    // 70 loopback `.prisma` files in prisma/schema/ and no prisma/schema.prisma: past 64, it asks.
    const listed = { ...readers, dirIn: (_dir, path) => (path === "prisma/schema" ? many : null), fileIn: (dir, path) => (path === "prisma/schema.prisma" ? null : path.endsWith(".prisma") ? SCHEMA : file(dir, path)) };
    assert.equal(evaluate("prisma migrate reset --force", listed)?.decision, "ask");
    assert.equal(evaluate("prisma migrate reset --force", { ...listed, dirIn: (_dir, path) => (path === "prisma/schema" ? { ...many, files: many.files.slice(0, 10) } : null) })?.decision ?? null, null);
    const more = { ...readers, dirIn: (_dir, path) => (path === "prisma/schema" ? { dir: true, files: [], dirs: [], more: true } : null) };
    assert.equal(evaluate("prisma migrate reset --force", more)?.decision, "ask");
    // Written earlier on the line: what the reset reads is not what is on disk now.
    assert.equal(decision("cp other.prisma prisma/schema/db.prisma && prisma migrate reset --force"), "ask");
  });

  it("nit: dotenvValue skips a byte-order mark", () => {
    assert.equal(dotenvValue("﻿DATABASE_URL=x\n", "DATABASE_URL"), "x");
  });

  // S9: 64k-character single-segment lines: inside BOUND_MS with the default limits, and every one
  // asks once the time budget is gone (each loop checks the clock).
  /** @type {[string, (n: number) => string][]} */
  const single = [
    ["`cat <<A` openers", (n) => `cat ${"<<A ".repeat(n)}\nA`],
    ["`x` words", (n) => `psql -h ${H} ${"x ".repeat(n)}`],
    ["`cp a b;` chain", (n) => `${"cp a b;".repeat(n)}psql -h ${H}`],
    ["`ssh h psql` words", (n) => `ssh h ${"psql ".repeat(n)}-c "${D}"`],
    ["inline assignments", (n) => `${"A=1 ".repeat(n)}psql -h ${H}`],
    ["a .env-free prefix of env -u", (n) => `env ${"-u A ".repeat(n)}psql -h ${H}`],
  ];
  for (const [label, shape] of single) {
    it(`S9 ${label}: under ${String(BOUND_MS)} ms, and asks on a spent clock`, () => {
      const line = fill(shape);
      const started = performance.now();
      evaluate(line, readers);
      const took = performance.now() - started;
      assert.ok(took < BOUND_MS, `${Math.round(took)} ms`);
      assert.equal(evaluate(line, { ...readers, limits: { chars: LIMITS.chars, ms: 0 } })?.decision, "ask");
    });
  }
});

// ── Round 5 (template adversarial review): bypasses that each returned allow, and a control per rule ──
// [finding, command, branch where the hook runs, expected decision]. Strings only: nothing runs.
const round5 = [
  // 1. A full path to the program is that program, as the infra and SQL rules already read it.
  ["1 /usr/bin/git force-push dev", "/usr/bin/git push -f origin dev", "feat", "deny"],
  ["1 /usr/bin/git delete main", "/usr/bin/git push --delete origin main", "feat", "deny"],
  ["1 /usr/local/bin/git +main", "/usr/local/bin/git push origin +main", "feat", "deny"],
  ["1 /usr/bin/gh ready --undo", "/usr/bin/gh pr ready 1 --undo", "feat", "deny"],
  ["1 /opt/homebrew/bin/gh merge", "/opt/homebrew/bin/gh pr merge 1", "feat", "ask"],
  ["1 /usr/bin/dropdb", "/usr/bin/dropdb -h prod app", "feat", "deny"],
  ["1 /usr/bin/env git force-push main", "/usr/bin/env git push -f origin main", "feat", "deny"],
  ["1 git.exe force-push dev", "git.exe push -f origin dev", "feat", "deny"],
  ["1 control: /usr/bin/git feature push", "/usr/bin/git push -u origin feat/x", "feat/x", null],
  // 2. gh's repo flag in front of the subcommand.
  ["2 gh -R merge", "gh -R o/r pr merge 1", "feat", "ask"],
  ["2 gh --repo merge", "gh --repo o/r pr merge 1", "feat", "ask"],
  ["2 gh --repo= ready --undo", "gh --repo=o/r pr ready 1 --undo", "feat", "deny"],
  ["2 gh -R run rerun", "gh -R o/r run rerun 5", "feat", "deny"],
  ["2 gh -Ro/r glued merge", "gh -Ro/r pr merge 1", "feat", "ask"],
  ["2 control: gh -R pr view", "gh -R o/r pr view 1", "feat", null],
  ["2 control: gh -R rerun --failed", "gh -R o/r run rerun 5 --failed", "feat", null],
  // 3. Abbreviated long options git accepts.
  ["3 --no-verif", "git push --no-verif origin feat", "feat", "deny"],
  ["3 --delet dev", "git push --delet origin dev", "feat", "deny"],
  ["3 --force-with dev", "git push --force-with origin dev", "feat", "deny"],
  ["3 --force-if dev", "git push --force-if origin dev", "feat", "deny"],
  ["3 --forc main", "git push --forc origin main", "feat", "deny"],
  ["3 --mirr", "git push --mirr", "feat", "ask"],
  ["3 --mirr --forc", "git push --mirr --forc", "feat", "deny"],
  ["3 control: --force-with-lease= on a feature branch", "git push --force-with-lease=feat/x:abc origin feat/x", "feat/x", null],
  ["3 control: --dry on a feature branch", "git push --dry origin feat", "feat", null],
  ["3 control: --no-force-with-lease is no force", "git push --no-force-with-lease origin dev", "feat", null],
  ["3 control: --rep takes the next word", "git push --rep origin dev", "feat", null],
  // 4. git's global options that take a separate value.
  ["4 --git-dir X push -f dev", "git --git-dir .git push -f origin dev", "feat", "deny"],
  ["4 --work-tree X push -f main", "git --work-tree . push -f origin main", "feat", "deny"],
  ["4 --namespace X push -f dev", "git --namespace x push -f origin dev", "feat", "deny"],
  ["4 --attr-source X push --delete main", "git --attr-source HEAD push --delete origin main", "feat", "deny"],
  ["4 --git-dir: a bare forced push can't be placed", "git --git-dir ../other/.git push -f", "feat", "ask"],
  ["4 -c then -C: the push runs in -C's directory", "git -c x.y=1 -C ../habit push --force", "feat", "deny"],
  ["4 control: --git-dir status", "git --git-dir .git status", "feat", null],
  ["4 control: --work-tree feature push", "git --work-tree . push origin feat", "feat", null],
  // 5. `@` is HEAD; a glob refspec writes every branch it matches.
  ["5 @ on main", "git push origin @", "main", "ask"],
  ["5 +@ on dev", "git push origin +@", "dev", "deny"],
  ["5 @:main", "git push origin @:main", "feat", "ask"],
  ["5 +refs/heads/*:refs/heads/*", "git push origin '+refs/heads/*:refs/heads/*'", "feat", "deny"],
  ["5 +*:*", "git push origin '+*:*'", "feat", "deny"],
  ["5 refs/heads/m*:refs/heads/m*", "git push origin 'refs/heads/m*:refs/heads/m*'", "feat", "ask"],
  ["5 :refs/heads/d* deletes dev", "git push origin ':refs/heads/d*'", "feat", "deny"],
  ["5 control: @ on a feature branch", "git push origin @", "feat", null],
  ["5 control: +@ on a feature branch", "git push origin +@", "feat", null],
  ["5 control: a glob over feature branches", "git push origin '+refs/heads/feat-*:refs/heads/feat-*'", "feat", null],
  // 6. gh api writes, judged as the gh subcommand for the same act; reads run.
  ["6 DELETE refs/heads/main", "gh api -X DELETE repos/o/r/git/refs/heads/main", "feat", "deny"],
  ["6 PATCH dev force=true", "gh api --method PATCH repos/o/r/git/refs/heads/dev -F force=true", "feat", "deny"],
  ["6 -XPATCH main (glued) moves main", "gh api -XPATCH /repos/o/r/git/refs/heads/main -f sha=abc", "feat", "ask"],
  ["6 PATCH dev with a body from a file", "gh api -X PATCH repos/o/r/git/refs/heads/dev --input body.json", "feat", "ask"],
  ["6 control: PATCH dev without force (a plain push to dev)", "gh api -X PATCH repos/o/r/git/refs/heads/dev -f sha=abc", "feat", null],
  ["6 PATCH dev with a body from a file", "gh api -X PATCH repos/o/r/git/refs/heads/dev --input body.json", "feat", "ask"],
  ["6 control: PATCH dev without force (a plain push to dev)", "gh api -X PATCH repos/o/r/git/refs/heads/dev -f sha=abc", "feat", null],
  ["6 --method=DELETE dev", "gh api --method=DELETE repos/o/r/git/refs/heads/dev", "feat", "deny"],
  ["6 full rerun", "gh api -X POST repos/o/r/actions/runs/5/rerun", "feat", "deny"],
  ["6 dispatch (implicit POST from -f)", "gh api repos/o/r/actions/workflows/ci.yml/dispatches -f ref=dev", "feat", "ask"],
  ["6 repository_dispatch (--input)", "gh api repos/o/r/dispatches --input body.json", "feat", "ask"],
  ["6 merges endpoint", "gh api repos/o/r/merges -f base=main -f head=dev", "feat", "ask"],
  ["6 PUT pulls/N/merge (kept)", "gh api -X PUT repos/o/r/pulls/12/merge", "feat", "ask"],
  ["6 DELETE branch protection", "gh api -X DELETE repos/o/r/branches/main/protection", "feat", "deny"],
  ["6 PUT branch protection", "gh api -X PUT repos/o/r/branches/main/protection --input p.json", "feat", "ask"],
  ["6 DELETE a ruleset", "gh api -X DELETE repos/o/r/rulesets/42", "feat", "deny"],
  ["6 rename main", "gh api repos/o/r/branches/main/rename -f new_name=trunk", "feat", "deny"],
  ["6 DELETE the repository", "gh api -X DELETE repos/o/r", "feat", "deny"],
  ["6 DELETE a release", "gh api -X DELETE https://api.github.com/repos/o/r/releases/7", "feat", "deny"],
  ["6 graphql mergePullRequest", "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "feat", "ask"],
  ["6 graphql markPullRequestReadyForReview", "gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "feat", "ask"],
  ["6 graphql deleteBranchProtectionRule", "gh api graphql -f query='mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: \"x\"}) { clientMutationId } }'", "feat", "deny"],
  ["6 graphql in a heredoc on --input -", "gh api graphql --input - <<'EOF'\n{\"query\": \"mutation { convertPullRequestToDraft(input: {pullRequestId: \\\"x\\\"}) { clientMutationId } }\"}\nEOF", "feat", "deny"],
  ["6 graphql query from a file", "gh api graphql -F query=@q.graphql", "feat", "ask"],
  ["6 gh repo delete", "gh repo delete o/r --yes", "feat", "deny"],
  ["6 gh release delete", "gh release delete v1 --yes", "feat", "deny"],
  ["6 gh release delete-asset", "gh release delete-asset v1 app.zip", "feat", "deny"],
  ["6 control: GET pulls/12", "gh api repos/o/r/pulls/12", "feat", null],
  ["6 control: GET refs/heads/main", "gh api --method GET repos/o/r/git/refs/heads/main", "feat", null],
  ["6 control: comment on a PR (POST)", "gh api repos/o/r/issues/12/comments -f body='merge and DELETE later'", "feat", null],
  ["6 control: create a feature ref", "gh api -X POST repos/o/r/git/refs -f ref=refs/heads/feat -f sha=abc", "feat", null],
  ["6 control: rerun failed jobs", "gh api -X POST repos/o/r/actions/runs/5/rerun-failed-jobs", "feat", null],
  ["6 control: graphql read", "gh api graphql -f query='query { viewer { login } }'", "feat", null],
  ["6 control: gh release view", "gh release view v1", "feat", null],
  ["6 control: PR text naming the mutations", "gh pr create --draft --title 'mergePullRequest notes' --body 'gh api -X DELETE repos/o/r; gh repo delete'", "feat", null],
  // 7. The pre-push hook skipped another way, and aliases that hide what runs.
  ["7 -c core.hooksPath push", "git -c core.hooksPath=/dev/null push origin feat", "feat", "deny"],
  ["7 -c core.hookspath (any case) push", "git -c Core.HooksPath=x push origin feat", "feat", "deny"],
  ["7 --config-env core.hooksPath push", "git --config-env core.hooksPath=HOOKS push origin feat", "feat", "deny"],
  ["7 git config core.hooksPath", "git config core.hooksPath /tmp/x", "feat", "ask"],
  ["7 git config --global core.hooksPath", "git config --global core.hooksPath /tmp/x", "feat", "ask"],
  ["7 git config set core.hooksPath", "git config set core.hooksPath /tmp/x", "feat", "ask"],
  ["7 git config --unset core.hooksPath", "git config --unset core.hooksPath", "feat", "ask"],
  ["7 -c alias.X=… X", "git -c alias.p='push -f origin main' p", "feat", "ask"],
  ["7 git config alias.X 'push …'", "git config alias.p 'push -f origin main'", "feat", "ask"],
  ["7 control: git config --get core.hooksPath", "git config --get core.hooksPath", "feat", null],
  ["7 control: git config alias.co (a read)", "git config alias.co", "feat", null],
  ["7 control: git config user.name", "git config user.name 'Bret'", "feat", null],
  ["7 control: -c user.name commit", "git -c user.name=x commit -m hi", "feat", null],
  // 8. Shell writes to the guard's own files ask (the hook's entry is tested below).
  ["8 sed -i the guard", "sed -i 's/deny/null/' scripts/command-guard.mjs", "feat", "ask"],
  ["8 rm the hook entry", "rm scripts/command-guard-hook.mjs", "feat", "ask"],
  ["8 chmod the guard", "chmod 000 scripts/command-guard.mjs", "feat", "ask"],
  ["8 redirect over the Cursor hooks", "echo '{}' > .cursor/hooks.json", "feat", "ask"],
  ["8 heredoc over settings.json", "cat > .claude/settings.json <<'EOF'\n{}\nEOF", "feat", "ask"],
  ["8 settings.local.json", "echo '{\"disableAllHooks\": true}' > .claude/settings.local.json", "feat", "ask"],
  ["8 mv the project rules away", "mv command-guard.project.json /tmp/", "feat", "ask"],
  ["8 rm -rf the folder holding them", "rm -rf .claude", "feat", "ask"],
  ["8 cd then rm", "cd scripts && rm command-guard.mjs", "feat", "ask"],
  ["8 an absolute path", "rm /home/me/repo/scripts/command-guard.mjs", "feat", "ask"],
  ["8 git rm", "git rm scripts/command-guard.mjs", "feat", "ask"],
  ["8 cp over a pack rule file", "cp x.json scripts/command-guard.d/infra.json", "feat", "ask"],
  ["8 control: read the guard", "sed -n 1,20p scripts/command-guard.mjs", "feat", null],
  ["8 control: run its tests", "node --test scripts/command-guard.test.mjs", "feat", null],
  ["8 control: git add", "git add scripts/command-guard.mjs .claude/settings.json", "feat", null],
  ["8 control: rm elsewhere in scripts", "rm -rf scripts/lib/tmp", "feat", null],
  // 9. Data-loss commands the guard didn't know.
  ["9 neon (neonctl's other name)", "neon branches delete preview-1", "feat", "deny"],
  ["9 turso db destroy", "turso db destroy app", "feat", "deny"],
  ["9 pscale database delete", "pscale database delete app --force", "feat", "deny"],
  ["9 wrangler r2 bucket delete", "wrangler r2 bucket delete uploads", "feat", "deny"],
  ["9 wrangler d1 delete", "npx wrangler d1 delete app", "feat", "deny"],
  ["9 wrangler d1 execute --remote DROP", "wrangler d1 execute DB --remote --command 'DROP TABLE users'", "feat", "deny"],
  ["9 wrangler d1 execute --remote --file unread", "wrangler d1 execute DB --remote --file drop.sql", "feat", "ask"],
  ["9 docker compose down -v", "docker compose down -v", "feat", "ask"],
  ["9 docker compose -f x down --volumes", "docker compose -f dev.yml down --volumes", "feat", "ask"],
  ["9 docker-compose down -v", "docker-compose down -v", "feat", "ask"],
  ["9 docker volume rm", "docker volume rm pgdata", "feat", "ask"],
  ["9 docker volume prune", "docker volume prune -f", "feat", "ask"],
  ["9 docker system prune --volumes", "docker system prune -af --volumes", "feat", "ask"],
  ["9 redis-cli FLUSHALL remote", "redis-cli -h prod.example.com FLUSHALL", "feat", "deny"],
  ["9 redis-cli -u URL flushdb", "redis-cli -u redis://:pw@cache.example.com:6379/0 flushdb", "feat", "deny"],
  ["9 redis-cli $HOST FLUSHALL", "redis-cli -h $REDIS_HOST FLUSHALL", "feat", "ask"],
  ["9 FLUSHALL piped into redis-cli", "echo FLUSHALL | redis-cli -h prod.example.com", "feat", "deny"],
  ["9 mongosh URL dropDatabase", "mongosh mongodb://prod.example.com/app --eval 'db.dropDatabase()'", "feat", "deny"],
  ["9 mongosh --host deleteMany", "mongosh --host rs0/db1.example.com:27017 --eval 'db.users.deleteMany({})'", "feat", "deny"],
  ["9 mongo host/db drop", "mongo db.example.com/app --eval 'db.users.drop()'", "feat", "deny"],
  ["9 ALTER COLUMN … TYPE … USING NULL", "psql -h db.example.com -c 'ALTER TABLE users ALTER COLUMN email TYPE text USING NULL'", "feat", "deny"],
  ["9 UPDATE … SET col = DEFAULT", "psql -h db.example.com -c 'UPDATE users SET email = DEFAULT'", "feat", "deny"],
  ["9 UPDATE … SET col = ''", "psql -h db.example.com -c \"UPDATE users SET email = ''\"", "feat", "deny"],
  ["9 UPDATE … SET (a) = (SELECT NULL)", "psql -h db.example.com -c 'UPDATE users SET (email) = (SELECT NULL)'", "feat", "deny"],
  ["9 control: neon branches list", "neon branches list", "feat", null],
  ["9 control: wrangler d1 execute local DROP", "wrangler d1 execute DB --command 'DROP TABLE users'", "feat", null],
  ["9 control: wrangler d1 execute --remote SELECT", "wrangler d1 execute DB --remote --command 'SELECT 1'", "feat", null],
  ["9 control: docker compose down", "docker compose down", "feat", null],
  ["9 control: docker volume ls", "docker volume ls", "feat", null],
  ["9 control: docker run -v", "docker run -v pgdata:/var/lib/postgresql/data postgres", "feat", null],
  ["9 control: redis-cli FLUSHALL on loopback", "redis-cli FLUSHALL", "feat", null],
  ["9 control: redis-cli -h localhost flushdb", "redis-cli -h localhost flushdb", "feat", null],
  ["9 control: mongosh local dropDatabase", "mongosh mongodb://localhost/app --eval 'db.dropDatabase()'", "feat", null],
  ["9 control: mongosh remote read", "mongosh mongodb://prod.example.com/app --eval 'db.users.find()'", "feat", null],
  ["9 control: a USING cast keeps the data", "psql -h db.example.com -c 'ALTER TABLE t ALTER COLUMN n TYPE int USING n::int'", "feat", null],
  ["9 control: '' in WHERE, not SET", "psql -h db.example.com -c \"UPDATE users SET verified = true WHERE email = ''\"", "feat", null],
  // 10. Every loopback address is loopback to the floor too.
  ["10 psql -h ::1 TRUNCATE", "psql -h ::1 -c 'TRUNCATE users'", "feat", null],
  ["10 psql -h 127.0.0.2 TRUNCATE", "psql -h 127.0.0.2 -c 'TRUNCATE users'", "feat", null],
  ["10 psql [::1] URL DROP", "psql 'postgres://u@[::1]:5432/app' -c 'DROP TABLE users'", "feat", null],
  ["10 control: ::1 in a remote host's name is still remote", "psql -h db::1x -c 'TRUNCATE users'", "feat", "deny"],
  ["10 control: a remote host still refuses", "psql -h 10.0.0.1 -c 'TRUNCATE users'", "feat", "deny"],
];

describe("command-guard: round 5 — paths, gh flags, abbreviations, refspecs, the API, data stores", () => {
  for (const [finding, command, branch, expected] of round5) {
    it(`${finding} → ${String(expected)}`, () => {
      assert.equal(evaluate(command, { branch, branchIn: (dir) => DIRS[dir] ?? "" })?.decision ?? null, expected, command);
    });
  }
});

// The guard and its hook entry in a temp root, the guard's text replaced by `guard` when given.
const hookIn = (guard) => {
  const root = guardIn({});
  copyFileSync(fileURLToPath(new URL("./command-guard-hook.mjs", import.meta.url)), join(root, "scripts", "command-guard-hook.mjs"));
  if (guard !== undefined) writeFileSync(join(root, "scripts", "command-guard.mjs"), guard);
  return root;
};

// Runs the hook entry as a host would; { status, stdout, stderr }, whatever the exit code.
const runHook = (root, host, input, extraEnv = {}) => {
  const env = { ...process.env };
  delete env.WHIPPLETREE_GUARD;
  const result = spawnSync(process.execPath, [join(root, "scripts", "command-guard-hook.mjs"), host], { input: JSON.stringify(input), env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("command-guard: the hook entry fails closed (round 5, finding 8)", () => {
  it("passes the guard's answers through unchanged", () => {
    const root = hookIn();
    const asked = runHook(root, "claude", { tool_input: { command: "gh pr ready 1" }, cwd: tmpdir() });
    assert.equal(asked.status, 0);
    assert.equal(JSON.parse(asked.stdout).hookSpecificOutput.permissionDecision, "ask");
    const allowed = runHook(root, "claude", { tool_input: { command: "ls" }, cwd: tmpdir() });
    assert.deepEqual([allowed.status, allowed.stdout], [0, ""]);
    assert.equal(JSON.parse(runHook(root, "cursor", { command: "ls", cwd: tmpdir() }).stdout).permission, "allow");
  });

  it("blocks (exit 2) when the guard doesn't parse, for both hosts", () => {
    const root = hookIn("export const main = () => {\n");
    const claude = runHook(root, "claude", { tool_input: { command: "ls" } });
    assert.equal(claude.status, 2);
    assert.match(claude.stderr, /didn't load/);
    const cursor = runHook(root, "cursor", { command: "ls" });
    assert.equal(cursor.status, 2);
    assert.equal(JSON.parse(cursor.stdout).permission, "deny");
  });

  it("blocks when the guard is missing", () => {
    const root = hookIn();
    rmSync(join(root, "scripts", "command-guard.mjs"));
    assert.equal(runHook(root, "claude", { tool_input: { command: "ls" } }).status, 2);
  });

  it("blocks when the guard exits any other way than an answer (exit 1, a throw after loading)", () => {
    assert.equal(runHook(hookIn("export const main = () => process.exit(1);\n"), "claude", {}).status, 2);
    const thrown = runHook(hookIn("export const main = () => setTimeout(() => { throw new Error('late'); }, 1);\n"), "claude", {});
    assert.equal(thrown.status, 2);
    assert.match(thrown.stderr, /exited with code 1/);
  });

  it("the human's off switch still lets a broken guard through", () => {
    const off = runHook(hookIn("syntax error ("), "claude", { tool_input: { command: "ls" } }, { WHIPPLETREE_GUARD: "off" });
    assert.deepEqual([off.status, off.stdout], [0, ""]);
  });

  it("asks when the input has no command where the host puts one", () => {
    const root = hookIn();
    for (const input of [{ tool_input: { cmd: "git push -f origin main" } }, { tool_input: { command: ["git", "push"] } }, {}]) {
      const output = runHook(root, "claude", input);
      assert.equal(JSON.parse(output.stdout).hookSpecificOutput.permissionDecision, "ask", JSON.stringify(input));
    }
  });

  it("both hosts' hook configs run the entry, not the guard directly", () => {
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const claude = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")).hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    assert.ok(claude.some((command) => command.endsWith('scripts/command-guard-hook.mjs" claude || exit 2')), claude.join("\n"));
    assert.ok(!claude.some((command) => /command-guard\.mjs/.test(command)));
    const cursor = JSON.parse(readFileSync(join(repo, ".cursor", "hooks.json"), "utf8")).hooks.beforeShellExecution.map((hook) => hook.command);
    assert.deepEqual(cursor, ["node scripts/command-guard-hook.mjs cursor"]);
  });
});
