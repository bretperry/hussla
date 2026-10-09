// Pitch routes: who may start, add, pick live and delete, and that an agent's version never goes live by itself.
// In the app: the security model's "pick a live pitch needs a passkey tap" and "a key is never upgraded", for pitches.
// Used by: go test ./internal/httpapi/... (pnpm go:test).
// Uses: the rig in harness_test.go (real router, real WebAuthn verification, fake tailnet).

package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
)

// pitchVersions reads the version numbers and live version off a Pitch response.
func pitchVersions(t *testing.T, body map[string]any) (live float64, numbers []float64) {
	t.Helper()
	for _, entry := range body["versions"].([]any) {
		numbers = append(numbers, entry.(map[string]any)["version"].(float64))
	}
	return body["liveVersion"].(float64), numbers
}

func TestPitchesAgentsAddVersionsOnlyTheOwnerPicksLiveOrDeletes(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("laptop")

	// Starting a pitch is the owner's; an agent key is refused even with the owner's identity behind it.
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, "/api/pitches", map[string]any{"slot": 1, "title": "Who I am", "text": "x"}))
	agentOnOwnersLaptop := asAgent(secret, http.MethodPost, "/api/pitches", map[string]any{"slot": 1, "title": "Who I am", "text": "x"})
	agentOnOwnersLaptop.from, agentOnOwnersLaptop.origin = ownerAddr, tailnetOrigin
	r.must(http.StatusForbidden, agentOnOwnersLaptop)
	created := r.must(http.StatusCreated, ownerWrite(http.MethodPost, "/api/pitches", map[string]any{"slot": 1, "title": "Who I am", "when": "Opening", "text": "I build calm tools."})).json(t)
	if live, numbers := pitchVersions(t, created); live != 1 || len(numbers) != 1 {
		t.Fatalf("a new pitch: %v", created)
	}
	r.must(http.StatusConflict, ownerWrite(http.MethodPost, "/api/pitches", map[string]any{"slot": 1, "title": "Again", "text": "y"}))

	// An agent adds a version; it is in the history, and the live one hasn't moved.
	added := r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/pitches/1/versions", map[string]any{"text": "I make busy days calmer.", "note": "warmer"})).json(t)
	if live, numbers := pitchVersions(t, added); live != 1 || len(numbers) != 2 {
		t.Fatalf("after the agent's version: %v", added)
	}
	// A retry of the same words adds nothing.
	again := r.must(http.StatusCreated, asAgent(secret, http.MethodPost, "/api/pitches/1/versions", map[string]any{"text": "I make busy days calmer.", "note": "warmer"})).json(t)
	if _, numbers := pitchVersions(t, again); len(numbers) != 2 {
		t.Fatalf("a retried version was added twice: %v", again)
	}
	r.must(http.StatusBadRequest, asAgent(secret, http.MethodPost, "/api/pitches/1/versions", map[string]any{"text": "x", "live": true}))
	r.must(http.StatusNotFound, asAgent(secret, http.MethodPost, "/api/pitches/2/versions", map[string]any{"text": "x"}))
	r.must(http.StatusBadRequest, asAgent(secret, http.MethodPost, "/api/pitches/11/versions", map[string]any{"text": "x"}))

	// Picking the live version: never an agent; the owner only with a tap for exactly this route.
	live := map[string]any{"version": 2}
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPost, "/api/pitches/1/live", live))
	noTap := r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/pitches/1/live", live))
	if noTap.code() != "passkey-required" {
		t.Fatalf("live without a tap: %s", noTap.body)
	}
	wrongRoute := ownerWrite(http.MethodPost, "/api/pitches/1/live", live)
	wrongRoute.headers = map[string]string{"X-Hussla-Step-Up": r.stepUp(http.MethodDelete, "/api/pitches/1")}
	r.must(http.StatusForbidden, wrongRoute)
	madeLive := r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/pitches/1/live", live)).json(t)
	if current, _ := pitchVersions(t, madeLive); current != 2 {
		t.Fatalf("live should be 2: %v", madeLive)
	}

	// Deleting: the live version can't go; an old one can, with a tap; agents never.
	r.must(http.StatusForbidden, asAgent(secret, http.MethodDelete, "/api/pitches/1/versions/1", nil))
	r.must(http.StatusBadRequest, r.ownerStepUp(http.MethodDelete, "/api/pitches/1/versions/2", nil))
	r.must(http.StatusOK, r.ownerStepUp(http.MethodDelete, "/api/pitches/1/versions/1", nil))
	r.must(http.StatusForbidden, asAgent(secret, http.MethodDelete, "/api/pitches/1", nil))
	r.must(http.StatusForbidden, ownerWrite(http.MethodDelete, "/api/pitches/1", nil))
	r.must(http.StatusOK, r.ownerStepUp(http.MethodDelete, "/api/pitches/1", nil))

	listed := r.must(http.StatusOK, asAgent(secret, http.MethodGet, "/api/pitches", nil)).json(t)
	if pitches := listed["pitches"].([]any); len(pitches) != 0 {
		t.Fatalf("the pitch should be gone: %v", listed)
	}
	settings := listed["settings"].(map[string]any)
	if settings["slots"] != float64(10) || settings["rotateSeconds"] != float64(180) || settings["wordsPerMinute"] != float64(150) {
		t.Errorf("settings = %v", settings)
	}

	// The log names who did each step, and the agent's line names the agent key.
	events := r.must(http.StatusOK, call{path: "/api/events?limit=50"}).body
	for _, want := range []string{`"actor":"agent:laptop","action":"Added a pitch version"`, `"action":"Made a pitch version live"`, `"action":"Deleted a pitch"`} {
		if !strings.Contains(string(events), want) {
			t.Errorf("activity log lacks %s: %s", want, events)
		}
	}
}

func TestPitchEditsAreTheOwners(t *testing.T) {
	r := newRig(t).enroll()
	secret := r.agentKey("laptop")
	r.must(http.StatusCreated, ownerWrite(http.MethodPost, "/api/pitches", map[string]any{"title": "Why me", "text": "Because."}))
	r.must(http.StatusForbidden, asAgent(secret, http.MethodPatch, "/api/pitches/1", map[string]any{"title": "Hijacked"}))
	edited := r.must(http.StatusOK, ownerWrite(http.MethodPatch, "/api/pitches/1", map[string]any{"title": "Why me, really", "when": "When asked to compare"})).json(t)
	if edited["title"] != "Why me, really" || edited["when"] != "When asked to compare" {
		t.Fatalf("edit: %v", edited)
	}
	r.must(http.StatusBadRequest, ownerWrite(http.MethodPatch, "/api/pitches/1", map[string]any{"title": ""}))
}
