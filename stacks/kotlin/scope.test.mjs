/*
  The Kotlin pack's CI scope: which changed paths wake the Android emulator job, and that a broken classifier fails closed.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`).
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/kotlin/scope.mjs.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { changedPaths, classify } from "./scope.mjs";

describe("classify", () => {
  it("wakes on Kotlin files, the app module, Gradle files, this pack's scripts, and the workflow", () => {
    for (const path of ["domain/src/main/kotlin/x/Note.kt", "app/src/main/res/values/strings.xml", "app/src/main/AndroidManifest.xml", "build.gradle.kts", "settings.gradle.kts", "data/build.gradle.kts", "gradle.properties", "gradle/libs.versions.toml", "gradlew", "stacks/kotlin/run.mjs", ".github/workflows/ci.yml"]) {
      assert.equal(classify([path]), true, path);
    }
  });

  it("stays asleep for everything else, and for nothing changed", () => {
    for (const paths of [[], ["web/app.ts", "docs/plans/x.md", "README.md", "package.json", "stacks/rust/pack.json", "Package.resolved"]]) assert.equal(classify(paths), false, paths.join());
  });

  it("wakes when only one of several changed paths is Android's", () => {
    assert.equal(classify(["README.md", "app/src/main/kotlin/x/MainActivity.kt"]), true);
  });
});

describe("changedPaths", () => {
  it("throws for an event it can't diff, so the entry point fails closed", () => {
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "workflow_dispatch" }), /unsupported event/);
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "pull_request" }), /PR_BASE_SHA/);
    assert.throws(() => changedPaths({ GITHUB_EVENT_NAME: "push", BEFORE_SHA: "0000000" }), /no parent/);
  });
});

describe("the script", () => {
  it("writes android=true when it can't tell (fail closed)", () => {
    const output = join(mkdtempSync(join(tmpdir(), "android-scope-")), "out");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [resolve("stacks/kotlin/scope.mjs")], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "pull_request", PR_BASE_SHA: "" } });
    assert.equal(result.status, 0);
    assert.equal(readFileSync(output, "utf8"), "android=true\n");
  });
});
