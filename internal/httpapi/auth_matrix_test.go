// The auth matrix: every way in that must be refused, one test per row of the plan's Phase 3 list.
// In the app: the security model (docs/plans/hussla-v1.md → Security model) as executable checks.
// Used by: `go test ./internal/httpapi/...` (pnpm go:test, CI).
// Uses: the rig in harness_test.go (real router, real WebAuthn verification, fake tailnet).
//
// Each test was proved by removing the check it guards and watching it fail (the list is in the
// Phase 3 report and CHANGELOG-TECHNICAL). A refusal is asserted with its status and, where a
// client acts on it, its code; every row also asserts the allowed neighbor still works, so a test
// can't pass because everything is refused.

package httpapi_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/tokens"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
)

// Row: no identity. Off the tailnet with no key and no session, nothing but the setup screen and health.
func TestAuthMatrixNoIdentity(t *testing.T) {
	r := newRig(t).enroll()
	r.must(http.StatusOK, call{path: "/api/jobs"}) // the owner, for contrast
	for _, path := range []string{"/api/jobs", "/api/me", "/api/config", "/api/tokens", "/api/export", "/api/docs"} {
		r.must(http.StatusUnauthorized, call{path: path, from: offAddr})
		r.must(http.StatusUnauthorized, call{path: path, local: true})
	}
	r.must(http.StatusUnauthorized, call{method: http.MethodPost, path: "/api/jobs", body: map[string]string{"company": "X", "title": "Y"}, from: offAddr, origin: tailnetOrigin})
	r.must(http.StatusOK, call{path: "/healthz", from: offAddr})
	r.must(http.StatusOK, call{path: "/api/setup", from: offAddr})
	// A cookie that was never issued is no identity either, while a real session exists.
	r.must(http.StatusOK, call{path: "/api/jobs", local: true, cookie: r.localSession()})
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", local: true, cookie: "forged"})
}

// Row: a non-owner tailnet user. Another user, and the owner's own account on a tagged device, are refused.
func TestAuthMatrixNonOwnerTailnetUser(t *testing.T) {
	r := newRig(t).enroll()
	r.must(http.StatusOK, call{path: "/api/jobs"})
	for _, from := range []string{otherAddr, taggedAddr} {
		r.must(http.StatusForbidden, call{path: "/api/jobs", from: from})
		r.must(http.StatusForbidden, call{path: "/api/tokens", from: from})
		r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/jobs", body: map[string]string{"company": "X", "title": "Y"}, from: from, origin: tailnetOrigin})
		r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/stepup/begin", body: map[string]string{"method": "DELETE", "path": "/api/jobs/x"}, from: from, origin: tailnetOrigin})
		// The setup code can't make them the owner once there is one.
		r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/setup/claim", body: map[string]string{"code": "AAAA-AAAA-AAAA"}, from: from, origin: tailnetOrigin})
	}
}

// identityHeaders are every header a proxy (Tailscale Serve, a reverse proxy) might use to name a user.
var identityHeaders = map[string]string{
	"Tailscale-User-Login":        ownerPeer.Login,
	"Tailscale-User-Name":         ownerPeer.Name,
	"Tailscale-User-Profile-Pic":  "https://example.com/p.png",
	"Tailscale-Headers-Info":      "https://tailscale.com/s/serve-headers",
	"X-Forwarded-For":             "100.64.0.1",
	"X-Real-Ip":                   "100.64.0.1",
	"X-Forwarded-User":            ownerPeer.Login,
	"X-Webauth-User":              ownerPeer.Login,
	"Remote-User":                 ownerPeer.Login,
	"X-Hussla-Step-Up":            "anything",
	"X-Tailscale-User":            ownerPeer.Login,
	"X-Forwarded-Host":            tailnetHost,
	"Forwarded":                   "for=100.64.0.1;host=" + tailnetHost,
	"X-Original-Remote-Addr":      ownerAddr,
	"Tailscale-Forwarded-For-Tcp": ownerAddr,
}

// Row: identity headers sent from loopback (and from off the tailnet) are ignored.
func TestAuthMatrixIdentityHeadersFromLoopback(t *testing.T) {
	r := newRig(t).enroll()
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", local: true, headers: identityHeaders})
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", from: offAddr, headers: identityHeaders})
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", from: "127.0.0.1:41000", headers: identityHeaders})
	r.must(http.StatusForbidden, call{path: "/api/jobs", from: otherAddr, headers: identityHeaders})
	r.must(http.StatusUnauthorized, call{method: http.MethodDelete, path: "/api/jobs/x", local: true, origin: localOrigin, headers: identityHeaders})
}

