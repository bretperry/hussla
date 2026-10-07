/*
  The Rust per-edit check: finds the owning crate, notices a file nothing compiles, says so when cargo is missing, and kills a hung cargo's children.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; the process cases need only `node` and `sh`.
  Uses: stacks/rust/check-edited.mjs (owningCrate, isCompiled, and the script itself against a fake `cargo` on PATH).

  Lives in the pack, so removing the pack removes it.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { isCompiled, owningCrate } from "./check-edited.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-edited.mjs");
const scratch = mkdtempSync(join(tmpdir(), "rust-edit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("owningCrate", () => {
  const here = process.cwd();
  const metadata = {
    target_directory: join(here, "target"),
    packages: [
      { name: "domain", edition: "2024", manifest_path: join(here, "crates/domain/Cargo.toml") },
      { name: "outer", edition: "2021", manifest_path: join(here, "crates/Cargo.toml") },
    ],
  };

  it("picks the deepest crate above the file, and reports its edition", () => {
    assert.deepEqual(owningCrate(metadata, "crates/domain/src/note.rs")?.name, "domain");
    assert.equal(owningCrate(metadata, "crates/domain/tests/x.rs")?.edition, "2024");
    assert.equal(owningCrate(metadata, "crates/other/src/lib.rs")?.name, "outer");
  });

  it("a file in no crate has no owner", () => {
    assert.equal(owningCrate(metadata, "scripts/x.rs"), undefined);
  });
});

describe("isCompiled", () => {
  const target = join(scratch, "target");
  mkdirSync(join(target, "debug", "deps"), { recursive: true });
  writeFileSync(join(target, "debug", "deps", "my_crate-abc123.d"), "target/debug/deps/my_crate-abc123.d: crates/my/src/lib.rs crates/my/src/used.rs\n\ncrates/my/src/lib.rs:\ncrates/my/src/used.rs:\n");

  it("a file the compile read is compiled; one it never read is not", () => {
    assert.equal(isCompiled(target, "my-crate", "crates/my/src/used.rs"), true);
    assert.equal(isCompiled(target, "my-crate", "crates/my/src/stray.rs"), false);
  });

  it("with no dep-info to ask, it makes no claim", () => {
    assert.equal(isCompiled(target, "unbuilt", "crates/x/src/lib.rs"), undefined);
    assert.equal(isCompiled(join(scratch, "nothing"), "my-crate", "a.rs"), undefined);
  });
});

// Runs the script with `bin` ahead of node and the system dirs on PATH (never the real cargo).
const runScript = (file, bin, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, file], { cwd: scratch, encoding: "utf8", env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...env } });

describe("check-edited.mjs", () => {
  const empty = join(scratch, "bin-empty");
  mkdirSync(empty);

  it("says cargo is missing, in one line, for a .rs file and for a Cargo.toml alike", () => {
    for (const file of ["crates/a/src/lib.rs", "Cargo.toml", "deny.toml"]) {
      assert.equal(runScript(file, empty).stdout, "cargo not installed: Rust edits unchecked", file);
    }
  });

  it("says nothing about a .toml that is not ours", () => {
    assert.equal(runScript("pyproject.toml", empty).stdout, "");
  });

  it("kills a hung cargo and everything it started, and reports the timeout", () => {
    const bin = join(scratch, "bin-hung");
    mkdirSync(bin);
    const pidFile = join(scratch, "grandchild.pid");
    // Answers --version, hangs on anything else by starting a long-lived grandchild.
    writeFileSync(join(bin, "cargo"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo cargo 0; exit 0; }\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(join(bin, "cargo"), 0o755);
    const result = runScript("crates/a/src/lib.rs", bin, { RUST_EDIT_CHECK_TIMEOUT_MS: "800" });
    assert.match(result.stdout, /metadata timed out after 0\.8 s and was killed/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Dead, or a zombie nobody has reaped yet (a container's init may not): either way it is not running.
    const state = (() => {
      try {
        return /^\d+ \(.*\) (\S)/.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1] ?? "?";
      } catch {
        return "gone";
      }
    })();
    assert.ok(state === "gone" || state === "Z", `the grandchild outlived the timeout (state ${state})`);
  });
});
