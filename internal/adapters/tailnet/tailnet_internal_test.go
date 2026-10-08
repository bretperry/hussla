// The node's join state: the login link it records and logs once, and the certificate name it needs before serving.
// In the app: a headless first run, before the owner logs in or turns on HTTPS in the tailnet.
// Used by: `go test ./internal/adapters/tailnet/`.
// Uses: tsnet's bus and status types, built by hand (no real tailnet in tests).

package tailnet

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"

	"github.com/bretperry/hussla/internal/app/auth"
)

func recordingNode() (*Node, *[]string) {
	var lines []string
	node := New(Options{Logf: func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }})
	return node, &lines
}

func TestLoginLinkRecordedAndLoggedOncePerLink(t *testing.T) {
	node, lines := recordingNode()
	needsLogin := ipn.NeedsLogin
	first, second := "https://login.example/a/1111", "https://login.example/a/2222"

	notices := []ipn.Notify{
		{State: &needsLogin},
		{State: &needsLogin, BrowseToURL: &first},
		{BrowseToURL: &first}, // tsnet repeats the same link
		{State: &needsLogin},
		{BrowseToURL: &second}, // a new link (the old one expired)
	}
	for index, notice := range notices {
		if node.observe(notice) {
			t.Fatalf("notice %d: running before login", index)
		}
		if index == 2 {
			if state := node.State(); state.Phase != auth.TailnetNeedsLogin || state.AuthURL != first {
				t.Fatalf("after the first link: %+v", state)
			}
		}
	}
	if state := node.State(); state.Phase != auth.TailnetNeedsLogin || state.AuthURL != second {
		t.Fatalf("after the second link: %+v", state)
	}
	if len(*lines) != 2 || !strings.Contains((*lines)[0], first) || !strings.Contains((*lines)[1], second) {
		t.Fatalf("want one line per new link, got %q", *lines)
	}
	running := ipn.Running
	if !node.observe(ipn.Notify{State: &running}) {
		t.Fatal("running not seen")
	}
}

func TestHTTPSOffIsReportedUntilTheTailnetGivesACertificateName(t *testing.T) {
	node, _ := recordingNode()
	status := &ipnstate.Status{
		CurrentTailnet: &ipnstate.TailnetStatus{MagicDNSEnabled: true},
		Self:           &ipnstate.PeerStatus{UserID: 7},
		User:           map[tailcfg.UserID]tailcfg.UserProfile{7: {LoginName: "owner@example.com", DisplayName: "Pat Owner"}},
	}
	if err := node.running(status); !errors.Is(err, ErrHTTPSOff) {
		t.Fatalf("no certificate name: %v", err)
	}
	if state := node.State(); state.Phase != auth.TailnetNeedsHTTPS {
		t.Fatalf("state: %+v", state)
	}
	if _, err := node.Listener(); !errors.Is(err, ErrHTTPSOff) {
		t.Fatalf("listener with HTTPS off: %v", err)
	}

	// MagicDNS off: a certificate name alone isn't enough.
	status.CertDomains = []string{"hussla.tail0000.ts.net"}
	status.CurrentTailnet.MagicDNSEnabled = false
	if err := node.running(status); !errors.Is(err, ErrHTTPSOff) {
		t.Fatalf("MagicDNS off: %v", err)
	}

	// The owner turns both on; the next Up sees it without a restart.
	status.CurrentTailnet.MagicDNSEnabled = true
	if err := node.running(status); err != nil {
		t.Fatal(err)
	}
	if node.Domain() != "hussla.tail0000.ts.net" || node.State().Domain != "hussla.tail0000.ts.net" {
		t.Fatalf("domain %q, state %+v", node.Domain(), node.State())
	}
	if owner := node.NodeOwner(); owner.UserID != "7" || owner.Login != "owner@example.com" || owner.Tagged {
		t.Fatalf("owner: %+v", owner)
	}
}
