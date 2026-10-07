#!/usr/bin/env node
// The infra pack's checks: terraform fmt and validate, tflint, and hadolint over every tracked .tf and Dockerfile.
// In the app: nothing at runtime; `pnpm check` and CI's "Stack pack checks" run it through package.json `infra:*`.
// Used by: package.json (infra:fmt, infra:validate, infra:lint, infra:docker); stacks/infra/check-edited.mjs and infra.test.mjs import its helpers.
// Uses: terraform (or tofu), tflint, hadolint on PATH; .tflint.hcl and .hadolint.yaml at the repo root; scripts/stack.mjs trackedFiles.
//
//   node stacks/infra/check.mjs <fmt|validate|lint|docker>
//
// No Terraform or Dockerfile in the repo: passes and says so, without needing the tool. A tool
// that is missing: locally a loud SKIPPED line on stderr and exit 0 (the pack can sit in a repo
// before anyone installs the tools); in CI (any CI but empty, 0, or false) a failure, because CI installs them
// (stacks/infra/install-tools.sh) and a skipped check there would read as green while checking
// nothing. validate runs `init -backend=false` first: it downloads providers but never touches
// remote state, and with a committed .terraform.lock.hcl it refuses to change it.

// Node builtins only, plus the harness's own file lister.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { trackedFiles } from "../../scripts/stack.mjs";

// Knob: paths the checks skip. The pack's own fixtures are wrong on purpose (infra.test.mjs).
const IGNORED_PREFIXES = ["stacks/infra/fixtures/"];

// Terraform files fmt reads; validate and tflint work per directory of .tf files.
const TERRAFORM_FILE = /\.(tf|tfvars)$/;

// Dockerfile, Dockerfile.prod, api.Dockerfile, and the Podman spellings.
export const isDockerfile = (path) => /^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/.test(basename(path));

