#!/usr/bin/env bash
# One-time GitHub and clone setup for a new project made from whippletree: dev and main, rulesets, hooks, harness base.
# In the app: nothing at runtime; run once by the human after "Use this template" and choosing stacks. Safe to re-run.
# Used by: README.md → Quickstart; docs/guide/getting-started.md → 3. Bootstrap GitHub.
# Uses: gh (authenticated, repo admin), git, node; scripts/install-git-hooks.sh, scripts/stack.mjs; harness.json,
#   harness.project.json; HARNESS_UPSTREAM_URL (optional: read upstream from another URL or a local path).
#
# Everything here is what branch-protection.mdc says enforces the branch flow, done by API so no
# project starts with it half set up. Each step checks first and skips what already exists, so a
# re-run after a partial failure finishes the job instead of duplicating it.
#
# Required checks default to the template's CI job names plus each present stack pack's
# (pack.json `requiredChecks`). A project whose CI differs passes its own, and then no pack is
# read: REQUIRED_CHECKS="Checks,Build,End-to-end" bash scripts/bootstrap-repo.sh

# Stop on the first failed step; unset variables are errors.
set -euo pipefail

# Run from the repo root so relative paths below resolve.
cd "$(git rev-parse --show-toplevel)"

# This repo's owner/name, from gh (fails loudly when gh isn't authenticated).
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "bootstrap: $repo"

# Turns "A,B" into the ruleset's [{"context":"A"},{"context":"B"}] list. node builds the JSON, so a
# quote or backslash in a name is escaped rather than breaking the body; the name arrives as an argument, never as code.
checks_json() {
  # Split on commas (spaces inside a name stay: "Unit tests"); empty pieces dropped.
  node -e 'console.log(JSON.stringify(process.argv[1].split(",").filter((name) => name !== "").map((context) => ({ context }))))' "$1"
}

# 1. dev and main both exist on GitHub. "Use this template" copies only the template's default
# branch (dev), and the production ruleset and the ship flow both need main, so each is created
# from the other's tip when missing.
# True when the branch exists on GitHub.
has_branch() { gh api "repos/$repo/branches/$1" --silent 2>/dev/null; }
# The ref API needs a sha, so read the source branch's tip first.
branch_from() {
  local sha
  sha="$(gh api "repos/$repo/git/ref/heads/$2" --jq .object.sha)"
  gh api "repos/$repo/git/refs" -f ref="refs/heads/$1" -f sha="$sha" --silent
  echo "  $1: created from $2 ($sha)"
}
# dev first, from main when only main exists (a repo made before the template's default was dev).
if has_branch dev; then
  echo "  dev: exists"
elif has_branch main; then
  branch_from dev main
else
  echo "bootstrap: neither dev nor main exists on $repo; push your default branch as dev, then re-run." >&2
  exit 1
fi
# Then main, from dev, so production starts as the same tree the source guard compares against.
if has_branch main; then echo "  main: exists"; else branch_from main dev; fi

# 2. dev is the default branch (PRs target it by default), and merged branches delete themselves.
gh api -X PATCH "repos/$repo" -f default_branch=dev -F delete_branch_on_merge=true --silent
echo "  default branch: dev; delete branch on merge: on"

# 3. Local clone: on dev, tracking origin, and up to date, so the packs read below (and the
# harness base) are the ones on GitHub, including a stack choice merged before bootstrap.
git fetch --quiet origin
# Check out dev tracking origin, unless we're already on it.
[[ "$(git rev-parse --abbrev-ref HEAD)" == "dev" ]] || git checkout --quiet -B dev --track origin/dev
# Fast-forward only: local commits not on GitHub are the human's to push or drop, so say so and go on.
git merge --quiet --ff-only origin/dev 2>/dev/null || echo "  local dev: not fast-forwarded (it has commits origin/dev lacks); reading packs from this checkout"
bash scripts/install-git-hooks.sh

# The checks every dev PR must pass, comma-separated; main also requires the source guard.
# REQUIRED_CHECKS wins outright, so the packs are read only without it (a broken pack.json can't block an override).
if [[ -n "${REQUIRED_CHECKS:-}" ]]; then
  checks="$REQUIRED_CHECKS"
else
  # The checks every present pack's CI job adds (empty when none do); stack.mjs reads stacks/*/pack.json.
  pack_checks="$(node scripts/stack.mjs required-checks)"
  checks="Checks,Build${pack_checks:+,$pack_checks}"
fi
echo "  required checks: $checks"

# Names of the rulesets already on the repo, one per line; empty when the plan has none.
# A 403/404 here means rulesets aren't available (private repo on a free plan).
if ! existing="$(gh api "repos/$repo/rulesets" --jq '.[].name' 2>/dev/null)"; then
  echo "  rulesets: not available on this plan; the pre-push hook and the red guard check are the only stops (branch-protection.mdc)"
  existing="__unavailable__"
fi

# Creates one ruleset from a JSON body unless one with that name exists.
make_ruleset() {
  # $1 is the ruleset name; $2 is its full JSON body.
  local name="$1" body="$2"
  # Plan without rulesets: nothing to do.
  [[ "$existing" == "__unavailable__" ]] && return 0
  # Already there: leave it, including any edits made by hand since.
  if grep -qxF "$name" <<< "$existing"; then
    echo "  ruleset '$name': exists"
    return 0
  fi
  gh api -X POST "repos/$repo/rulesets" --input - --silent <<< "$body"
  echo "  ruleset '$name': created"
}

