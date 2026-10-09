// The first run through the real router: the home-network page's checks and states, Start over, the first-run link, who the setup pages name, the wizard, and mail setup that never gives the password back.
// In the app: a NAS owner's first visit to http://<NAS>:8484, then the wizard on the ts.net address.
// Used by: `go test ./internal/httpapi/...`.
// Uses: the rig (harness_test.go) with its fake tailnet node; fakes for the mail secret store and sender.

package httpapi_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/mailbox"
	"github.com/bretperry/hussla/internal/app/mailsetup"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/httpapi"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
	"github.com/bretperry/hussla/internal/testsupport/virtualauthn"
)

const homeHost = "192.168.1.20:8484"

// homeCall is one request to the home-network page from a laptop on the home network.
func (r *rig) home(method, path, host, from, origin string) (int, string) {
	r.t.Helper()
	status, _, body := r.homeFull(method, path, host, from, origin)
	return status, body
}

// homeFull is home with the response headers too (the Location of a redirect).
func (r *rig) homeFull(method, path, host, from, origin string) (int, http.Header, string) {
	r.t.Helper()
	request := httptest.NewRequest(method, path, nil)
	request.Host, request.RemoteAddr = host, from
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	recorder := httptest.NewRecorder()
	httpapi.NewHome(r.deps.Setup).ServeHTTP(recorder, request)
	result := recorder.Result()
	defer func() { _ = result.Body.Close() }()
	body, _ := io.ReadAll(result.Body)
	return result.StatusCode, result.Header, string(body)
}

// makeItMine presses the home-network page's button and returns the first-run link's secret.
func (r *rig) makeItMine(from string) string {
	r.t.Helper()
	status, header, body := r.homeFull(http.MethodPost, "/make-it-mine", homeHost, from, "http://"+homeHost)
	location := header.Get("Location")
	if status != http.StatusSeeOther || !strings.HasPrefix(location, tailnetOrigin+"/setup?link=") {
		r.t.Fatalf("make it mine: %d to %q\n%s", status, location, body)
	}
	target, err := url.Parse(location)
	if err != nil {
		r.t.Fatal(err)
	}
	return target.Query().Get("link")
}

func TestHomePageAnswersOnlyTheHomeNetwork(t *testing.T) {
	r := newRig(t)
	cases := []struct {
		host, from string
		want       int
	}{
		{homeHost, "192.168.1.30:51000", http.StatusOK},
		{"nas:8484", "10.0.0.7:51000", http.StatusOK},
		{"diskstation.local:8484", "172.16.4.2:51000", http.StatusOK},
		{"localhost:8484", "127.0.0.1:51000", http.StatusOK},
		{"[fd00::20]:8484", "[fd00::30]:51000", http.StatusOK},
		{"evil.example", "192.168.1.30:51000", http.StatusMisdirectedRequest},           // DNS rebinding
		{"evil.example:8484", "192.168.1.30:51000", http.StatusMisdirectedRequest},      // with a port
		{"8.8.8.8:8484", "192.168.1.30:51000", http.StatusMisdirectedRequest},           // a public address as Host
		{"hussla.tail0000.ts.net", "192.168.1.30:51000", http.StatusMisdirectedRequest}, // a dotted name that isn't .local
		{homeHost, "203.0.113.9:51000", http.StatusForbidden},                           // a public source
		{homeHost, "100.64.0.1:51000", http.StatusForbidden},                            // CGNAT isn't the home network
	}
	for _, test := range cases {
		if status, body := r.home(http.MethodGet, "/", test.host, test.from, ""); status != test.want {
			t.Errorf("Host %s from %s: %d, want %d: %.80s", test.host, test.from, status, test.want, body)
		}
	}
}

