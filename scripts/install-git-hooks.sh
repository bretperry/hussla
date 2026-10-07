#!/usr/bin/env bash
# Copy versioned hooks from .githooks/ into the repo's live hooks dir (no git config changes).
# In the app: run once per clone (`pnpm hooks:install` or `bash scripts/install-git-hooks.sh`), from the clone or any worktree.
# Used by: a fresh clone; branch-protection.mdc.
# Uses: every file in .githooks/ (pre-push today); `git rev-parse --git-path hooks`.
#
# Re-run after .githooks/ changes: copies don't follow the source. `git config core.hooksPath
# .githooks` would, at the cost of a config change per clone; this template chose copies.

# Abort on error, on unset variables, and on any failure in a pipeline.
set -euo pipefail

# Repo root (this script lives in scripts/) and the versioned hooks.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.githooks"

# Ask git where hooks live instead of assuming `.git/hooks`: in a worktree `.git` is a file, and
# every worktree shares the main clone's hooks dir (this also honors a core.hooksPath).
if ! DEST="$(git -C "$ROOT" rev-parse --path-format=absolute --git-path hooks 2>/dev/null)"; then
  echo "Not a git repo: $ROOT" >&2
  exit 1
fi

# The versioned hooks are missing — wrong tree, or a bad checkout.
if [[ ! -d "$SRC" ]]; then
  echo "Missing $SRC" >&2
  exit 1
fi

# The hooks dir is usually already there; -p makes this safe if it isn't.
mkdir -p "$DEST"
# Count of hooks copied, for the summary line.
installed=0
# Copy every file in .githooks/ into the hooks dir and make it executable.
for hook in "$SRC"/*; do
  # Skip anything that isn't a regular file (stray dirs, broken globs).
  [[ -f "$hook" ]] || continue
  name="$(basename "$hook")"
  # Skip non-hook helper files if any appear later.
  case "$name" in
    .* | *.md | *.txt) continue ;;
  esac
  # Overwrite the live hook and mark it runnable (git ignores non-executable hooks).
  cp "$hook" "$DEST/$name"
  chmod +x "$DEST/$name"
  echo "Installed $name → $DEST"
  installed=$((installed + 1))
done

echo "Done ($installed hook(s))."
