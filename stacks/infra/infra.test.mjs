/*
  The infra pack's checks catch what they exist to catch, on fixtures that are wrong on purpose.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check` and CI).
  Used by: node:test (`node --test`), with node:assert; no install needed.
  Uses: stacks/infra/check.mjs helpers; terraform (or tofu) and hadolint on PATH; scripts/plans-status.mjs (runbook lint).

  Each red fixture has a green twin that differs only in the fault, so a red result means the
  check caught the fault, not that the setup was broken. Without the tool, a test skips and says
  which tool and how to install it; in CI (CI set, and not 0 or false) it runs anyway and fails, because CI installs
  the tools and a skip there would be a green check that checked nothing.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// [harness]
// Only the runbook-template test below uses these; a separate line so an eject can drop it.
import { existsSync, mkdirSync } from "node:fs";
// [/harness]
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { hadolint, inCi, isDockerfile, runs, targets, terraformBin, validateModule } from "./check.mjs";

// The repo root and the fixtures, wherever the test runs from.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

// Temp dirs, removed after the run.
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A fresh temp dir.
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "infra-pack-"));
  temps.push(dir);
  return dir;
};

// node:test's skip value: a loud reason when `tool` is missing outside CI, else false (run, and fail if it's missing).
const unlessInstalled = (tool, present) => (present || inCi() ? false : `${tool} is not installed (bash stacks/infra/install-tools.sh)`);

// A fixture module copied out, so `init` writes its .terraform/ in a temp dir, not the repo.
const moduleCopy = (name) => {
  const dir = join(temp(), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};

describe("terraform validate", { skip: unlessInstalled("terraform", terraformBin() !== "") }, () => {
  it("rejects a module that uses an undeclared variable", () => {
    const result = validateModule(terraformBin(), moduleCopy("bad-tf"));
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /undeclared input variable/i);
  });

  it("accepts the same module with the variable declared", () => {
    const result = validateModule(terraformBin(), moduleCopy("good-tf"));
    assert.equal(result.ok, true, result.output);
  });
});

describe("hadolint with the repo's .hadolint.yaml", { skip: unlessInstalled("hadolint", runs("hadolint")) }, () => {
  it("rejects a `latest` base image as an error (DL3007)", () => {
    const result = hadolint(ROOT, [join(FIXTURES, "docker-latest", "Dockerfile")]);
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /DL3007/);
  });

  it("accepts the same image on a pinned base", () => {
    const result = hadolint(ROOT, [join(FIXTURES, "docker-pinned", "Dockerfile")]);
    assert.equal(result.ok, true, result.output);
  });
});

describe("CI detection", () => {
  it("counts any CI value but empty, 0, or false", () => {
    const saved = process.env.CI;
    try {
      for (const [value, expected] of [["true", true], ["1", true], ["yes", true], ["TRUE", true], ["", false], ["0", false], ["false", false], ["False", false], [undefined, false]]) {
        if (value === undefined) delete process.env.CI;
        else process.env.CI = value;
        assert.equal(inCi(), expected, String(value));
      }
    } finally {
      if (saved === undefined) delete process.env.CI;
      else process.env.CI = saved;
    }
  });
});

describe("install-tools.sh", () => {
  it("warns before replacing a tool already in the install directory, and only then", () => {
    // Just the warn_existing function, sourced on its own: nothing is downloaded or installed.
    const script = readFileSync(join(ROOT, "stacks", "infra", "install-tools.sh"), "utf8");
    const fn = /^warn_existing\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0] ?? "";
    assert.notEqual(fn, "", "warn_existing() not found");
    const dest = temp();
    writeFileSync(join(dest, "terraform"), "");
    const warned = (tool) => spawnSync("bash", ["-c", `${fn}\nwarn_existing "$1" 9.9.9`, "warn", tool], { env: { ...process.env, DEST: dest }, encoding: "utf8" }).stderr;
    assert.match(warned("terraform"), /warning: replacing the existing .*terraform with terraform 9\.9\.9/);
    assert.equal(warned("tflint"), "");
  });
});

describe("what the checks read", () => {
  it("names every Dockerfile spelling and nothing else", () => {
    for (const path of ["Dockerfile", "app/Dockerfile.prod", "api.Dockerfile", "Containerfile"]) assert.ok(isDockerfile(path), path);
    for (const path of ["docs/Dockerfile.md.bak/x", "Dockerfiles", "dockerfile-notes.txt", ".dockerignore"]) assert.ok(!isDockerfile(path), path);
  });

  it("skips the pack's own fixtures, which are wrong on purpose", () => {
    const found = targets(ROOT);
    for (const path of [...found.terraform, ...found.dockerfiles]) assert.ok(!path.startsWith("stacks/infra/fixtures/"), path);
  });
});

// [harness]
// The runbook lint is the harness's (scripts/plans-status.mjs); `pnpm harness:eject` drops it and this test.
describe("the deploy and rollback runbook template", () => {
  it("passes the runbook lint once copied into place (`pnpm plans:check`)", () => {
    // A minimal project: the template copied to docs/runbooks/deploy.md, and this repo's stations and gates.
    const root = temp();
    mkdirSync(join(root, "docs", "runbooks"), { recursive: true });
    writeFileSync(join(root, "docs", "runbooks", "deploy.md"), readFileSync(join(ROOT, "docs", "runbooks", "_deploy.md"), "utf8"));
    // No config means plans.mdc's default stations and gates, as in a project that has none.
    if (existsSync(join(ROOT, "docs", "human-checks.json"))) cpSync(join(ROOT, "docs", "human-checks.json"), join(root, "docs", "human-checks.json"));
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "plans-status.mjs"), "check"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /0 plans, 1 runbooks ok/);
  });
});
// [/harness]
