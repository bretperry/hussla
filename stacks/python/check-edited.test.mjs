// Tests for the Python pack's per-edit check: a crashed or silent-failing tool is reported, and no venv still gets a syntax check.
// In the app: nothing at runtime; `pnpm test:harness` runs it (node:test, no install).
// Used by: package.json `test:harness`.
// Uses: stacks/python/check-edited.mjs, run as the core runs it (cwd = project root, argv[2] = the file).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

// The script under test, by absolute path; each case runs it from its own temp project root.
const SCRIPT = resolve(import.meta.dirname, "check-edited.mjs");

// A temp project holding `files` ({ path: content }); executable ones are `{ exec: true, text }`.
const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), "py-hook-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    const spec = typeof content === "string" ? { text: content, exec: false } : content;
    writeFileSync(join(root, path), spec.text);
    chmodSync(join(root, path), spec.exec ? 0o755 : 0o644);
  }
  return root;
};

// Runs the hook on `file` in `root`; returns what it printed.
const hook = (root, file) => spawnSync(process.execPath, [SCRIPT, file], { cwd: root, encoding: "utf8" }).stdout;

describe("python check-edited", () => {
  it("a tool that exits non-zero without printing is reported, not read as clean", () => {
    const root = project({ "a.py": "x = 1\n", ".venv/bin/ruff": { text: "#!/bin/sh\nexit 3\n", exec: true } });
    assert.match(hook(root, "a.py"), /ruff exited 3/);
  });

  it("a tool that cannot start is reported, not read as clean", () => {
    // Present but not executable: spawn fails with EACCES, which spawnSync reports as `error`, not a status.
    const root = project({ "a.py": "x = 1\n", ".venv/bin/ruff": "#!/bin/sh\nexit 0\n" });
    assert.match(hook(root, "a.py"), /ruff could not run/);
  });

  it("a tool that passes is silent", () => {
    const root = project({ "a.py": "x = 1\n", ".venv/bin/ruff": { text: "#!/bin/sh\nexit 0\n", exec: true } });
    assert.equal(hook(root, "a.py"), "");
  });

  it("with no .venv a syntax error is still caught, and the output says to run uv sync", () => {
    const root = project({ "a.py": "def broken(:\n" });
    const out = hook(root, "a.py");
    assert.match(out, /py_compile/);
    assert.match(out, /uv sync/);
  });

  it("with no .venv a clean file is silent", () => {
    assert.equal(hook(project({ "a.py": "x = 1\n" }), "a.py"), "");
  });
});
