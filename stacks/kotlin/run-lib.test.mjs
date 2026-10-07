/*
  The device lock takes a free or stale lock, refuses a held or unreadable one, and never releases or takes over another run's; the instrumented-test count ignores skipped tests.
  In the app: nothing at runtime; runs in `pnpm test:harness` while this pack is installed.
  Used by: node:test (`node --test`), with node:assert; no JDK or device needed.
  Uses: stacks/kotlin/run-lib.mjs → takeLock(), releaseLock(), ranInstrumentedTests().

  Lives in the pack, so removing the pack removes it.
*/
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ranInstrumentedTests, releaseLock, takeLock } from "./run-lib.mjs";

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "kotlin-run-lib-"));
  dirs.push(dir);
  return dir;
};
// A kill(pid, 0) that says only `alive` pids run.
const killer =
  (...alive) =>
  (pid) => {
    if (!alive.includes(pid)) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };

describe("kotlin device lock", () => {
  it("takes a free lock and writes its pid", () => {
    const lock = join(scratch(), "device.lock");
    assert.deepEqual(takeLock(lock, 101, killer()), { taken: true });
    assert.equal(readFileSync(lock, "utf8"), "101\n");
  });

  it("refuses a lock whose holder is running", () => {
    const lock = join(scratch(), "device.lock");
    writeFileSync(lock, "202\n");
    const result = takeLock(lock, 101, killer(202));
    assert.equal(result.taken, false);
    assert.match(result.why, /pid 202/);
  });

  it("takes over a lock whose holder is gone", () => {
    const lock = join(scratch(), "device.lock");
    writeFileSync(lock, "202\n");
    assert.deepEqual(takeLock(lock, 101, killer()), { taken: true });
    assert.equal(readFileSync(lock, "utf8"), "101\n");
  });

  it("never removes a newer run's lock while taking over a stale one", () => {
    const lock = join(scratch(), "device.lock");
    writeFileSync(lock, "999\n");
    // Run 101 reads the dead pid 999; before it moves the lock, run 202 takes it over first.
    const raced = (pid) => {
      assert.deepEqual(takeLock(lock, 202, killer()), { taken: true });
      killer()(pid);
    };
    assert.equal(takeLock(lock, 101, raced).taken, false);
    assert.equal(readFileSync(lock, "utf8"), "202\n");
  });

  it("counts an empty, garbled, or directory lock as held, not stale", () => {
    for (const plant of [(lock) => writeFileSync(lock, ""), (lock) => writeFileSync(lock, "x1\n"), (lock) => mkdirSync(lock)]) {
      const lock = join(scratch(), "device.lock");
      plant(lock);
      assert.equal(takeLock(lock, 101, killer()).taken, false);
      assert.ok(existsSync(lock));
    }
  });

  it("releases only its own lock", () => {
    const lock = join(scratch(), "device.lock");
    writeFileSync(lock, "202\n");
    releaseLock(lock, 101);
    assert.ok(existsSync(lock));
    releaseLock(lock, 202);
    assert.ok(!existsSync(lock));
  });
});

describe("kotlin instrumented-test count", () => {
  it("counts executed test cases across devices and skips skipped ones", () => {
    const dir = scratch();
    mkdirSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a/TEST-one.xml"), '<testsuite><testcase name="x" classname="C"/><testcase name="y" classname="C"><skipped/></testcase></testsuite>');
    writeFileSync(join(dir, "TEST-two.xml"), '<testsuite><testcase name="z" classname="C"><failure>f</failure></testcase></testsuite>');
    assert.equal(ranInstrumentedTests([dir]), 2);
  });

  it("is 0 with no results at all", () => {
    assert.equal(ranInstrumentedTests([join(scratch(), "missing")]), 0);
  });
});