// Row: a bearer key plus the owner's identity on an owner-only route. The key decides alone.
func TestAuthMatrixBearerKeyWithOwnerIdentity(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("laptop")
	id := r.newJob("Engineer")

	// From the owner's own laptop (WhoIs says owner), with an Origin and a valid step-up token.
	asOwnerToo := func(method, path string, body any) call {
		request := asAgent(secret, method, path, body)
		request.from, request.origin = ownerAddr, tailnetOrigin
		request.headers[httpapi.StepUpHeader] = r.stepUp(method, path)
		return request
	}
	r.must(http.StatusForbidden, asOwnerToo(http.MethodDelete, "/api/jobs/"+id, nil))
	r.must(http.StatusForbidden, asOwnerToo(http.MethodGet, "/api/tokens", nil))
	r.must(http.StatusForbidden, asOwnerToo(http.MethodPost, "/api/tokens", map[string]string{"name": "more"}))
	r.must(http.StatusForbidden, asOwnerToo(http.MethodPatch, "/api/config", map[string]any{"x": 1}))
	r.must(http.StatusForbidden, asOwnerToo(http.MethodPost, "/api/stepup/begin", map[string]string{"method": "DELETE", "path": "/api/jobs/" + id}))
	r.must(http.StatusOK, call{path: "/api/jobs/" + id}) // still there

	// A wrong, revoked or malformed key never falls back to the connection's owner identity.
	for _, header := range []string{"Bearer hussla_wrong", "Bearer ", "Basic b3duZXI6b3duZXI=", "hussla_" + secret} {
		r.must(http.StatusUnauthorized, call{path: "/api/jobs", headers: map[string]string{"Authorization": header}})
	}
	before := r.tailnet.Calls
	r.must(http.StatusOK, asAgent(secret, http.MethodGet, "/api/jobs", nil))
	if r.tailnet.Calls != before {
		t.Fatalf("a keyed request asked the tailnet who it was (%d calls)", r.tailnet.Calls-before)
	}

	// The key writes as the agent, never as the owner.
	created := r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/jobs/"+id+"/events", map[string]string{"action": "Ran search"})).json(t)
	var events []map[string]any
	if err := json.Unmarshal(r.must(http.StatusOK, call{path: "/api/events"}).body, &events); err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event["id"] == created["id"] && event["actor"] != "agent:laptop" {
			t.Fatalf("event actor = %v, want agent:laptop", event["actor"])
		}
	}
}

// Row: an owner-only route without a passkey assertion. Missing, wrong-purpose, reused, expired,
// and another caller's step-up tokens are all refused.
func TestAuthMatrixOwnerOnlyNeedsPasskey(t *testing.T) {
	r := newRig(t).enroll()
	id := r.newJob("Engineer")
	other := r.newJob("Designer")
	path := "/api/jobs/" + id
	withToken := func(token string) call {
		request := ownerWrite(http.MethodDelete, path, nil)
		request.headers = map[string]string{httpapi.StepUpHeader: token}
		return request
	}

	if got := r.must(http.StatusForbidden, ownerWrite(http.MethodDelete, path, nil)); got.code() != "passkey-required" {
		t.Fatalf("code = %q, want passkey-required", got.code())
	}
	r.must(http.StatusForbidden, withToken("made-up"))
	r.must(http.StatusForbidden, withToken(r.stepUp(http.MethodDelete, "/api/jobs/"+other))) // another record
	r.must(http.StatusForbidden, withToken(r.stepUp(http.MethodPost, path)))                 // another method

	expired := r.stepUp(http.MethodDelete, path)
	r.clock.Advance(config.StepUpLifetime + time.Second)
	r.must(http.StatusForbidden, withToken(expired))

	// A token granted to the owner's local session isn't the tailnet caller's, even for its purpose.
	localToken := r.localClaim(r.localSession())
	register := ownerWrite(http.MethodPost, "/api/passkeys/register/begin", nil)
	register.headers = map[string]string{httpapi.StepUpHeader: localToken}
	r.must(http.StatusForbidden, register)

	token := r.stepUp(http.MethodDelete, path)
	r.must(http.StatusOK, withToken(token))
	r.must(http.StatusNotFound, call{path: path})
	// Spent: the same token can't do it again (on the other job either).
	request := withToken(token)
	request.path = "/api/jobs/" + other
	r.must(http.StatusForbidden, request)
	r.must(http.StatusOK, call{path: "/api/jobs/" + other})
	// Spent means spent for its own action too.
	again := r.ownerStepUp(http.MethodPatch, "/api/config", map[string]any{"targetRoles": []string{"Engineer"}})
	r.must(http.StatusOK, again)
	r.must(http.StatusForbidden, again)

	// Every owner-only route is behind the same gate.
	for _, route := range []struct{ method, path string }{
		{http.MethodDelete, "/api/files/f1"},
		{http.MethodDelete, "/api/answers/a1"},
		{http.MethodPatch, "/api/config"},
		{http.MethodPost, "/api/import"},
		{http.MethodPost, "/api/tokens"},
		{http.MethodDelete, "/api/tokens/k1"},
		{http.MethodPost, "/api/mail/test"},
		{http.MethodPost, "/api/emails/e1/approve"},
		{http.MethodPost, "/api/passkeys/register/begin"},
		{http.MethodPost, "/api/sessions/revoke-all"},
	} {
		if got := r.do(ownerWrite(route.method, route.path, map[string]any{})); got.status != http.StatusForbidden || got.code() != "passkey-required" {
			t.Errorf("%s %s without a tap: %d %s", route.method, route.path, got.status, got.body)
		}
	}
}

