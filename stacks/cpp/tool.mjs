// Shared by the C++ pack's scripts: find each tool and its version, and run a command that can't leave strays behind.
// In the app: nothing at runtime; run.mjs, gates.mjs, and check-edited.mjs import it.
// Used by: stacks/cpp/run.mjs, stacks/cpp/evaluated.mjs, stacks/cpp/gates.mjs, stacks/cpp/check-edited.mjs; tested by stacks/cpp/tool.test.mjs.
// Uses: cmake, ninja, clang++, clang-tidy, clang-format, nm, g++ on PATH.
//
// Two rules live here so no caller can forget them:
// - A missing tool never reads as a pass. Locally the check says "SKIPPED" out loud and exits 0
//   (a contributor without a C++ toolchain can still run `pnpm check`); under CI (CI set, not 0/false) it fails.
//   A tool below its floor, or one that won't answer, fails everywhere.
// - A command that times out, or whose caller is told to stop, is killed with its whole process
//   group: `cmake --build` runs ninja, which runs compilers, and killing only the parent leaves
//   them writing into the build tree the next run reads.

// Node builtins only.
import { spawn, spawnSync } from "node:child_process";

// True on Windows, where a process group can't be signalled by a negative pid (Git Bash only, plan Phase 7).
const NO_GROUPS = process.platform === "win32";

// Knob: each tool the pack runs, its version floor, and how to read its version. clang 18 and
// gcc 13 are the first that build C++20 with this seed's flags; cmake 3.28 reads the presets file.
export const TOOLS = {
  cmake: { args: ["--version"], pattern: /cmake version (\d+)\.(\d+)/, floor: [3, 28] },
  ninja: { args: ["--version"], pattern: /^(\d+)\.(\d+)/, floor: [1, 10] },
  "clang++": { args: ["--version"], pattern: /clang version (\d+)\.(\d+)/, floor: [18, 0] },
  "clang-tidy": { args: ["--version"], pattern: /LLVM version (\d+)\.(\d+)/, floor: [18, 0] },
  "clang-format": { args: ["--version"], pattern: /clang-format version (\d+)\.(\d+)/, floor: [18, 0] },
  nm: { args: ["--version"], pattern: /(\d+)\.(\d+)/, floor: [2, 30] },
  "g++": { args: ["--version"], pattern: /\) (\d+)\.(\d+)/, floor: [13, 0] },
};

// Knob: how long a `--version` probe may take before the tool counts as broken.
export const VERSION_TIMEOUT_MS = 20_000;

// Knob: after a timeout's SIGTERM, how long a group gets to exit before SIGKILL.
const KILL_GRACE_MS = 3_000;

// A limit, unless CPP_PACK_TIMEOUT_MS overrides every limit (tests only: a stand-in hung tool is caught in a fraction of a second).
export const limit = (ms) => {
  const forced = Number(process.env.CPP_PACK_TIMEOUT_MS);
  return Number.isFinite(forced) && forced > 0 ? forced : ms;
};

// The grace before SIGKILL, unless CPP_PACK_GRACE_MS overrides it (tests only). A node child (run.mjs
// under gates.mjs) spends up to one grace stopping its own groups, so it gets two.
const grace = (child) => {
  const forced = Number(process.env.CPP_PACK_GRACE_MS);
  const base = Number.isFinite(forced) && forced > 0 ? forced : KILL_GRACE_MS;
  return child.spawnfile === process.execPath ? 2 * base : base;
};

// What a tool's `--version` run means: "missing" (ENOENT), "old" (below its floor), "broken"
// (anything else: a crash, a hang, unreadable output), or "ok". `version` is its first line, or why it failed.
export const classify = (name, { error, status, output }) => {
  const tool = TOOLS[name];
  if (error?.code === "ENOENT") return { state: "missing", version: "" };
  if (error?.code === "ETIMEDOUT") return { state: "broken", version: `\`${name} --version\` timed out after ${String(VERSION_TIMEOUT_MS / 1000)} s (VERSION_TIMEOUT_MS in stacks/cpp/tool.mjs)` };
  if (error !== undefined || status !== 0) return { state: "broken", version: `\`${name} --version\` failed (${error?.message ?? `exit ${String(status)}`})` };
  const found = tool.pattern.exec(output);
  const version = output.split("\n").find((line) => tool.pattern.test(line)) ?? output.split("\n")[0] ?? "";
  if (found === null) return { state: "broken", version: `\`${name} --version\` printed no version: ${version}` };
  const [major, minor] = [Number(found[1]), Number(found[2])];
  const old = major < tool.floor[0] || (major === tool.floor[0] && minor < tool.floor[1]);
  return { state: old ? "old" : "ok", version: version.trim() };
};

