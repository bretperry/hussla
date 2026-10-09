// Passkey and setup routes: what a tap must prove, the setup code's limits, and a second address's first passkey.
// In the app: the setup screen, the add-a-passkey step, and every passkey prompt.
// Used by: `go test ./internal/httpapi/...`.
// Uses: the rig (harness_test.go) with the real go-webauthn checks and the virtual authenticator.

package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
	"github.com/bretperry/hussla/internal/testsupport/virtualauthn"
)

// beginStepUp starts a prompt and returns its id and options.
func (r *rig) beginStepUp(method, path string) (string, []byte) {
	r.t.Helper()
	challenge := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/stepup/begin", map[string]string{"method": method, "path": path})).json(r.t)
	options, _ := json.Marshal(challenge["options"])
	id, _ := challenge["challengeId"].(string)
	return id, options
}

func (r *rig) finishStepUp(id string, answer []byte) reply {
	return r.do(ownerWrite(http.MethodPost, "/api/stepup/finish", map[string]any{"challengeId": id, "credential": json.RawMessage(answer)}))
}

func TestStepUpRefusesABadTap(t *testing.T) {
	r := newRig(t).enroll()

	// Signed for another site: the origin in the client data doesn't match.
	id, options := r.beginStepUp(http.MethodPatch, "/api/config")
	answer, err := r.key.Assert(options, "https://evil.example")
	if err != nil {
		t.Fatal(err)
	}
	if got := r.finishStepUp(id, answer); got.status != http.StatusForbidden {
		t.Fatalf("foreign-origin tap: %d %s", got.status, got.body)
	}

	// An authenticator the owner never registered.
	id, options = r.beginStepUp(http.MethodPatch, "/api/config")
	answer, err = virtualauthn.New().Assert(options, tailnetOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.finishStepUp(id, answer); got.status != http.StatusForbidden {
		t.Fatalf("unknown authenticator: %d %s", got.status, got.body)
	}

	// A cloned credential: the counter goes backwards.
	r.stepUp(http.MethodPatch, "/api/config") // counter 1 is now stored
	r.key.Counter = 0
	id, options = r.beginStepUp(http.MethodPatch, "/api/config")
	answer, err = r.key.Assert(options, tailnetOrigin) // counter 1 again
	if err != nil {
		t.Fatal(err)
	}
	if got := r.finishStepUp(id, answer); got.status != http.StatusForbidden {
		t.Fatalf("replayed counter: %d %s", got.status, got.body)
	}

	// A prompt is good once, and only for the caller who started it.
	r.key.Counter = 10
	id, options = r.beginStepUp(http.MethodPatch, "/api/config")
	answer, err = r.key.Assert(options, tailnetOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.finishStepUp(id, answer); got.status != http.StatusOK {
		t.Fatalf("good tap: %d %s", got.status, got.body)
	}
	if got := r.finishStepUp(id, answer); got.status != http.StatusBadRequest {
		t.Fatalf("reused prompt: %d %s", got.status, got.body)
	}
	id, options = r.beginStepUp(http.MethodPatch, "/api/config")
	answer, _ = r.key.Assert(options, tailnetOrigin)
	cookie := r.localSession()
	stolen := call{
		method: http.MethodPost, path: "/api/stepup/finish", local: true, cookie: cookie, origin: localOrigin,
		body: map[string]any{"challengeId": id, "credential": json.RawMessage(answer)},
	}
	r.must(http.StatusBadRequest, stolen)
}

func TestSetupCodeLimits(t *testing.T) {
	r := newRig(t)
	code := r.setupCode
	wrong := ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": "0000-0000-0000"})
	for attempt := 1; attempt <= config.SetupCodeAttempts; attempt++ {
		r.must(http.StatusForbidden, wrong)
	}
	if r.setupCode != code || r.announced != 1 {
		t.Fatal("wrong guesses changed the code")
	}
	// Out of tries: more wrong guesses are refused, but the right code never is (an agent sharing
	// the owner's tailnet identity must not be able to lock the owner out). Typed loosely: lower
	// case, no dashes.
	r.must(http.StatusForbidden, wrong)
	claimed := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": lowerNoDashes(code)})).json(t)
	if claimed["next"] != "POST /api/passkeys/register/begin" {
		t.Fatalf("claim: %v", claimed)
	}
	// Spent by the first stored passkey.
	stepUp, _ := claimed["stepUp"].(string)
	r.key = virtualauthn.New()
	r.registerPasskey(r.key, stepUp, tailnetOrigin, "")
	r.must(http.StatusConflict, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": code}))
}

// Another tailnet user's wrong guesses don't touch the owner's code: it stays the same and still
// works for the owner.
func TestWrongGuessesLeaveTheOwnersCode(t *testing.T) {
	r := newRig(t) // a tagged node: nobody adopted, so any untagged user may try the code
	code := r.setupCode
	guess := func(typed string) call {
		return call{method: http.MethodPost, path: "/api/setup/claim", body: map[string]string{"code": typed}, from: otherAddr, origin: tailnetOrigin}
	}
	for attempt := 1; attempt <= config.SetupCodeAttempts+3; attempt++ {
		r.must(http.StatusForbidden, guess("0000-0000-0000"))
	}
	if r.setupCode != code || r.announced != 1 {
		t.Fatal("someone else's wrong guesses replaced the owner's code")
	}
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": code}))
}

// A cancelled Face ID prompt (register/begin with no finish) can be retried with the same code;
// the code is spent only when a passkey is stored.
func TestCancelledPasskeyPromptRetriesWithTheSameCode(t *testing.T) {
	r := newRig(t)
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	claim := ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode})
	claimed := r.must(http.StatusOK, claim).json(t)
	stepUp, _ := claimed["stepUp"].(string)
	begin := ownerWrite(http.MethodPost, "/api/passkeys/register/begin", nil)
	begin.headers = map[string]string{httpapi.StepUpHeader: stepUp}
	r.must(http.StatusOK, begin) // the browser shows Face ID; the owner cancels
	r.must(http.StatusForbidden, begin)

	claimed = r.must(http.StatusOK, claim).json(t)
	stepUp, _ = claimed["stepUp"].(string)
	r.key = virtualauthn.New()
	r.registerPasskey(r.key, stepUp, tailnetOrigin, "")
	r.must(http.StatusConflict, claim)
	if r.announced != 1 {
		t.Fatalf("%d codes printed, want 1", r.announced)
	}
}

// A restart keeps the code printed before it (only its hash is stored) and says so, instead of
// printing a new one that makes the older log line wrong.
func TestSetupCodeSurvivesARestart(t *testing.T) {
	r := newRig(t)
	code := r.setupCode
	r.clock.Advance(time.Hour)
	r.restart()
	if r.announced != 1 || r.setupCode != code {
		t.Fatalf("a restart printed a new code (%d printed)", r.announced)
	}
	if len(r.reminded) != 1 || !r.reminded[0].Equal(r.clock.Now().Add(-time.Hour)) {
		t.Fatalf("reminders: %v", r.reminded)
	}
	var settings map[string]string
	if err := r.store.View(context.Background(), func(tx store.Tx) error {
		var err error
		settings, err = tx.Settings().All(context.Background())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for key, value := range settings {
		if strings.Contains(value, code) || strings.Contains(value, lowerNoDashes(code)) || strings.Contains(strings.ToUpper(value), strings.ReplaceAll(code, "-", "")) {
			t.Fatalf("setting %s holds the code itself", key)
		}
	}
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": code}))
}

// With the owner pinned, another tailnet user holding the right code is refused without spending
// it, and is never adopted as the node's owner; the pinned login (any case) still claims.
func TestPinnedOwnerLogin(t *testing.T) {
	r := newRigPinned(t, "Owner@Example.com")
	if adopted, err := r.auth.AdoptNodeOwner(context.Background(), otherPeer); err != nil || adopted {
		t.Fatalf("adopted an unpinned node owner: %v %v", adopted, err)
	}
	code := r.setupCode
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/setup/claim", body: map[string]string{"code": code}, from: otherAddr, origin: tailnetOrigin})
	if r.setupCode != code {
		t.Fatal("a refused login rotated the code")
	}
	claimed := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": code})).json(t)
	if claimed["next"] != "POST /api/passkeys/register/begin" {
		t.Fatalf("claim: %v", claimed)
	}
}

func lowerNoDashes(code string) string {
	out := make([]rune, 0, len(code))
	for _, character := range code {
		if character == '-' {
			continue
		}
		if character >= 'A' && character <= 'Z' {
			character += 'a' - 'A'
		}
		out = append(out, character)
	}
	return string(out)
}

// The local address needs its own first passkey, with the setup code from the log; then owner-only
// actions work there too.
func TestLocalAddressGetsItsOwnPasskey(t *testing.T) {
	r := newRig(t).enroll()
	cookie := r.localSession()
	id := r.newJob("Engineer")

	begin := call{method: http.MethodPost, path: "/api/stepup/begin", local: true, cookie: cookie, origin: localOrigin, body: map[string]string{"method": "DELETE", "path": "/api/jobs/" + id}}
	r.must(http.StatusConflict, begin) // no passkey for localhost yet

	laptop := virtualauthn.New()
	r.registerPasskey(laptop, r.localClaim(cookie), localOrigin, cookie)

	challenge := r.must(http.StatusOK, begin).json(t)
	options, _ := json.Marshal(challenge["options"])
	answer, err := laptop.Assert(options, localOrigin)
	if err != nil {
		t.Fatal(err)
	}
	finished := r.must(http.StatusOK, call{
		method: http.MethodPost, path: "/api/stepup/finish", local: true, cookie: cookie, origin: localOrigin,
		body: map[string]any{"challengeId": challenge["challengeId"], "credential": json.RawMessage(answer)},
	}).json(t)
	token, _ := finished["token"].(string)

	// Another session (another browser on this computer) can't finish this session's prompt.
	challenge = r.must(http.StatusOK, begin).json(t)
	options, _ = json.Marshal(challenge["options"])
	answer, err = laptop.Assert(options, localOrigin)
	if err != nil {
		t.Fatal(err)
	}
	r.must(http.StatusBadRequest, call{
		method: http.MethodPost, path: "/api/stepup/finish", local: true, cookie: r.localSession(), origin: localOrigin,
		body: map[string]any{"challengeId": challenge["challengeId"], "credential": json.RawMessage(answer)},
	})

	r.must(http.StatusOK, call{method: http.MethodDelete, path: "/api/jobs/" + id, local: true, cookie: cookie, origin: localOrigin, headers: map[string]string{httpapi.StepUpHeader: token}})

	// The tailnet passkey doesn't work on the local address (another relying party).
	passkeys := r.must(http.StatusOK, call{path: "/api/passkeys"}).body
	var list []map[string]any
	if err := json.Unmarshal(passkeys, &list); err != nil || len(list) != 2 {
		t.Fatalf("passkeys: %s", passkeys)
	}
	for _, passkey := range list {
		if _, leaked := passkey["credential"]; leaked {
			t.Fatal("a stored credential left the server")
		}
	}
}