// Every file this pack checks, from git (tracked or new and not ignored), minus the ignored prefixes.
export const targets = (root) => {
  const files = trackedFiles(root).filter((path) => !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const terraform = files.filter((path) => TERRAFORM_FILE.test(path));
  return {
    terraform,
    // One entry per directory holding .tf files (a root module or a child module).
    modules: [...new Set(terraform.filter((path) => path.endsWith(".tf")).map((path) => dirname(path)))].toSorted((a, b) => a.localeCompare(b)),
    dockerfiles: files.filter(isDockerfile),
  };
};

// The Terraform binary: TERRAFORM_BIN when set, else terraform, else tofu (same flags); "" when none runs.
export const terraformBin = () => [process.env.TERRAFORM_BIN, "terraform", "tofu"].find((bin) => bin !== undefined && bin !== "" && runs(bin)) ?? "";

// True when `bin --version` starts and exits 0.
export const runs = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

// Runs a tool; returns { ok, output } with stdout and stderr together.
export const run = (bin, args, { cwd, env } = {}) => {
  // CHECKPOINT_DISABLE: terraform's version check phones home on every run; a check has no use for it.
  const result = spawnSync(bin, args, { cwd, env: { ...process.env, CHECKPOINT_DISABLE: "1", ...env }, encoding: "utf8" });
  // A spawn error (ENOENT) has no status; report it as output so it isn't read as a pass.
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error.message) : ""}`;
  return { ok: result.status === 0, output };
};

// terraform validate for one module directory, after a backend-less init; { ok, output }.
export const validateModule = (bin, dir) => {
  // No Terraform on PATH (terraformBin() returned ""): say so rather than crash in spawnSync.
  if (!bin) return { ok: false, output: "terraform (or tofu) is not installed; run stacks/infra/install-tools.sh" };
  // Shared provider cache, so each module and each run doesn't download the same providers again.
  const cache = process.env.TF_PLUGIN_CACHE_DIR ?? join(homedir(), ".terraform.d", "plugin-cache");
  mkdirSync(cache, { recursive: true });
  const env = { TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: "1" };
  // A committed lock file is the provider pin: init may read it, never rewrite it.
  const lock = existsSync(join(dir, ".terraform.lock.hcl")) ? ["-lockfile=readonly"] : [];
  const init = run(bin, ["init", "-backend=false", "-input=false", "-no-color", ...lock], { cwd: dir, env });
  if (!init.ok) return { ok: false, output: `init failed:\n${init.output}` };
  return run(bin, ["validate", "-no-color"], { cwd: dir, env });
};

// hadolint over some Dockerfiles with the repo's config (hadolint's defaults when there is none); { ok, output }.
export const hadolint = (root, files) => {
  const config = join(root, ".hadolint.yaml");
  return run("hadolint", [...(existsSync(config) ? ["--config", config] : []), "--no-color", ...files], { cwd: root });
};

// True in CI: CI set to anything but empty, 0, or false (CI=1 and CI=yes count, as CI providers set them).
export const inCi = () => !["", "0", "false"].includes((process.env.CI ?? "").trim().toLowerCase());

// A tool that isn't installed: loud on stderr; fatal only in CI, where install-tools.sh should have put it.
const missing = (tool, check) => {
  const fatal = inCi();
  process.stderr.write(`${fatal ? "✗" : "⚠"} infra: ${check} ${fatal ? "FAILED" : "SKIPPED"}: ${tool} is not installed. Install the pinned tools: bash stacks/infra/install-tools.sh\n`);
  return fatal ? 1 : 0;
};

// Prints a failed tool's output under a heading; returns 1.
const fail = (heading, output) => {
  process.stderr.write(`✗ infra: ${heading}\n${output.trim()}\n`);
  return 1;
};

// The four checks, by name; each returns an exit code.
const CHECKS = {
  // Formatting is canonical (`terraform fmt`); -diff shows the fix.
  fmt: (root, { terraform }) => {
    if (terraform.length === 0) return none("Terraform files", "fmt");
    const bin = terraformBin();
    if (bin === "") return missing("terraform (or tofu)", "terraform fmt");
    const result = run(bin, ["fmt", "-check", "-diff", "-no-color", ...terraform], { cwd: root });
    return result.ok ? pass(`fmt: ${terraform.length} files`) : fail("terraform fmt -check found unformatted files (run `terraform fmt` on them):", result.output);
  },
  // Every module must parse and type-check: references, arguments, provider schemas.
  validate: (root, { modules }) => {
    if (modules.length === 0) return none("Terraform modules", "validate");
    const bin = terraformBin();
    if (bin === "") return missing("terraform (or tofu)", "terraform validate");
    let code = 0;
    for (const dir of modules) {
      const result = validateModule(bin, join(root, dir));
      if (!result.ok) code = fail(`terraform validate failed in ${dir}:`, result.output);
    }
    return code === 0 ? pass(`validate: ${modules.length} modules`) : code;
  },
  // tflint per module with the repo's .tflint.hcl; --init fetches any plugin the config adds.
  lint: (root, { modules }) => {
    if (modules.length === 0) return none("Terraform modules", "tflint");
    if (!runs("tflint")) return missing("tflint", "tflint");
    const config = ["--config", join(root, ".tflint.hcl")];
    if (!existsSync(join(root, ".tflint.hcl"))) return fail("tflint:", ".tflint.hcl is missing at the repo root; the infra pack ships one.");
    const init = run("tflint", ["--init", ...config], { cwd: root });
    if (!init.ok) return fail("tflint --init failed:", init.output);
    let code = 0;
    for (const dir of modules) {
      const result = run("tflint", [`--chdir=${dir}`, ...config, "--no-color"], { cwd: root });
      if (!result.ok) code = fail(`tflint found problems in ${dir}:`, result.output);
    }
    return code === 0 ? pass(`tflint: ${modules.length} modules`) : code;
  },
  // hadolint, with .hadolint.yaml's floor (pinned base images, no `latest`).
  docker: (root, { dockerfiles }) => {
    if (dockerfiles.length === 0) return none("Dockerfiles", "hadolint");
    if (!runs("hadolint")) return missing("hadolint", "hadolint");
    const result = hadolint(root, dockerfiles);
    return result.ok ? pass(`hadolint: ${dockerfiles.length} files`) : fail("hadolint found problems:", result.output);
  },
};

// Nothing of this kind in the repo: a pass that says why, so a green check never hides "checked nothing".
const none = (what, check) => {
  process.stdout.write(`infra: no ${what} tracked; ${check} has nothing to check.\n`);
  return 0;
};

// A clean run: one line.
const pass = (what) => {
  process.stdout.write(`infra: ${what} ok\n`);
  return 0;
};

// CLI: one check per run, from the repo root.
const main = () => {
  const [name = ""] = process.argv.slice(2);
  const check = Object.hasOwn(CHECKS, name) ? CHECKS[name] : undefined;
  if (check === undefined) {
    process.stderr.write(`usage: node stacks/infra/check.mjs <${Object.keys(CHECKS).join("|")}>\n`);
    return 2;
  }
  const root = process.cwd();
  return check(root, targets(root));
};

// Run only as a script, so the edit check and the tests can import the helpers.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
