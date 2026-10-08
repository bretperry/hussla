// Passkey and setup routes: what a tap must prove, the setup code's limits, and a second address's first passkey.
// In the app: the setup screen, the add-a-passkey step, and every passkey prompt.
// Used by: `go test ./internal/httpapi/...`.
// Uses: the rig (harness_test.go) with the real go-webauthn checks and the virtual authenticator.

package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

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
	first := r.setupCode
	for attempt := 1; attempt < config.SetupCodeAttempts; attempt++ {
		r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": "0000-0000-0000"}))
	}
	if r.setupCode != first {
		t.Fatal("the code changed before the attempts ran out")
	}
	r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": "0000-0000-0000"}))
	if r.setupCode == first {
		t.Fatal("the code survived too many wrong tries")
	}
	r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": first}))
	// Typed loosely: lower case, no dashes.
	claimed := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": lowerNoDashes(r.setupCode)})).json(t)
	if claimed["next"] != "POST /api/passkeys/register/begin" {
		t.Fatalf("claim: %v", claimed)
	}
	// Used once.
	r.must(http.StatusConflict, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode}))
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
