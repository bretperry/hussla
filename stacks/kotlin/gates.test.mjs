/*
  The Kotlin gates' floors refuse a weakened LAYERS row, and the stamp skips a local run only when nothing the gates read has changed.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; no JDK needed.
  Uses: stacks/kotlin/gates-lib.mjs → floorProblems(), gateStamp(), shouldSkip(), writeStamp(), recordPass().

  Lives in the pack, so removing the pack removes it.
*/
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { floorProblems, gateStamp, recordPass, shouldSkip, STAMP_FILE, writeStamp } from "./gates-lib.mjs";

// A row as printLayers prints it.
const row = (path, fields) => ({ path, mayUse: [], libraries: [], bytecodeAllowed: [], bytecode: [], allowsJava: false, requiresTests: true, noTestsReason: "", android: false, ...fields });
// The seed's shape: a pure row with an allowlist, a use-case row with a denylist, an adapter row,
// and the Android app (the composition root).
const seed = () => [
  row(":domain", { bytecodeAllowed: ["kotlin/*"], bytecode: ["java/lang/Math.random"] }),
  row(":usecases", { mayUse: [":domain"], libraries: ["x:y"], bytecode: ["java/io/"] }),
  row(":data", { mayUse: [":domain", ":usecases"], libraries: ["*"], requiresTests: false }),
  row(":app", { mayUse: [":domain", ":usecases", ":data"], libraries: ["*"], android: true }),
];
const samples = ["java/lang/Math.random", "java/io/"];

