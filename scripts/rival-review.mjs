#!/usr/bin/env node
// Lets an agent hand a change to the rival model (OpenAI Codex, so ChatGPT) for dynamite test, then talk back to it.
// In the app: nothing at runtime; agents run it from dynamite-test.mdc → Rival, people via `pnpm rival`.
// Used by: package.json (`pnpm rival`), .cursor/rules/dynamite-test.mdc.
// Uses: scripts/agent-overrides.mjs (the scopes: agent-overrides.json → dynamiteTest, and your own
//   agent-overrides.local.json), scripts/model-tiers.mjs (is a rival picked, and which model),
//   OpenAI's Codex plugin for Claude Code when installed, else the `codex` CLI; tested by scripts/rival-review.test.mjs.
//
// The plugin's own /codex:adversarial-review can't be called by an agent (it is user-invoked only),
// so this finds the plugin's runtime and calls it directly. Without the plugin (Cursor, Gemini CLI,
// a bare shell) it falls back to `codex exec` in a read-only sandbox, so every tool gets the same rival.
//
//   doctor                          what is set up, what is missing, and the exact fix for each; exits 1 if not ready
//   scope                           both scopes on stdout: `test: <scope>`, then `rival: <scope or off>`
//                                   (each `all`, `high-risk`, or `major-release`)
//   review [--base <ref>] [--model <id>] [focus …]
//                                   dynamite test of this branch against <ref> (default origin/dev), read-only
//   chat [--resume] [--model <id>] <message …>
//                                   ask the rival anything, read-only; --resume continues the last chat thread

// Node builtins only, so it runs before `pnpm install`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_FILE, readOverrides } from "./agent-overrides.mjs";
import { resolve as resolveModels } from "./model-tiers.mjs";

// When the dynamite test runs: every PR, only high-risk changes, or only major releases (dynamite-test.mdc → When it runs).
// Widest first, so a later index is narrower.
export const SCOPES = ["all", "high-risk", "major-release"];
export const DEFAULT_SCOPE = "high-risk";

// The tier a dynamite test runs at (showrunner.mdc gives it to `deep` phases), so the cell that counts.
const REVIEW_TIER = "deep";
const LINEAGE = "rival";

// Where Claude Code caches the plugin: <config>/plugins/cache/<marketplace>/<plugin>/<version>/.
const PLUGIN_CACHE = ["plugins", "cache", "openai-codex", "codex"];
const COMPANION = join("scripts", "codex-companion.mjs");

// The branch a PR merges into, so the default review target (branching.mdc).
const DEFAULT_BASE = "origin/dev";

// The fallback's instructions when the plugin (which brings its own adversarial prompt) is absent.
const FALLBACK_PROMPT = (base, focus) =>
  [
    `Adversarial review. Run \`git diff ${base}...HEAD\` and read what you need around it; change nothing.`,
    "Try to break the change: silent failures, commit-point order, auth and permission holes,",
    "data loss, races and retries, backfills and sign-outs at deploy, inputs the tests skip.",
    "Report only material findings, each with file:line, the concrete input or state that fails, and the fix.",
    "If you cannot defend a finding from the code, leave it out. If it is safe, say so.",
    focus ? `Focus: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");

// One key's value, failing loudly on one the rule doesn't define: a typo must not quietly change who tests.
const checked = (key, entry) => {
  if (!SCOPES.includes(entry.value)) throw new Error(`${entry.file}: dynamiteTest.${key} must be one of ${SCOPES.join(", ")}; got ${JSON.stringify(entry.value)}`);
  return entry.value;
};

// The scope a set of overrides gives the test (default when unset).
const testScope = ({ scope }) => (scope ? checked("scope", scope) : DEFAULT_SCOPE);

// Reads the scopes: { scope } for the dynamite test, { rivalScope } for the rival (follows scope when absent).
export function readScopes(root = ".") {
  const { dynamiteTest } = readOverrides(root);
  const scope = testScope(dynamiteTest);
  const rivalScope = dynamiteTest.rivalScope ? checked("rivalScope", dynamiteTest.rivalScope) : scope;
  // A personal file may test more, never less than the team asked: the team's scope is a floor.
  if (dynamiteTest.scope?.layer === "local") {
    const team = testScope(readOverrides(root, { local: false }).dynamiteTest);
    if (SCOPES.indexOf(scope) > SCOPES.indexOf(team))
      throw new Error(`${dynamiteTest.scope.file}: dynamiteTest.scope ${JSON.stringify(scope)} is narrower than the team's ${JSON.stringify(team)}; yours may only be the same or wider (narrow rivalScope instead)`);
  }
  // The rival only runs inside a dynamite test, so a wider rivalScope would promise reviews that never happen.
  if (SCOPES.indexOf(rivalScope) < SCOPES.indexOf(scope))
    throw new Error(`${(dynamiteTest.rivalScope ?? dynamiteTest.scope).file}: dynamiteTest.rivalScope ${JSON.stringify(rivalScope)} is wider than scope ${JSON.stringify(scope)}; it may only be the same or narrower`);
  return { scope, rivalScope };
}

