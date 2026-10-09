// The HTTP tests' rig: the real router and use-cases over the in-memory store, a fake tailnet, a virtual authenticator, and request helpers.
// In the app: nothing at runtime (tests only).
// Used by: every _test.go in this package.
// Uses: httpapi.New, the use-cases, the passkey adapter (the real WebAuthn checks), internal/testsupport fakes.
//
// Requests go straight into the handler (no socket), with RemoteAddr set the way the tailnet
// listener would see it, so WhoIs is answered by the fake tailnet table. Fixtures are synthetic.

package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/filestore"
	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/app/attachments"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/app/tracker"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
	"github.com/bretperry/hussla/internal/testsupport/fakeauth"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
	"github.com/bretperry/hussla/internal/testsupport/virtualauthn"
)

const (
	tailnetHost   = "hussla.tail0000.ts.net"
	tailnetOrigin = "https://" + tailnetHost
	localHost     = "localhost:8484"
	localOrigin   = "http://" + localHost

	ownerAddr  = "100.64.0.1:40001" // the owner's laptop
	otherAddr  = "100.64.0.2:40002" // someone else on the tailnet (a shared-in node, a family member)
	taggedAddr = "100.64.0.3:40003" // a tagged server under the owner's account
	offAddr    = "127.0.0.1:50000"  // not a tailnet address: loopback
)

var (
	ownerPeer  = auth.TailnetPeer{UserID: "1001", Login: "owner@example.com", Name: "Pat Owner"}
	otherPeer  = auth.TailnetPeer{UserID: "2002", Login: "guest@example.com", Name: "Guest"}
	taggedPeer = auth.TailnetPeer{UserID: "1001", Login: "tagged-devices", Tagged: true}
)

// rig is one install: shared storage and services, one handler per listener.
type rig struct {
	t         *testing.T
	store     *fakes.Store
	auth      *auth.Service
	tailnet   *fakeauth.Tailnet
	node      *fakeNode // the server's own tailnet node, for the setup pages
	signIn    *fakeauth.SignInTokens
	clock     *fakeauth.Clock
	setupCode string
	announced int         // setup codes printed so far
	reminded  []time.Time // restarts that found a live code (its issue time)
	ownerPin  string
	deps      httpapi.Deps
	tailnetUI http.Handler
	localUI   http.Handler
	key       *virtualauthn.Authenticator
}

func newRig(t *testing.T) *rig { return newRigPinned(t, "") }

// newRigPinned is newRig with the owner pinned to one tailnet login (HUSSLA_OWNER_LOGIN).
func newRigPinned(t *testing.T, ownerLogin string) *rig {
	t.Helper()
	r := &rig{
		t: t, store: fakes.New(), tailnet: fakeauth.NewTailnet(), signIn: &fakeauth.SignInTokens{},
		node:  &fakeNode{state: auth.TailnetState{Phase: auth.TailnetRunning, Domain: tailnetHost}},
		clock: fakeauth.NewClock(time.Date(2026, 10, 8, 15, 0, 0, 0, time.UTC)),
	}
	r.tailnet.Add(ownerAddr, ownerPeer)
	r.tailnet.Add(otherAddr, otherPeer)
	r.tailnet.Add(taggedAddr, taggedPeer)
	r.ownerPin = ownerLogin
	dir := t.TempDir()
	blobs, err := filestore.NewBlobs(filepath.Join(dir, "files"))
	if err != nil {
		t.Fatal(err)
	}
	resumes, err := filestore.NewResumes(filepath.Join(dir, "resumes"))
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation(config.MailTimeZone)
	if err != nil {
		t.Fatal(err)
	}
	r.deps = httpapi.Deps{
		Tracker:     tracker.New(r.store, r.clock.Now),
		Mail:        mailbox.New(mailbox.Options{Store: r.store, Location: location, Now: r.clock.Now}),
		Attachments: attachments.New(r.store, blobs, resumes, config.UploadMaxBytes, r.clock.Now),
		AgentsGuide: "# guide",
	}
	return r.restart()
}

