/*
  The Swift pack's wiring outside its scripts: its required CI check, its CI jobs' conditions, its permissions, and when a project adopts it.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no swift.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/swift/pack.json, .github/workflows/ci.yml, .claude/settings.json, scripts/harness-sync.mjs (holdsPackFiles).
*/
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { holdsPackFiles } from "../../scripts/harness-sync.mjs";

const REPO = resolve(".");
const pack = JSON.parse(readFileSync(join(REPO, "stacks/swift/pack.json"), "utf8"));
const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");

// One job's block in ci.yml: from `  <id>:` to the next job or the end.
const job = (id) => new RegExp(`^  ${id}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(ci)?.[0] ?? "";

describe("the required check", () => {
  it("names a job the workflow runs, so the ruleset bootstrap adds always gets a report", () => {
    assert.deepEqual(pack.requiredChecks, ["Swift tests"]);
    for (const name of pack.requiredChecks) assert.match(ci, new RegExp(`^    name: ${name}$`, "m"), `no CI job is named "${name}"`);
  });

  it("reports even when the macOS job skips, and not for a run that was cancelled", () => {
    const aggregator = job("swift");
    assert.match(aggregator, /name: Swift tests\n/);
    assert.match(aggregator, /if: \$\{\{ !cancelled\(\) \}\}/);
    assert.doesNotMatch(aggregator, /always\(\)/);
  });
});

describe("the macOS job", () => {
  it("skips on a push to dev, which repeats the merged PR's run", () => {
    assert.match(job("swift-macos"), /if: .*github\.event_name != 'push'/);
  });
});

describe("permissions", () => {
  it("allow only the swift format forms the pack uses, not every subcommand", () => {
    const formats = pack.claudeSettings.allow.filter((entry) => entry.startsWith("Bash(swift format"));
    assert.deepEqual(formats, ["Bash(swift format lint *)", "Bash(swift format -i *)"]);
    const settings = readFileSync(join(REPO, ".claude/settings.json"), "utf8");
    for (const entry of pack.claudeSettings.allow) assert.ok(settings.includes(JSON.stringify(entry)), `${entry} missing from .claude/settings.json`);
  });
});

describe("the edit hook", () => {
  it("also runs on the pack's own configs", () => {
    assert.deepEqual(pack.editCheck.files, ["swift-layers.json", ".swift-format"]);
  });
});

// A pre-pack project holding `files`: does harness:pull adopt the swift pack?
const adopts = (files) => {
  const root = mkdtempSync(join(tmpdir(), "swift-adopt-"));
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "");
  }
  return holdsPackFiles(root, "swift", pack);
};

describe("adoption", () => {
  it("keys on the pack's layer map, not a rule file a project may have written for itself", () => {
    assert.equal(adopts([".cursor/rules/swift.mdc", ".cursor/rules/testing-swift.mdc", "Package.swift"]), false);
    assert.equal(adopts(["swift-layers.json"]), true);
  });
});
