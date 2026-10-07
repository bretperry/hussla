// The Kotlin runner's pure parts: the machine-wide device lock, and counting the instrumented tests a device run executed.
// In the app: nothing at runtime; stacks/kotlin/run.mjs (`pnpm kotlin:device`) calls these.
// Used by: stacks/kotlin/run.mjs; stacks/kotlin/run-lib.test.mjs (node:test).
// Uses: Node builtins only.
//
// Why a separate module: the device run needs an emulator, so the rules that decide whether it
// may start and whether it proved anything are tested here without one.

// Node builtins only.
import { closeSync, existsSync, linkSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

// Knob: the device lock. A fixed path under /tmp, not os.tmpdir(): an agent sandbox can give each
// session its own TMPDIR (and macOS gives each user one), and a lock nobody else can see guards
// nothing. Windows has no /tmp, so it falls back to the temp directory there.
export const DEVICE_LOCK = process.platform === "win32" ? join(process.env.TEMP ?? ".", "whippletree-android-device.lock") : "/tmp/whippletree-android-device.lock";

// Whether a pid names a running process (EPERM: it runs, under another user).
const running = (pid, kill) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Takes `path` for `pid`. Returns { taken: true } or { taken: false, why }. A lock whose holder
// isn't running (a crash, a killed shell) is taken over; one that can't be read (empty while its
// holder is still writing its pid, a directory, garbage) counts as held, since guessing "stale"
// there is how two runs share a device. `kill` is injectable for the tests.
export const takeLock = (path, pid = process.pid, kill = process.kill) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return { taken: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let text = "";
    try {
      text = statSync(path).isFile() ? readFileSync(path, "utf8") : "";
    } catch {
      // Gone between the open and the read: try again.
      continue;
    }
    const holder = /^\d+\n?$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (Number.isNaN(holder)) return { taken: false, why: `${path} exists but names no process yet (another run may be starting); if none is, delete it` };
    if (running(holder, kill)) return { taken: false, why: `another run (pid ${holder}) holds ${path}` };
    // Take the stale lock over by moving it aside, not deleting it: two runs can read the same dead
    // pid, and the second one's delete would remove the lock the first had just written.
    const aside = `${path}.stale-${pid}`;
    try {
      renameSync(path, aside);
    } catch {
      // Someone else moved it first: try again.
      continue;
    }
    let moved = "";
    try {
      moved = readFileSync(aside, "utf8");
    } catch {
      // Unreadable: treat it as someone else's, below.
    }
    if (moved !== text) {
      // What we moved was a newer run's live lock: put it back (link fails if another lock is there).
      try {
        linkSync(aside, path);
      } catch {
        // Another lock already took its place.
      }
      rmSync(aside, { force: true });
      return { taken: false, why: `another run took ${path} first` };
    }
    rmSync(aside, { force: true });
  }
  return { taken: false, why: `another run took ${path} first` };
};

// Releases `path` only if `pid` still holds it, so a run never deletes someone else's lock.
export const releaseLock = (path, pid = process.pid) => {
  try {
    if (readFileSync(path, "utf8").trim() === String(pid)) rmSync(path, { force: true });
  } catch {
    // Already gone, or not a file we wrote.
  }
};

// Every file under `dir`.
const filesUnder = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
};

// The instrumented tests a run executed (not skipped), from the JUnit XML AGP writes per device
// under <module>/build/outputs/androidTest-results/connected. An empty androidTest source set
// passes connectedDebugAndroidTest with nothing run, so the runner counts instead of trusting it.
export const ranInstrumentedTests = (resultDirs) => {
  let ran = 0;
  for (const file of resultDirs.flatMap(filesUnder).filter((path) => path.endsWith(".xml"))) {
    for (const testCase of readFileSync(file, "utf8").match(/<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g) ?? []) {
      if (!/<skipped\b/.test(testCase)) ran++;
    }
  }
  return ran;
};
