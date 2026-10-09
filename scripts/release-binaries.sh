#!/usr/bin/env bash
# Builds the plain Hussla binaries for every platform, with the web app inside, into ./release with checksums.
# In the app: the downloads for a laptop without Docker (docs/install/laptop.md); the image is built by the Dockerfile instead.
# Used by: .github/workflows/publish-image.yml (Binaries job, on a v* tag); a person can run it locally too.
# Uses: pnpm (the Vite build), go (cgo off, so one static binary per target), sha256sum or shasum.
#
#   bash scripts/release-binaries.sh v1.2.3
#
# The Go sources are copied to a scratch folder with the Vite build where the placeholder page
# was, so the working tree is never touched. Signing and notarizing (macOS, Windows) are a
# person's step on the draft release; unsigned macOS binaries need right-click → Open once.

# Stop on the first failure, an unset variable, or a failed pipe stage.
set -euo pipefail

# The version recorded in the binary (and in each migration); "dev" when none is given.
VERSION="${1:-dev}"
# Run from the repo root wherever the script is called from.
cd "$(dirname "$0")/.."
# Every platform a person might run Hussla on without Docker.
TARGETS=(darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64)

# A scratch folder for the build copy, removed at exit (it holds only copies of tracked sources).
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Build the web app once; every binary embeds the same files.
pnpm build

# Copy what the Go build reads (the same list as the Dockerfile's server stage).
mkdir -p "$SCRATCH/docs"
cp -R go.mod go.sum assets.go cmd internal "$SCRATCH/"
cp docs/agents-api.md "$SCRATCH/docs/"
# The Vite build replaces the placeholder page in the copy.
rm -rf "$SCRATCH/cmd/hussla/web"
cp -R dist "$SCRATCH/cmd/hussla/web"

# Start from an empty output folder so a stale binary can't ship.
rm -rf release
mkdir -p release
OUT="$(pwd)/release"

# One static binary per target, named hussla-<os>-<arch>[.exe].
for target in "${TARGETS[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  name="hussla-${os}-${arch}"
  # Windows needs the .exe suffix to run on a double-click.
  if [ "$os" = "windows" ]; then name="${name}.exe"; fi
  echo "building $name"
  (cd "$SCRATCH" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w -X main.appVersion=${VERSION}" -o "$OUT/$name" ./cmd/hussla)
done

# Checksums, so a download can be checked against the release page.
cd release
if command -v sha256sum >/dev/null; then sha256sum hussla-* > SHA256SUMS; else shasum -a 256 hussla-* > SHA256SUMS; fi
echo "release/: $(ls | wc -l | tr -d ' ') files for ${VERSION}"
