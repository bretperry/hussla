// Embedded Tailscale: the node Hussla runs as on the owner's tailnet, its HTTPS listener, its join state, and WhoIs for every connection.
// In the app: https://hussla.<tailnet>.ts.net from the owner's phone and laptop, with no password.
// Used by: cmd/hussla (New, Up and Listener in its retry loop; the node as auth.PeerIdentifier; NodeOwner after joining).
// Uses: tailscale.com/tsnet (pinned exactly in go.mod).
//
// Identity comes from the connection only: WhoIs asks the embedded node which tailnet peer owns the
// remote address of this TCP connection. No header is read here or anywhere. The node's state lives
// in <DATA_DIR>/tailscale, so the same node (and certificate name) comes back after a restart; the
// auth key is used only for the first join.
//
// Up can be called again after it fails: that is how a headless server recovers from a tailnet
// with HTTPS off (the owner flips the switch, the next Up sees the certificate name) without a
// restart. While Up waits for a login it records tsnet's login link in State and logs it once per
// new link (tsnet itself repeats it every few seconds; that line is dropped).

package tailnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"

	"github.com/bretperry/hussla/internal/app/auth"
)

// ErrHTTPSOff: the node is on the tailnet but has no HTTPS certificate name (HTTPS certificates
// or MagicDNS are off in the tailnet's DNS settings). Up again after they are turned on.
var ErrHTTPSOff = errors.New("the tailnet has HTTPS certificates or MagicDNS turned off")

// tsnetLoginLine starts tsnet's own repeated login-link line, which this adapter replaces with one
// line per new link.
const tsnetLoginLine = "To start this tsnet server"

// Options configure the node.
type Options struct {
	DataDir  string
	Hostname string // the MagicDNS name, "hussla" by default
	AuthKey  string // TS_AUTHKEY; only needed the first time
	Logf     func(format string, args ...any)
}

// Node is the tailnet node. Its methods are safe for concurrent use.
type Node struct {
	options Options

	mutex   sync.Mutex
	server  *tsnet.Server // nil until Up starts one, and again after a failed start
	client  *local.Client
	domain  string
	owner   auth.TailnetPeer
	state   auth.TailnetState
	lastURL string // the login link last logged
	// listening is true once Listener opened the HTTPS listener; Refresh reports Running only then.
	listening bool
}

var _ auth.TailnetStatus = (*Node)(nil)

// New makes the node without touching the network; Up joins.
func New(options Options) *Node {
	if options.Logf == nil {
		options.Logf = func(string, ...any) {}
	}
	return &Node{options: options}
}

// Up joins the tailnet and waits until the node runs (recording the login link while it waits for
// one), then reads its certificate name and owner. ErrHTTPSOff when the tailnet gives no
// certificate name; any other error leaves the node ready for another Up.
func (node *Node) Up(ctx context.Context) error {
	client, err := node.start()
	if err != nil {
		return err
	}
	watcher, err := client.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		node.discard()
		return fmt.Errorf("join the tailnet: %w", err)
	}
	defer func() { _ = watcher.Close() }()
	for {
		notify, err := watcher.Next()
		if err != nil {
			if ctx.Err() == nil {
				node.discard()
			}
			return fmt.Errorf("join the tailnet: %w", err)
		}
		if notify.ErrMessage != nil {
			node.discard()
			return fmt.Errorf("join the tailnet: %s", *notify.ErrMessage)
		}
		if !node.observe(notify) {
			continue
		}
		status, err := client.Status(ctx)
		if err != nil {
			return fmt.Errorf("tailnet status: %w", err)
		}
		return node.running(status)
	}
}

// start makes and starts the tsnet server when there is none (tsnet remembers a failed start, so a
// retry needs a fresh one).
func (node *Node) start() (*local.Client, error) {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if node.client != nil {
		return node.client, nil
	}
	userLogf := node.options.Logf
	server := &tsnet.Server{
		Dir:      filepath.Join(node.options.DataDir, "tailscale"),
		Hostname: node.options.Hostname,
		AuthKey:  node.options.AuthKey,
		UserLogf: func(format string, args ...any) {
			if !strings.HasPrefix(format, tsnetLoginLine) {
				userLogf(format, args...)
			}
		},
	}
	client, err := server.LocalClient() // starts the server
	if err != nil {
		_ = server.Close()
		return nil, fmt.Errorf("start the tailnet node: %w", err)
	}
	node.server, node.client = server, client
	node.state = auth.TailnetState{Phase: auth.TailnetStarting}
	return client, nil
}

// discard closes a server that failed, so the next Up starts a fresh one.
func (node *Node) discard() {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if node.server != nil {
		_ = node.server.Close()
	}
	node.server, node.client = nil, nil
	node.state = auth.TailnetState{Phase: auth.TailnetStarting}
}

