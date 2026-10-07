/*
  Tests for gates.mjs: each depguard rule's path, spoiled in a temp copy, must turn the gate red.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/go/gates.mjs against a temp copy of go.mod, go.sum, .golangci.yml, internal/ and gates.project.json; golangci-lint on PATH.

  Skipped, loudly, when golangci-lint isn't installed: the gate itself needs it, and a skip that
  says nothing would read as a pass. Each case that reaches the lint takes about 10 s; the
  static ones (an unguarded directory, a build tag, a nolint directive) fail at once.
*/
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(".");
const GATES = join(REPO, "stacks/go/gates.mjs");

// The linter, named once as a variable: knip reads a literal binary name in spawnSync as a dependency to list.
const LINTER = "golangci-lint";

// Why the cases are skipped, or false when the gate can run here.
const skip = (() => {
  if (!existsSync(join(REPO, "stacks/go/gates.project.json"))) return "go pack files are not in this checkout";
  const probe = spawnSync(LINTER, ["version"], { encoding: "utf8" });
  const found = probe.error === undefined && /version 2\./.test(probe.stdout);
  if (!found) process.stderr.write("SKIPPED stacks/go/gates.test.mjs: golangci-lint v2 is not on PATH, so the Go gates are untested here.\n");
  return found ? false : "golangci-lint v2 is not installed";
})();

// A temp project holding what the gate reads.
const tempProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "go-gates-test-"));
  for (const name of ["go.mod", "go.sum", ".golangci.yml", "stacks/go/gates.project.json"]) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    cpSync(join(REPO, name), join(dir, name));
  }
  cpSync(join(REPO, "internal"), join(dir, "internal"), { recursive: true });
  return dir;
};

// Runs the gate in `dir`; resolves to { status, stdout, stderr }. Async only to keep the test runner responsive; golangci-lint refuses to run twice at once, so cases run one after another.
const gate = (dir) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [GATES], { cwd: dir, timeout: 240_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });

// Rewrites a file in the temp project.
const edit = (dir, path, change) => writeFileSync(join(dir, path), change(readFileSync(join(dir, path), "utf8")));

// The text of one depguard rule's block in .golangci.yml: its key line through the line before the next key at the same indent.
const ruleBlock = (text, name) => new RegExp(`^ {8}${name}:\\n(?: {10,}.*\\n|\\n)*`, "m").exec(text)?.[0] ?? assert.fail(`no depguard rule '${name}' in .golangci.yml`);

describe("go gates", { skip }, () => {
  // The failure that matters: a glob that matches nothing leaves `golangci-lint run` at 0 issues.
  for (const rule of ["domain", "domain-tests", "config", "app", "adapters", "testsupport"]) {
    it(`a misspelled path in the '${rule}' rule fails the gate`, async () => {
      const dir = tempProject();
      edit(dir, ".golangci.yml", (text) => text.replace(ruleBlock(text, rule), (block) => block.replaceAll("**/internal/", "**/intern4l/")));
      const result = await gate(dir);
      assert.equal(result.status, 1, `gate passed with '${rule}' misspelled:\n${result.stdout}`);
    });
  }

  it("the old domain-tests glob, which matches no top-level test file, fails the gate", async () => {
    const dir = tempProject();
    edit(dir, ".golangci.yml", (text) => text.replace("**/internal/domain/**_test.go", "**/internal/domain/**/*_test.go"));
    const result = await gate(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /zz_gate_test_adapter_test\.go/);
  });

  it("a generated-file exemption fails the gate", async () => {
    const dir = tempProject();
    edit(dir, ".golangci.yml", (text) => text.replace(/^ {4}generated: disable/m, "    generated: lax"));
    const result = await gate(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /zz_gate_generated\.go/);
  });

  it("an internal directory no rule covers fails at once", async () => {
    const dir = tempProject();
    mkdirSync(join(dir, "internal/domainx"), { recursive: true });
    writeFileSync(join(dir, "internal/domainx/x.go"), "package domainx\n");
    const result = await gate(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /internal\/domainx is covered by no depguard rule/);
  });

  it("a custom build tag in internal/ fails at once; an OS tag is fine to the static check", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, "internal/domain/hidden.go"), "//go:build ignore\n\npackage domain\n\nimport _ \"net/http\"\n");
    const result = await gate(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /build tag 'ignore'/);
  });

  it("a //nolint directive that lists nolintlint fails at once", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, "internal/domain/quiet.go"), "package domain\n\nimport _ \"net/http\" //nolint:depguard,nolintlint\n");
    const result = await gate(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /listing nolintlint/);
  });
});
