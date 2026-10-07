/*
  The rival reviewer's switches: the dynamite test's scope settings, whether a rival is listed, and which plugin runtime runs.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/rival-review.mjs → readScopes(), rivalModel(), findCompanion(), parseArgs(); model-tiers.json shapes.

  Each of these fails quietly if it's wrong: a misread scope or tiers cell turns the rival off with
  no error, and an old plugin version picked over a new one runs stale prompts.
*/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SCOPE, findCompanion, knownIds, parseArgs, readScopes, rivalModel } from "./rival-review.mjs";

// A scratch project root holding these files.
const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), "rival-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

// Suggestions with this rival on the `deep` row (null = no pick).
const tiers = (rival) =>
  JSON.stringify({ lineages: { home: {}, rival: {}, wildcard: {} }, tiers: { deep: { home: { label: "H" }, rival, wildcard: null } } });

// The scopes a project with this dynamite-test.project.json (object, raw text, or none) reads.
const scopes = (config) =>
  readScopes(project(config === undefined ? {} : { "dynamite-test.project.json": typeof config === "string" ? config : JSON.stringify(config) }));

describe("scope", () => {
  it("defaults to high-risk for both with no file or no keys", () => {
    assert.equal(DEFAULT_SCOPE, "high-risk");
    assert.deepEqual(scopes(), { scope: "high-risk", rivalScope: "high-risk" });
    assert.deepEqual(scopes({}), { scope: "high-risk", rivalScope: "high-risk" });
  });
  it("reads each defined value, and the rival follows scope when it has none", () => {
    for (const scope of ["all", "high-risk", "major-release"]) assert.deepEqual(scopes({ scope }), { scope, rivalScope: scope });
  });
  it("lets the rival run narrower than the test, for a smaller rival budget", () => {
    assert.deepEqual(scopes({ rivalScope: "major-release" }), { scope: "high-risk", rivalScope: "major-release" });
    assert.deepEqual(scopes({ scope: "all", rivalScope: "high-risk" }), { scope: "all", rivalScope: "high-risk" });
  });
  it("refuses a rival wider than the test, since it only runs inside one", () => {
    assert.throws(() => scopes({ rivalScope: "all" }), /wider than scope/);
    assert.throws(() => scopes({ scope: "major-release", rivalScope: "high-risk" }), /wider than scope/);
  });
  it("refuses a value the rule doesn't define, rather than changing who tests", () => {
    assert.throws(() => scopes('{"scope":"high"}'), /scope must be one of/);
    assert.throws(() => scopes('{"rivalScope":"high"}'), /rivalScope must be one of/);
  });
});

describe("rival picked", () => {
  it("reads the deep rival, with its model id when one is set", () => {
    assert.deepEqual(rivalModel(project({ "model-tiers.json": tiers({ label: "R", model: "r-1" }) })), { label: "R", model: "r-1", source: "whippletree" });
    assert.equal(rivalModel(project({ "model-tiers.json": tiers({ label: "R" }) })).model, null);
  });
  it("is off with no pick, or when the project says none", () => {
    assert.equal(rivalModel(project({ "model-tiers.json": tiers(null) })), null);
    const files = { "model-tiers.json": tiers({ label: "R" }), "model-tiers.project.json": '{"tiers":{"deep":{"rival":"none"}}}' };
    assert.equal(rivalModel(project(files)), null);
  });
  it("finds the template's own pick", () => {
    assert.ok(rivalModel("."), "model-tiers.json picks a rival for deep");
  });
});

describe("plugin runtime", () => {
  it("picks the newest version, numerically", () => {
    const home = project({
      ".claude/plugins/cache/openai-codex/codex/1.0.9/scripts/codex-companion.mjs": "",
      ".claude/plugins/cache/openai-codex/codex/1.0.10/scripts/codex-companion.mjs": "",
      ".claude/plugins/cache/openai-codex/codex/1.0.11/README.md": "",
    });
    assert.match(findCompanion({ HOME: home }), /1\.0\.10/);
  });
  it("honours CLAUDE_CONFIG_DIR and an explicit path, and returns null when absent", () => {
    const dir = project({ "plugins/cache/openai-codex/codex/2.0.0/scripts/codex-companion.mjs": "" });
    assert.match(findCompanion({ CLAUDE_CONFIG_DIR: dir }), /2\.0\.0/);
    assert.equal(findCompanion({ HOME: project({}) }), null);
    assert.equal(findCompanion({ CODEX_COMPANION: join(dir, "nope.mjs") }), null);
  });
});

describe("args", () => {
  it("splits options from the free text", () => {
    assert.deepEqual(parseArgs(["--base", "origin/main", "look", "at", "auth"], ["base", "model"], []), {
      options: { base: "origin/main" },
      text: "look at auth",
    });
    assert.deepEqual(parseArgs(["--resume", "why?"], ["model"], ["resume"]), { options: { resume: true }, text: "why?" });
  });
});

describe("Codex catalog", () => {
  it("lists the slugs, and says nothing rather than guessing when the output isn't the catalog", () => {
    assert.deepEqual(knownIds(JSON.stringify({ models: [{ slug: "a-1" }, { slug: "b-2" }] })), ["a-1", "b-2"]);
    assert.equal(knownIds("Not logged in"), null);
  });
});
