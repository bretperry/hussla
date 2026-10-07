/*
  The Rust pack's build inputs wake the heavy CI tier; a lookalike path elsewhere doesn't.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/lib/ci-change-scope.mjs → classify(), packPatterns(); this pack's `ciHeavy`.

  Lives in the pack, not beside ci-change-scope's own test, so removing the pack removes it.
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, packPatterns } from "../../scripts/lib/ci-change-scope.mjs";

describe("rust pack ciHeavy", () => {
  const patterns = packPatterns(".");

  it("the workspace manifest, lockfile, toolchain pin, and any crate are heavy", () => {
    for (const path of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/domain/src/note.rs", "crates/app/Cargo.toml"]) {
      assert.equal(classify([path], patterns), true, path);
    }
  });

  it("a Cargo.toml below the root, outside crates/, is not", () => {
    assert.equal(classify(["docs/examples/Cargo.toml"], patterns), false);
  });
});