// restart is a new process over the same storage: a fresh auth use-case (nothing kept in memory)
// and fresh handlers, then the startup setup-code step.
func (r *rig) restart() *rig {
	r.t.Helper()
	r.auth = auth.New(auth.Options{
		Store: r.store, Ceremony: passkey.Ceremony{}, SignIn: r.signIn, Now: r.clock.Now,
		AnnounceSetupCode: func(code string) { r.setupCode = code; r.announced++ },
		RemindSetupCode:   func(issuedAt time.Time) { r.reminded = append(r.reminded, issuedAt) },
		OwnerLogin:        r.ownerPin,
		Node:              r.node,
	})
	r.deps.Auth = r.auth
	r.deps.Setup = setup.New(setup.Options{Auth: r.auth, Tailnet: r.node, Store: r.store, Now: r.clock.Now})
	r.tailnetUI = httpapi.New(httpapi.Config{Listener: httpapi.ListenerTailnet, Hosts: []string{tailnetHost}, Peers: r.tailnet}, r.deps)
	r.localUI = httpapi.New(httpapi.Config{Listener: httpapi.ListenerLocal, Hosts: []string{localHost, "127.0.0.1:8484"}}, r.deps)
	if err := r.auth.IssueSetupCode(context.Background()); err != nil {
		r.t.Fatal(err)
	}
	return r
}

// fakeNode is the server's own tailnet node as the setup pages see it: a settable state and
// owner (none unless a test sets one), and a Logout that records itself.
type fakeNode struct {
	mutex   sync.Mutex
	state   auth.TailnetState
	owner   auth.TailnetPeer
	logouts int
}

func (node *fakeNode) NodeOwner() auth.TailnetPeer {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.owner
}

func (node *fakeNode) setOwner(owner auth.TailnetPeer) {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.owner = owner
}

func (node *fakeNode) State() auth.TailnetState {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.state
}

func (node *fakeNode) set(state auth.TailnetState) {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.state = state
}

func (node *fakeNode) Logout(context.Context) error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.logouts++
	node.owner = auth.TailnetPeer{}
	node.state = auth.TailnetState{Phase: auth.TailnetNeedsLogin, AuthURL: "https://login.example/a/next"}
	return nil
}

// call is one request; the zero value is a GET from the owner's laptop on the tailnet with no Origin.
type call struct {
	method  string
	path    string
	body    any // marshaled as JSON unless []byte
	from    string
	host    string
	origin  string
	headers map[string]string
	local   bool   // send to the local listener
	cookie  string // the local session cookie's value
}

type reply struct {
	status int
	header http.Header
	body   []byte
}

func (r reply) json(t *testing.T) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(r.body, &decoded); err != nil {
		t.Fatalf("response is not a JSON object (%d): %s", r.status, r.body)
	}
	return decoded
}

func (r reply) code() string {
	var decoded struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.body, &decoded)
	return decoded.Code
}

func (r *rig) do(c call) reply {
	r.t.Helper()
	if c.method == "" {
		c.method = http.MethodGet
	}
	var body io.Reader
	switch value := c.body.(type) {
	case nil:
	case []byte:
		body = bytes.NewReader(value)
	case string:
		body = strings.NewReader(value)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			r.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(c.method, c.path, body)
	handler := r.tailnetUI
	request.Host, request.RemoteAddr = tailnetHost, ownerAddr
	if c.local {
		handler = r.localUI
		request.Host, request.RemoteAddr = localHost, offAddr
	}
	if c.host != "" {
		request.Host = c.host
	}
	if c.from != "" {
		request.RemoteAddr = c.from
	}
	if c.origin != "" {
		request.Header.Set("Origin", c.origin)
	}
	if c.body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.cookie != "" {
		request.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: c.cookie})
	}
	for name, value := range c.headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	result := recorder.Result()
	defer func() { _ = result.Body.Close() }()
	raw, _ := io.ReadAll(result.Body)
	return reply{status: result.StatusCode, header: result.Header, body: raw}
}

// must runs a request and fails the test unless it answers `want`.
func (r *rig) must(want int, c call) reply {
	r.t.Helper()
	got := r.do(c)
	if got.status != want {
		r.t.Fatalf("%s %s: status %d, want %d: %s", c.method, c.path, got.status, want, got.body)
	}
	return got
}

// ownerWrite is a write from the owner's browser on the tailnet (Origin set).
func ownerWrite(method, path string, body any) call {
	return call{method: method, path: path, body: body, origin: tailnetOrigin}
}

// enroll makes the owner (the node's owning user), registers their passkey with the setup code,
// and returns the rig ready for owner-only actions.
func (r *rig) enroll() *rig {
	r.t.Helper()
	ctx := context.Background()
	if _, err := r.auth.AdoptNodeOwner(ctx, ownerPeer); err != nil {
		r.t.Fatal(err)
	}
	claimed := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode})).json(r.t)
	stepUp, _ := claimed["stepUp"].(string)
	r.key = virtualauthn.New()
	r.registerPasskey(r.key, stepUp, tailnetOrigin, "")
	return r
}

