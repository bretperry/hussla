/*
  One override file for the team, one for each person, and the old per-setting files still read beneath them.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/agent-overrides.mjs → readLayers(), readOverrides(); scripts/model-tiers.mjs → resolve();
    scripts/rival-review.mjs → readScopes().

  The layers decide who runs, and how often a change gets tested, so the order and the floor are pinned here.
*/
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOCAL_FILE, PROJECT_FILE, readLayers, readOverrides } from "./agent-overrides.mjs";
import { resolve } from "./model-tiers.mjs";
import { readScopes } from "./rival-review.mjs";

// A scratch root with these files (objects are written as JSON), plus a one-row model table.
const root = (files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "overrides-"));
  const tiers = { lineages: { home: {}, rival: {}, wildcard: {} }, tiers: { deep: { home: { label: "H", model: "h-1" }, rival: { label: "R" }, wildcard: null } } };
  for (const [path, body] of Object.entries({ "model-tiers.json": tiers, ...files }))
    writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
};

describe("layers", () => {
  it("reads nothing when no file is present", () => {
    assert.deepEqual(readLayers(root()), []);
    assert.deepEqual(readOverrides(root()), { models: {}, dynamiteTest: {} });
  });
  it("orders legacy < project < local, and the later one wins key by key", () => {
    const dir = root({
      "model-tiers.project.json": { tiers: { deep: { home: "old", rival: "old" } } },
      "dynamite-test.project.json": { scope: "all", rivalScope: "all" },
      [PROJECT_FILE]: { models: { deep: { rival: "team" } }, dynamiteTest: { rivalScope: "high-risk" } },
      [LOCAL_FILE]: { models: { deep: { home: "mine" } } },
    });
    assert.deepEqual(readLayers(dir).map((l) => l.layer), ["legacy", "legacy", "project", "local"]);
    const { models, dynamiteTest } = readOverrides(dir);
    assert.deepEqual(models.deep.home, { value: "mine", file: LOCAL_FILE, layer: "local" });
    assert.deepEqual(models.deep.rival, { value: "team", file: PROJECT_FILE, layer: "project" });
    assert.equal(dynamiteTest.scope.file, "dynamite-test.project.json");
    assert.equal(dynamiteTest.rivalScope.value, "high-risk");
  });
  it("leaves the personal file out when asked for the team's settings", () => {
    const dir = root({ [PROJECT_FILE]: { dynamiteTest: { scope: "all" } }, [LOCAL_FILE]: { dynamiteTest: { scope: "all", rivalScope: "major-release" } } });
    assert.deepEqual(Object.keys(readOverrides(dir, { local: false }).dynamiteTest), ["scope"]);
  });
  it("refuses a key it doesn't know, naming the file, rather than ignoring it", () => {
    assert.throws(() => readLayers(root({ [PROJECT_FILE]: { model: {} } })), /agent-overrides.json: unknown key "model"/);
    assert.throws(() => readLayers(root({ [LOCAL_FILE]: { dynamiteTest: { scopes: "all" } } })), /local.json: unknown key "dynamiteTest.scopes"/);
    assert.throws(() => readLayers(root({ [PROJECT_FILE]: "[]" })), /must be a JSON object/);
    assert.throws(() => readLayers(root({ [PROJECT_FILE]: "{" })), /agent-overrides.json/);
  });
});

describe("models through the layers", () => {
  it("marks a cell set by the team or by you", () => {
    const deep = resolve(root({ [PROJECT_FILE]: { models: { deep: { rival: "r-2" } } }, [LOCAL_FILE]: { models: { deep: { home: "latest" } } } })).deep;
    assert.equal(deep.rival.source, "project");
    assert.equal(deep.home.source, "local");
  });
  it("lets you turn the rival off for yourself", () => {
    assert.equal(resolve(root({ [LOCAL_FILE]: { models: { deep: { rival: "none" } } } })).deep.rival, null);
  });
  it("names the file holding a bad tier", () => {
    assert.throws(() => resolve(root({ [LOCAL_FILE]: { models: { deeep: { home: "x" } } } })), /agent-overrides.local.json: unknown tier "deeep"/);
  });
});

describe("dynamite test scope through the layers", () => {
  it("lets you narrow the rival for a smaller budget", () => {
    const dir = root({ [PROJECT_FILE]: { dynamiteTest: { scope: "high-risk" } }, [LOCAL_FILE]: { dynamiteTest: { rivalScope: "major-release" } } });
    assert.deepEqual(readScopes(dir), { scope: "high-risk", rivalScope: "major-release" });
  });
  it("lets you test more than the team asked", () => {
    assert.equal(readScopes(root({ [LOCAL_FILE]: { dynamiteTest: { scope: "all" } } })).scope, "all");
  });
  it("refuses a personal scope narrower than the team's, since the team's is a floor", () => {
    assert.throws(() => readScopes(root({ [LOCAL_FILE]: { dynamiteTest: { scope: "major-release" } } })), /narrower than the team's "high-risk"/);
    const dir = root({ [PROJECT_FILE]: { dynamiteTest: { scope: "all" } }, [LOCAL_FILE]: { dynamiteTest: { scope: "high-risk" } } });
    assert.throws(() => readScopes(dir), /local.json: .*narrower than the team's "all"/);
  });
  it("lets the team narrow its own scope in the project file", () => {
    assert.equal(readScopes(root({ [PROJECT_FILE]: { dynamiteTest: { scope: "major-release" } } })).scope, "major-release");
  });
});
