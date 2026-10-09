// A fake Tailscale for end-to-end tests: a node that needs a login, a "login page" that grants it, an HTTPS switch, and a plain-HTTP tailnet listener on localhost.
// In the app: nothing. Only the end-to-end test build (`go build -tags faketailnet`, the Dockerfile's e2e target) links it; release builds can't.
// Used by: cmd/hussla/tailnet_fake.go; src/test/setup-e2e.mjs and scripts/container-smoke.sh drive it.
// Uses: net/http (its own login page), a JSON state file in the data directory.
//
// How it fakes Tailscale (the plan asks this be said):
//   - The node starts logged out. Its login link is http://<host>:<login port>/login on a tiny
//     server of its own; opening it "signs in" as owner@example.com (or ?login=<login>), the way
//     a click on tsnet's real link does.
//   - HUSSLA_FAKE_TAILNET_HTTPS=off starts with HTTPS certificates off; GET /https-on on the login
//     server turns them on, the way the switch in the admin console does.
//   - Once signed in with HTTPS on, the "tailnet" listener is plain HTTP on the tailnet port, and
//     the node's name is <host>:<tailnet port> (localhost by default). Browsers treat localhost as a
//     secure context, so passkeys work there with a virtual authenticator.
//   - WhoIs answers the signed-in user for every connection: the fake has one device and one user.
//     No header is read, here or anywhere.
//   - State (signed in, which login, HTTPS) lives in <DATA_DIR>/faketailnet.json, so a container
//     recreated with the same volume comes back signed in, as tsnet's state dir does.

package faketailnet

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
)

// ErrHTTPSOff mirrors the real adapter's: signed in, but HTTPS certificates are off.
var ErrHTTPSOff = errors.New("the tailnet has HTTPS certificates or MagicDNS turned off")

// DefaultLogin is who the login page signs in as when it isn't told.
const DefaultLogin = "owner@example.com"

const stateFile = "faketailnet.json"

// Options configure the fake. Getenv reads HUSSLA_FAKE_TAILNET_* (os.Getenv when nil).
type Options struct {
	DataDir string
	Logf    func(format string, args ...any)
	Getenv  func(string) string
}

type persisted struct {
	SignedIn bool   `json:"signedIn"`
	Login    string `json:"login"`
	HTTPS    bool   `json:"https"`
}

// Node is the fake tailnet node.
type Node struct {
	dataDir     string
	logf        func(format string, args ...any)
	host        string // the name the browser uses for both the login page and the tailnet
	tailnetPort string
	loginPort   string
	keyExpiry   time.Time

	mutex     sync.Mutex
	state     persisted
	listening bool
	changed   chan struct{}
	login     *http.Server
}

// New makes the fake without listening; Up starts its login page.
func New(options Options) *Node {
	getenv := options.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	setting := func(name, fallback string) string {
		if value := getenv(name); value != "" {
			return value
		}
		return fallback
	}
	if options.Logf == nil {
		options.Logf = func(string, ...any) {}
	}
	node := &Node{
		dataDir: options.DataDir, logf: options.Logf,
		host:        setting("HUSSLA_FAKE_TAILNET_HOST", "localhost"),
		tailnetPort: setting("HUSSLA_FAKE_TAILNET_PORT", "8443"),
		loginPort:   setting("HUSSLA_FAKE_TAILNET_LOGIN_PORT", "8445"),
		changed:     make(chan struct{}, 1),
		state:       persisted{HTTPS: getenv("HUSSLA_FAKE_TAILNET_HTTPS") != "off"},
	}
	if expiry, err := time.Parse(time.RFC3339, getenv("HUSSLA_FAKE_TAILNET_KEY_EXPIRY")); err == nil {
		node.keyExpiry = expiry
	}
	if saved, err := os.ReadFile(filepath.Join(node.dataDir, stateFile)); err == nil {
		_ = json.Unmarshal(saved, &node.state)
	}
	return node
}

// Up starts the login page (once) and waits until the node is signed in with HTTPS on.
func (node *Node) Up(ctx context.Context) error {
	if err := node.serveLogin(); err != nil {
		return err
	}
	for {
		node.mutex.Lock()
		state := node.state
		node.mutex.Unlock()
		if state.SignedIn && !state.HTTPS {
			return ErrHTTPSOff
		}
		if state.SignedIn {
			return nil
		}
		node.logf("Tailscale login needed: open %s and log in as the Tailscale user who will own Hussla", node.loginURL())
		select {
		case <-ctx.Done():
			return fmt.Errorf("join the fake tailnet: %w", ctx.Err())
		case <-node.changed:
		}
	}
}

func (node *Node) loginURL() string {
	return "http://" + net.JoinHostPort(node.host, node.loginPort) + "/login"
}

