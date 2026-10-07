/*
  The fault-injection fakes are tested by plain `cargo test`, and a production build never contains them.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; needs `cargo` on PATH.
  Uses: crates/adapters (the `test-support` feature and its self dev-dependency).

  Why a test: a test gated by `required-features` is skipped without a word under plain `cargo test`,
  which is a silent pass. Here the count of tests cargo lists must equal the count in the file.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const REPO = resolve(".");
const scratch = mkdtempSync(join(tmpdir(), "rust-chaos-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cargo = (args, cwd = REPO, env = {}) => spawnSync("cargo", args, { cwd, encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: join(scratch, "target"), ...env } });

// A throwaway crate that depends on `adapters` the way production code would.
const consumer = (features) => {
  const dir = mkdtempSync(join(scratch, "consumer-"));
  mkdirSync(join(dir, "src"));
  const dependency = `adapters = { path = "${join(REPO, "crates/adapters")}"${features ? ', features = ["test-support"]' : ""} }`;
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2024"\n\n[workspace]\n\n[dependencies]\n${dependency}\n`);
  writeFileSync(join(dir, "src/lib.rs"), "pub use adapters::chaos::VirtualClock;\n");
  return dir;
};


describe("adapters::chaos and the test-support feature", () => {
  it("plain `cargo test -p adapters` lists every chaos test, and there is at least one", () => {
    const source = readFileSync(join(REPO, "crates/adapters/tests/note_sync_chaos.rs"), "utf8");
    // One `#[tokio::test…]` per async test, plus the proptest! block's `#[test]`.
    const declared = (source.match(/^\s*#\[(?:tokio::test|test)\b/gm) ?? []).length;
    const listed = cargo(["test", "-p", "adapters", "--test", "note_sync_chaos", "--", "--list"]);
    assert.equal(listed.status, 0, listed.stderr);
    const count = (listed.stdout.match(/: test$/gm) ?? []).length;
    assert.ok(count > 0, "cargo listed no chaos tests: they are being skipped");
    assert.equal(count, declared, `cargo lists ${count} chaos tests, the file declares ${declared}`);
  });

  it("a normal build of adapters does not contain chaos; asking for test-support does", () => {
    const without = cargo(["check", "--quiet"], consumer(false));
    assert.notEqual(without.status, 0, "chaos compiled without the feature");
    assert.match(without.stderr, /chaos/);
    const withFeature = cargo(["check", "--quiet"], consumer(true));
    assert.equal(withFeature.status, 0, withFeature.stderr);
  });
});