# The pull-request rule both PR rulesets share: a PR, no approvals needed (solo repo, agents draft).
pr_rule='{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}}'

# 4a. main: no deletion, no force-push, PR + every check green, the source guard included. No bypass.
make_ruleset "main: production" "$(cat <<JSON
{"name":"main: production","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},$pr_rule,
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
   "required_status_checks":$(checks_json "$checks,Only dev merges to main")}}]}
JSON
)"

# 4b. dev: never force-pushed or deleted, by anyone.
make_ruleset "dev: no force-push or deletion" "$(cat <<JSON
{"name":"dev: no force-push or deletion","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["refs/heads/dev"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"}]}
JSON
)"

# 4c. dev: PR + checks, admin-bypassable (actor 5 = the admin role) so docs-only pushes and a wedged CI still work.
make_ruleset "dev: PR and checks" "$(cat <<JSON
{"name":"dev: PR and checks","target":"branch","enforcement":"active",
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "conditions":{"ref_name":{"include":["refs/heads/dev"],"exclude":[]}},
 "rules":[$pr_rule,
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
   "required_status_checks":$(checks_json "$checks")}}]}
JSON
)"

# 5. harness.project.json → base: the whippletree commit this project started from, so
# `pnpm harness:pull` can tell upstream's later changes from this project's own edits. A template
# copy shares no history with upstream: its first commit is a fresh commit holding the tree of the
# template branch as it stood. So base is the upstream commit with that exact tree, found in
# upstream's history (commits only, no file contents), not upstream's tip today, which may have
# moved on, or sit on another branch than the one copied. Never fatal: a private upstream, no
# network, or a first commit that isn't a template copy leaves base empty and says how to finish.
# The upstream slug from the manifest (owner/name on GitHub).
upstream="$(node -p 'JSON.parse(require("fs").readFileSync("harness.json","utf8")).upstream')"
# base already recorded (a re-run, or a project that took a pull): never move it from here.
current_base="$(node -p 'const fs = require("fs"); fs.existsSync("harness.project.json") ? (JSON.parse(fs.readFileSync("harness.project.json","utf8")).base ?? "") : ""')"
# Upstream itself has no base; a recorded one stays; otherwise look it up.
if [[ "$repo" == "$upstream" ]]; then
  echo "  harness base: this is $upstream itself; nothing to record"
elif [[ -n "$current_base" ]]; then
  echo "  harness base: $upstream@${current_base:0:7} (already recorded)"
else
  # The tree of this project's first commit (the oldest root, should there be several).
  start_tree="$(git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}")"
  # Where to read upstream from: GitHub, unless HARNESS_UPSTREAM_URL names another clone (as harness-sync.mjs reads it).
  url="${HARNESS_UPSTREAM_URL:-https://github.com/$upstream.git}"
  # A scratch bare repo, so upstream's commits never land in this project's object store.
  scratch="$(mktemp -d)"
  git init --quiet --bare "$scratch"
  # gh's login is the credential, so a private upstream the human can read works; no prompt, so
  # one it can't fails fast. tree:0 fetches commits only (a local path ignores the filter).
  base=""
  if GIT_TERMINAL_PROMPT=0 git -C "$scratch" -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
      fetch --quiet --no-tags --filter=tree:0 "$url" '+refs/heads/*:refs/heads/*' 2>/dev/null; then
    # Newest first, so a tree that recurs (a revert) resolves to its latest commit. awk reads to the
    # end rather than exiting early: an early exit kills git log with SIGPIPE, which pipefail turns into a failed step.
    base="$(git -C "$scratch" log --all --format='%H %T' | awk -v tree="$start_tree" '$2 == tree && base == "" { base = $1 } END { print base }')"
    [[ -n "$base" ]] || echo "  harness base: no commit in $upstream has this project's first tree (was it made with \"Use this template\"?)"
  else
    echo "  harness base: could not read $upstream (private, or no network). gh auth login as someone who can read it, then re-run."
  fi
  # Drop the scratch repo whichever way the lookup went.
  rm -rf "$scratch"
  # Found: write it. Not found: leave the file alone and say how to finish.
  if [[ -n "$base" ]]; then
    # Keep whatever is already there (removedStacks from stack:remove, skips); only base changes.
    node -e 'const fs = require("fs"); const file = "harness.project.json";
      const project = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { base: "", skip: {} };
      fs.writeFileSync(file, `${JSON.stringify({ ...project, base: process.argv[1] }, null, 2)}\n`);' "$base"
    echo "  harness base: $upstream@${base:0:7}. Commit it on dev (docs-only):"
    echo "    git add harness.project.json && git commit -m 'chore: record harness base [skip ci]' && git push"
  else
    echo "  harness base: left empty, so harness:status shows '? no base yet' and the first harness:pull takes upstream whole."
    echo "    To set it by hand: base in harness.project.json = the $upstream commit whose tree is $start_tree."
  fi
fi

echo "bootstrap: done. Next: fill the {{…}} placeholders, then pnpm check (docs/guide/getting-started.md → 4. Fill the placeholders)."