// observe records what one bus message says and reports whether the node is now running. A login
// link is logged once per new link.
func (node *Node) observe(notify ipn.Notify) (running bool) {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if notify.BrowseToURL != nil && *notify.BrowseToURL != "" {
		url := *notify.BrowseToURL
		node.state = auth.TailnetState{Phase: auth.TailnetNeedsLogin, AuthURL: url}
		if url != node.lastURL {
			node.lastURL = url
			node.options.Logf("Tailscale login needed: open %s and log in as the Tailscale user who will own Hussla", url)
		}
	}
	if notify.State == nil {
		return false
	}
	switch *notify.State {
	case ipn.Running:
		return true
	case ipn.NeedsLogin:
		if node.state.Phase != auth.TailnetNeedsLogin {
			node.state = auth.TailnetState{Phase: auth.TailnetNeedsLogin}
		}
	case ipn.NeedsMachineAuth:
		node.state = auth.TailnetState{Phase: auth.TailnetNeedsApproval}
	case ipn.NoState, ipn.InUseOtherUser, ipn.Stopped, ipn.Starting:
		node.state = auth.TailnetState{Phase: auth.TailnetStarting}
	}
	return false
}

// running records the certificate name and the node's owner from a running node's status.
func (node *Node) running(status *ipnstate.Status) error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.domain = ""
	if len(status.CertDomains) > 0 && (status.CurrentTailnet == nil || status.CurrentTailnet.MagicDNSEnabled) {
		node.domain = status.CertDomains[0]
	}
	var keyExpiry time.Time
	if self := status.Self; self != nil {
		tagged := self.Tags != nil && self.Tags.Len() > 0
		node.owner = auth.TailnetPeer{UserID: strconv.FormatInt(int64(self.UserID), 10), Tagged: tagged, Tailnet: tailnetID(status.CurrentTailnet)}
		if profile, found := status.User[self.UserID]; found && !tagged {
			node.owner.Login, node.owner.Name = profile.LoginName, profile.DisplayName
		}
		if self.KeyExpiry != nil {
			keyExpiry = *self.KeyExpiry
		}
	}
	if node.domain == "" {
		node.state = auth.TailnetState{Phase: auth.TailnetNeedsHTTPS, KeyExpiry: keyExpiry}
		return ErrHTTPSOff
	}
	phase := auth.TailnetStarting
	if node.listening {
		phase = auth.TailnetRunning
	}
	node.state = auth.TailnetState{Phase: phase, Domain: node.domain, KeyExpiry: keyExpiry}
	return nil
}

// tailnetID names the tailnet the node is on, for the owner's node binding: the stable id when
// the control server gives one, else the tailnet's name ("" when the status has neither).
func tailnetID(tailnet *ipnstate.TailnetStatus) string {
	if tailnet == nil {
		return ""
	}
	if tailnet.StableID != "" {
		return "id:" + string(tailnet.StableID)
	}
	if tailnet.Name != "" {
		return "name:" + tailnet.Name
	}
	return ""
}

// Refresh re-reads a joined node's status (call it every config.TailnetRefresh): a rename moves
// Domain, a new login moves the owner and key expiry, and a node that needs a login again (its key
// expired, or Logout) asks tsnet for a new login link, so the home-network page can offer Connect
// again. It never restarts the node.
func (node *Node) Refresh(ctx context.Context) error {
	node.mutex.Lock()
	client := node.client
	node.mutex.Unlock()
	if client == nil {
		return nil
	}
	status, err := client.Status(ctx)
	if err != nil {
		return fmt.Errorf("tailnet status: %w", err)
	}
	return node.refreshed(ctx, client, status)
}

// loginStarter is the one call refreshed makes back into tsnet (a fake in tests).
type loginStarter interface {
	StartLoginInteractive(ctx context.Context) error
}

func (node *Node) refreshed(ctx context.Context, client loginStarter, status *ipnstate.Status) error {
	switch status.BackendState {
	case ipn.Running.String():
		if err := node.running(status); err != nil && !errors.Is(err, ErrHTTPSOff) {
			return err
		}
		return nil
	case ipn.NeedsLogin.String():
		if status.AuthURL == "" {
			if err := client.StartLoginInteractive(ctx); err != nil {
				return fmt.Errorf("ask for a Tailscale login link: %w", err)
			}
			return nil
		}
		url := status.AuthURL
		node.observe(ipn.Notify{BrowseToURL: &url})
	case ipn.NeedsMachineAuth.String():
		// A tailnet with device approval on: the page says to approve it; the next refresh sees Running.
		approval := ipn.NeedsMachineAuth
		node.observe(ipn.Notify{State: &approval})
	}
	return nil
}

