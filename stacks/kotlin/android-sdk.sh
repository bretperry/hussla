#!/usr/bin/env bash
# Makes sure an Android SDK the app module can build against is on this machine: Google's command-line tools and platform-tools, with the SDK license accepted.
# In the app: nothing at runtime; CI's Checks and Android emulator jobs run it, and a person or agent runs it once per machine.
# Used by: .github/workflows/ci.yml ([stack:kotlin] steps); stacks/kotlin/run.mjs names it when no SDK is found.
# Uses: curl, unzip, sha256sum or shasum; dl.google.com (the tools; sdkmanager then reads the licenses from there).
#
# Only the tools and the license: the Android Gradle Plugin downloads the platform and build-tools
# the catalog's SDK levels need on the first build, once the licenses are accepted, so a version
# bump never has to be repeated here. The SDK goes in $ANDROID_HOME (or $ANDROID_SDK_ROOT), else
# ~/Android/Sdk (where Android Studio puts it on Linux); one that already has the tools is reused,
# as on GitHub's hosted runners. In GitHub Actions, ANDROID_HOME is passed on to later steps.

# Stop on the first failure, an unset variable, or a failed pipe stage.
set -euo pipefail

# Knob: the command-line tools build, and its zip's sha256 per OS (computed from Google's download,
# whose sha1 matched the one Google lists in repository2-3.xml). Bump all three together.
TOOLS_BUILD="16111833"
LINUX_SHA256="0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8"
MAC_SHA256="7e601c04e7173754b3d051a87bb4c3a8243c65a9d7bfa9356ed6499fb8953fa3"

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
sdkmanager="$sdk/cmdline-tools/latest/bin/sdkmanager"

# The tools, unless this SDK already has them.
if [ ! -x "$sdkmanager" ]; then
  case "$(uname -s)" in
    Linux) zip="commandlinetools-linux-${TOOLS_BUILD}_latest.zip" sum="$LINUX_SHA256" ;;
    # Google ships one Mac zip, x86_64: sdkmanager (all this script runs) is a shell launcher over
    # Java, so it works on both Mac CPUs; the zip's native \`android\` binary needs Rosetta on Apple silicon.
    Darwin) zip="commandlinetools-mac_x86_64-${TOOLS_BUILD}_latest.zip" sum="$MAC_SHA256" ;;
    *) echo "android-sdk: unsupported OS $(uname -s) (Linux and macOS only)" >&2; exit 1 ;;
  esac
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  curl -fsSL "https://dl.google.com/android/repository/$zip" -o "$work/$zip"
  if command -v sha256sum > /dev/null; then got="$(sha256sum "$work/$zip" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$work/$zip" | cut -d' ' -f1)"; fi
  if [ "$got" != "$sum" ]; then
    echo "android-sdk: $zip has sha256 $got, expected $sum; not installing it." >&2
    exit 1
  fi
  unzip -q "$work/$zip" -d "$work"
  mkdir -p "$sdk/cmdline-tools"
  rm -rf "$sdk/cmdline-tools/latest"
  mv "$work/cmdline-tools" "$sdk/cmdline-tools/latest"
fi

# platform-tools (adb, for the device tests). Installing it records the SDK license in
# $sdk/licenses, which is what lets AGP download the platform and build-tools on its own; the newer
# tools no longer take `--licenses`, so this is the one spelling both old and new accept. `yes`
# answers an older sdkmanager's license prompt, and dies of SIGPIPE when it stops reading, which
# pipefail would count.
(yes || true) | "$sdkmanager" "platform-tools" > /dev/null

if [ -n "${GITHUB_ENV:-}" ]; then echo "ANDROID_HOME=$sdk" >> "$GITHUB_ENV"; fi
echo "android-sdk: $sdk ($("$sdkmanager" --version))"
