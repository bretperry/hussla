/*
  Harness files name a model tier (`quick`, `workhorse`, `deep`, `frontier`) and lineage, never a model.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: harness.json and each stacks/<name>/pack.json (the harness file lists); model-tiers.json and
    model-tiers.project.json are the only files allowed to name models; scripts/model-tiers.mjs → resolve().

  Model names date with every release; a tier doesn't. Keeping them in one table means a new model
  is a one-row change there, not a hunt through every rule and template.
*/
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATALOG_TIERS, resolve } from "./model-tiers.mjs";
import { presentPacks } from "./stack.mjs";

// The files that map tiers to models, and this test (its pattern names them).
const ALLOWED = new Set(["model-tiers.json", "model-tiers.project.json", "scripts/model-tiers.test.mjs"]);

// Model names from every lineage: Claude families (bare or in an id like `claude-sonnet-…`), and a
// versioned GPT or Gemini (`gemini` alone is the CLI and its config dir, not a model).
const MODEL_NAME = /\b(haiku|sonnet|opus|fable)\b|\bgpt-?\d|\bgemini[- ]\d|\bgrok[- ]\d/i;

const manifest = JSON.parse(readFileSync("harness.json", "utf8"));
// Present stack packs ship harness files too (`docs`, `code`), and their manifests are harness files.
const packFiles = presentPacks(".").flatMap((pack) => [`stacks/${pack.name}/pack.json`, ...(pack.docs ?? []), ...(pack.code ?? [])]);
// A project may skip a harness file, so only check the ones present.
const files = [...manifest.docs, ...manifest.code, ...packFiles].filter((path) => !ALLOWED.has(path) && existsSync(path));

describe("model tiers", () => {
  it("no harness file outside model-tiers.json names a model", () => {
    const offenders = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => (MODEL_NAME.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(offenders, [], "name a tier (plans.mdc → Model tiers) instead; models live in model-tiers.json");
  });
});

// A suggested cell.
const cell = (label, extra = {}) => ({ label, ...extra });

// A scratch root with these suggestions and, optionally, these project overrides.
const root = (overrides) => {
  const dir = mkdtempSync(join(tmpdir(), "tiers-"));
  writeFileSync(
    join(dir, "model-tiers.json"),
    JSON.stringify({
      lineages: { home: {}, rival: {}, wildcard: {} },
      tiers: { deep: { home: cell("H", { model: "h-1", latest: "h" }), rival: cell("R"), wildcard: null } },
    }),
  );
  if (overrides) writeFileSync(join(dir, "model-tiers.project.json"), JSON.stringify({ tiers: overrides }));
  return dir;
};

describe("resolve", () => {
  it("uses the suggestions when the project sets nothing", () => {
    assert.deepEqual(resolve(root()).deep, {
      home: { label: "H", model: "h-1", source: "whippletree" },
      rival: { label: "R", model: null, source: "whippletree" },
      wildcard: null,
    });
  });
  it("lets the project pin, follow latest, opt out, or fill an empty cell", () => {
    const deep = resolve(root({ deep: { home: "latest", rival: "none", wildcard: "w-9" } })).deep;
    assert.deepEqual(deep.home, { label: "latest", model: "h", source: "project" });
    assert.equal(deep.rival, null);
    assert.deepEqual(deep.wildcard, { label: "w-9", model: "w-9", source: "project" });
  });
  it("refuses a tier, lineage, or value it doesn't know, rather than quietly using the suggestion", () => {
    assert.throws(() => resolve(root({ deeep: { home: "x" } })), /unknown tier "deeep"/);
    assert.throws(() => resolve(root({ deep: { homme: "x" } })), /unknown lineage "homme"/);
    assert.throws(() => resolve(root({ deep: { home: "" } })), /must be a model id/);
  });
  it("resolves the template's own file", () => {
    assert.ok(resolve(".").deep.home.model);
  });
});

describe("catalog", () => {
  const suggested = JSON.parse(readFileSync("model-tiers.json", "utf8"));
  it("tags every model with a known tier", () => {
    const bad = Object.values(suggested.catalog).flatMap((vendor) => vendor.models.filter((model) => !CATALOG_TIERS.includes(model.tier)));
    assert.deepEqual(bad, []);
  });
  it("lists every pinned suggestion under its lineage's vendor, so a suggestion can't name a model nobody checked", () => {
    const missing = Object.entries(suggested.tiers).flatMap(([tier, cells]) =>
      Object.entries(cells).flatMap(([lineage, picked]) => {
        const ids = suggested.catalog[suggested.lineages[lineage].vendor].models.map((model) => model.id);
        return picked?.model && !ids.includes(picked.model) ? [`${tier}.${lineage}: ${picked.model}`] : [];
      }),
    );
    assert.deepEqual(missing, []);
  });
});