func TestHomePageWalksTheTailnetStatesWithoutARestart(t *testing.T) {
	r := newRig(t)
	from := "192.168.1.30:51000"

	r.node.set(auth.TailnetState{Phase: auth.TailnetNeedsLogin, AuthURL: "https://login.tailscale.com/a/abc123"})
	_, body := r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, `href="https://login.tailscale.com/a/abc123"`) || !strings.Contains(body, "Connect to Tailscale") {
		t.Fatalf("needs login: no Connect button:\n%s", body)
	}
	if strings.Contains(body, "Setup code") || strings.Contains(body, r.setupCode) {
		t.Fatal("the home page shows the setup code")
	}

	// Device approval on: the page says to approve this machine, with the Machines link.
	r.node.set(auth.TailnetState{Phase: auth.TailnetNeedsApproval})
	_, body = r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, "Waiting for approval") || !strings.Contains(body, config.TailscaleAdminMachines) {
		t.Fatalf("needs approval: no approval step:\n%s", body)
	}

	// HTTPS certificates off: the one switch, with the admin link.
	r.node.set(auth.TailnetState{Phase: auth.TailnetNeedsHTTPS})
	_, body = r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, "One switch to flip") || !strings.Contains(body, config.TailscaleAdminDNS) || !strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("needs HTTPS: no switch, admin link or refresh:\n%s", body)
	}

	// The owner flips it; the same server, with no restart, shows the address and the first-run link.
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	r.node.set(auth.TailnetState{Phase: auth.TailnetRunning, Domain: tailnetHost})
	_, body = r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, tailnetOrigin) || !strings.Contains(body, "<svg") || !strings.Contains(body, ownerPeer.Login) {
		t.Fatalf("running: no address, QR or owner:\n%s", body)
	}
	// The page shows a button, never the link: a GET holds no first-run secret.
	if !strings.Contains(body, `action="/make-it-mine"`) || strings.Contains(body, "link=") {
		t.Fatalf("running: want the Make it mine form and no link:\n%s", body)
	}
	if csp := r.homeCSP(from); !strings.Contains(csp, "form-action 'self' "+tailnetOrigin) {
		t.Fatalf("the page's CSP must let the form redirect to the tailnet address: %s", csp)
	}
	// Only a form post from this page mints one.
	for _, origin := range []string{"", "http://evil.example"} {
		if code, _ := r.home(http.MethodPost, "/make-it-mine", homeHost, from, origin); code != http.StatusForbidden {
			t.Fatalf("make it mine with Origin %q: %d", origin, code)
		}
	}
	secret := r.makeItMine(from)

	// The link adds the first passkey on the tailnet, for the node's owner only.
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/setup/claim", body: map[string]string{"link": secret}, from: otherAddr, origin: tailnetOrigin})
	claimed := r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"link": secret})).json(t)
	stepUp, _ := claimed["stepUp"].(string)
	r.key = virtualauthn.New()
	r.registerPasskey(r.key, stepUp, tailnetOrigin, "")

	// Set up: the page stops refreshing, drops the link and Start over.
	_, body = r.home(http.MethodGet, "/", homeHost, from, "")
	if strings.Contains(body, "make-it-mine") || strings.Contains(body, "start-over") || strings.Contains(body, `http-equiv="refresh"`) {
		t.Fatalf("after setup the page still offers setup:\n%s", body)
	}
	r.must(http.StatusConflict, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"link": secret}))
	if code, _ := r.home(http.MethodPost, "/make-it-mine", homeHost, from, "http://"+homeHost); code != http.StatusConflict {
		t.Fatalf("make it mine after setup: %d", code)
	}
}

// homeCSP is the home page's Content-Security-Policy as a GET from the home network sees it.
func (r *rig) homeCSP(from string) string {
	r.t.Helper()
	_, header, _ := r.homeFull(http.MethodGet, "/", homeHost, from, "")
	return header.Get("Content-Security-Policy")
}

func TestNoGetEverShowsTheFirstRunLink(t *testing.T) {
	r := newRig(t)
	from := "192.168.1.30:51000"
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	secret := r.makeItMine(from)
	for _, path := range []string{"/", "/home.css", "/healthz"} {
		if _, body := r.home(http.MethodGet, path, homeHost, from, ""); strings.Contains(body, secret) || strings.Contains(body, "link=") {
			t.Fatalf("GET %s shows the first-run link:\n%s", path, body)
		}
	}
	if body := string(r.must(http.StatusOK, call{path: "/api/setup"}).body); strings.Contains(body, secret) {
		t.Fatalf("GET /api/setup shows the first-run link: %s", body)
	}
}