// registerPasskey runs register/begin (with a step-up token) and finish with the authenticator;
// cookie is the local session (empty on the tailnet).
func (r *rig) registerPasskey(key *virtualauthn.Authenticator, stepUp, origin string, cookie string) {
	r.t.Helper()
	local := cookie != ""
	begin := ownerWrite(http.MethodPost, "/api/passkeys/register/begin", nil)
	begin.origin, begin.local, begin.cookie = origin, local, cookie
	begin.headers = map[string]string{httpapi.StepUpHeader: stepUp}
	challenge := r.must(http.StatusOK, begin).json(r.t)
	options, _ := json.Marshal(challenge["options"])
	credential, err := key.Register(options, origin)
	if err != nil {
		r.t.Fatal(err)
	}
	finish := ownerWrite(http.MethodPost, "/api/passkeys/register/finish", map[string]any{
		"challengeId": challenge["challengeId"], "name": "Laptop", "credential": json.RawMessage(credential),
	})
	finish.origin, finish.local, finish.cookie = origin, local, cookie
	r.must(http.StatusCreated, finish)
}

// stepUp taps the owner's passkey for one action and returns the token.
func (r *rig) stepUp(method, path string) string {
	r.t.Helper()
	challenge := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/stepup/begin", map[string]string{"method": method, "path": path})).json(r.t)
	options, _ := json.Marshal(challenge["options"])
	answer, err := r.key.Assert(options, tailnetOrigin)
	if err != nil {
		r.t.Fatal(err)
	}
	finished := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/stepup/finish", map[string]any{
		"challengeId": challenge["challengeId"], "credential": json.RawMessage(answer),
	})).json(r.t)
	token, _ := finished["token"].(string)
	if token == "" {
		r.t.Fatalf("step-up gave no token: %v", finished)
	}
	return token
}

// ownerStepUp is an owner write carrying a fresh step-up token for exactly that action.
func (r *rig) ownerStepUp(method, path string, body any) call {
	r.t.Helper()
	request := ownerWrite(method, path, body)
	request.headers = map[string]string{httpapi.StepUpHeader: r.stepUp(method, strings.SplitN(path, "?", 2)[0])}
	return request
}

// agentKey creates an agent key (as the owner, with a tap) and returns its secret.
func (r *rig) agentKey(name string) string {
	r.t.Helper()
	created := r.must(http.StatusCreated, r.ownerStepUp(http.MethodPost, "/api/tokens", map[string]string{"name": name})).json(r.t)
	secret, _ := created["token"].(string)
	if !strings.HasPrefix(secret, auth.AgentKeyPrefix) {
		r.t.Fatalf("no key in %v", created)
	}
	return secret
}

// asAgent is a request with an agent key, from off the tailnet's owner identity unless `from` says otherwise.
func asAgent(secret, method, path string, body any) call {
	return call{method: method, path: path, body: body, from: offAddr, headers: map[string]string{"Authorization": "Bearer " + secret}}
}

// newJob creates a job as the owner and returns its id.
func (r *rig) newJob(title string) string {
	r.t.Helper()
	created := r.must(http.StatusCreated, ownerWrite(http.MethodPost, "/api/jobs", map[string]any{"company": "Example Co", "title": title})).json(r.t)
	id, _ := created["id"].(string)
	return id
}

// sessionCookie is the session cookie a response set ("" when none).
func sessionCookie(response reply) string {
	for _, cookie := range (&http.Response{Header: response.header}).Cookies() {
		if cookie.Name == httpapi.SessionCookie {
			return cookie.Value
		}
	}
	return ""
}

// localSession signs in on the local listener with a fresh `hussla open` token and returns the cookie.
func (r *rig) localSession() string {
	r.t.Helper()
	r.signIn.Put("local-token-"+r.clock.Now().Format(time.RFC3339Nano), r.clock.Now().Add(config.SignInTokenLifetime))
	token, _ := r.signIn.Read(context.Background())
	response := r.do(call{path: "/signin?t=" + token.Secret, local: true})
	cookie := sessionCookie(response)
	if response.status != http.StatusSeeOther || cookie == "" {
		r.t.Fatalf("local sign-in: %d %s", response.status, response.body)
	}
	r.clock.Advance(time.Millisecond)
	return cookie
}

// localClaim spends a setup code from the local session (the setup screen issues one when this
// address has no passkey) and returns the step-up token for registering a passkey here.
func (r *rig) localClaim(cookie string) string {
	r.t.Helper()
	r.must(http.StatusOK, call{path: "/api/setup", local: true, cookie: cookie})
	claimed := r.must(http.StatusOK, call{method: http.MethodPost, path: "/api/setup/claim", local: true, cookie: cookie, origin: localOrigin, body: map[string]string{"code": r.setupCode}}).json(r.t)
	token, _ := claimed["stepUp"].(string)
	return token
}
