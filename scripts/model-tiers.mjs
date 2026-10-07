#!/usr/bin/env node
// Resolves which model runs for each tier and lineage: the project's pick, else whippletree's suggestion.
// In the app: nothing at runtime; `pnpm models` for people, the showrunner and scripts/rival-review.mjs for agents.
// Used by: package.json (`pnpm models`), scripts/rival-review.mjs, .cursor/rules/plans.mdc → Model tiers.
// Uses: model-tiers.json (whippletree's suggestions, harness-owned), scripts/agent-overrides.mjs (the team's and
//   your own picks: agent-overrides.json → models, agent-overrides.local.json); tested by scripts/model-tiers.test.mjs.
//
// Plans name a tier, never a model, so a project changes its models here without touching a plan.
// A project value is a model id (pinned), `latest` (home: the Claude Code alias that tracks the newest
// of the family; rival and wildcard: the tool's own default), or `none` (no pick: no rival review, say).
//
//   (none)                 the resolved table, with where each cell came from
//   json                   the same, as JSON
//   get <tier> <lineage>   the model to pass the tool; empty line = let the tool choose; exit 1 = no pick
//   catalog [vendor]       every model each vendor offers, with the tier whippletree suggests for it

// Node builtins only, so it runs before `pnpm install`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LOCAL_FILE, PROJECT_FILE, readOverrides } from "./agent-overrides.mjs";

// Whippletree's suggestions.
export const SUGGESTED = "model-tiers.json";

// Catalog tiers: the four plan tiers, plus superseded models and ones not meant for plans.
export const CATALOG_TIERS = ["quick", "workhorse", "deep", "frontier", "legacy", "special"];

// The two words a project may use instead of a model id.
const LATEST = "latest";
const NONE = "none";

// Reads a JSON file, naming it when it doesn't parse.
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
};

// One cell: the override (if any) over the suggestion. null = no pick. Source: whippletree, project, or local.
const resolveCell = (suggested, override) => {
  // No override: the suggestion as written; a cell without `model` means "the tool's default".
  if (override === undefined) return suggested ? { label: suggested.label, model: suggested.model ?? null, source: "whippletree" } : null;
  // A legacy model-tiers.project.json is the team's pick too.
  const source = override.layer === "local" ? "local" : "project";
  // `none`: the cell is opted out.
  if (override.value === NONE) return null;
  // `latest`: home has a family alias; other tools pick their own default.
  if (override.value === LATEST) return { label: LATEST, model: suggested?.latest ?? null, source };
  // Anything else is a pinned model id.
  return { label: override.value, model: override.value, source };
};

// The whole table: { tier: { lineage: cell | null } }, failing loudly on an override key or value it can't use.
export function resolve(root = ".") {
  const suggested = readJson(join(root, SUGGESTED));
  const overrides = readOverrides(root).models;
  const lineages = Object.keys(suggested.lineages);
  // A typo in a tier or lineage name would otherwise be ignored and the suggestion would quietly run.
  for (const [tier, cells] of Object.entries(overrides)) {
    for (const [lineage, { value, file }] of Object.entries(cells)) {
      if (!(tier in suggested.tiers)) throw new Error(`${file}: unknown tier "${tier}" (have ${Object.keys(suggested.tiers).join(", ")})`);
      if (!lineages.includes(lineage)) throw new Error(`${file}: unknown lineage "${lineage}" (have ${lineages.join(", ")})`);
      if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: ${tier}.${lineage} must be a model id, "${LATEST}", or "${NONE}"`);
    }
  }
  // Every tier, every lineage, override over suggestion.
  return Object.fromEntries(
    Object.entries(suggested.tiers).map(([tier, cells]) => [
      tier,
      Object.fromEntries(lineages.map((lineage) => [lineage, resolveCell(cells[lineage] ?? null, overrides[tier]?.[lineage])])),
    ]),
  );
}

// Marks where a cell was set, when not by whippletree.
const MARK = { project: " *", local: " **" };

// One cell as text: label, the id the tool gets (or its default), and a mark when an override set it.
const showCell = (c) => (c ? `${c.label}${c.model && c.model !== c.label ? ` [${c.model}]` : c.model ? "" : " [tool default]"}${MARK[c.source] ?? ""}` : "—");

// The resolved table as aligned text, one row per tier.
const render = (table) => {
  const lineages = Object.keys(Object.values(table)[0] ?? {});
  const rows = [["tier", ...lineages], ...Object.entries(table).map(([tier, cells]) => [tier, ...lineages.map((l) => showCell(cells[l]))])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return [...rows.map((row) => row.map((text, i) => text.padEnd(widths[i])).join("  ").trimEnd()), "", `* = the team's pick (${PROJECT_FILE}); ** = yours (${LOCAL_FILE}); the rest are whippletree's suggestions (${SUGGESTED}).`].join("\n");
};

// One vendor's catalog as text: how to list ids yourself, when it was checked, then a row per model.
const renderCatalog = (name, vendor) => {
  const rows = vendor.models.map((model) => [model.tier, model.id ?? "(see /model)", model.label, model.note ?? ""]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i].length)));
  return [
    `${name} — ${vendor.tool}`,
    `  find ids: ${vendor.find}`,
    `  checked:  ${vendor.checked}`,
    ...rows.map((row) => `  ${row.map((text, i) => (i < 3 ? text.padEnd(widths[i]) : text)).join("  ").trimEnd()}`),
  ].join("\n");
};

function main([command, tier, lineage]) {
  // The catalog is reference data, read straight from the suggestions file.
  if (command === "catalog") {
    const catalog = readJson(SUGGESTED).catalog ?? {};
    const names = tier ? [tier] : Object.keys(catalog);
    if (!names.every((name) => name in catalog)) return console.error(`vendors: ${Object.keys(catalog).join(", ")}`), 2;
    return console.log(names.map((name) => renderCatalog(name, catalog[name])).join("\n\n")), 0;
  }
  const table = resolve();
  if (!command) return console.log(render(table)), 0;
  if (command === "json") return console.log(JSON.stringify(table, null, 2)), 0;
  if (command === "get" && tier in table && lineage in table[tier]) {
    const cell = table[tier][lineage];
    // No pick: the caller decides what that means (rival review off, use the tier below).
    if (!cell) return 1;
    return console.log(cell.model ?? ""), 0;
  }
  console.error("usage: model-tiers.mjs [json | get <tier> <lineage> | catalog [vendor]]");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