func (node *Node) serveLogin() error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if node.login != nil {
		return nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("", node.loginPort))
	if err != nil {
		return fmt.Errorf("fake tailnet login page: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		login := r.URL.Query().Get("login")
		if login == "" {
			login = DefaultLogin
		}
		node.update(func(state *persisted) { state.SignedIn, state.Login = true, login })
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprintf(w, "<!doctype html><title>Fake Tailscale</title><p id=signed-in>Signed in to the fake Tailscale as %s. Go back to the Hussla page.</p>", html.EscapeString(login))
	})
	// Browsers ask for it; an empty answer keeps a 404 out of the e2e run's console check.
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /https-on", func(w http.ResponseWriter, _ *http.Request) {
		node.update(func(state *persisted) { state.HTTPS = true })
		_, _ = w.Write([]byte("HTTPS certificates on\n"))
	})
	node.login = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = node.login.Serve(listener) }()
	return nil
}

// update changes the state, saves it, and wakes Up.
func (node *Node) update(change func(*persisted)) {
	node.mutex.Lock()
	change(&node.state)
	encoded, _ := json.Marshal(node.state)
	node.mutex.Unlock()
	_ = os.WriteFile(filepath.Join(node.dataDir, stateFile), encoded, 0o600)
	select {
	case node.changed <- struct{}{}:
	default:
	}
}

// Listener is the plain-HTTP "tailnet" listener on every interface (a container publishes it).
func (node *Node) Listener() (net.Listener, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("", node.tailnetPort))
	if err != nil {
		return nil, fmt.Errorf("fake tailnet listener: %w", err)
	}
	node.mutex.Lock()
	node.listening = true
	node.mutex.Unlock()
	return listener, nil
}

// RedirectListener: the fake has no port 80.
func (node *Node) RedirectListener() (net.Listener, error) {
	return nil, errors.New("the fake tailnet has no port 80")
}

// FunnelListener: the fake has no Funnel (the agent door's tests build its handler directly).
func (node *Node) FunnelListener(string) (net.Listener, error) {
	return nil, errors.New("the fake tailnet has no Funnel")
}

// Refresh has nothing to ask: State reads the live state.
func (node *Node) Refresh(context.Context) error { return nil }

// Logout signs the fake out; the login page signs it in again.
func (node *Node) Logout(context.Context) error {
	node.update(func(state *persisted) { state.SignedIn, state.Login = false, "" })
	return nil
}

// State is the node's progress.
func (node *Node) State() auth.TailnetState {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	switch {
	case !node.state.SignedIn:
		return auth.TailnetState{Phase: auth.TailnetNeedsLogin, AuthURL: node.loginURL()}
	case !node.state.HTTPS:
		return auth.TailnetState{Phase: auth.TailnetNeedsHTTPS, KeyExpiry: node.keyExpiry}
	case !node.listening:
		return auth.TailnetState{Phase: auth.TailnetStarting, Domain: node.domainLocked(), KeyExpiry: node.keyExpiry}
	}
	return auth.TailnetState{Phase: auth.TailnetRunning, Domain: node.domainLocked(), KeyExpiry: node.keyExpiry}
}

func (node *Node) domainLocked() string {
	if !node.state.SignedIn || !node.state.HTTPS {
		return ""
	}
	return net.JoinHostPort(node.host, node.tailnetPort)
}

// Domain is the "ts.net name": <host>:<tailnet port>.
func (node *Node) Domain() string {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.domainLocked()
}

// NodeOwner is the signed-in user.
func (node *Node) NodeOwner() auth.TailnetPeer {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.peerLocked()
}

func (node *Node) peerLocked() auth.TailnetPeer {
	if !node.state.SignedIn {
		return auth.TailnetPeer{}
	}
	sum := sha256.Sum256([]byte(strings.ToLower(node.state.Login)))
	id := strconv.FormatUint(binary.BigEndian.Uint64(sum[:8])>>1, 10)
	name, _, _ := strings.Cut(node.state.Login, "@")
	return auth.TailnetPeer{UserID: id, Login: node.state.Login, Name: name, Tailnet: FakeTailnet}
}

// FakeTailnet is the one tailnet the fake's node is ever on.
const FakeTailnet = "name:fake.example"

// WhoIs answers the signed-in user for every connection (one device, one user).
func (node *Node) WhoIs(context.Context, string) (auth.TailnetPeer, error) {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if !node.state.SignedIn {
		return auth.TailnetPeer{}, auth.ErrUnknownPeer
	}
	return node.peerLocked(), nil
}

// Close stops the login page.
func (node *Node) Close() error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if node.login != nil {
		_ = node.login.Close()
	}
	return nil
}
