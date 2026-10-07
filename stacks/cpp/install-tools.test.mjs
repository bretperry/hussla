/*
  The C++ pack's Linux tool installer: it names a missing sanitizer runtime (TSan and UBSan, not only ASan) instead of leaving a link error for later, and says why when vm.mmap_rnd_bits can't be read or lowered instead of dying silently.
  In the app: nothing at runtime; runs in `pnpm test:harness` (and so `pnpm check`). Needs bash only: uname, sysctl, apt-get, sudo, and ninja are stand-ins on PATH, and the runtimes sit in a temp dir (CPP_RT_DIR).
  Used by: node:test (`node --test`), with node:assert.
  Uses: stacks/cpp/install-tools.sh.
*/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

// The script under test, from the repo root (node --test runs there).
const SCRIPT = "stacks/cpp/install-tools.sh";

// Stand-ins: a non-root Linux x86_64 machine. sysctl reads STUB_BITS ("fail" = unreadable) only as root, like the real 0600
// /proc/sys/vm/mmap_rnd_bits, and refuses a write when STUB_WRITE=fail. sudo marks what it runs as root (STUB_ROOT).
const STUBS = {
  uname: '#!/bin/sh\nif [ "$1" = "-m" ]; then echo x86_64; else echo Linux; fi\n',
  id: '#!/bin/sh\necho 1000\n',
  sysctl:
    '#!/bin/sh\nif [ "$1" = "-n" ]; then\n  [ "$STUB_ROOT" = "1" ] || { echo "sysctl: permission denied" >&2; exit 1; }\n  [ "$STUB_BITS" = "fail" ] && exit 1\n  echo "$STUB_BITS"\nelse\n  [ "$STUB_WRITE" = "fail" ] && { echo "sysctl: permission denied" >&2; exit 1; }\n  echo "$2"\nfi\n',
  "apt-get": "#!/bin/sh\nexit 0\n",
  sudo: '#!/bin/sh\necho "$@" >> "$STUB_SUDO_LOG"\nexport STUB_ROOT=1\nexec "$@"\n',
  ninja: "#!/bin/sh\nexit 0\n",
};

// Every runtime the presets link, by file name.
const RUNTIMES = ["libclang_rt.asan_static-x86_64.a", "libclang_rt.ubsan_standalone-x86_64.a", "libclang_rt.tsan-x86_64.a"];

const scratch = mkdtempSync(join(tmpdir(), "cpp-install-tools-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const bin = join(scratch, "bin");
mkdirSync(bin);
for (const [name, text] of Object.entries(STUBS)) writeFileSync(join(bin, name), text, { mode: 0o755 });

// Runs the script with `present` runtimes on disk, the sysctl stand-in set by `bits` / `write`, and
// GitHub's RUNNER_ENVIRONMENT as `runner` (unset by default: a person's machine). `sudo` lists what ran as root.
const install = ({ present = RUNTIMES, bits = "28", write = "ok", runner } = {}) => {
  const runtimes = mkdtempSync(join(scratch, "rt-"));
  for (const name of present) writeFileSync(join(runtimes, name), "");
  const sudoLog = join(runtimes, "sudo.log");
  writeFileSync(sudoLog, "");
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, CPP_RT_DIR: runtimes, STUB_BITS: bits, STUB_WRITE: write, STUB_SUDO_LOG: sudoLog };
  delete env.RUNNER_ENVIRONMENT;
  if (runner !== undefined) env.RUNNER_ENVIRONMENT = runner;
  const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, sudo: readFileSync(sudoLog, "utf8") };
};

describe("install-tools.sh", { skip: process.platform === "win32" && "bash stand-ins need a POSIX shell" }, () => {
  it("is ready when every runtime is there and the entropy is low enough", () => {
    const result = install();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /C\+\+ toolchain ready/);
  });
  it("fails naming the TSan runtime when only it is missing, not at link time later", () => {
    const result = install({ present: RUNTIMES.filter((name) => !name.includes("tsan")) });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /still missing[\s\S]*libclang_rt\.tsan-x86_64\.a/);
  });
  it("fails naming the UBSan runtime when only it is missing", () => {
    const result = install({ present: RUNTIMES.filter((name) => !name.includes("ubsan")) });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /libclang_rt\.ubsan_standalone-x86_64\.a/);
  });
  it("says why when vm.mmap_rnd_bits can't be read, and goes on", () => {
    const result = install({ bits: "fail" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /can't read vm\.mmap_rnd_bits \(it needs root[\s\S]*unexpected memory mapping/);
  });
  it("reads the root-only vm.mmap_rnd_bits through sudo, so a non-root runner still lowers it", () => {
    const result = install({ bits: "32" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /lowering vm\.mmap_rnd_bits from 32 to 28/);
    assert.doesNotMatch(result.output, /can't read/);
  });
  it("fails saying why when vm.mmap_rnd_bits is too high and read-only", () => {
    const result = install({ bits: "32", write: "fail" });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /couldn't lower vm\.mmap_rnd_bits \(\/proc\/sys is read-only/);
  });
  it("on a GitHub-hosted runner, lowers vm.mmap_rnd_bits through sudo as on a person's machine", () => {
    const result = install({ bits: "32", runner: "github-hosted" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.sudo, /sysctl -w vm\.mmap_rnd_bits=28/);
  });
  it("on a self-hosted runner, never touches the host's ASLR or runs sudo, and says what TSan needs", () => {
    const result = install({ bits: "32", runner: "self-hosted" });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.sudo, "");
    assert.match(result.output, /self-hosted runner, so vm\.mmap_rnd_bits was left as it is \(needs 28 or lower\)/);
  });
  it("on a self-hosted runner, installs nothing and names what to preinstall", () => {
    const result = install({ present: RUNTIMES.filter((name) => !name.includes("tsan")), runner: "self-hosted" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.sudo, "");
    assert.match(result.output, /nothing is installed here\. Preinstall: libclang-rt-18-dev/);
  });
});
