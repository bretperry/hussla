// The agent door on Tailscale Funnel: agent keys only, the allowlisted routes only, no owner and no web app.
// In the app: https://<name>.<tailnet>.ts.net:8443 on the public internet when HUSSLA_AGENT_FUNNEL=1, for a cloud agent.
// Used by: `go test ./internal/httpapi/...` (pnpm go:test, CI).
// Uses: the rig in harness_test.go (its funnelUI is httpapi.New with ListenerFunnel).
//
// Each refusal is paired with the neighbor that must still work (the same request on the tailnet,
// or the same route with a key), so a test can't pass because everything is refused.

package httpapi_test

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/httpapi"
)

// onFunnel is an agent request on the agent door.
func onFunnel(secret, method, path string, body any) call {
	request := asAgent(secret, method, path, body)
	request.funnel, request.from = true, ""
	return request
}

// No key is 401 on every route, the owner's tailnet identity, cookies and identity headers included.
func TestFunnelWithoutKeyIs401(t *testing.T) {
	r := newRig(t).enroll()
	cookie := r.localSession()
	for _, path := range []string{"/api/jobs", "/api/me", "/api/docs", "/api", "/api/tokens", "/api/setup", "/healthz", "/", "/signin"} {
		got := r.must(http.StatusUnauthorized, call{path: path, funnel: true})
		if got.header.Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: 401 without WWW-Authenticate", path)
		}
		// The owner's own tailnet address, a session cookie and every proxy identity header are no identity here.
		r.must(http.StatusUnauthorized, call{path: path, funnel: true, from: ownerAddr, cookie: cookie, headers: identityHeaders})
	}
	r.must(http.StatusUnauthorized, call{method: http.MethodPost, path: "/api/setup/claim", funnel: true, origin: "https://" + funnelHost, body: map[string]string{"code": r.setupCode}})
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", funnel: true, headers: map[string]string{"Authorization": "Bearer hussla_wrong"}})
	r.must(http.StatusOK, call{path: "/api/jobs"}) // the owner on the tailnet, for contrast
	before := r.tailnet.Calls
	r.must(http.StatusUnauthorized, call{path: "/api/jobs", funnel: true, from: ownerAddr})
	if r.tailnet.Calls != before {
		t.Fatal("the agent door asked the tailnet who a caller was")
	}
}

// With a valid key, owner-only, setup, passkey and sign-in routes don't exist; nor does the web app.
func TestFunnelOwnerRoutesAre404(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("cloud")
	id := r.newJob("Engineer")
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/tokens"},
		{http.MethodPost, "/api/tokens"},
		{http.MethodDelete, "/api/tokens/k1"},
		{http.MethodDelete, "/api/jobs/" + id},
		{http.MethodPatch, "/api/config"},
		{http.MethodPost, "/api/import"},
		{http.MethodGet, "/api/export"},
		{http.MethodGet, "/api/passkeys"},
		{http.MethodPost, "/api/stepup/begin"},
		{http.MethodPost, "/api/passkeys/register/begin"},
		{http.MethodPost, "/api/sessions/revoke-all"},
		{http.MethodGet, "/api/setup"},
		{http.MethodPost, "/api/setup/claim"},
		{http.MethodPost, "/api/setup/code"},
		{http.MethodPost, "/api/emails/e1/approve"},
		{http.MethodGet, "/api/mail/settings"},
		{http.MethodPut, "/api/mail/settings"},
		{http.MethodPost, "/api/pitches"},
		{http.MethodPost, "/api/pitches/a/live"},
	} {
		request := onFunnel(secret, route.method, route.path, map[string]any{})
		// Even with the owner's address, a step-up header and an owner-looking cookie.
		request.from, request.cookie = ownerAddr, "forged"
		request.headers[httpapi.StepUpHeader] = "anything"
		got := r.must(http.StatusNotFound, request)
		if message := got.json(t)["error"]; message != "no such endpoint; GET /api lists them" {
			t.Fatalf("%s %s: %v", route.method, route.path, message)
		}
	}
	for _, path := range []string{"/", "/index.html", "/jobs/" + id, "/healthz", "/signin"} {
		got := r.must(http.StatusNotFound, onFunnel(secret, http.MethodGet, path, nil))
		if ct := got.header.Get("Content-Type"); regexp.MustCompile(`text/html`).MatchString(ct) {
			t.Fatalf("%s served HTML on the agent door", path)
		}
	}
	r.must(http.StatusOK, call{path: "/api/tokens"}) // the owner on the tailnet, for contrast
}

