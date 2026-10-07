// Shared by the Swift pack's scripts: find the swift toolchain, and run a command that can't leave strays behind.
// In the app: nothing at runtime; run.mjs, gates.mjs, and check-edited.mjs import it.
// Used by: stacks/swift/run.mjs, stacks/swift/gates.mjs, stacks/swift/check-edited.mjs; tested by stacks/swift/tool.test.mjs.
// Uses: `swift` on PATH.
//
// Two rules live here so no caller can forget them:
// - A missing toolchain never reads as a pass. Locally the check says "SKIPPED" out loud and exits 0
//   (a contributor on Linux without Swift can still run `pnpm check`); under CI (CI set, not 0/false) it fails.
// - A command that times out, or whose caller is told to stop, is killed with its whole process
//   group. `swift build` spawns compilers and a package-lock holder; killing only the parent leaves
//   them running and blocks the next build on SwiftPM's lock.

// Node builtins only.
import { spawn, spawnSync } from "node:child_process";

// True on Windows, where a process group can't be signalled by a negative pid (Git Bash only, plan Phase 7).
const NO_GROUPS = process.platform === "win32";

// Knob: the oldest Swift the pack supports (Package.swift's tools version is 6.2).
export const MIN_SWIFT = [6, 2];

// Knob: how long `swift --version` may take in a check before the toolchain counts as broken.
// A cold first run on a fresh runner took over 30 s in CI (it warms its module cache), so it is generous.
export const VERSION_TIMEOUT_MS = 180_000;

// Knob: the edit hook's per-tool limits. They must sum under the core's per-pack limit
// (scripts/check-edited.mjs PACK_TIMEOUT_MS, 80 s), so a slow tool is reported here by name
// before the core kills the hook; tool.test.mjs checks the sum. The probe is short on purpose:
// a toolchain too cold to answer in 10 s is said to be, instead of eating the build's time.
export const HOOK_TIMEOUT_MS = { version: 10_000, format: 10_000, build: 55_000 };

// Knob: after a timeout's SIGTERM, how long a group gets to exit before SIGKILL. A node child
// (run.mjs under gates.mjs) uses it to kill its own groups first.
const KILL_GRACE_MS = 3_000;

// A limit, unless SWIFT_PACK_TIMEOUT_MS overrides every limit (tests only: a stand-in hung swift is caught in a fraction of a second).
export const limit = (ms) => {
  const forced = Number(process.env.SWIFT_PACK_TIMEOUT_MS);
  return Number.isFinite(forced) && forced > 0 ? forced : ms;
};

// The grace before SIGKILL for one child, unless SWIFT_PACK_GRACE_MS overrides KILL_GRACE_MS (tests only, like limit()).
// A node child is one of this pack's scripts (run.mjs under gates.mjs), which spends up to one grace
// stopping its own groups on SIGTERM, so it gets two: killed at one, it would orphan them.
const grace = (child) => {
  const forced = Number(process.env.SWIFT_PACK_GRACE_MS);
  const base = Number.isFinite(forced) && forced > 0 ? forced : KILL_GRACE_MS;
  return child.spawnfile === process.execPath ? 2 * base : base;
};

// Seconds for a message, without a trailing ".0".
const seconds = (ms) => `${String(ms / 1000)} s`;

// What a `swift --version` run means. `version` is its "Swift version" line, or why it failed, for the log.
// "missing" is ENOENT; "old" is a toolchain below the floor; "broken" is anything else (a crash, a hang, unreadable output).
const classify = ({ error, status, timedOut, output }, timeoutMs, knob) => {
  if (error?.code === "ENOENT") return { state: "missing", version: "" };
  if (timedOut || error?.code === "ETIMEDOUT") return { state: "broken", version: `\`swift --version\` timed out after ${seconds(timeoutMs)} (${knob} in stacks/swift/tool.mjs)` };
  if (error !== undefined || status !== 0) return { state: "broken", version: `\`swift --version\` failed (${error?.message ?? `exit ${String(status)}`})` };
  const found = /Swift version (\d+)\.(\d+)/.exec(output);
  const version = output.split("\n").find((line) => /Swift version/.test(line)) ?? output.split("\n")[0] ?? "";
  if (found === null) return { state: "broken", version: `\`swift --version\` printed no version: ${version}` };
  const [major, minor] = [Number(found[1]), Number(found[2])];
  const old = major < MIN_SWIFT[0] || (major === MIN_SWIFT[0] && minor < MIN_SWIFT[1]);
  return { state: old ? "old" : "ok", version };
};

// What "swift is here" means: `swift --version` ran, exited 0, and is at least MIN_SWIFT. Blocking; for the CLI checks.
export const swiftInfo = ({ timeoutMs = limit(VERSION_TIMEOUT_MS) } = {}) => {
  const result = spawnSync("swift", ["--version"], { encoding: "utf8", timeout: timeoutMs });
  return classify({ error: result.error, status: result.status, timedOut: false, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }, timeoutMs, "VERSION_TIMEOUT_MS");
};

