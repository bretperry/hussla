/*
  The TypeScript pack's build inputs wake the heavy CI tier; a lookalike path elsewhere doesn't.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: scripts/lib/ci-change-scope.mjs → classify(), packPatterns(); this pack's `ciHeavy`.

  Lives in the pack, not beside ci-change-scope's own test, so removing the pack removes it.
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, packPatterns } from "../../scripts/lib/ci-change-scope.mjs";

describe("typescript pack ciHeavy", () => {
  const patterns = packPatterns(".");

  it("root compiler configs are heavy", () => {
    assert.equal(classify(["tsconfig.base.json"], patterns), true);
    assert.equal(classify(["tsconfig.json"], patterns), true);
  });

  it("a compiler config below the root is not", () => {
    assert.equal(classify(["docs/tsconfig.json"], patterns), false);
  });
});
