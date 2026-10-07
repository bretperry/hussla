/*
  Which way a harness file should flow, and which files a project has opted out of.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/harness-sync.mjs → classify(), isSkipped(), splitPacks(), harnessPaths(), holdsPackFiles();
    stacks/{infra,sql-migrations,kotlin}/pack.json (their `adoptOn`).

  The verdict is the whole safety story: "upstream" is overwritten on pull, "local" is offered on
  push, so mixing them up either wipes a project's edit or reverts upstream's.
*/
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { classify, harnessPaths, holdsPackFiles, isSkipped, splitPacks } from "./harness-sync.mjs";

describe("classify", () => {
  it("names the side that moved since base", () => {
    assert.equal(classify({ ours: "a", base: "a", theirs: "a", hasBase: true }), "same");
    assert.equal(classify({ ours: "a", base: "a", theirs: "b", hasBase: true }), "upstream");
    assert.equal(classify({ ours: "b", base: "a", theirs: "a", hasBase: true }), "local");
    assert.equal(classify({ ours: "b", base: "a", theirs: "c", hasBase: true }), "both");
  });

  it("a file new upstream, or deleted here, reads as one side moving", () => {
    assert.equal(classify({ ours: null, base: null, theirs: "new", hasBase: true }), "upstream");
    assert.equal(classify({ ours: null, base: "a", theirs: "a", hasBase: true }), "local");
  });

  it("without a base it can't tell, unless the two already match", () => {
    assert.equal(classify({ ours: "a", base: null, theirs: "b", hasBase: false }), "unknown");
    assert.equal(classify({ ours: "a", base: null, theirs: "a", hasBase: false }), "same");
  });
});

describe("isSkipped", () => {
  const skip = { "scripts/check-edited.mjs": "too slow here", ".github/workflows": "own CI" };

  it("matches the file itself or anything under a skipped directory", () => {
    assert.equal(isSkipped("scripts/check-edited.mjs", skip), true);
    assert.equal(isSkipped(".github/workflows/harness-drift.yml", skip), true);
  });

  it("does not match a sibling that only shares a prefix", () => {
    assert.equal(isSkipped("scripts/check-edited.mjs.bak", skip), false);
    assert.equal(isSkipped(".github/workflows-old/x.yml", skip), false);
    assert.equal(isSkipped("scripts/command-guard.mjs", skip), false);
  });
});

describe("stack packs", () => {
  const manifest = { docs: ["a.md"], code: ["b.mjs"], stacks: ["lang", "addon"] };

  it("compares only installed packs and lists the rest as available, never kept", () => {
    assert.deepEqual(splitPacks(manifest, (name) => name === "lang"), { kept: ["lang"], adopted: [], available: ["addon"] });
    // No packs on disk and none adoptable: nothing pulled in.
    assert.deepEqual(splitPacks(manifest, () => false), { kept: [], adopted: [], available: ["lang", "addon"] });
    assert.deepEqual(splitPacks({}, () => true), { kept: [], adopted: [], available: [] });
  });

  it("adopts a pack whose files a pre-pack project already holds, and keeps it in sync", () => {
    assert.deepEqual(splitPacks(manifest, () => false, (name) => name === "lang"), { kept: ["lang"], adopted: ["lang"], available: ["addon"] });
  });

  it("a kept pack adds its manifest (as code) and files; a removed one adds nothing", () => {
    const lang = { docs: ["lang.mdc"], code: ["lang.json"] };
    assert.deepEqual(harnessPaths(manifest, { lang }), [
      { path: "a.md", group: "docs" },
      { path: "b.mjs", group: "code" },
      { path: "lang.mdc", group: "docs" },
      { path: "stacks/lang/pack.json", group: "code" },
      { path: "lang.json", group: "code" },
    ]);
    assert.deepEqual(harnessPaths(manifest, {}).map((row) => row.path), ["a.md", "b.mjs"]);
  });

  it("a pack's files count only outside its own stacks/<name>/ dir", () => {
    const root = mkdtempSync(join(tmpdir(), "adopt-"));
    const pack = { docs: [".cursor/rules/lang.mdc"], code: ["stacks/lang/check.mjs"] };
    assert.equal(holdsPackFiles(root, "lang", pack), false);
    mkdirSync(join(root, "stacks/lang"), { recursive: true });
    writeFileSync(join(root, "stacks/lang/check.mjs"), "");
    assert.equal(holdsPackFiles(root, "lang", pack), false);
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    writeFileSync(join(root, ".cursor/rules/lang.mdc"), "");
    assert.equal(holdsPackFiles(root, "lang", pack), true);
  });

  it("a pack's `adoptOn` names the files only it would have: a generic config alone doesn't adopt it", () => {
    const root = mkdtempSync(join(tmpdir(), "adopt-on-"));
    const pack = { docs: [".cursor/rules/lang.mdc"], code: ["lang.toml", "fmt.toml"], adoptOn: [".cursor/rules/lang.mdc"] };
    writeFileSync(join(root, "fmt.toml"), "");
    writeFileSync(join(root, "lang.toml"), "");
    assert.equal(holdsPackFiles(root, "lang", pack), false);
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    writeFileSync(join(root, ".cursor/rules/lang.mdc"), "");
    assert.equal(holdsPackFiles(root, "lang", pack), true);
  });

  // The shipped manifests, not fakes: a pack whose rule has a topic name (infra.mdc) once adopted
  // any project with its own rule of that name, and pull merged ours into theirs with conflict markers.
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const [name, rule] of [["infra", "infra.mdc"], ["sql-migrations", "migrations.mdc"], ["kotlin", "kotlin.mdc"]]) {
    const packFile = join(repo, `stacks/${name}/pack.json`);
    it(`a project with its own ${rule} and no ${name} pack does not adopt it`, { skip: existsSync(packFile) ? false : `${name} pack removed here` }, () => {
      const root = mkdtempSync(join(tmpdir(), "adopt-topic-"));
      mkdirSync(join(root, ".cursor/rules"), { recursive: true });
      writeFileSync(join(root, `.cursor/rules/${rule}`), "our own rule\n");
      assert.equal(holdsPackFiles(root, name, JSON.parse(readFileSync(packFile, "utf8"))), false);
    });
  }
});