// The same probe through run(), so a signal to the caller still kills it; the edit hook's, with the short limit.
export const swiftInfoAsync = async ({ timeoutMs = limit(HOOK_TIMEOUT_MS.version) } = {}) =>
  classify(await run("swift", ["--version"], { timeoutMs }), timeoutMs, "HOOK_TIMEOUT_MS.version");

// Whether CI asked for every check to really run: CI set to anything but empty, 0, or false, the
// same rule as stacks/infra/check.mjs and sql-migrations (`=== "true"` let CI=1 turn a missing swift into a passing SKIP).
export const inCI = (env = process.env) => !["", "0", "false"].includes((env.CI ?? "").trim().toLowerCase());

// Gate for a check that needs swift. Returns true when it may go on. Missing: skip loudly, or fail under CI. Old or broken: always fail.
export const requireSwift = (what) => {
  const { state, version } = swiftInfo();
  if (state === "ok") return true;
  if (state === "old") {
    process.stderr.write(`swift pack: ${version.trim()} is older than ${MIN_SWIFT.join(".")}, so ${what} cannot run (Package.swift needs tools 6.2). Upgrade the toolchain; this is never read as a pass.\n`);
    process.exit(1);
  }
  if (state === "broken") {
    process.stderr.write(`swift pack: ${version}, so ${what} cannot run. Fix the toolchain; this is never read as a pass.\n`);
    process.exit(1);
  }
  if (inCI()) {
    process.stderr.write(`swift pack: swift is not installed, and CI is set (CI=${process.env.CI}): ${what} must run here. Add the toolchain step to the job (ci.yml, [stack:swift] fence).\n`);
    process.exit(1);
  }
  process.stderr.write(`\n*** SKIPPED: swift not installed, so ${what} did NOT run. This is not a pass; install Swift 6.2 (swift.org/install) to run it. CI fails instead of skipping. ***\n\n`);
  return false;
};

// Process groups run() started that are still alive, by leader pid.
const active = new Map();

// Signals one group; a group already gone is fine.
const signalGroup = (child, signal) => {
  try {
    if (NO_GROUPS) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};

// Stops every group run() started and has not seen end, for a script told to stop mid-run: SIGTERM
// first, so a node child (run.mjs under gates.mjs) gets to stop its own groups, then SIGKILL for a
// group still there after its grace. Resolves once every group has been sent SIGKILL.
export const killActiveGroups = async () => {
  const children = [...active.values()];
  for (const child of children) signalGroup(child, "SIGTERM");
  const until = Date.now() + Math.max(0, ...children.map(grace));
  while (children.some((child) => active.has(child.pid)) && Date.now() < until) await new Promise((wake) => setTimeout(wake, 25));
  // The leader may be gone while a member that ignored SIGTERM is not: KILL every group either way.
  for (const child of children) signalGroup(child, "SIGKILL");
};

// Opt-in for a script that runs tools: on SIGTERM, SIGINT, or SIGHUP (the edit hook's core timing it
// out, Ctrl-C, a closed terminal), stop every group it started, then die of that same signal, so
// the caller sees a signal (the core reads SIGTERM as "timed out"), not an exit code.
// The groups are detached, so without this they outlive us: a signal reaches only our own group.
export const killGroupsOnSignal = () => {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, async () => {
      // A second signal while stopping changes nothing: the first one's cleanup is still running.
      if (stopping) return;
      stopping = true;
      await killActiveGroups();
      // Our handlers off, so the re-raised signal takes the default action: death by it.
      for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(name);
      process.kill(process.pid, signal);
    });
  }
};

// Runs a command in its own process group; resolves { status, signal, timedOut, output, stdout }. `output` is stdout and stderr, interleaved as they arrived; `stdout` is stdout alone.
// A timeout sends the group SIGTERM, then SIGKILL after the grace (KILL_GRACE_MS), so no compiler outlives it. A spawn failure resolves with `error`.
export const run = (command, args, { cwd = process.cwd(), timeoutMs, onOutput, env } = {}) =>
  new Promise((done) => {
    const child = spawn(command, args, { cwd, env, detached: !NO_GROUPS, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stdout = "";
    let timedOut = false;
    let killer;
    if (child.pid !== undefined) active.set(child.pid, child);
    const take = (chunk) => {
      const text = chunk.toString();
      output += text;
      onOutput?.(text);
      return text;
    };
    child.stdout.on("data", (chunk) => {
      stdout += take(chunk);
    });
    child.stderr.on("data", take);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalGroup(child, "SIGTERM");
            killer = setTimeout(() => signalGroup(child, "SIGKILL"), grace(child));
          }, timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      clearTimeout(killer);
      // The leader is gone; after a timeout, anything left in its group (a compiler that ignored SIGTERM) goes too.
      if (timedOut) signalGroup(child, "SIGKILL");
      active.delete(child.pid);
      done(result);
    };
    child.on("error", (error) => finish({ status: null, signal: null, timedOut, output, stdout, error }));
    child.on("close", (status, signal) => finish({ status, signal, timedOut, output, stdout }));
  });