// The rival picked for the review tier ({ label, model, source }; model null = Codex's default), or null for no pick.
export const rivalModel = (root = ".") => resolveModels(root)[REVIEW_TIER]?.[LINEAGE] ?? null;

// Compares dotted version strings numerically, so 1.0.10 sorts after 1.0.9.
const byVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map((n) => Number.parseInt(n, 10) || 0));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

// The newest installed plugin runtime, or null; CODEX_COMPANION overrides the search.
export function findCompanion(env = process.env) {
  // An explicit path wins, so an unusual install still works.
  if (env.CODEX_COMPANION) return existsSync(env.CODEX_COMPANION) ? env.CODEX_COMPANION : null;
  // Claude Code's config dir, which CLAUDE_CONFIG_DIR moves.
  const cache = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), ...PLUGIN_CACHE);
  if (!existsSync(cache)) return null;
  // Each version directory that actually holds the runtime, newest last.
  const versions = readdirSync(cache)
    .filter((version) => existsSync(join(cache, version, COMPANION)))
    .toSorted(byVersion);
  return versions.length ? join(cache, versions.at(-1), COMPANION) : null;
}

// Runs a command with the terminal attached; returns its exit code (127 when it can't start).
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  return result.error ? 127 : (result.status ?? 1);
};

// Runs a command quietly; returns { ok, out }.
const probe = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

// Pulls `--name value` and `--flag` out of argv; the rest is free text.
export function parseArgs(argv, valued, flags) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    // A valued option takes the next word.
    if (argv[i].startsWith("--") && valued.includes(name)) options[name] = argv[++i];
    // A flag is just present.
    else if (argv[i].startsWith("--") && flags.includes(name)) options[name] = true;
    else rest.push(argv[i]);
  }
  return { options, text: rest.join(" ").trim() };
}

// The setup steps, in order; each is something only the person at the keyboard can do.
const SETUP = [
  "1. Install the Codex CLI:   npm install -g @openai/codex",
  "2. Sign in with ChatGPT:    codex login   (a ChatGPT plan works, Free included; or pipe an API key to `codex login --with-api-key`)",
  "3. In Claude Code, accept the `openai-codex` marketplace when asked, or run:",
  "     /plugin marketplace add openai/codex-plugin-cc",
  "     /plugin install codex@openai-codex",
  "     /reload-plugins",
  "4. Check:                   pnpm rival doctor   (full guide: docs/guide/models.md)",
];

// The model ids this Codex knows, from its bundled catalog (works signed out and offline); null if it can't say.
export const knownIds = (catalogJson) => {
  try {
    return JSON.parse(catalogJson).models.map((model) => model.slug);
  } catch {
    return null;
  }
};

