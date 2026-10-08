// Embedded Tailscale: the node Hussla runs as on the owner's tailnet, its HTTPS listener, and WhoIs for every connection.
// In the app: https://hussla.<tailnet>.ts.net from the owner's phone and laptop, with no password.
// Used by: cmd/hussla (Start, then Listener for the tailnet handler, Peers as auth.PeerIdentifier, NodeOwner at startup).
// Uses: tailscale.com/tsnet (pinned exactly in go.mod).
//
// Identity comes from the connection only: WhoIs asks the embedded node which tailnet peer owns the
// remote address of this TCP connection. No header is read here or anywhere. The node's state lives
// in <DATA_DIR>/tailscale, so the same node (and certificate name) comes back after a restart; the
// auth key is used only for the first join.

package tailnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"

	"github.com/bretperry/hussla/internal/app/auth"
)

// Options configure the node.
type Options struct {
	DataDir  string
	Hostname string // the MagicDNS name, "hussla" by default
	AuthKey  string // TS_AUTHKEY; only needed the first time
	Logf     func(format string, args ...any)
}

// Node is the running tailnet node.
type Node struct {
	server *tsnet.Server
	client *local.Client
	domain string
	owner  auth.TailnetPeer
}

// Start joins the tailnet (waiting for login when there is no auth key and no saved state) and
// opens nothing yet. The context bounds the wait.
func Start(ctx context.Context, options Options) (*Node, error) {
	server := &tsnet.Server{
		Dir:      filepath.Join(options.DataDir, "tailscale"),
		Hostname: options.Hostname,
		AuthKey:  options.AuthKey,
		UserLogf: options.Logf,
	}
	status, err := server.Up(ctx)
	if err != nil {
		_ = server.Close()
		return nil, fmt.Errorf("join the tailnet: %w", err)
	}
	client, err := server.LocalClient()
	if err != nil {
		_ = server.Close()
		return nil, fmt.Errorf("tailnet client: %w", err)
	}
	node := &Node{server: server, client: client}
	if len(status.CertDomains) > 0 {
		node.domain = status.CertDomains[0]
	}
	if self := status.Self; self != nil {
		tagged := self.Tags != nil && self.Tags.Len() > 0
		node.owner = auth.TailnetPeer{UserID: strconv.FormatInt(int64(self.UserID), 10), Tagged: tagged}
		if profile, found := status.User[self.UserID]; found && !tagged {
			node.owner.Login, node.owner.Name = profile.LoginName, profile.DisplayName
		}
	}
	return node, nil
}

// Domain is the node's ts.net name, the one Host the tailnet listener answers.
func (node *Node) Domain() string { return node.domain }

// NodeOwner is the user who owns the node (Tagged when it belongs to tags instead).
func (node *Node) NodeOwner() auth.TailnetPeer { return node.owner }

// Listener is HTTPS on :443 with the node's certificate (MagicDNS and HTTPS must be on in the tailnet).
func (node *Node) Listener() (net.Listener, error) {
	if node.domain == "" {
		return nil, errors.New("the tailnet has no HTTPS certificate name for this node: turn on MagicDNS and HTTPS in the Tailscale admin console")
	}
	listener, err := node.server.ListenTLS("tcp", ":443")
	if err != nil {
		return nil, fmt.Errorf("listen on the tailnet: %w", err)
	}
	return listener, nil
}

// WhoIs implements auth.PeerIdentifier from the connection's remote address.
func (node *Node) WhoIs(ctx context.Context, remoteAddr string) (auth.TailnetPeer, error) {
	who, err := node.client.WhoIs(ctx, remoteAddr)
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
	if err := node.server.Close(); err != nil {
		return fmt.Errorf("close tailnet node: %w", err)
	}
	return nil
}
