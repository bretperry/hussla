#!/usr/bin/env node
// Says whether this CI event changed anything the macOS Swift job can fail on, so a docs-only or TypeScript-only PR doesn't pay for a Mac.
// In the app: nothing at runtime; the "Change scope" job in .github/workflows/ci.yml runs it (fenced step, `swift` output).
// Used by: ci.yml (`needs.scope.outputs.swift`); tested by stacks/swift/scope.test.mjs.
// Uses: scripts/lib/ci-change-scope.mjs → changedPaths() (git diff); GITHUB_OUTPUT, GITHUB_EVENT_NAME, PR_BASE_SHA, BEFORE_SHA, AFTER_SHA.
//
// macOS minutes bill about 10x Linux, so the job runs only when a Swift path changed. Same shape
// as scripts/lib/ci-change-scope.mjs and the same rule: fail closed. Any error collecting or
// classifying writes swift=true and exits 0, so a broken classifier bills minutes rather than
// quietly skipping the only job that runs the tests on a Mac.

// Node builtins only, plus the harness's change list (itself builtins plus scripts/stack.mjs), so this runs before `pnpm install`.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { changedPaths } from "../../scripts/lib/ci-change-scope.mjs";

// Knob: paths the Swift job can fail on. Swift files anywhere, the package's own config, this pack's scripts,
// and the workflow and the change list this reads (so a change to what gates the job is verified by running it).
const SWIFT_PATHS = [/\.swift$/, /^Package\.resolved$/, /^swift-layers\.json$/, /^\.swift-format$/, /^stacks\/swift\//, /^\.github\/workflows\/ci\.yml$/, /^scripts\/lib\/ci-change-scope\.mjs$/];

// True when any changed path can affect the Swift job. An empty list is "nothing changed".
export const classify = (paths) => paths.some((path) => SWIFT_PATHS.some((pattern) => pattern.test(path)));

// Changed paths for this event, from the harness classifier: NUL-separated and unquoted (a
// non-ASCII `Sources/naïve.swift` still ends in .swift) and rename-free (moving a Swift file away
// still lists its old path). Re-exported so the tests can drive it.
export { changedPaths };

// Job entry point: writes `swift=true|false` to GITHUB_OUTPUT.
const main = () => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    process.stderr.write("swift scope: GITHUB_OUTPUT is not set; run this inside a workflow\n");
    process.exit(1);
  }
  let swift = true;
  try {
    swift = classify(changedPaths(process.env));
  } catch (error) {
    process.stderr.write(`swift scope: ${error instanceof Error ? error.message : String(error)}; failing closed (swift=true)\n`);
  }
  appendFileSync(output, `swift=${swift}\n`);
  process.stdout.write(`swift scope: swift=${swift}\n`);
};

// Run only as a script, so the tests can import classify.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