// Reports each piece and the fix for what's missing.
function doctor() {
  const { scope, rivalScope } = readScopes();
  const model = rivalModel();
  const codex = probe("codex", ["--version"]);
  const login = codex.ok ? probe("codex", ["login", "status"]) : { ok: false, out: "" };
  const companion = findCompanion();
  // One line per piece, so a missing one is obvious.
  console.log(`scope:      ${scope}   (dynamiteTest.scope; default ${DEFAULT_SCOPE}; pnpm overrides says which file)`);
  console.log(`rivalScope: ${model ? rivalScope : "off"}   (dynamiteTest.rivalScope; default: scope)`);
  console.log(`rival:      ${model ? `${model.label} [${model.model ?? "Codex default"}]` : "none picked"}   (pnpm models: ${REVIEW_TIER} → ${LINEAGE})`);
  console.log(`codex CLI:  ${codex.ok ? codex.out : "missing"}`);
  console.log(`signed in:  ${login.ok ? "yes" : "no"}`);
  console.log(`plugin:     ${companion ?? "not installed (Claude Code only; other tools use the CLI)"}`);
  // No rival listed means the rule never calls it, so nothing else is needed.
  if (!model) return console.log("\nNo rival picked: dynamite test stays Claude-only."), 0;
  // A pinned id this Codex doesn't know fails every review, so catch it here.
  const ids = codex.ok && model.model ? knownIds(probe("codex", ["debug", "models"]).out) : null;
  if (ids && !ids.includes(model.model)) {
    console.log(`\nThis Codex doesn't know "${model.model}". Its ids: ${ids.join(", ")}`);
    console.log(`Update Codex (npm install -g @openai/codex), or set models.${REVIEW_TIER}.${LINEAGE} in ${PROJECT_FILE} or your agent-overrides.local.json (docs/guide/overrides.md).`);
    return 1;
  }
  // Ready needs the CLI and a sign-in; the plugin is a nicety outside Claude Code.
  if (codex.ok && login.ok) return console.log("\nReady."), 0;
  console.log(`\nNot ready. Steps:\n${SETUP.join("\n")}`);
  return 1;
}

// Sends a review or a chat to the plugin runtime, or to the CLI without it.
function dispatch(mode, argv) {
  // No rival picked: nothing to call (the rule never asks for one then).
  const picked = rivalModel();
  if (!picked) return console.error(`No rival picked for ${REVIEW_TIER} (pnpm models).`), 1;
  // Fail fast: a signed-out CLI retries quietly instead of erroring.
  if (!probe("codex", ["login", "status"]).ok) return console.error(`Codex is missing or signed out. Steps:\n${SETUP.join("\n")}`), 1;
  const companion = findCompanion();
  // Review: plugin's dynamite test, waiting for the result.
  if (mode === "review") {
    const { options, text } = parseArgs(argv, ["base", "model"], []);
    options.model ??= picked.model ?? undefined;
    const base = options.base ?? DEFAULT_BASE;
    const model = options.model ? ["--model", options.model] : [];
    if (companion) return run(process.execPath, [companion, "adversarial-review", "--wait", "--base", base, ...model, ...(text ? [text] : [])]);
    return run("codex", ["exec", "--sandbox", "read-only", ...(options.model ? ["-m", options.model] : []), FALLBACK_PROMPT(base, text)]);
  }
  // Chat: a read-only Codex thread; --resume continues the last one.
  const { options, text } = parseArgs(argv, ["model"], ["resume"]);
  options.model ??= picked.model ?? undefined;
  if (!text) throw new Error("chat needs a message");
  const model = options.model ? ["--model", options.model] : [];
  if (companion) return run(process.execPath, [companion, "task", options.resume ? "--resume-last" : "--fresh", ...model, text]);
  // The CLI keeps a resumed session's sandbox, so only a new one names it.
  if (options.resume) return run("codex", ["exec", "resume", "--last", ...(options.model ? ["-m", options.model] : []), text]);
  return run("codex", ["exec", "--sandbox", "read-only", ...(options.model ? ["-m", options.model] : []), text]);
}

function main([command = "doctor", ...argv]) {
  if (command === "doctor") return doctor();
  // Off when no rival is listed, whatever the setting says.
  if (command === "scope") {
    const { scope, rivalScope } = readScopes();
    return console.log(`test: ${scope}\nrival: ${rivalModel() ? rivalScope : "off"}`), 0;
  }
  if (command === "review" || command === "chat") return dispatch(command, argv);
  console.error("usage: rival-review.mjs doctor | scope | review [--base <ref>] [--model <id>] [focus] | chat [--resume] [--model <id>] <message>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
