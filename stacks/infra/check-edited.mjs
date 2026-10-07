#!/usr/bin/env node
// The infra pack's per-edit check: terraform fmt on an edited .tf/.tfvars, hadolint on an edited Dockerfile.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a file this pack claims.
// Used by: scripts/check-edited.mjs, through stacks/infra/pack.json `editCheck`.
// Uses: terraform (or tofu) and hadolint on PATH, via stacks/infra/check.mjs.
//
// Contract with the core: argv[2] is the edited file, repo-relative; print failures, or nothing
// when clean. Static and offline only: validate needs `init` (provider downloads) and tflint is
// per module, so both stay in `pnpm check`. The pack claims .tf/.tfvars by extension and every
// Dockerfile spelling (`Dockerfile`, `Dockerfile.prod`, `api.Dockerfile`, `Containerfile.dev`) by
// basename pattern (pack.json `editCheck.names`).
// A tool that isn't installed prints nothing here, like the TypeScript pack before `pnpm install`;
// `pnpm check` is where a missing tool is reported, loudly.

// Node builtins only, plus the pack's own helpers.
import { existsSync } from "node:fs";

import { hadolint, isDockerfile, run, runs, terraformBin } from "./check.mjs";

// Lines of tool output kept: the agent needs the first problems, not all.
const MAX_LINES = 30;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it; gone (a delete) means nothing to check.
const file = process.argv[2] ?? "";
if (file === "" || !existsSync(file) || file.startsWith("stacks/infra/fixtures/")) process.exit(0);

// Trims a tool's output to what the agent can act on.
const cap = (text) => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n") : lines.join("\n");
};

// Terraform: canonical formatting, with the diff that fixes it.
if (/\.(tf|tfvars)$/.test(file)) {
  const bin = terraformBin();
  if (bin === "") process.exit(0);
  const result = run(bin, ["fmt", "-check", "-diff", "-no-color", file], { cwd: root });
  if (!result.ok) process.stdout.write(`terraform fmt (run \`${bin} fmt ${file}\`):\n${cap(result.output)}\n`);
  process.exit(0);
}

// Dockerfile: hadolint with the repo's config.
if (isDockerfile(file)) {
  if (!runs("hadolint")) process.exit(0);
  const result = hadolint(root, [file]);
  if (!result.ok) process.stdout.write(`hadolint:\n${cap(result.output)}\n`);
}
