// The node's join state: the login link it records and logs once, and the certificate name it needs before serving.
// In the app: a headless first run, before the owner logs in or turns on HTTPS in the tailnet.
// Used by: `go test ./internal/adapters/tailnet/`.
// Uses: tsnet's bus and status types, built by hand (no real tailnet in tests).

package tailnet

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/views"

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

// loginCounter stands in for tsnet's local client when Refresh asks for a login link.
type loginCounter struct{ calls int }

func (counter *loginCounter) StartLoginInteractive(context.Context) error {
	counter.calls++
	return nil
}

func TestRefreshFollowsRenameKeyExpiryAndLogout(t *testing.T) {
	node, lines := recordingNode()
	node.listening = true // Up and Listener already ran
	expiry := time.Date(2027, 4, 1, 0, 0, 0, 0, time.UTC)
	status := &ipnstate.Status{
		BackendState:   ipn.Running.String(),
		CurrentTailnet: &ipnstate.TailnetStatus{MagicDNSEnabled: true},
		CertDomains:    []string{"hussla.tail0000.ts.net"},
		Self:           &ipnstate.PeerStatus{UserID: 7, KeyExpiry: &expiry},
		User:           map[tailcfg.UserID]tailcfg.UserProfile{7: {LoginName: "owner@example.com"}},
	}
	counter := &loginCounter{}
	if err := node.refreshed(t.Context(), counter, status); err != nil {
		t.Fatal(err)
	}
	if state := node.State(); state.Phase != auth.TailnetRunning || !state.KeyExpiry.Equal(expiry) {
		t.Fatalf("running: %+v", state)
	}

	// Renamed in the admin console: the new name is the domain.
	status.CertDomains = []string{"jobs.tail0000.ts.net"}
	if err := node.refreshed(t.Context(), counter, status); err != nil || node.Domain() != "jobs.tail0000.ts.net" {
		t.Fatalf("rename: %q %v", node.Domain(), err)
	}

	// A tailnet with device approval: waiting for an admin, then running again on the next refresh.
	if err := node.refreshed(t.Context(), counter, &ipnstate.Status{BackendState: ipn.NeedsMachineAuth.String()}); err != nil || node.State().Phase != auth.TailnetNeedsApproval {
		t.Fatalf("needs approval: %+v %v", node.State(), err)
	}

	// The key expired: no link yet, so one is asked for; then the link is offered and logged once.
	status = &ipnstate.Status{BackendState: ipn.NeedsLogin.String()}
	if err := node.refreshed(t.Context(), counter, status); err != nil || counter.calls != 1 {
		t.Fatalf("needs login: %d calls, %v", counter.calls, err)
	}
	status.AuthURL = "https://login.example/a/3333"
	for range 2 {
		if err := node.refreshed(t.Context(), counter, status); err != nil {
			t.Fatal(err)
		}
	}
	if state := node.State(); state.Phase != auth.TailnetNeedsLogin || state.AuthURL != status.AuthURL || counter.calls != 1 {
		t.Fatalf("login link: %+v, %d calls", state, counter.calls)
	}
	if len(*lines) != 1 || !strings.Contains((*lines)[0], "3333") {
		t.Fatalf("want one log line for the new link, got %q", *lines)
	}
}

// The node's tailnet rides along with its owner, tagged or not, so the owner check can tell a node
// moved to someone else's tailnet: the stable id when there is one, else the tailnet's name.
func TestTheNodeOwnerCarriesItsTailnet(t *testing.T) {
	node, _ := recordingNode()
	tags := views.SliceOf([]string{"tag:server"})
	status := &ipnstate.Status{
		CertDomains:    []string{"hussla.tail0000.ts.net"},
		CurrentTailnet: &ipnstate.TailnetStatus{MagicDNSEnabled: true, StableID: "Tnet1234", Name: "example.com"},
		Self:           &ipnstate.PeerStatus{UserID: 7, Tags: &tags},
	}
	if err := node.running(status); err != nil {
		t.Fatal(err)
	}
	if owner := node.NodeOwner(); !owner.Tagged || owner.Tailnet != "id:Tnet1234" {
		t.Fatalf("tagged owner: %+v", owner)
	}
	status.CurrentTailnet.StableID = ""
	if err := node.running(status); err != nil {
		t.Fatal(err)
	}
	if owner := node.NodeOwner(); owner.Tailnet != "name:example.com" {
		t.Fatalf("owner with no stable id: %+v", owner)
	}
}
