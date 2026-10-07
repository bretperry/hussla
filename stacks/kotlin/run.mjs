#!/usr/bin/env node
// Runs the Kotlin pack's Gradle tasks through the project's wrapper, and says plainly when Java or the Android SDK is missing.
// In the app: nothing at runtime; package.json `kotlin:check` (so `pnpm check` and CI) and `kotlin:device` call it.
// Used by: package.json scripts, stacks/kotlin/pack.json `checks`, ci.yml (the Android emulator job).
// Uses: ./gradlew (the wrapper pins Gradle; it needs a JDK on PATH or JAVA_HOME, and an Android SDK for app/); run-lib.mjs (the lock, the test count).
//
// Why a wrapper and not `./gradlew check` in package.json: knip reads every binary a package.json
// script names and fails on one it can't find in node_modules. A missing JDK or SDK also gets one
// line saying what to install, not Gradle's stack trace.
//
// `device` runs the app's instrumented tests on whatever emulator or device adb sees. Those are
// machine-wide (AGENTS.md → machine-wide resources), so it takes a lock under /tmp first and exits
// 75 when another run holds it: wait or skip, never kill the other run. It fails a run that passed
// with zero instrumented tests executed.

// Node builtins only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DEVICE_LOCK, ranInstrumentedTests, releaseLock, takeLock } from "./run-lib.mjs";

// Knob: each task's Gradle arguments. `check` is compile, ktfmt, detekt (type-resolved), the
// layer map, Android lint, and the host tests, in every module. `device` is the instrumented
// tests on a connected emulator or device.
const TASKS = {
  check: ["check"],
  device: ["connectedDebugAndroidTest"],
};

// Tasks that use a machine-wide resource, and the lock file each takes (run-lib.mjs).
const LOCKS = {
  device: DEVICE_LOCK,
};

// Exit code for "another run holds the lock" (EX_TEMPFAIL), the same as the other machine-wide locks.
const LOCKED = 75;

// The wrapper script for this OS.
const GRADLEW = process.platform === "win32" ? "gradlew.bat" : "./gradlew";

// Which task: argv[2].
const name = process.argv[2] ?? "";
const task = TASKS[name];
if (task === undefined) {
  process.stderr.write(`kotlin pack: unknown task '${name}'; one of ${Object.keys(TASKS).join(", ")}\n`);
  process.exit(2);
}

// Android modules: top-level directories with an Android manifest (AGP needs one in src/main).
const androidModules = readdirSync(".", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(entry.name, "src/main/AndroidManifest.xml")))
  .map((entry) => entry.name);

// Whether the Android SDK can be found the way AGP looks: ANDROID_HOME, ANDROID_SDK_ROOT, or
// sdk.dir in local.properties (Android Studio writes that one).
const sdkFound = () => {
  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const dir = process.env[variable] ?? "";
    if (dir !== "" && existsSync(dir)) return true;
  }
  if (!existsSync("local.properties")) return false;
  const line = readFileSync("local.properties", "utf8")
    .split("\n")
    .find((each) => each.trim().startsWith("sdk.dir"));
  const dir = line?.split("=").slice(1).join("=").trim().replaceAll("\\\\", "\\").replaceAll("\\:", ":") ?? "";
  return dir !== "" && existsSync(dir);
};

// No SDK with an Android module present: the build would stop at configuration with a long trace.
// A failure, never a skip: a check that quietly didn't run must not read as green.
if (androidModules.length > 0 && !sdkFound()) {
  process.stderr.write(
    `kotlin pack: ${androidModules.join(", ")}/ is an Android module and needs an Android SDK: \`bash stacks/kotlin/android-sdk.sh\` installs one in ~/Android/Sdk, then set ANDROID_HOME to it (or sdk.dir in local.properties; kotlin.mdc → Tools). A project with no Android app deletes app/, its include, and its LAYERS row instead.\n`,
  );
  process.exit(1);
}
if (name === "device" && androidModules.length === 0) {
  process.stderr.write("kotlin pack: no Android module (a directory with src/main/AndroidManifest.xml), so there are no instrumented tests to run.\n");
  process.exit(1);
}

const lock = LOCKS[name];
if (lock !== undefined) {
  const { taken, why } = takeLock(lock);
  if (!taken) {
    process.stderr.write(`kotlin pack: ${why}; wait for it or skip, and never kill it.\n`);
    process.exit(LOCKED);
  }
}

// Last run's device results, so the count below sees only this run's.
const resultDirs = androidModules.map((module) => join(module, "build/outputs/androidTest-results/connected"));
if (name === "device") for (const dir of resultDirs) rmSync(dir, { recursive: true, force: true });

// Plain console: the output lands in a log or an agent's context, not a terminal that redraws.
// Run with the terminal attached, so Gradle's output is the check's output.
const result = spawnSync(GRADLEW, [...task, "--console=plain"], { stdio: "inherit", shell: process.platform === "win32" });
if (lock !== undefined) releaseLock(lock);

// No wrapper (the pack is half-removed) or no shell to run it: say so. Anything else that isn't
// a clean exit (a signal, a failed build) is a failure too, never a pass.
if (result.error !== undefined) {
  process.stderr.write(`kotlin pack: could not run ${GRADLEW}: ${result.error.message}. It needs a JDK 21 (java on PATH or JAVA_HOME; kotlin.mdc → Tools).\n`);
  process.exit(1);
}
if (result.status === 0 && name === "device") {
  const ran = ranInstrumentedTests(resultDirs);
  if (ran === 0) {
    process.stderr.write(`kotlin pack: the device run passed but executed 0 instrumented tests (${resultDirs.join(", ")}); add or un-skip one in src/androidTest.\n`);
    process.exit(1);
  }
  process.stdout.write(`kotlin pack: ${ran} instrumented test(s) ran.\n`);
}
process.exit(result.status ?? 1);