describe("kotlin gates floors", () => {
  it("the seed's rows meet every floor", () => {
    assert.deepEqual(floorProblems(seed(), samples), []);
  });

  it("a non-adapter row with no bytecode rules fails, even when its rules moved to the adapter row", () => {
    const [domain, usecases, data, app] = seed();
    const moved = [domain, { ...usecases, bytecode: [] }, { ...data, bytecode: usecases.bytecode }, app];
    assert.match(floorProblems(moved, samples).join("\n"), /row :usecases has no bytecode rules and no allowlist/);
  });

  it("a sample no row forbids any more fails", () => {
    const [domain, usecases, data] = seed();
    assert.match(floorProblems([domain, { ...usecases, bytecode: ["java/net/"] }, data], samples).join("\n"), /no LAYERS row forbids "java\/io\/"/);
  });

  it("a pure row with no allowlist fails", () => {
    const [domain, usecases, data] = seed();
    assert.match(floorProblems([{ ...domain, bytecodeAllowed: [] }, usecases, data], samples).join("\n"), /:domain is pure .* no bytecodeAllowed/);
  });

  it("a non-adapter row without requiresTests fails unless noTestsReason says why", () => {
    const [domain, usecases, data] = seed();
    assert.match(floorProblems([domain, { ...usecases, requiresTests: false }, data], samples).join("\n"), /:usecases doesn't require tests/);
    assert.deepEqual(floorProblems([domain, { ...usecases, requiresTests: false, noTestsReason: "ports only" }, data], samples), []);
  });

  it("an Android row must be the composition root: every library, no bytecode rules", () => {
    const [domain, usecases, data, app] = seed();
    assert.match(floorProblems([domain, { ...usecases, android: true }, data, app], samples).join("\n"), /row :usecases is an Android module/);
    assert.match(floorProblems([domain, usecases, data, { ...app, bytecode: ["java/io/"] }], samples).join("\n"), /row :app is an Android module/);
    assert.match(floorProblems([{ ...domain, android: true }, usecases, data, app], samples).join("\n"), /row :domain is an Android module/);
  });
});

describe("kotlin gates stamp", () => {
  const roots = [];
  after(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });
  // A minimal tree with the files the stamp reads.
  const tree = () => {
    const root = mkdtempSync(join(tmpdir(), "kotlin-gates-stamp-"));
    roots.push(root);
    for (const [path, text] of [
      ["settings.gradle.kts", 'includeBuild("build-logic")\ninclude(":domain")\n'],
      ["build.gradle.kts", "plugins { base }\n"],
      ["domain/build.gradle.kts", 'apply(from = "../gradle/conventions.gradle.kts")\n'],
      ["domain/src/main/kotlin/com/example/domain/Note.kt", "package com.example.domain\n"],
      ["gradle/conventions.gradle.kts", "\n"],
      ["gradle/wrapper/gradle-wrapper.jar", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])],
      ["buildSrc/src/main/kotlin/Conventions.kt", "object Conventions\n"],
      ["build-logic/src/main/kotlin/Logic.kt", "object Logic\n"],
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };
  const local = {};

  it("no stamp yet: the gates run", () => {
    assert.equal(shouldSkip(tree(), local), false);
  });

  it("a stamp from a passing run skips the next local run", () => {
    const root = tree();
    writeStamp(root);
    assert.equal(shouldSkip(root, local), true);
  });

  it("a source edit inside a package doesn't invalidate the stamp", () => {
    const root = tree();
    writeStamp(root);
    appendFileSync(join(root, "domain/src/main/kotlin/com/example/domain/Note.kt"), "class Note\n");
    assert.equal(shouldSkip(root, local), true);
  });

  it("a changed module build file runs them", () => {
    const root = tree();
    writeStamp(root);
    appendFileSync(join(root, "domain/build.gradle.kts"), 'dependencies { implementation(files("x.jar")) }\n');
    assert.equal(shouldSkip(root, local), false);
  });

  it("a new package directory runs them", () => {
    const root = tree();
    writeStamp(root);
    mkdirSync(join(root, "domain/src/main/kotlin/com/example/other"), { recursive: true });
    assert.equal(shouldSkip(root, local), false);
  });

  // Each of these changes what a build does without touching a build.gradle.kts.
  for (const { what, change } of [
    { what: "an applied script's content", change: (root) => appendFileSync(join(root, "gradle/conventions.gradle.kts"), 'tasks.named("check") { enabled = false }\n') },
    { what: "a buildSrc source file", change: (root) => appendFileSync(join(root, "buildSrc/src/main/kotlin/Conventions.kt"), "val off = true\n") },
    { what: "the wrapper jar", change: (root) => appendFileSync(join(root, "gradle/wrapper/gradle-wrapper.jar"), Buffer.from([2])) },
    { what: "an included build's source file", change: (root) => appendFileSync(join(root, "build-logic/src/main/kotlin/Logic.kt"), "val off = true\n") },
    { what: "a Groovy script anywhere in the tree", change: (root) => writeFileSync(join(root, "domain/extra.gradle"), "check.enabled = false\n") },
  ]) {
    it(`a change to ${what} runs them`, () => {
      const root = tree();
      writeStamp(root);
      change(root);
      assert.equal(shouldSkip(root, local), false);
    });
  }

  it("a pass is recorded under the stamp taken at the start, and not at all if the tree changed mid-run", () => {
    const root = tree();
    const atStart = gateStamp(root);
    // Unchanged: written, with the start value, and the next run skips.
    assert.equal(recordPass(root, atStart), true);
    assert.equal(readFileSync(join(root, STAMP_FILE), "utf8").trim(), atStart);
    assert.equal(shouldSkip(root, local), true);
    // Changed during the run: nothing written, so the stale stamp can't cover the edit.
    const edited = tree();
    const editedAtStart = gateStamp(edited);
    appendFileSync(join(edited, "domain/build.gradle.kts"), "// edited mid-run\n");
    assert.equal(recordPass(edited, editedAtStart), false);
    assert.equal(existsSync(join(edited, STAMP_FILE)), false);
    assert.equal(shouldSkip(edited, local), false);
  });

  it("CI set runs them even on a stamp hit", () => {
    const root = tree();
    writeStamp(root);
    assert.equal(shouldSkip(root, { CI: "true" }), false);
  });
});