// Every route the door lists is one an agent may call; every route it leaves off is a 404 there.
func TestFunnelServesOnlyAgentRoutes(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("cloud")
	endpoints := func(c call) map[string]bool {
		var index struct {
			Endpoints []string `json:"endpoints"`
		}
		if err := json.Unmarshal(r.must(http.StatusOK, c).body, &index); err != nil {
			t.Fatal(err)
		}
		set := map[string]bool{}
		for _, endpoint := range index.Endpoints {
			set[endpoint] = true
		}
		return set
	}
	onDoor := endpoints(onFunnel(secret, http.MethodGet, "/api", nil))
	onTailnet := endpoints(call{path: "/api"})
	if len(onDoor) == 0 || len(onDoor) >= len(onTailnet) {
		t.Fatalf("door lists %d endpoints, tailnet %d", len(onDoor), len(onTailnet))
	}
	placeholder := regexp.MustCompile(`\{[^}]+\}`)
	for endpoint := range onTailnet {
		method, path, _ := strings.Cut(endpoint, " ")
		path = placeholder.ReplaceAllString(path, "x")
		got := r.do(onFunnel(secret, method, path, map[string]any{}))
		notThere := got.status == http.StatusNotFound && got.json(t)["error"] == "no such endpoint; GET /api lists them"
		if onDoor[endpoint] == notThere {
			t.Fatalf("%s: listed on the door = %v, but answered %d %s", endpoint, onDoor[endpoint], got.status, got.body)
		}
		if onDoor[endpoint] && (got.status == http.StatusUnauthorized || got.status == http.StatusForbidden) {
			t.Fatalf("%s: listed on the door but refused an agent key: %d %s", endpoint, got.status, got.body)
		}
	}
}

// A valid key works end to end: create a job, patch it, read the guide and use /api/me.
func TestFunnelAgentCreatesAndPatchesAJob(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("cloud")
	created := r.must(http.StatusCreated, onFunnel(secret, http.MethodPost, "/api/jobs", map[string]any{"company": "Example Co", "title": "Engineer"})).json(t)
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatalf("no id in %v", created)
	}
	r.must(http.StatusOK, onFunnel(secret, http.MethodPatch, "/api/jobs/"+id, map[string]any{"score": 80, "note": "from the cloud"}))
	job := r.must(http.StatusOK, call{path: "/api/jobs/" + id}).json(t) // the owner sees it on the tailnet
	if job["score"] != float64(80) {
		t.Fatalf("score = %v, want 80", job["score"])
	}
	if me := r.must(http.StatusOK, onFunnel(secret, http.MethodGet, "/api/me", nil)).json(t); me["kind"] != "agent" || me["name"] != "cloud" {
		t.Fatalf("me = %v", me)
	}
	r.must(http.StatusOK, onFunnel(secret, http.MethodGet, "/api/docs", nil))
	// A foreign Origin and a wrong Host are still refused before identity.
	foreign := onFunnel(secret, http.MethodGet, "/api/jobs", nil)
	foreign.origin = "https://evil.example"
	r.must(http.StatusForbidden, foreign)
	wrongHost := onFunnel(secret, http.MethodGet, "/api/jobs", nil)
	wrongHost.host = tailnetHost
	r.must(http.StatusMisdirectedRequest, wrongHost)
}

// While the node is logged in as someone else, the agent door checks the key first: no key is the
// plain 401 (never the "Not your Hussla" page), and a valid key is a JSON 403.
func TestFunnelNodeOwnerCheckRunsAfterTheKey(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("cloud")
	r.node.setOwner(ownerPeer)
	r.must(http.StatusOK, onFunnel(secret, http.MethodGet, "/api/jobs", nil))
	r.node.setOwner(otherPeer)
	for _, request := range []call{
		{path: "/api/jobs", funnel: true},
		{path: "/", funnel: true},
		{path: "/api/jobs", funnel: true, headers: map[string]string{"Authorization": "Bearer hussla_wrong"}},
	} {
		got := r.must(http.StatusUnauthorized, request)
		if strings.Contains(string(got.body), "someone else") || got.header.Get("WWW-Authenticate") == "" {
			t.Fatalf("%s: %s (WWW-Authenticate %q)", request.path, got.body, got.header.Get("WWW-Authenticate"))
		}
	}
	got := r.must(http.StatusForbidden, onFunnel(secret, http.MethodGet, "/api/jobs", nil))
	if !strings.Contains(string(got.body), "someone else") || !strings.HasPrefix(got.header.Get("Content-Type"), "application/json") {
		t.Fatalf("a valid key while the node is someone else's: %s %s", got.header.Get("Content-Type"), got.body)
	}
}

// An Authorization that isn't Bearer is a 401 that names the scheme it wants, on every door.
func TestNonBearerAuthorizationSaysBearer(t *testing.T) {
	r := newRig(t).enroll()
	for _, funnel := range []bool{false, true} {
		got := r.must(http.StatusUnauthorized, call{path: "/api/jobs", funnel: funnel, headers: map[string]string{"Authorization": "Basic YWdlbnQ6eA=="}})
		if !strings.HasPrefix(got.header.Get("WWW-Authenticate"), "Bearer") {
			t.Fatalf("funnel=%v: WWW-Authenticate %q", funnel, got.header.Get("WWW-Authenticate"))
		}
	}
}
