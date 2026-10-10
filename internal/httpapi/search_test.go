// The Search now routes: owner only, saving takes a passkey tap, the token never comes back, and each refusal's status.
// In the app: the Jobs page's Search now button and Settings → Job search.
// Used by: `go test ./internal/httpapi/...`.
// Uses: the rig in harness_test.go, with fakeFirer standing in for the routine's endpoint.

package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/app/searchrun"
	"github.com/bretperry/hussla/internal/config"
)

// fakeFirer counts fires and answers with its scripted error, or a session link.
type fakeFirer struct {
	fires int
	err   error
}

func (firer *fakeFirer) Fire(context.Context, string, mailsetup.Secret, string) (searchrun.Fired, error) {
	firer.fires++
	if firer.err != nil {
		return searchrun.Fired{}, firer.err
	}
	return searchrun.Fired{SessionURL: "https://claude.ai/code/session_01X"}, nil
}

const routineToken = "sk-ant-oat01-routine-token"

func saveRoutine(r *rig) {
	r.t.Helper()
	body := map[string]string{"routine": "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire", "token": routineToken}
	saved := r.must(http.StatusOK, r.ownerStepUp(http.MethodPut, "/api/search", body))
	if strings.Contains(string(saved.body), routineToken) {
		r.t.Fatalf("the token came back: %s", saved.body)
	}
}

func TestSearchNowNeedsASetup(t *testing.T) {
	r := newRig(t).enroll()
	view := r.must(http.StatusOK, call{path: "/api/search"}).json(t)
	if view["configured"] != false {
		t.Fatalf("fresh install: %v", view)
	}
	r.must(http.StatusBadRequest, ownerWrite(http.MethodPost, "/api/search/run", nil))
	if r.firer.fires != 0 {
		t.Fatal("fired with no setup")
	}
}

func TestSearchNowSaveNeedsAPasskeyTap(t *testing.T) {
	r := newRig(t).enroll()
	got := r.must(http.StatusForbidden, ownerWrite(http.MethodPut, "/api/search", map[string]string{"routine": "trig_01ABC", "token": "x"}))
	if got.code() != "passkey-required" {
		t.Fatalf("code: %q", got.code())
	}
	saveRoutine(r)
	view := r.must(http.StatusOK, call{path: "/api/search"}).json(t)
	if view["configured"] != true || view["routineId"] != "trig_01ABC" || view["hasToken"] != true {
		t.Fatalf("after save: %v", view)
	}
}

func TestSearchNowRunsOnceThenCoolsDown(t *testing.T) {
	r := newRig(t).enroll()
	saveRoutine(r)
	run := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/search/run", nil)).json(t)
	if run["sessionUrl"] != "https://claude.ai/code/session_01X" {
		t.Fatalf("run: %v", run)
	}
	r.must(http.StatusTooManyRequests, ownerWrite(http.MethodPost, "/api/search/run", nil))
	r.clock.Advance(config.SearchRunCooldown)
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/search/run", nil))
	if r.firer.fires != 2 {
		t.Fatalf("want 2 fires, got %d", r.firer.fires)
	}
}

func TestSearchNowRefusedTokenIsABadGateway(t *testing.T) {
	r := newRig(t).enroll()
	saveRoutine(r)
	r.firer.err = searchrun.ErrTokenRejected
	got := r.must(http.StatusBadGateway, ownerWrite(http.MethodPost, "/api/search/run", nil)).json(t)
	if got["error"] != searchrun.ErrTokenRejected.Error() {
		t.Fatalf("error: %v", got)
	}
	r.firer.err = &searchrun.FireError{Reason: "Claude answered 500"}
	got = r.must(http.StatusBadGateway, ownerWrite(http.MethodPost, "/api/search/run", nil)).json(t)
	if !strings.Contains(got["error"].(string), "Claude answered 500") {
		t.Fatalf("error: %v", got)
	}
}

// Agents can't start a search or read the setup: a run spends the owner's Claude usage.
func TestSearchNowIsOwnerOnly(t *testing.T) {
	r := newRig(t).enroll()
	saveRoutine(r)
	secret := r.agentKey("Helper")
	r.must(http.StatusForbidden, asAgent(secret, http.MethodGet, "/api/search", nil))
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, "/api/search/run", nil))
	r.must(http.StatusForbidden, call{path: "/api/search", from: otherAddr})
	onFunnel := asAgent(secret, http.MethodPost, "/api/search/run", nil)
	onFunnel.funnel = true
	r.must(http.StatusNotFound, onFunnel)
	if r.firer.fires != 0 {
		t.Fatalf("someone other than the owner fired it %d times", r.firer.fires)
	}
}