func TestARestartDoesNotReopenTheFirstRunWindow(t *testing.T) {
	r := newRig(t)
	from := "192.168.1.30:51000"
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(config.FirstRunWindow + time.Second)
	r.restart()
	_, body := r.home(http.MethodGet, "/", homeHost, from, "")
	if strings.Contains(body, "make-it-mine") || !strings.Contains(body, "timed out") || strings.Contains(body, "Restart Hussla") {
		t.Fatalf("after the window and a restart: want timed out, no button, no restart advice:\n%s", body)
	}
	if code, _ := r.home(http.MethodPost, "/make-it-mine", homeHost, from, "http://"+homeHost); code != http.StatusConflict {
		t.Fatalf("make it mine after a restart past the window: %d", code)
	}
	// The setup code from the log still works.
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode}))
}

func TestANodeSignedInAsSomeoneElseFailsClosed(t *testing.T) {
	r := newRig(t).enroll()
	from := "192.168.1.30:51000"
	guarded := httpapi.GuardNodeOwner(r.deps.Setup, r.tailnetUI)
	serve := func(method, path, remote string) (int, string) {
		request := httptest.NewRequest(method, path, nil)
		request.Host, request.RemoteAddr = tailnetHost, remote
		request.Header.Set("Origin", tailnetOrigin)
		recorder := httptest.NewRecorder()
		guarded.ServeHTTP(recorder, request)
		return recorder.Code, recorder.Body.String()
	}
	r.node.setOwner(ownerPeer)
	if code, _ := serve(http.MethodGet, "/api/me", ownerAddr); code != http.StatusOK {
		t.Fatalf("the owner's own node: %d", code)
	}
	// While the node is logged in as its owner, Reconnect does nothing.
	if code, _ := r.home(http.MethodPost, "/reconnect", homeHost, from, "http://"+homeHost); code != http.StatusConflict || r.node.logouts != 0 {
		t.Fatalf("reconnect on a healthy node: %d, %d logouts", code, r.node.logouts)
	}

	// The key expired; someone on the home network signed the node in with their own account.
	r.node.setOwner(otherPeer)
	agent := r.agentKey("Helper")
	for _, request := range []struct{ method, path, from string }{
		{http.MethodGet, "/", otherAddr},
		{http.MethodGet, "/api/setup", otherAddr},
		{http.MethodGet, "/api/me", ownerAddr},
		{http.MethodPost, "/api/setup/code", otherAddr},
		{http.MethodPost, "/api/jobs", ownerAddr},
	} {
		code, body := serve(request.method, request.path, request.from)
		if code != http.StatusForbidden || !strings.Contains(body, "belongs to someone else") {
			t.Fatalf("%s %s on a node signed in as someone else: %d %.120s", request.method, request.path, code, body)
		}
	}
	keyed := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	keyed.Host, keyed.RemoteAddr = tailnetHost, otherAddr
	keyed.Header.Set("Authorization", "Bearer "+agent)
	recorder := httptest.NewRecorder()
	guarded.ServeHTTP(recorder, keyed)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("an agent key on a node signed in as someone else: %d", recorder.Code)
	}

	// The home-network page says so and offers the way back, without Start over or the address.
	_, body := r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, `action="/reconnect"`) || strings.Contains(body, "start-over") || strings.Contains(body, `id="address"`) {
		t.Fatalf("home page on a node signed in as someone else:\n%s", body)
	}
	if code, _ := r.home(http.MethodPost, "/reconnect", homeHost, from, ""); code != http.StatusForbidden {
		t.Fatalf("reconnect from another site: %d", code)
	}
	if code, _ := r.home(http.MethodPost, "/reconnect", homeHost, from, "http://"+homeHost); code != http.StatusSeeOther || r.node.logouts != 1 {
		t.Fatalf("reconnect: %d, %d logouts", code, r.node.logouts)
	}
	// Logged out: the re-login link is there for the owner, and the owner record and passkey stayed.
	_, body = r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, "https://login.example/a/next") {
		t.Fatalf("after reconnect, no Connect link:\n%s", body)
	}
	if login, err := r.auth.OwnerLogin(context.Background()); err != nil || login != ownerPeer.Login {
		t.Fatalf("owner after reconnect: %q %v", login, err)
	}
	r.node.set(auth.TailnetState{Phase: auth.TailnetRunning, Domain: tailnetHost})
	r.node.setOwner(ownerPeer)
	if code, _ := serve(http.MethodGet, "/api/me", ownerAddr); code != http.StatusOK {
		t.Fatalf("the owner signed back in: %d", code)
	}
}

