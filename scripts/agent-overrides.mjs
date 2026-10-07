#!/usr/bin/env node
// The one place a project, and each person on it, overrides how the agents work: models and the dynamite test.
// In the app: nothing at runtime; `pnpm overrides` for people, scripts/model-tiers.mjs and scripts/rival-review.mjs for agents.
// Used by: package.json (`pnpm overrides`), scripts/model-tiers.mjs, scripts/rival-review.mjs.
// Uses: agent-overrides.json (the team's, committed), agent-overrides.local.json (yours, gitignored), and the
//   files they replace, model-tiers.project.json and dynamite-test.project.json, still read; tested by
//   scripts/agent-overrides.test.mjs.
//
// Layers, lowest first; a higher one wins key by key:
//   1. whippletree's defaults (model-tiers.json, the rules)
//   2. model-tiers.project.json, dynamite-test.project.json (legacy, read until a project moves them)
//   3. agent-overrides.json        the team's choices, in git
//   4. agent-overrides.local.json  one person's choices, this machine only: models, a narrower rival for a
//                                  smaller token budget. It may not test less than the team asked for.
//
//   (none)   every value set, with the file it came from
//   init     create agent-overrides.local.json if missing, and make sure git ignores it

// Node builtins only, so it runs before `pnpm install`.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECT_FILE = "agent-overrides.json";
export const LOCAL_FILE = "agent-overrides.local.json";

// The files the project file replaces, and how each maps into its shape.
export const LEGACY = {
  "model-tiers.project.json": (data) => ({ models: data.tiers }),
  "dynamite-test.project.json": ({ $comment: _comment, ...rest }) => ({ dynamiteTest: rest }),
};

// The sections an override file may hold. A typo in a key must fail, not quietly do nothing.
const SECTIONS = ["models", "dynamiteTest"];
const DYNAMITE_KEYS = ["scope", "rivalScope"];

// What `init` writes: empty sections, so the keys are there to fill.
const LOCAL_SKELETON = {
  $comment: `Your own agent settings, this machine only (gitignored). Wins over ${PROJECT_FILE}. docs/guide/overrides.md`,
  models: {},
  dynamiteTest: {},
};

// Reads a JSON file, naming it when it doesn't parse.
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Checks one layer's shape; values are checked by the script that owns them, which names this file.
const validate = (file, data) => {
  if (!isObject(data)) throw new Error(`${file}: must be a JSON object`);
  for (const key of Object.keys(data)) {
    if (key !== "$comment" && !SECTIONS.includes(key)) throw new Error(`${file}: unknown key "${key}" (have ${SECTIONS.join(", ")})`);
  }
  if (data.models !== undefined) {
    if (!isObject(data.models)) throw new Error(`${file}: models must be { "<tier>": { "<lineage>": … } }`);
    for (const [tier, cells] of Object.entries(data.models)) {
      if (!isObject(cells)) throw new Error(`${file}: models.${tier} must be { "<lineage>": … }`);
    }
  }
  if (data.dynamiteTest !== undefined) {
    if (!isObject(data.dynamiteTest)) throw new Error(`${file}: dynamiteTest must be { "scope", "rivalScope" }`);
    for (const key of Object.keys(data.dynamiteTest)) {
      if (!DYNAMITE_KEYS.includes(key)) throw new Error(`${file}: unknown key "dynamiteTest.${key}" (have ${DYNAMITE_KEYS.join(", ")})`);
    }
  }
  return data;
};

// Every override file present, lowest first: { file, layer: "legacy" | "project" | "local", data }.
export function readLayers(root = ".", { local = true } = {}) {
  const layers = [];
  for (const [file, toShape] of Object.entries(LEGACY)) {
    if (existsSync(join(root, file))) layers.push({ file, layer: "legacy", data: validate(file, toShape(readJson(join(root, file)))) });
  }
  for (const [file, layer] of [[PROJECT_FILE, "project"], ...(local ? [[LOCAL_FILE, "local"]] : [])]) {
    if (existsSync(join(root, file))) layers.push({ file, layer, data: validate(file, readJson(join(root, file))) });
  }
  return layers;
}

// The merged settings, each value with where it came from: { value, file, layer }.
//   models:       { tier: { lineage: entry } }
//   dynamiteTest: { scope?: entry, rivalScope?: entry }
// `local: false` gives the team's settings alone, the floor a personal file can't go under.
export function readOverrides(root = ".", options = {}) {
  const models = {};
  const dynamiteTest = {};
  for (const { file, layer, data } of readLayers(root, options)) {
    for (const [tier, cells] of Object.entries(data.models ?? {})) {
      for (const [lineage, value] of Object.entries(cells)) (models[tier] ??= {})[lineage] = { value, file, layer };
    }
    for (const [key, value] of Object.entries(data.dynamiteTest ?? {})) dynamiteTest[key] = { value, file, layer };
  }
  return { models, dynamiteTest };
}

// Every value set, one line each, with its file; then a nudge for any legacy file.
const render = (root) => {
  const layers = readLayers(root);
  const { models, dynamiteTest } = readOverrides(root);
  const lines = [
    ...Object.entries(models).flatMap(([tier, cells]) => Object.entries(cells).map(([lineage, e]) => `models.${tier}.${lineage} = ${e.value}   (${e.file})`)),
    ...Object.entries(dynamiteTest).map(([key, e]) => `dynamiteTest.${key} = ${e.value}   (${e.file})`),
  ];
  const legacy = layers.filter((l) => l.layer === "legacy").map((l) => l.file);
  return [
    lines.length ? lines.join("\n") : "Nothing overridden: whippletree's defaults apply.",
    "",
    `Files: ${layers.length ? layers.map((l) => l.file).join(" < ") : "none"} (later wins). Full picture: pnpm models, pnpm rival scope.`,
    ...(legacy.length ? [`Move ${legacy.join(" and ")} into ${PROJECT_FILE}; both are still read, below it (docs/guide/overrides.md).`] : []),
    ...(existsSync(join(root, LOCAL_FILE)) ? [] : [`No ${LOCAL_FILE} yet: \`pnpm overrides init\` makes one for your own picks.`]),
  ].join("\n");
};

// Makes git ignore the personal file. .gitignore is a project file, so a project made before this
// one existed has no line for it, and a personal pick must never land in a commit.
const ensureIgnored = () => {
  if (spawnSync("git", ["check-ignore", "-q", LOCAL_FILE]).status === 0) return false;
  const current = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
  appendFileSync(".gitignore", `${current && !current.endsWith("\n") ? "\n" : ""}# Personal agent overrides (docs/guide/overrides.md).\n/${LOCAL_FILE}\n`);
  return true;
};

function main([command]) {
  if (!command) return console.log(render(".")), 0;
  if (command === "init") {
    if (ensureIgnored()) console.log(`Added /${LOCAL_FILE} to .gitignore; commit that line.`);
    if (existsSync(LOCAL_FILE)) return console.log(`${LOCAL_FILE} exists; edit it.`), 0;
    writeFileSync(LOCAL_FILE, `${JSON.stringify(LOCAL_SKELETON, null, 2)}\n`);
    return console.log(`Wrote ${LOCAL_FILE} (gitignored). Fill it in, then run pnpm overrides.`), 0;
  }
  console.error("usage: agent-overrides.mjs [init]");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
