#!/usr/bin/env node
// Says whether this CI event changed anything the Android emulator job can fail on, so a PR that
// touches no Kotlin or Gradle path doesn't boot an emulator.
// In the app: nothing at runtime; the "Change scope" job in .github/workflows/ci.yml runs it (fenced step, `android` output).
// Used by: ci.yml (`needs.scope.outputs.android`); tested by stacks/kotlin/scope.test.mjs.
// Uses: git diff; GITHUB_OUTPUT, GITHUB_EVENT_NAME, PR_BASE_SHA, BEFORE_SHA, AFTER_SHA.
//
// The emulator job takes minutes to boot and is the only one that runs instrumented tests, so it
// gets its own scope rather than the shared `heavy` (which would wake Build on every .kt edit).
// Same shape as the Swift pack's scope.mjs and the same rule: fail closed. Any error collecting or
// classifying writes android=true and exits 0, so a broken classifier bills minutes rather than
// quietly skipping the only job that runs the app on a device.

// Node builtins only.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Knob: paths the emulator job can fail on. Kotlin files anywhere, the app module (resources,
// manifest), any Gradle build file, the wrapper and version catalog, this pack's scripts, and the
// workflow (so a change to what gates the job is verified by running it).
const ANDROID_PATHS = [/\.kt$/, /^app\//, /(^|\/)(settings|build)\.gradle\.kts$/, /^gradle\.properties$/, /^gradle\//, /^gradlew(\.bat)?$/, /^stacks\/kotlin\//, /^\.github\/workflows\/ci\.yml$/];

// True when any changed path can affect the emulator job. An empty list is "nothing changed".
export const classify = (paths) => paths.some((path) => ANDROID_PATHS.some((pattern) => pattern.test(path)));

// `git diff --name-only` output, one path per line; git's own failure throws and fails closed upstream.
const diff = (...args) => execFileSync("git", ["diff", "--name-only", ...args], { encoding: "utf8" });

// Changed paths for this event: three-dot on PRs (what the branch changed), two-dot on push.
export const changedPaths = (env) => {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    if (!env.PR_BASE_SHA) throw new Error("PR_BASE_SHA is empty");
    return diff(`${env.PR_BASE_SHA}...HEAD`).split("\n").filter(Boolean);
  }
  if (env.GITHUB_EVENT_NAME === "push") {
    // An all-zero BEFORE_SHA is a new branch: no parent to diff against.
    if (!env.BEFORE_SHA || /^0+$/.test(env.BEFORE_SHA)) throw new Error("push has no parent SHA to diff");
    return diff(env.BEFORE_SHA, env.AFTER_SHA || "HEAD").split("\n").filter(Boolean);
  }
  throw new Error(`unsupported event '${env.GITHUB_EVENT_NAME ?? ""}'`);
};

// Job entry point: writes `android=true|false` to GITHUB_OUTPUT.
const main = () => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    process.stderr.write("android scope: GITHUB_OUTPUT is not set; run this inside a workflow\n");
    process.exit(1);
  }
  let android = true;
  try {
    android = classify(changedPaths(process.env));
  } catch (error) {
    process.stderr.write(`android scope: ${error instanceof Error ? error.message : String(error)}; failing closed (android=true)\n`);
  }
  appendFileSync(output, `android=${android}\n`);
  process.stdout.write(`android scope: android=${android}\n`);
};

// Run only as a script, so the tests can import classify.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
