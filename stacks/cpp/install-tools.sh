#!/usr/bin/env bash
# Makes a Linux machine's C++ toolchain able to run the C++ pack's sanitizer builds: the clang runtimes, ninja, and an mmap entropy TSan accepts.
# In the app: nothing at runtime; CI's Checks job runs it before the pack's checks, and a person runs it once per Linux machine.
# Used by: .github/workflows/ci.yml ([stack:cpp] step); cpp.mdc → Tools names it.
# Uses: apt-get and sudo (Debian/Ubuntu), sysctl; the compilers themselves come from the OS image (ubuntu-24.04 ships clang 18 and g++ 13);
#   RUNNER_ENVIRONMENT (set by GitHub Actions: github-hosted or self-hosted).
#
# On a self-hosted runner it changes nothing: no apt, no sudo, no sysctl. Lowering vm.mmap_rnd_bits
# weakens ASLR for the whole host, and an apt install there is the machine owner's call, not a
# workflow's. It only checks and says what is missing. Such a machine must already have: clang 18
# with clang-tidy and clang-format, cmake 3.28+, ninja, g++ 13, libclang-rt-18-dev (the ASan, UBSan,
# and TSan runtimes), and, for the TSan tests, vm.mmap_rnd_bits at 28 or lower (set by its owner).
#
# Why a script and not an action: the runner image already carries clang, clang-tidy,
# clang-format, cmake, and g++, so only the gaps are filled, from the distro's own signed apt
# repository (no third-party download to pin). Version floors are checked afterwards by
# `node stacks/cpp/run.mjs version`, which fails loudly, so this script stays small.

# Stop on the first failure, an unset variable, or a failed pipe stage.
set -euo pipefail

# Knob: the clang major whose sanitizer runtimes the presets link (keep in step with TOOLS in stacks/cpp/tool.mjs).
CLANG_MAJOR="18"

# Knob: the highest mmap ASLR entropy TSan's memory layout accepts (Linux 6.x kernels default to 32 on some images).
MAX_MMAP_RND_BITS="28"

# Only Linux needs this; macOS's Xcode clang ships its sanitizer runtimes.
if [ "$(uname -s)" != "Linux" ]; then
  echo "install-tools: nothing to do on $(uname -s)"
  exit 0
fi

# GitHub's self-hosted runner (any value but github-hosted; unset is a person at their own machine).
self_hosted=0
if [ -n "${RUNNER_ENVIRONMENT:-}" ] && [ "${RUNNER_ENVIRONMENT}" != "github-hosted" ]; then
  self_hosted=1
fi

# Runs a command as root: directly when we are root, through sudo otherwise.
as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# The packages still missing, collected so apt runs once.
missing=()

# Where clang's sanitizer runtimes live; CPP_RT_DIR overrides it (stacks/cpp/install-tools.test.mjs points it at a stand-in).
rt_dir="${CPP_RT_DIR:-/usr/lib/llvm-${CLANG_MAJOR}/lib/clang/${CLANG_MAJOR}/lib/linux}"

# The runtimes the presets link: ASan (asan tree), UBSan (asan tree), TSan (tsan tree). All ship in
# libclang-rt-<major>-dev, which the runner image may not carry; a missing one is otherwise a link error.
runtimes=(
  "$rt_dir/libclang_rt.asan_static-$(uname -m).a"
  "$rt_dir/libclang_rt.ubsan_standalone-$(uname -m).a"
  "$rt_dir/libclang_rt.tsan-$(uname -m).a"
)

# The runtimes not on disk; prints one path per line.
missing_runtimes() {
  local runtime
  for runtime in "${runtimes[@]}"; do
    if [ ! -f "$runtime" ]; then echo "$runtime"; fi
  done
}

if [ -n "$(missing_runtimes)" ]; then
  missing+=("libclang-rt-${CLANG_MAJOR}-dev")
fi

# The presets generate Ninja build files.
if ! command -v ninja > /dev/null 2>&1; then
  missing+=("ninja-build")
fi

# Self-hosted: install nothing; name what the machine's owner must add.
if [ "${#missing[@]}" -gt 0 ] && [ "$self_hosted" = "1" ]; then
  echo "install-tools: self-hosted runner (RUNNER_ENVIRONMENT=$RUNNER_ENVIRONMENT), so nothing is installed here. Preinstall: ${missing[*]}" >&2
  exit 1
fi

# Install what is missing, from the distro's repository.
if [ "${#missing[@]}" -gt 0 ]; then
  echo "install-tools: installing ${missing[*]}"
  as_root apt-get update -qq
  as_root apt-get install -y -qq --no-install-recommends "${missing[@]}"
fi

# Still a runtime missing after the install: say which file, so the failure isn't a cryptic link error later.
still_missing="$(missing_runtimes)"
if [ -n "$still_missing" ]; then
  echo "install-tools: still missing after the install (install clang ${CLANG_MAJOR}'s compiler-rt for this OS):" >&2
  echo "$still_missing" >&2
  exit 1
fi

# TSan maps its shadow memory at fixed ranges that higher ASLR entropy collides with ("unexpected memory mapping").
# The value is root-only (/proc/sys/vm/mmap_rnd_bits is 0600), so it is read through as_root too; a plain read fails on every non-root machine, the CI runner included.
# Where it still can't be read or written (no sudo, a container, WSL), say so instead of dying silently under set -e.
tsan_note="TSan tests may then fail with 'unexpected memory mapping'; on a host you control: sudo sysctl -w vm.mmap_rnd_bits=$MAX_MMAP_RND_BITS"
if [ "$self_hosted" = "1" ]; then
  # Host-wide ASLR is the owner's setting, not this workflow's: leave it, and say what TSan needs.
  echo "install-tools: self-hosted runner, so vm.mmap_rnd_bits was left as it is (needs $MAX_MMAP_RND_BITS or lower). $tsan_note" >&2
elif ! bits="$(as_root sysctl -n vm.mmap_rnd_bits 2> /dev/null)"; then
  echo "install-tools: can't read vm.mmap_rnd_bits (it needs root and sudo failed, or there is no /proc/sys/vm here), so it was left as it is. $tsan_note" >&2
elif [ "$bits" -gt "$MAX_MMAP_RND_BITS" ]; then
  echo "install-tools: lowering vm.mmap_rnd_bits from $bits to $MAX_MMAP_RND_BITS for TSan"
  if ! as_root sysctl -w "vm.mmap_rnd_bits=$MAX_MMAP_RND_BITS"; then
    echo "install-tools: couldn't lower vm.mmap_rnd_bits (/proc/sys is read-only here: a container or WSL). $tsan_note" >&2
    exit 1
  fi
fi

echo "install-tools: C++ toolchain ready"
