/*
  How a Cursor rule becomes a Claude rule: always-on, path-scoped, or left to a skill.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/sync-claude-rules.mjs → splitGlobs(), toClaudeRule(), sync().
*/
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { demoteHeadings, splitGlobs, sync, toClaudeRule, withAgentsBlock } from "./sync-claude-rules.mjs";

// A rule file with Cursor frontmatter.
const rule = (frontmatter, body = "# Body\n") => `---\n${frontmatter}\n---\n\n${body}`;

describe("splitGlobs", () => {
  it("keeps brace groups whole and strips quotes", () => {
    assert.deepEqual(splitGlobs('"**/*.{ts,tsx}"'), ["**/*.{ts,tsx}"]);
    assert.deepEqual(splitGlobs("src/**, scripts/**,Dockerfile"), ["src/**", "scripts/**", "Dockerfile"]);
    assert.deepEqual(splitGlobs(""), []);
  });

  it("strips quotes from each glob in a quoted list", () => {
    assert.deepEqual(splitGlobs('"e2e/**/*.ts","playwright.config.ts"'), ["e2e/**/*.ts", "playwright.config.ts"]);
  });
});

describe("toClaudeRule", () => {
  it("always-on rules get no paths", () => {
    const out = toClaudeRule("core", rule("description: Core\nalwaysApply: true"));
    assert.ok(!out.includes("paths:"));
    assert.ok(out.includes("description: Core"));
    assert.ok(out.includes("# Body"));
  });

  it("a YAML list of globs reads the same as the one-line form", () => {
    const out = toClaudeRule("auth", rule("description: Auth\nglobs:\n  - src/server/auth/**/*\n  - src/features/auth/**/*\nalwaysApply: false")) ?? "";
    assert.ok(out.includes('paths:\n  - "src/server/auth/**/*"\n  - "src/features/auth/**/*"'));
    assert.ok(out.includes("description: Auth"));
  });

  it("globs become a paths list", () => {
    const out = toClaudeRule("ts", rule('description: TS\nglobs: "**/*.{ts,tsx}"\nalwaysApply: false')) ?? "";
    assert.ok(out.includes('paths:\n  - "**/*.{ts,tsx}"'));
    assert.ok(!out.includes("globs:"));
  });

  it("AGENTS.md rules get no Claude copy", () => {
    assert.equal(toClaudeRule("core", rule("agentsMd: 1\nalwaysApply: false")), null);
  });

  it("session-mode rules (no globs, not always) are left to skills", () => {
    assert.equal(toClaudeRule("wrangler", rule("description: W\nalwaysApply: false")), null);
  });
});