// Row: a wrong Host (DNS rebinding, an IP literal, another name) is refused before anything else.
func TestAuthMatrixWrongHost(t *testing.T) {
	r := newRig(t).enroll()
	for _, host := range []string{"evil.example", "100.64.0.10", "hussla.tail0000.ts.net.evil.example", "localhost:8484", "hussla"} {
		r.must(http.StatusMisdirectedRequest, call{path: "/api/jobs", host: host})
		r.must(http.StatusMisdirectedRequest, call{path: "/healthz", host: host})
	}
	for _, host := range []string{"evil.example:8484", tailnetHost, "localhost:9999"} {
		r.must(http.StatusMisdirectedRequest, call{path: "/api/setup", host: host, local: true})
	}
	r.must(http.StatusOK, call{path: "/api/jobs", host: "HUSSLA.tail0000.ts.net"}) // host names are case-blind
	r.must(http.StatusOK, call{path: "/api/setup", local: true, host: "127.0.0.1:8484"})
}

// Row: a foreign Origin is refused on every method; an owner write with no Origin is refused too.
func TestAuthMatrixForeignOrigin(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("laptop")
	for _, origin := range []string{"https://evil.example", "http://" + tailnetHost, "https://" + tailnetHost + ":444", "null", localOrigin} {
		r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/jobs", body: map[string]string{"company": "X", "title": "Y"}, origin: origin})
		r.must(http.StatusForbidden, call{path: "/api/jobs", origin: origin})
		request := asAgent(secret, http.MethodPost, "/api/events", map[string]string{"action": "x"})
		request.origin = origin
		r.must(http.StatusForbidden, request)
	}
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/jobs", body: map[string]string{"company": "X", "title": "Y"}})
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/jobs", local: true, body: map[string]string{"company": "X", "title": "Y"}, cookie: r.localSession()})
	r.must(http.StatusCreated, ownerWrite(http.MethodPost, "/api/jobs", map[string]string{"company": "X", "title": "Y"}))
	r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/events", map[string]string{"action": "x"})) // scripts send none
}

// Row: a used, expired or wrong sign-in token gets no session.
func TestAuthMatrixSignInToken(t *testing.T) {
	r := newRig(t).enroll()
	signIn := func(token string) reply { return r.do(call{path: "/signin?t=" + url.QueryEscape(token), local: true}) }

	r.signIn.Put("token-one", r.clock.Now().Add(config.SignInTokenLifetime))
	if got := signIn("token-wrong"); got.status != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", got.status)
	}
	if got := signIn(""); got.status != http.StatusUnauthorized {
		t.Fatalf("empty token: %d", got.status)
	}
	first := signIn("token-one") // a wrong guess didn't burn it
	if first.status != http.StatusSeeOther || sessionCookie(first) == "" {
		t.Fatalf("first use: %d %v", first.status, first.header)
	}
	if got := signIn("token-one"); got.status != http.StatusUnauthorized {
		t.Fatalf("second use: %d", got.status)
	}
	// Even if removing the file had failed, the same token is refused (remembered in memory).
	r.signIn.Put("token-one", r.clock.Now().Add(config.SignInTokenLifetime))
	if got := signIn("token-one"); got.status != http.StatusUnauthorized {
		t.Fatalf("replayed after a failed removal: %d", got.status)
	}

	r.signIn.Put("token-two", r.clock.Now().Add(config.SignInTokenLifetime))
	r.clock.Advance(config.SignInTokenLifetime + time.Second)
	if got := signIn("token-two"); got.status != http.StatusUnauthorized {
		t.Fatalf("expired token: %d", got.status)
	}
	// A token file claiming a far-off expiry (planted, or a clock jump) is refused too.
	r.signIn.Put("token-three", r.clock.Now().Add(24*time.Hour))
	if got := signIn("token-three"); got.status != http.StatusUnauthorized {
		t.Fatalf("over-long token: %d", got.status)
	}
	// Sign-in links don't work on the tailnet listener at all.
	r.signIn.Put("token-four", r.clock.Now().Add(config.SignInTokenLifetime))
	r.must(http.StatusNotFound, call{path: "/signin?t=token-four", from: offAddr})

	// The session from the first use works, until "sign out everywhere".
	cookie := sessionCookie(first)
	r.must(http.StatusOK, call{path: "/api/jobs", local: true, cookie: cookie})
	r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/sessions/revoke-all", nil))
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", local: true, cookie: cookie})
}

