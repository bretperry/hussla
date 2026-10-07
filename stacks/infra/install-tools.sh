#!/usr/bin/env bash
# Installs the infra pack's pinned tools (terraform, tflint, hadolint) after checking each download's sha256.
# In the app: nothing at runtime; CI's Checks job runs it before "Stack pack checks", and a person runs it once per machine.
# Used by: .github/workflows/ci.yml ([stack:infra] step); stacks/infra/check.mjs names it when a tool is missing.
# Uses: curl, unzip, sha256sum or shasum; releases.hashicorp.com, github.com (tflint), files.pythonhosted.org (hadolint).
#
# Pins are knobs: bump a version and its checksums together, in this file only. Every sum is
# pinned here, copied from the release's own checksum list, so a replaced release asset fails.
# hadolint comes from its official PyPI wheel (hadolint-bin), which carries the release binary, so
# its sha256 is the wheel's as PyPI lists it. Installs to $INFRA_TOOLS_DIR (default ~/.local/bin)
# and, in GitHub Actions, adds that directory to the PATH of later steps.

# Stop on the first failure, an unset variable, or a failed pipe stage.
set -euo pipefail

# Knob: pinned versions.
TERRAFORM_VERSION="1.16.4"
TFLINT_VERSION="0.64.0"
HADOLINT_VERSION="2.15.1"

# Where the binaries land; created if missing.
DEST="${INFRA_TOOLS_DIR:-$HOME/.local/bin}"
mkdir -p "$DEST"

# Platform as each project names it: os = linux|darwin, arch = amd64|arm64.
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64 | amd64) arch="amd64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "install-tools: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
# Only these two systems have pins below.
case "$os" in
  linux | darwin) ;;
  *) echo "install-tools: unsupported OS $os (Linux and macOS only)" >&2; exit 1 ;;
esac

# Knob: terraform zip sha256 per platform, from releases.hashicorp.com's SHA256SUMS for TERRAFORM_VERSION.
terraform_sum() {
  case "$1" in
    linux_amd64) echo "dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df" ;;
    linux_arm64) echo "8263f301cb1a24489a4adeed147bf28504053f77237b3ea97a0ef2972659de30" ;;
    darwin_amd64) echo "2ee4b62064086e4b24b0d6cf2e61718fbaf0556feba990f708a5e32557554b3b" ;;
    darwin_arm64) echo "42cfdf97ad722f79085fe2279b06d4b8680172de3534b22eeddd9a0fbbe7b8f1" ;;
  esac
}

# Knob: tflint zip sha256 per platform, from the TFLINT_VERSION release's checksums.txt.
tflint_sum() {
  case "$1" in
    linux_amd64) echo "cca9d13e2e1d7a2c627af60ff899a3c9b74212899416aeb96ec764d2ef954537" ;;
    linux_arm64) echo "560da89aacf59389d4eb029730dd5b109b7288096c32f2726a0d9e783a5ea8eb" ;;
    darwin_amd64) echo "0f3a9fd17526014646a2dfc3f9122f7b4161abe3d6b0f0f03f9014483ddf4d19" ;;
    darwin_arm64) echo "2496e9cb3d24992d553b45e7c87a0fdc9449ca975233876247a9bfeda857e6c0" ;;
  esac
}

