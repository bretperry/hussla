#!/usr/bin/env node
// The Kotlin pack's per-edit check: compile errors, detekt, ktfmt, and the layer map for one edited file's module.
// In the app: nothing at runtime; scripts/check-edited.mjs runs it after an agent edits a .kt, .kts, or the version catalog.
// Used by: scripts/check-edited.mjs, through stacks/kotlin/pack.json `editCheck`.
// Uses: ./gradlew (a JDK 21), build.gradle.kts (LAYERS), config/detekt/detekt.yml.
//
// Contract with the core: argv[2] is the edited file, repo-relative with forward slashes; print the
// failures to stdout, or nothing when clean. Gradle checks a source set at a time (types cross
// files), so the file's source set is compiled, linted, and format-checked, and only this file's
// findings are printed when it has any: a half-done multi-file edit doesn't drown the agent in
// errors it is about to fix. Tests are not run here (`pnpm check`, pre-push, and CI run them).
//
// Fast enough for the hook: with the Gradle daemon warm and the configuration cached, one source
// set takes a few seconds; the timeout below is for a cold daemon. A missing JDK or a timeout is
// reported, not read as clean, because "no output" must never mean "not checked".

// Node builtins only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Knob: lines kept; the agent needs the first findings, not all.
const MAX_LINES = 30;

// Knob: one Gradle run's timeout. Under the core's 80 s per-pack limit, so a cold start is reported here by name.
const TIMEOUT_MS = 70_000;

// The project root is the working directory the core runs us in.
const root = process.cwd();

// The edited file, as the core passes it.
const file = process.argv[2] ?? "";

// No wrapper at the root: not a Gradle build here (or the pack is half-removed); nothing to check against.
const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
if (file === "" || !existsSync(join(root, "gradlew"))) process.exit(0);

// The module a file belongs to: the nearest directory above it with a build.gradle.kts ("" is the root project).
const moduleDirOf = (path) => {
  for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    if (existsSync(join(root, dir, "build.gradle.kts"))) return dir;
  }
  return "";
};

// A source set's task-name part: src/main → Main, src/testFixtures → TestFixtures.
const capitalized = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// An Android module (the app) builds variants, not source sets: each source set's compile and
// type-resolved detekt task is the debug variant's (release for src/release; tests build for debug
// only, so src/testDebug and src/androidTestDebug go with test and androidTest). ktfmt still goes by
// source set. A source set not listed here (testRelease, a flavor) is skipped: no variant compiles it.
const ANDROID_TASKS = {
  main: ["compileDebugKotlin", "detektDebug"],
  debug: ["compileDebugKotlin", "detektDebug"],
  release: ["compileReleaseKotlin", "detektRelease"],
  test: ["compileDebugUnitTestKotlin", "detektDebugUnitTest"],
  testDebug: ["compileDebugUnitTestKotlin", "detektDebugUnitTest"],
  androidTest: ["compileDebugAndroidTestKotlin", "detektDebugAndroidTest"],
  androidTestDebug: ["compileDebugAndroidTestKotlin", "detektDebugAndroidTest"],
};

// Whether a module directory is an Android one: AGP needs a manifest in src/main.
const isAndroid = (moduleDir) => existsSync(join(root, moduleDir, "src/main/AndroidManifest.xml"));

// Which Gradle tasks check this file.
const tasksFor = (path) => {
  // The version catalog: configuring the build reads it (and runs the layer map).
  if (path === "gradle/libs.versions.toml") return ["help"];
  // Any other .toml belongs to another tool (a Rust or Python pack's); not ours.
  if (path.endsWith(".toml")) return [];
  const moduleDir = moduleDirOf(path);
  const project = moduleDir === "" ? "" : `:${moduleDir.replaceAll("/", ":")}`;
  // A build script: configuring runs the layer map; the format check covers the script itself.
  if (path.endsWith(".kts")) return [`${project}:ktfmtCheckScripts`];
  // A source file: its source set's compile, type-resolved detekt, and format check.
  const sourceSet = /(?:^|\/)src\/([^/]+)\/(?:kotlin|java)\//.exec(path)?.[1];
  if (sourceSet === undefined) return [];
  if (moduleDir !== "" && isAndroid(moduleDir)) {
    const tasks = ANDROID_TASKS[sourceSet];
    return tasks === undefined ? [] : [...tasks.map((task) => `${project}:${task}`), `${project}:ktfmtCheck${capitalized(sourceSet)}`];
  }
  const set = sourceSet === "main" ? "" : capitalized(sourceSet);
  return [`${project}:compile${set}Kotlin`, `${project}:detekt${capitalized(sourceSet)}`, `${project}:ktfmtCheck${capitalized(sourceSet)}`];
};

const tasks = tasksFor(file);
if (tasks.length === 0) process.exit(0);

// --continue so a compile error doesn't hide the lint and format findings; quiet so a clean run prints nothing.
const result = spawnSync(gradlew, [...tasks, "--continue", "--quiet", "--console=plain"], {
  cwd: root,
  encoding: "utf8",
  timeout: TIMEOUT_MS,
  shell: process.platform === "win32",
});

// Couldn't start, or killed by the timeout: say so, since there is no output to show.
if (result.error !== undefined && result.signal === null) {
  process.stdout.write(`Kotlin edit check could not run ${gradlew}: ${result.error.message}. It needs a JDK 21 (kotlin.mdc → Tools).`);
  process.exit(0);
}
if (result.signal !== null) {
  process.stdout.write(`Kotlin edit check timed out after ${TIMEOUT_MS / 1000} s (${tasks.join(" ")}); run \`pnpm kotlin:check\` to see why.`);
  process.exit(0);
}
if (result.status === 0) process.exit(0);

// This file's findings only: compiler and detekt lines name it by absolute path (a compiler one as
// a file:// URL). A failure with none of them (the layer map, a build script that won't compile,
// a missing JDK) is shown whole: it is about the edit too.
const absolute = resolve(root, file);
const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("Picked up JAVA_TOOL_OPTIONS"));
const mine = lines.filter((line) => line.includes(absolute));
const shown = mine.length > 0 ? mine : lines;
const kept = shown.slice(0, MAX_LINES);
const text = shown.length > kept.length ? [...kept, `… ${shown.length - kept.length} more lines`] : kept;

// Print for the core to hand back; nothing printed means clean.
process.stdout.write(`Kotlin (${tasks.join(" ")}; \`./gradlew ktfmtFormat\` fixes formatting; docs/ports-and-adapters.md for a boundary finding):\n${text.join("\n")}`);
