#!/usr/bin/env bash
# Container smoke test: the e2e image from a fresh volume through sign-in, then recreated on the same volume.
# In the app: nothing at runtime; proves Phase 6's "fresh volume / wrong code / evil Host / recreate keeps it" Done-when items.
# Used by: a person or agent after `docker build --target e2e -t hussla:e2e .` (docs/plans/hussla-v1.md → Phase 6).
# Uses: docker, curl, flock; the image's fake Tailscale (internal/testsupport/faketailnet), never a real tailnet.
#
# Fixed host ports (18484 home page, 18443 "tailnet", 18445 fake login) are a machine-wide resource,
# so the run holds a lock and exits 75 when another run has it (AGENTS.md → machine-wide resources).
# The volume and container it makes are its own (named hussla-smoke-<pid>) and it removes both at exit.

# Stop on the first failure, an unset variable, or a failed pipe stage.
set -euo pipefail

# The image to test; a caller can point it at another tag.
IMAGE="${HUSSLA_SMOKE_IMAGE:-hussla:e2e}"
# This run's own container and volume names, so it can never touch someone else's.
NAME="hussla-smoke-$$"
VOLUME="hussla-smoke-$$"
# Host ports; the fake Tailscale is told the same numbers, so the names it hands out match what curl dials.
HOME_PORT=18484
TAILNET_PORT=18443
LOGIN_PORT=18445
HOME_URL="http://localhost:${HOME_PORT}"
TAILNET_URL="http://localhost:${TAILNET_PORT}"

# Take the lock on the fixed ports, or give way: 75 is "temporary failure, try again".
exec 9>"${TMPDIR:-/tmp}/hussla-container-smoke.lock"
if ! flock -n 9; then
  echo "container-smoke: another run holds the ports (lock held); try again later" >&2
  exit 75
fi

# On any exit, remove this run's container and its throwaway volume (test data the run made itself).
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Fail with a message and the container's log, so a red run says why.
fail() {
  echo "container-smoke: FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -30 >&2 || true
  exit 1
}

# Start the container on the volume, with the fake Tailscale's ports matching the published ones.
start() {
  docker run -d --name "$NAME" -v "$VOLUME:/data" \
    -p "${HOME_PORT}:8484" -p "${TAILNET_PORT}:${TAILNET_PORT}" -p "${LOGIN_PORT}:${LOGIN_PORT}" \
    -e HUSSLA_FAKE_TAILNET_PORT="$TAILNET_PORT" -e HUSSLA_FAKE_TAILNET_LOGIN_PORT="$LOGIN_PORT" \
    "$IMAGE" >/dev/null
}

# Wait (up to 30 s) until the home page's HTML contains the given id.
wait_for_page() {
  local id="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "$HOME_URL/" 2>/dev/null | grep -q "id=\"$id\"\|id=$id"; then return 0; fi
    sleep 0.5
  done
  fail "the home page never showed #$id"
}

# 1. A fresh volume: the home page shows only the state (connect to Tailscale), no code and no address.
start
wait_for_page connect
page="$(curl -fsS "$HOME_URL/")"
if grep -qi "setup code" <<<"$page"; then fail "the fresh home page shows a setup code"; fi
if grep -q 'id="address"\|id=address' <<<"$page"; then fail "the fresh home page shows an address before sign-in"; fi
echo "ok: a fresh volume shows only the Tailscale step"

# 2. A Host from outside the home network is refused, on the home page and on the tailnet door.
status="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$HOME_URL/")"
[ "$status" = "421" ] || fail "the home page answered Host: evil.example with $status, want 421"
echo "ok: Host: evil.example is refused on the home page (421)"

# 3. Sign in to the fake Tailscale, the way a click on the page's link does; the page moves on by itself.
curl -fsS "http://localhost:${LOGIN_PORT}/login" >/dev/null
wait_for_page address
echo "ok: after sign-in the home page shows the address, with no restart"

# The tailnet door refuses a foreign Host too.
status="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$TAILNET_URL/api/setup")"
case "$status" in 4*) ;; *) fail "the tailnet door answered Host: evil.example with $status" ;; esac
echo "ok: Host: evil.example is refused on the tailnet door ($status)"

# 4. A wrong setup code is refused.
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $TAILNET_URL" -H 'Content-Type: application/json' \
  -d '{"code":"AAAA-AAAA-AAAA"}' "$TAILNET_URL/api/setup/claim")"
case "$status" in 4*) ;; *) fail "a wrong setup code got $status" ;; esac
echo "ok: a wrong setup code is refused ($status)"

# Read the address the server reports, to compare after the recreate.
address_before="$(curl -fsS "$TAILNET_URL/api/setup" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')"
[ -n "$address_before" ] || fail "no address before the recreate"

# 5. Recreate the container on the same volume: the sign-in and the address survive.
docker rm -f "$NAME" >/dev/null
start
wait_for_page address
address_after="$(curl -fsS "$TAILNET_URL/api/setup" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')"
[ "$address_after" = "$address_before" ] || fail "the address changed across a recreate: $address_before → $address_after"
echo "ok: a recreated container keeps the sign-in and the address ($address_after)"

# 6. The image's health check passes.
docker exec "$NAME" /hussla health >/dev/null || fail "the health check failed"
echo "ok: /hussla health"

echo "container-smoke: all passed"