# Knob: hadolint-bin wheel URL and sha256 per platform, as PyPI lists them for HADOLINT_VERSION.
hadolint_wheel() {
  case "$1" in
    linux_amd64) echo "https://files.pythonhosted.org/packages/f8/4f/2d98b50d966b32e4e6f71ac429bd90bd1c2390ce4cd7dcc1056df9c233a2/hadolint_bin-2.15.1-py3-none-manylinux2014_x86_64.musllinux_1_1_x86_64.whl bed607e611b0f7e4ef78e4bba9bdf39504d8234d3eadfe86d702f2bff14ac2d5" ;;
    linux_arm64) echo "https://files.pythonhosted.org/packages/35/39/61cfdc0ccd2e43865249a25c02db8e54115ba97eae178b619ce1af527926/hadolint_bin-2.15.1-py3-none-manylinux2014_aarch64.musllinux_1_1_aarch64.whl 9d810140051c6068d002202a420e5705ffa9fff42e7fc0f54e67f90e6845723d" ;;
    darwin_amd64) echo "https://files.pythonhosted.org/packages/8a/2d/61dd58ec15986fa29204564438d82bdc46eec885e9f3049a3936ad3b571a/hadolint_bin-2.15.1-py3-none-macosx_10_9_x86_64.whl df1696d766373cac8f2fe0938230d65efb9348557816f402868e0769de62916c" ;;
    darwin_arm64) echo "https://files.pythonhosted.org/packages/f2/f5/6ee242b698bc38b02730c718f6e12d898651f44c96ff574ddef606c27644/hadolint_bin-2.15.1-py3-none-macosx_11_0_arm64.whl 2dbbf293728f1e4232bb3f8a8165009ce27f2f70957381eeb5e501d08679769c" ;;
  esac
}

# sha256 of a file: sha256sum on Linux, shasum on macOS.
sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Fails the install when a download's sum isn't the expected one; a mismatch is never installed.
verify() {
  local file="$1" expected="$2" actual
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    echo "install-tools: checksum mismatch for $(basename "$file"): expected $expected, got $actual" >&2
    exit 1
  fi
}

# Warns before replacing a copy already in $DEST (another version, or one a package manager put
# there): the install overwrites it, and every later shell on that PATH gets the pinned version.
warn_existing() {
  if [ -e "$DEST/$1" ]; then
    echo "install-tools: warning: replacing the existing $DEST/$1 with $1 $2 (set INFRA_TOOLS_DIR to install somewhere else)" >&2
  fi
}

# Scratch space for downloads, removed however the script exits.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# terraform: the release zip, checked against the pinned sum, then the one binary out of it.
echo "install-tools: terraform $TERRAFORM_VERSION"
curl -fsSL -o "$work/terraform.zip" "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_${os}_${arch}.zip"
verify "$work/terraform.zip" "$(terraform_sum "${os}_${arch}")"
warn_existing terraform "$TERRAFORM_VERSION"
unzip -o -q "$work/terraform.zip" terraform -d "$DEST"

# tflint: the release zip, checked against the pinned sum.
echo "install-tools: tflint $TFLINT_VERSION"
curl -fsSL -o "$work/tflint.zip" "https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}/tflint_${os}_${arch}.zip"
verify "$work/tflint.zip" "$(tflint_sum "${os}_${arch}")"
warn_existing tflint "$TFLINT_VERSION"
unzip -o -q "$work/tflint.zip" tflint -d "$DEST"

# hadolint: the PyPI wheel (a zip), checked against the pinned sum; the binary sits under *.data/scripts/.
echo "install-tools: hadolint $HADOLINT_VERSION"
read -r wheel_url wheel_sum <<< "$(hadolint_wheel "${os}_${arch}")"
curl -fsSL -o "$work/hadolint.whl" "$wheel_url"
verify "$work/hadolint.whl" "$wheel_sum"
warn_existing hadolint "$HADOLINT_VERSION"
unzip -o -q -j "$work/hadolint.whl" "hadolint_bin-${HADOLINT_VERSION}.data/scripts/hadolint" -d "$DEST"

# Executable, whatever the archives recorded.
chmod +x "$DEST/terraform" "$DEST/tflint" "$DEST/hadolint"

# In GitHub Actions, later steps find the tools on PATH.
if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >> "$GITHUB_PATH"; fi

# Say what is installed, from the binaries themselves (no `| head`: under pipefail its early exit fails the step).
"$DEST/terraform" version
"$DEST/tflint" --version
"$DEST/hadolint" --version