describe("sync", () => {
  it("writes, detects drift, and removes copies whose rule became a skill", () => {
    const root = mkdtempSync(join(tmpdir(), "rules-"));
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    writeFileSync(join(root, ".cursor/rules/core.mdc"), rule("description: Core\nalwaysApply: true"));
    writeFileSync(join(root, ".cursor/rules/ts.mdc"), rule('globs: "**/*.ts"\nalwaysApply: false'));

    assert.deepEqual(sync(root), [".claude/rules/core.md", ".claude/rules/ts.md"]);
    assert.deepEqual(sync(root, { check: true }), []);

    // Someone edits the .mdc and forgets to sync.
    writeFileSync(join(root, ".cursor/rules/core.mdc"), rule("description: Core\nalwaysApply: true", "# Changed\n"));
    assert.deepEqual(sync(root, { check: true }), [".claude/rules/core.md"]);

    // A scoped rule turns into a session-mode rule: its generated copy goes away.
    writeFileSync(join(root, ".cursor/rules/ts.mdc"), rule("alwaysApply: false"));
    assert.deepEqual(sync(root), [".claude/rules/ts.md", ".claude/rules/core.md"]);
    assert.ok(readFileSync(join(root, ".claude/rules/core.md"), "utf8").includes("# Changed"));
  });

  it("reads a CRLF rule (a Windows checkout) the same as LF, so it isn't dropped to a skill", () => {
    const root = mkdtempSync(join(tmpdir(), "rules-"));
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Guide\n");
    writeFileSync(join(root, ".cursor/rules/ts.mdc"), rule('globs: "**/*.ts"\nalwaysApply: false'));
    writeFileSync(join(root, ".cursor/rules/core.mdc"), rule("agentsMd: 1\nalwaysApply: false", "# Core\n"));
    assert.deepEqual(sync(root), [".claude/rules/ts.md", "AGENTS.md"]);
    const lf = { ts: readFileSync(join(root, ".claude/rules/ts.md"), "utf8"), agents: readFileSync(join(root, "AGENTS.md"), "utf8") };

    // The same two rules checked out with CRLF line endings: nothing is stale, deleted, or dropped.
    for (const name of ["ts", "core"]) writeFileSync(join(root, `.cursor/rules/${name}.mdc`), readFileSync(join(root, `.cursor/rules/${name}.mdc`), "utf8").replaceAll("\n", "\r\n"));
    assert.deepEqual(sync(root, { check: true }), []);
    assert.deepEqual(sync(root), []);
    assert.equal(readFileSync(join(root, ".claude/rules/ts.md"), "utf8"), lf.ts);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), lf.agents);
  });

  it("never deletes a hand-written file in .claude/rules", () => {
    const root = mkdtempSync(join(tmpdir(), "rules-"));
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    mkdirSync(join(root, ".claude/rules"), { recursive: true });
    writeFileSync(join(root, ".claude/rules/mine.md"), "# Hand-written\n");
    assert.deepEqual(sync(root), []);
    assert.equal(readFileSync(join(root, ".claude/rules/mine.md"), "utf8"), "# Hand-written\n");
  });
});

describe("AGENTS.md block", () => {
  it("demotes headings but not shell comments in a fence", () => {
    assert.equal(demoteHeadings("# Core\n## Do not\n```sh\n# a comment\n```"), "## Core\n### Do not\n```sh\n# a comment\n```");
  });

  it("orders rules by agentsMd, then replaces the block in place", () => {
    const rules = [
      { name: "branching", order: 2, body: "# Branching\n" },
      { name: "core", order: 1, body: "# Core\n" },
    ];
    const first = withAgentsBlock("# Guide\n\nHand-written.\n", rules);
    assert.ok(first.indexOf("## Core") < first.indexOf("## Branching"));
    assert.equal(first.startsWith("# Guide\n\nHand-written.\n\n<!-- BEGIN always-on rules"), true);
    // Re-running on its own output changes nothing, and hand-written text after the block survives.
    assert.equal(withAgentsBlock(first, rules), first);
    const edited = `${first}\n## After\n`.replace("## Core\n", "## Core\nstray edit\n");
    assert.equal(withAgentsBlock(edited, rules), `${first}\n## After\n`);
  });

  it("a project companion with the same number lands right after its harness rule", () => {
    const rules = [
      { name: "branching.project", order: 3, body: "# Branching — this project\n" },
      { name: "architecture", order: 2, body: "# Architecture\n" },
      { name: "branching", order: 3, body: "# Branching\n" },
    ];
    const out = withAgentsBlock("# Guide\n", rules);
    assert.ok(out.indexOf("## Architecture") < out.indexOf("## Branching\n"));
    assert.ok(out.indexOf("## Branching\n") < out.indexOf("## Branching — this project"));
  });

  it("sync writes AGENTS.md and check reports its drift", () => {
    const root = mkdtempSync(join(tmpdir(), "rules-"));
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Guide\n");
    writeFileSync(join(root, ".cursor/rules/core.mdc"), rule("agentsMd: 1\nalwaysApply: false", "# Core\n"));

    assert.deepEqual(sync(root), ["AGENTS.md"]);
    assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes("## Core"));
    assert.deepEqual(sync(root, { check: true }), []);

    writeFileSync(join(root, ".cursor/rules/core.mdc"), rule("agentsMd: 1\nalwaysApply: false", "# Core\nNew line.\n"));
    assert.deepEqual(sync(root, { check: true }), ["AGENTS.md"]);
  });
});
