// Start over against a passkey that lands at the same moment: the node is never logged out while its owner stays recorded.
// In the app: the home-network page's "Start over" pressed just as the owner finishes Face ID on the tailnet address.
// Used by: `go test ./internal/app/setup/...`.
// Uses: auth.Service over the in-memory store, wrapped so a passkey lands right after any read; a fake tailnet node that counts logouts.

package setup_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/app/setup"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

// passkeyLandsAfterRead is the store with a passkey registration landing right after the next
// read-only unit of work: what the owner's Face ID finishing at that instant looks like.
type passkeyLandsAfterRead struct {
	*fakes.Store
	mutex sync.Mutex
	armed bool
}

func (racy *passkeyLandsAfterRead) View(ctx context.Context, work func(store.Tx) error) error {
	err := racy.Store.View(ctx, work)
	racy.mutex.Lock()
	fire := racy.armed
	racy.armed = false
	racy.mutex.Unlock()
	if fire {
		// "auth.firstPasskeyAt" is what FinishRegistration writes with the first passkey.
		landErr := racy.Atomically(ctx, func(tx store.Tx) error {
			return tx.Settings().Set(ctx, "auth.firstPasskeyAt", `"2026-10-09T09:00:00.000Z"`)
		})
		if landErr != nil {
			return landErr
		}
	}
	return err
}

type countingNode struct {
	mutex   sync.Mutex
	logouts int
}

func (node *countingNode) State() auth.TailnetState {
	return auth.TailnetState{Phase: auth.TailnetRunning, Domain: "hussla.tail0000.ts.net"}
}

func (node *countingNode) NodeOwner() auth.TailnetPeer { return auth.TailnetPeer{} }

func (node *countingNode) Logout(context.Context) error {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	node.logouts++
	return nil
}

func TestStartOverNeverLogsOutWhenAPasskeyLandsAtTheSameMoment(t *testing.T) {
	ctx := t.Context()
	racy := &passkeyLandsAfterRead{Store: fakes.New()}
	now := func() time.Time { return time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC) }
	authService := auth.New(auth.Options{Store: racy, Now: now})
	if _, err := authService.AdoptNodeOwner(ctx, auth.TailnetPeer{UserID: "1001", Login: "owner@example.com"}); err != nil {
		t.Fatal(err)
	}
	node := &countingNode{}
	service := setup.New(setup.Options{Auth: authService, Tailnet: node, Store: racy, Now: now})

	racy.mutex.Lock()
	racy.armed = true
	racy.mutex.Unlock()
	err := service.StartOver(ctx)
	racy.mutex.Lock()
	racy.armed = false
	racy.mutex.Unlock()
	if err != nil && !errors.Is(err, auth.ErrStartOverClosed) {
		t.Fatal(err)
	}
	// Either outcome is fine (released and logged out, or refused and untouched), but never a
	// node logged out of Tailscale with its owner still recorded and no way back from the page.
	enrolled, readErr := authService.Enrolled(ctx)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if node.logouts > 0 && enrolled {
		t.Fatalf("the node was logged out (%d) with its owner still recorded (StartOver: %v)", node.logouts, err)
	}
	if (err == nil) != (node.logouts == 1 && !enrolled) {
		t.Fatalf("StartOver %v, %d logouts, enrolled %v", err, node.logouts, enrolled)
	}
}