// Row: before the owner is enrolled, nothing but the setup screen works.
func TestAuthMatrixBeforeEnrollment(t *testing.T) {
	r := newRig(t)
	// A key restored into an install with no owner record (a copied database) must not open it.
	secret := "hussla_restoredkeyrestoredkeyrestoredkey00000"
	sum := sha256.Sum256([]byte(secret))
	err := r.store.Atomically(context.Background(), func(tx store.Tx) error {
		return tx.Tokens().Create(context.Background(), tokens.Token{ID: "k1", Name: "restored", Hash: hex.EncodeToString(sum[:]), CreatedAt: r.clock.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/jobs", "/api/me", "/api/config", "/api/export", "/api"} {
		if got := r.do(asAgent(secret, http.MethodGet, path, nil)); got.status != http.StatusForbidden || got.code() != "setup-required" {
			t.Errorf("agent %s before enrollment: %d %s", path, got.status, got.body)
		}
		r.must(http.StatusForbidden, call{path: path}) // the would-be owner: not the owner yet
		r.must(http.StatusUnauthorized, call{path: path, local: true})
	}
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, "/api/jobs", map[string]string{"company": "X", "title": "Y"}))
	r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/passkeys/register/begin", nil))

	status := r.must(http.StatusOK, call{path: "/api/setup"}).json(t)
	if status["enrolled"] != false || status["codeInLog"] != true {
		t.Fatalf("setup status = %v", status)
	}
	// An agent can't claim; a tagged device can't; the person at the owner's laptop can, with the code.
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode}))
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/setup/claim", body: map[string]string{"code": r.setupCode}, from: taggedAddr, origin: tailnetOrigin})
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode}))
	r.must(http.StatusOK, asAgent(secret, http.MethodGet, "/api/jobs", nil))
}

// Approve with a stale version is refused: the owner approves exactly what they read.
func TestAuthMatrixApproveStaleVersion(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("mailer")
	id := r.newJob("Engineer")
	draft := r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/jobs/"+id+"/emails", map[string]string{
		"to": "recruiter@example.com", "subject": "Following up", "body": "Hello", "kind": "follow-up",
	})).json(t)
	emailID, _ := draft["id"].(string)
	read, _ := draft["version"].(float64)

	r.must(http.StatusOK, asAgent(secret, http.MethodPatch, "/api/emails/"+emailID, map[string]string{"body": "Hello again"}))
	approvePath := "/api/emails/" + emailID + "/approve"
	stale := r.do(r.ownerStepUp(http.MethodPost, approvePath, map[string]int{"version": int(read)}))
	if stale.status != http.StatusConflict || stale.code() != "changed-since-read" {
		t.Fatalf("stale approve: %d %s", stale.status, stale.body)
	}
	// An agent can't approve at all, at any version, and its approve-at-once flag is ignored.
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, approvePath, map[string]int{"version": int(read) + 1}))
	flagged := r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/jobs/"+id+"/emails", map[string]any{
		"to": "recruiter@example.com", "subject": "Again", "body": "Hi", "kind": "follow-up", "approve": true,
	})).json(t)
	if flagged["status"] != "draft" {
		t.Fatalf("an agent's approve flag took effect: %v", flagged["status"])
	}

	current := r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, approvePath, map[string]int{"version": int(read) + 1})).json(t)
	if current["status"] != "approved" {
		t.Fatalf("approve: %v", current)
	}
}
