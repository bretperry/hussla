/*
  The C++ pack's tool helpers and runner: a missing, old, or broken tool is reported, never read as clean, and a timed-out command takes its whole process group with it.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs no C++ toolchain: stand-in tool scripts on PATH play each case.
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/cpp/tool.mjs, stacks/cpp/run.mjs (as a CLI, from a temp directory).
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";

import { classify, failure, pool, run, TOOLS } from "./tool.mjs";

const RUN = resolve("stacks/cpp/run.mjs");
const posix = process.platform !== "win32";

// Temp dirs made here, removed after the file's tests.
const made = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// A bin dir of stand-in tools: { name: first line its `--version` prints }.
const fakeTools = (versions) => {
  const bin = tempDir("cpp-bin-");
  for (const [name, version] of Object.entries(versions)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${version}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};

// Version lines every tool in TOOLS accepts as at its floor or above.
const CURRENT = {
  cmake: "cmake version 3.31.6",
  ninja: "1.13.2",
  "clang++": "Ubuntu clang version 18.1.3 (1ubuntu1)",
  "clang-tidy": "Ubuntu LLVM version 18.1.3",
  "clang-format": "Ubuntu clang-format version 18.1.3 (1ubuntu1)",
  nm: "GNU nm (GNU Binutils for Ubuntu) 2.42",
  "g++": "g++ (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0",
};

// run.mjs as a CLI in an empty project, with PATH holding only `bin`; CI as given ("" is off), the gcc leg off.
const runTask = (task, bin, { ci = "" } = {}) =>
  spawnSync(process.execPath, [RUN, task], { cwd: tempDir("cpp-root-"), encoding: "utf8", env: { ...process.env, PATH: bin, CI: ci, CPP_PACK_GCC: "" } });

// True while `pid` is a live process.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("classify", () => {
  it("reads every tool's real version line as ok at its floor", () => {
    for (const [name, line] of Object.entries(CURRENT)) assert.equal(classify(name, { status: 0, output: `${line}\n` }).state, "ok", name);
  });
  it("calls a tool below its floor old, and keeps the line that says so", () => {
    const info = classify("cmake", { status: 0, output: "cmake version 3.22.1\n" });
    assert.deepEqual(info, { state: "old", version: "cmake version 3.22.1" });
  });
  it("calls a tool that isn't there missing", () => {
    assert.equal(classify("ninja", { error: Object.assign(new Error("spawn ninja ENOENT"), { code: "ENOENT" }) }).state, "missing");
  });
  it("calls a crash, a hang, or no version broken, never ok", () => {
    assert.equal(classify("nm", { status: 139, output: "" }).state, "broken");
    assert.match(classify("nm", { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }).version, /VERSION_TIMEOUT_MS/);
    assert.equal(classify("clang-tidy", { status: 0, output: "hello\n" }).state, "broken");
  });
  it("has a floor and a pattern for every tool", () => {
    for (const [name, tool] of Object.entries(TOOLS)) assert.ok(tool.pattern instanceof RegExp && tool.floor.length === 2, name);
  });
});

describe("failure", () => {
  it("is empty only for a clean exit", () => {
    assert.equal(failure("x", { status: 0 }, 1000, "K"), "");
    assert.match(failure("x", { status: 2 }, 1000, "K"), /exited 2/);
    assert.match(failure("x", { status: null, signal: "SIGKILL" }, 1000, "K"), /killed by SIGKILL/);
    assert.match(failure("x", { status: null, timedOut: true }, 5000, "THE_KNOB"), /timed out after 5 s .*THE_KNOB/);
  });
});

describe("pool", () => {
  it("keeps results in job order and never runs more than its width", async () => {
    let running = 0;
    let most = 0;
    const jobs = [30, 5, 20, 1, 10].map((ms, index) => async () => {
      running += 1;
      most = Math.max(most, running);
      await sleep(ms);
      running -= 1;
      return index;
    });
    assert.deepEqual(await pool(jobs, 2), [0, 1, 2, 3, 4]);
    assert.equal(most, 2);
  });
});

describe("run", { skip: posix ? false : "process groups are POSIX" }, () => {
  it("kills the whole process group on a timeout, not just the leader", async () => {
    const dir = tempDir("cpp-hang-");
    const pidFile = join(dir, "child.pid");
    // A leader that starts a long sleep in the background and waits on it: the sleep is the stray.
    writeFileSync(join(dir, "hang.sh"), `sleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    process.env.CPP_PACK_GRACE_MS = "100";
    try {
      const result = await run("sh", [join(dir, "hang.sh")], { timeoutMs: 300 });
      assert.equal(result.timedOut, true);
      assert.notEqual(failure("hang", result, 300, "K"), "");
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let waited = 0; alive(pid) && waited < 2000; waited += 50) await sleep(50);
      assert.equal(alive(pid), false, "the background sleep outlived the timeout");
    } finally {
      delete process.env.CPP_PACK_GRACE_MS;
    }
  });
  it("resolves a command that isn't there with an error, not a pass", async () => {
    const result = await run("cpp-pack-no-such-tool", []);
    assert.ok(result.error !== undefined);
    assert.match(failure("no tool", result, 0, "K"), /could not run/);
  });
});

describe("run.mjs without a toolchain", { skip: posix ? false : "stand-in tools are sh scripts" }, () => {
  it("skips loudly locally, so the skip is never mistaken for a pass", () => {
    const result = runTask("build", fakeTools({}));
    assert.equal(result.status, 0);
    assert.match(result.stderr, /SKIPPED: .*cmake.* did NOT run/);
  });
  it("fails under CI=true", () => {
    const result = runTask("build", fakeTools({}), { ci: "true" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not installed, and CI is set \(CI=true\)/);
  });
  it("fails under CI=1 too, as the infra pack does, rather than skipping as a pass", () => {
    const result = runTask("build", fakeTools({}), { ci: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not installed, and CI is set \(CI=1\)/);
  });
  it("skips under CI=0 and CI=false, which mean not CI", () => {
    for (const ci of ["0", "false"]) assert.equal(runTask("build", fakeTools({}), { ci }).status, 0, ci);
  });
  it("fails an old tool even locally", () => {
    const result = runTask("build", fakeTools({ ...CURRENT, cmake: "cmake version 3.20.0" }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cmake: cmake version 3\.20\.0 is older than 3\.28/);
  });
  it("still runs the source rules in a lint without tools", () => {
    const result = runTask("lint", fakeTools({}));
    assert.equal(result.status, 1, "an empty project has no layer map, which the source rules report");
    assert.match(result.stderr, /cpp-layers\.json is missing/);
  });
  it("fails `version` on any missing tool, since CI's toolchain step proves the runner has them", () => {
    const result = runTask("version", fakeTools(Object.fromEntries(Object.entries(CURRENT).filter(([name]) => name !== "clang-tidy"))));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /clang-tidy: missing/);
  });
});