// Logout signs the node out of Tailscale and asks for a new login link at once, for "Start over".
// The node stays up (its listeners too); whoever logs in next owns it, and Refresh picks that up.
func (node *Node) Logout(ctx context.Context) error {
	node.mutex.Lock()
	client := node.client
	node.mutex.Unlock()
	if client == nil {
		return errors.New("the tailnet node isn't running")
	}
	if err := client.Logout(ctx); err != nil {
		return fmt.Errorf("log out of Tailscale: %w", err)
	}
	// Logout also turns the node off (WantRunning false); turn it back on so the next login runs it.
	if _, err := client.EditPrefs(ctx, &ipn.MaskedPrefs{WantRunningSet: true, Prefs: ipn.Prefs{WantRunning: true}}); err != nil {
		return fmt.Errorf("turn the tailnet node back on: %w", err)
	}
	node.mutex.Lock()
	node.owner = auth.TailnetPeer{}
	node.state = auth.TailnetState{Phase: auth.TailnetNeedsLogin}
	node.mutex.Unlock()
	if err := client.StartLoginInteractive(ctx); err != nil {
		return fmt.Errorf("ask for a Tailscale login link: %w", err)
	}
	return nil
}

// RedirectListener is plain HTTP on :80 on the tailnet, for the redirect from http:// and the
// short name to the full https address. Call it after Up succeeds.
func (node *Node) RedirectListener() (net.Listener, error) {
	node.mutex.Lock()
	server := node.server
	node.mutex.Unlock()
	if server == nil {
		return nil, errors.New("the tailnet node isn't running")
	}
	listener, err := server.Listen("tcp", ":80")
	if err != nil {
		return nil, fmt.Errorf("listen on the tailnet's port 80: %w", err)
	}
	return listener, nil
}

// FunnelListener is HTTPS on the public internet through Tailscale Funnel on port, for the agent
// door only (FunnelOnly: tailnet devices use the site's :443). Call it after Up succeeds. It fails
// until the tailnet policy grants this node the "funnel" node attribute.
func (node *Node) FunnelListener(port string) (net.Listener, error) {
	node.mutex.Lock()
	server, domain := node.server, node.domain
	node.mutex.Unlock()
	if server == nil || domain == "" {
		return nil, ErrHTTPSOff
	}
	listener, err := server.ListenFunnel("tcp", ":"+port, tsnet.FunnelOnly())
	if err != nil {
		return nil, fmt.Errorf("listen on Funnel port %s: %w", port, err)
	}
	return listener, nil
}

// State is the node's progress right now (auth.TailnetStatus).
func (node *Node) State() auth.TailnetState {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.state
}

// Domain is the node's ts.net name, the one Host the tailnet listener answers.
func (node *Node) Domain() string {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.domain
}

// NodeOwner is the user who owns the node (Tagged when it belongs to tags instead).
func (node *Node) NodeOwner() auth.TailnetPeer {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.owner
}

// Listener is HTTPS on :443 with the node's certificate. Call it after Up succeeds.
func (node *Node) Listener() (net.Listener, error) {
	node.mutex.Lock()
	server, domain := node.server, node.domain
	node.mutex.Unlock()
	if server == nil || domain == "" {
		return nil, ErrHTTPSOff
	}
	listener, err := server.ListenTLS("tcp", ":443")
	if err != nil {
		return nil, fmt.Errorf("listen on the tailnet: %w", err)
	}
	node.mutex.Lock()
	node.listening = true
	node.state = auth.TailnetState{Phase: auth.TailnetRunning, Domain: domain, KeyExpiry: node.state.KeyExpiry}
	node.mutex.Unlock()
	return listener, nil
}

// WhoIs implements auth.PeerIdentifier from the connection's remote address.
func (node *Node) WhoIs(ctx context.Context, remoteAddr string) (auth.TailnetPeer, error) {
	node.mutex.Lock()
	client := node.client
	node.mutex.Unlock()
	if client == nil {
		return auth.TailnetPeer{}, auth.ErrUnknownPeer
	}
	who, err := client.WhoIs(ctx, remoteAddr)
	if errors.Is(err, local.ErrPeerNotFound) {
		return auth.TailnetPeer{}, auth.ErrUnknownPeer
	}
	if err != nil {
		return auth.TailnetPeer{}, fmt.Errorf("whois %s: %w", remoteAddr, err)
	}
	if who.Node == nil || who.UserProfile == nil {
		return auth.TailnetPeer{}, auth.ErrUnknownPeer
	}
	return auth.TailnetPeer{
		UserID: strconv.FormatInt(int64(who.UserProfile.ID), 10), Login: who.UserProfile.LoginName,
		Name: who.UserProfile.DisplayName, Tagged: who.Node.IsTagged(),
	}, nil
}

// Close leaves the tailnet (the node stays registered; it comes back on the next start).
func (node *Node) Close() error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	if node.server == nil {
		return nil
	}
	if err := node.server.Close(); err != nil {
		return fmt.Errorf("close tailnet node: %w", err)
	}
	return nil
}