// Probes one tool. Blocking; for the CLI checks.
export const toolInfo = (name) => {
  const result = spawnSync(name, TOOLS[name].args, { encoding: "utf8", timeout: limit(VERSION_TIMEOUT_MS) });
  return classify(name, { error: result.error, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` });
};

// Whether CI asked for every check to really run: CI set to anything but empty, 0, or false, the
// same rule as stacks/infra/check.mjs and sql-migrations (CI=1 and CI=yes count, as some providers
// set them; `=== "true"` let CI=1 turn a missing tool into a passing SKIP).
export const inCI = (env = process.env) => !["", "0", "false"].includes((env.CI ?? "").trim().toLowerCase());

// Gate for a check that needs `names`. True when it may go on. Any missing: skip loudly, or fail
// under CI. Any old or broken: always fail (exits).
export const requireTools = (what, names) => {
  const infos = names.map((name) => ({ name, ...toolInfo(name) }));
  const bad = infos.filter((info) => info.state === "old" || info.state === "broken");
  if (bad.length > 0) {
    for (const info of bad) {
      const why = info.state === "old" ? `${info.version} is older than ${TOOLS[info.name].floor.join(".")}` : info.version;
      process.stderr.write(`cpp pack: ${info.name}: ${why}, so ${what} cannot run. Fix the toolchain; this is never read as a pass.\n`);
    }
    process.exit(1);
  }
  const missing = infos.filter((info) => info.state === "missing").map((info) => info.name);
  if (missing.length === 0) return true;
  if (inCI()) {
    process.stderr.write(`cpp pack: ${missing.join(", ")} not installed, and CI is set (CI=${process.env.CI}): ${what} must run here. Add it to the toolchain step (ci.yml, [stack:cpp] fence).\n`);
    process.exit(1);
  }
  process.stderr.write(`\n*** SKIPPED: ${missing.join(", ")} not installed, so ${what} did NOT run. This is not a pass; install them (cpp.mdc → Tools). CI fails instead of skipping. ***\n\n`);
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

// Stops every group run() started and has not seen end: SIGTERM first, so a node child gets to stop
// its own groups, then SIGKILL for whatever is still there after its grace.
export const killActiveGroups = async () => {
  const children = [...active.values()];
  for (const child of children) signalGroup(child, "SIGTERM");
  const until = Date.now() + Math.max(0, ...children.map(grace));
  while (children.some((child) => active.has(child.pid)) && Date.now() < until) await new Promise((wake) => setTimeout(wake, 25));
  // The leader may be gone while a member that ignored SIGTERM is not: KILL every group either way.
  for (const child of children) signalGroup(child, "SIGKILL");
};

// Opt-in for a script that runs tools: on SIGTERM, SIGINT, or SIGHUP, stop every group it started,
// then die of that same signal, so the caller sees a signal (the edit hook's core reads SIGTERM as
// "timed out"), not an exit code. The groups are detached, so without this they outlive us.
export const killGroupsOnSignal = () => {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, async () => {
      // A second signal while stopping changes nothing: the first one's cleanup is still running.
      if (stopping) return;
      stopping = true;
      await killActiveGroups();
      for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(name);
      process.kill(process.pid, signal);
    });
  }
};

// Runs a command in its own process group; resolves { status, signal, timedOut, output, stdout }.
// `output` is stdout and stderr interleaved; `stdout` is stdout alone. A timeout sends the group
// SIGTERM, then SIGKILL after the grace, so no compiler outlives it. A spawn failure resolves with `error`.
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

// Why a finished run() is not a clean pass, or "" when it exited 0. `knob` names the limit to raise.
export const failure = (what, result, ms, knob) => {
  if (result.error !== undefined) return `${what} could not run: ${result.error.message}`;
  if (result.timedOut) return `${what} timed out after ${String(ms / 1000)} s and was killed with its process group (${knob})`;
  if (result.status === null) return `${what} was killed by ${String(result.signal)}`;
  return result.status === 0 ? "" : `${what} exited ${String(result.status)}`;
};

// Runs `jobs` (functions returning promises) at most `width` at a time; resolves their results in order.
export const pool = async (jobs, width) => {
  const results = Array.from({ length: jobs.length });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, jobs.length)) }, worker));
  return results;
};