func TestHomePageSaysWhenTheLinkTimedOut(t *testing.T) {
	r := newRig(t)
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(config.FirstRunWindow + time.Second)
	_, body := r.home(http.MethodGet, "/", homeHost, "192.168.1.30:51000", "")
	if strings.Contains(body, "make-it-mine") || !strings.Contains(body, "timed out") {
		t.Fatalf("after the window: %s", body)
	}
}

func TestStartOverReleasesTheOwnerOnlyBeforeAPasskey(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	from := "192.168.1.30:51000"
	if _, err := r.auth.AdoptNodeOwner(ctx, otherPeer); err != nil { // the neighbor clicked Connect first
		t.Fatal(err)
	}
	// Every setup page names who it belongs to; the owner sees whose login they are.
	status := r.must(http.StatusOK, call{path: "/api/setup"}).json(t)
	if status["ownerLogin"] != otherPeer.Login || status["seenLogin"] != ownerPeer.Login || status["isOwner"] != false {
		t.Fatalf("setup status names %v, saw %v", status["ownerLogin"], status["seenLogin"])
	}
	// A form post from another site (or none) is refused.
	if code, _ := r.home(http.MethodPost, "/start-over", homeHost, from, ""); code != http.StatusForbidden {
		t.Fatalf("start over with no Origin: %d", code)
	}
	if code, _ := r.home(http.MethodPost, "/start-over", homeHost, from, "http://evil.example"); code != http.StatusForbidden {
		t.Fatalf("start over from another site: %d", code)
	}
	if code, _ := r.home(http.MethodPost, "/start-over", homeHost, from, "http://"+homeHost); code != http.StatusSeeOther {
		t.Fatalf("start over: %d", code)
	}
	if enrolled, _ := r.auth.Enrolled(ctx); enrolled || r.node.logouts != 1 {
		t.Fatalf("after start over: enrolled %v, logouts %d", enrolled, r.node.logouts)
	}
	_, body := r.home(http.MethodGet, "/", homeHost, from, "")
	if !strings.Contains(body, "https://login.example/a/next") {
		t.Fatalf("after start over, no new Connect link:\n%s", body)
	}
	// The right person connects and adds a passkey; Start over is gone for good.
	r.node.set(auth.TailnetState{Phase: auth.TailnetRunning, Domain: tailnetHost})
	r.enroll()
	if code, body := r.home(http.MethodPost, "/start-over", homeHost, from, "http://"+homeHost); code != http.StatusConflict || !strings.Contains(body, "already has a passkey") {
		t.Fatalf("start over after a passkey: %d\n%s", code, body)
	}
	if r.node.logouts != 1 {
		t.Fatal("start over after a passkey logged the node out")
	}
}

func TestANewSetupCodeOnRequest(t *testing.T) {
	r := newRig(t)
	if _, err := r.auth.AdoptNodeOwner(context.Background(), ownerPeer); err != nil {
		t.Fatal(err)
	}
	lost := r.setupCode
	r.must(http.StatusForbidden, call{method: http.MethodPost, path: "/api/setup/code", from: otherAddr, origin: tailnetOrigin})
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/code", nil))
	if r.setupCode == lost || r.announced != 2 {
		t.Fatalf("no new code printed (%d)", r.announced)
	}
	r.must(http.StatusTooManyRequests, ownerWrite(http.MethodPost, "/api/setup/code", nil))
	r.must(http.StatusForbidden, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": lost}))
	r.must(http.StatusOK, ownerWrite(http.MethodPost, "/api/setup/claim", map[string]string{"code": r.setupCode}))
}

func TestWizardProgressAndKeyExpiry(t *testing.T) {
	r := newRig(t)
	expires := r.clock.Now().Add(10 * 24 * time.Hour)
	r.node.set(auth.TailnetState{Phase: auth.TailnetRunning, Domain: tailnetHost, KeyExpiry: expires})
	r.enroll()
	status := r.must(http.StatusOK, call{path: "/api/setup"}).json(t)
	expiry, _ := status["keyExpiry"].(map[string]any)
	if expiry["warn"] != true || expiry["daysLeft"] != float64(10) {
		t.Fatalf("key expiry: %v", status["keyExpiry"])
	}
	r.must(http.StatusOK, ownerWrite(http.MethodPatch, "/api/setup/wizard", map[string]string{"step": "phone", "state": "done"}))
	r.must(http.StatusOK, ownerWrite(http.MethodPatch, "/api/setup/wizard", map[string]string{"step": "phone", "state": "done"})) // a retry
	r.must(http.StatusBadRequest, ownerWrite(http.MethodPatch, "/api/setup/wizard", map[string]string{"step": "nope", "state": "done"}))
	r.must(http.StatusForbidden, call{method: http.MethodPatch, path: "/api/setup/wizard", body: map[string]string{"step": "mail", "state": "done"}, from: otherAddr, origin: tailnetOrigin})
	// A restart keeps the progress.
	r.restart()
	wizard, _ := r.must(http.StatusOK, call{path: "/api/setup"}).json(t)["wizard"].(map[string]any)
	steps, _ := wizard["steps"].(map[string]any)
	if steps["phone"] != "done" || len(steps) != 1 || wizard["finished"] != false {
		t.Fatalf("wizard after a restart: %v", wizard)
	}
	qr := r.must(http.StatusOK, call{path: "/api/setup/qr"})
	if !strings.HasPrefix(string(qr.body), "<svg") || qr.header.Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("qr: %s %.40s", qr.header.Get("Content-Type"), qr.body)
	}
}

func TestMailSetupNeverGivesThePasswordBack(t *testing.T) {
	r := newRig(t)
	sender := &fakes.MailSender{}
	mailSetup := mailsetup.NewService(mailsetup.Dependencies{
		Store: r.store, Secrets: &fakes.SecretStore{}, Now: r.clock.Now,
		Factory: func(mailsetup.Connection) (mailsetup.MailSender, error) { return sender, nil },
	})
	location, _ := time.LoadLocation(config.MailTimeZone)
	r.deps.MailSetup = mailSetup
	r.deps.Mail = mailbox.New(mailbox.Options{Store: r.store, Location: location, Now: r.clock.Now, Mailer: mailbox.SetupMailer{Setup: mailSetup}})
	r.restart()
	r.enroll()
	const password = "abcd-efgh-ijkl-mnop"

	providers := r.must(http.StatusOK, call{path: "/api/mail/providers"})
	if !strings.Contains(string(providers.body), `"icloud"`) {
		t.Fatalf("catalog: %.200s", providers.body)
	}
	save := map[string]any{"providerId": "icloud", "username": "pat@example.com", "fromAddress": "pat@example.com", "fromName": "Pat Owner", "secret": password}
	r.must(http.StatusForbidden, ownerWrite(http.MethodPut, "/api/mail/settings", save)) // no passkey tap
	saved := r.must(http.StatusOK, r.ownerStepUp(http.MethodPut, "/api/mail/settings", save))
	got := r.must(http.StatusOK, call{path: "/api/mail/settings"})
	for _, body := range [][]byte{saved.body, got.body} {
		if strings.Contains(string(body), password) || !strings.Contains(string(body), `"hasSecret":true`) {
			t.Fatalf("mail settings answer: %s", body)
		}
	}
	r.must(http.StatusOK, r.ownerStepUp(http.MethodPost, "/api/mail/test", nil))
	delivered := sender.Delivered()
	if len(delivered) != 1 || delivered[0].Message.To[0] != "pat@example.com" {
		t.Fatalf("test email: %+v", delivered)
	}
	status := r.must(http.StatusOK, call{path: "/api/mail"}).json(t)
	if status["configured"] != true || status["provider"] != "iCloud Mail" {
		t.Fatalf("mail status: %v", status)
	}
}
