// Who the node belongs to, and guesses that can't lock the owner out: a tagged node moved to another tailnet, an owner pinned with HUSSLA_OWNER_LOGIN on a node logged in as someone else, wrong guesses from the owner's own identity, a new code that keeps the printed one good, and Start over reopening the window.
// In the app: the tailnet door's "belongs to someone else"; the setup screen's code; the home-network page's Start over and Make it mine.
// Used by: `go test ./internal/app/auth/...` (PR #13's second dynamite test).
// Uses: the auth use-case over the in-memory store, a settable node, a fake clock.

package auth_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/testsupport/fakeauth"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
)

// settableNode is the server's own tailnet node: who it is logged in as, given by the test.
type settableNode struct {
	mutex sync.Mutex
	peer  auth.TailnetPeer
}

func (node *settableNode) NodeOwner() auth.TailnetPeer {
	node.mutex.Lock()
	defer node.mutex.Unlock()
	return node.peer
}

// nodeService is an auth use-case on a fresh store with node as its tailnet node; it returns the printed code.
func nodeService(t *testing.T, node *settableNode, pin string) (*auth.Service, *string) {
	t.Helper()
	code := new(string)
	service := auth.New(auth.Options{
		Store: fakes.New(), Ceremony: passkey.Ceremony{}, Node: node, OwnerLogin: pin,
		AnnounceSetupCode: func(printed string) { *code = printed },
	})
	if err := service.IssueSetupCode(t.Context()); err != nil {
		t.Fatal(err)
	}
	return service, code
}

func mismatch(t *testing.T, service *auth.Service, node auth.TailnetPeer) bool {
	t.Helper()
	found, err := service.NodeOwnerMismatch(context.Background(), node)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestATaggedNodeOnAnotherTailnetIsSomeoneElses(t *testing.T) {
	ctx := t.Context()
	home := auth.TailnetPeer{UserID: "9", Tagged: true, Tailnet: "Tnet-home"}
	node := &settableNode{peer: home}
	service, code := nodeService(t, node, "")
	if adopted, err := service.AdoptNodeOwner(ctx, home); err != nil || adopted {
		t.Fatalf("a tagged node adopted an owner: %v %v", adopted, err)
	}
	// The owner claims the tagged node with the code from the log.
	caller, err := service.TailnetPrincipal(ctx, nodeOwner)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Claim(ctx, caller, *code); err != nil {
		t.Fatal(err)
	}
	if mismatch(t, service, home) {
		t.Fatal("the owner's own tagged node reads as someone else's")
	}
	if mismatch(t, service, auth.TailnetPeer{}) {
		t.Fatal("a logged-out node reads as someone else's")
	}
	// Someone logs the node in to their own tailnet and tags it there.
	if !mismatch(t, service, auth.TailnetPeer{UserID: "9", Tagged: true, Tailnet: "Tnet-attacker"}) {
		t.Fatal("a tagged node on another tailnet isn't a mismatch")
	}
	// Or signs it in untagged as another user of the owner's tailnet.
	if !mismatch(t, service, auth.TailnetPeer{UserID: neighbor.UserID, Login: neighbor.Login, Tailnet: "Tnet-home"}) {
		t.Fatal("another user's node isn't a mismatch")
	}
	// The owner signing the node in as themselves, on their own tailnet, is fine.
	if mismatch(t, service, auth.TailnetPeer{UserID: nodeOwner.UserID, Login: nodeOwner.Login, Tailnet: "Tnet-home"}) {
		t.Fatal("the owner's own login reads as someone else's")
	}
}

func TestAnUntaggedNodeOnAnotherTailnetIsSomeoneElses(t *testing.T) {
	ctx := t.Context()
	home := nodeOwner
	home.Tailnet = "Tnet-home"
	service, _ := nodeService(t, &settableNode{peer: home}, "")
	if adopted, err := service.AdoptNodeOwner(ctx, home); err != nil || !adopted {
		t.Fatalf("adopt: %v %v", adopted, err)
	}
	if mismatch(t, service, home) {
		t.Fatal("the owner's node reads as someone else's")
	}
	moved := home
	moved.Tailnet = "Tnet-attacker"
	if !mismatch(t, service, moved) {
		t.Fatal("the same user id on another tailnet isn't a mismatch")
	}
	if !mismatch(t, service, auth.TailnetPeer{UserID: "9", Tagged: true, Tailnet: "Tnet-attacker"}) {
		t.Fatal("a tagged node on another tailnet isn't a mismatch")
	}
}

// HUSSLA_OWNER_LOGIN names someone other than the node's login: that login claims with the code,
// is recorded as the owner, and the node's own login is no mismatch.
func TestAPinnedOwnerOnSomeoneElsesNodeIsNoMismatch(t *testing.T) {
	ctx := t.Context()
	admin := auth.TailnetPeer{UserID: "3003", Login: "admin@example.com", Tailnet: "Tnet-home"}
	service, code := nodeService(t, &settableNode{peer: admin}, nodeOwner.Login)
	if adopted, err := service.AdoptNodeOwner(ctx, admin); err != nil || adopted {
		t.Fatalf("the pin let the node's login be adopted: %v %v", adopted, err)
	}
	caller, err := service.TailnetPrincipal(ctx, nodeOwner)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Claim(ctx, caller, *code); err != nil {
		t.Fatal(err)
	}
	if login, err := service.OwnerLogin(ctx); err != nil || login != nodeOwner.Login {
		t.Fatalf("owner %q %v, want the pinned login", login, err)
	}
	if mismatch(t, service, admin) {
		t.Fatal("the node's own login reads as someone else's after the pinned owner claimed")
	}
	own := nodeOwner
	own.Tailnet = "Tnet-home"
	if mismatch(t, service, own) {
		t.Fatal("the pinned owner signing the node in reads as someone else's")
	}
	stranger := neighbor
	stranger.Tailnet = "Tnet-home"
	if !mismatch(t, service, stranger) {
		t.Fatal("a third login isn't a mismatch")
	}
}

// An agent with the owner's tailnet identity guesses wrong as often as it likes: the right code
// still works, and the code is long enough that guessing is hopeless.
func TestWrongGuessesNeverStopTheRightCode(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	owner := in.principal(nodeOwner)
	for range 3 * config.SetupCodeAttempts {
		if _, _, err := in.service.Claim(ctx, owner, "WRONG-WRONG-WRONG-WRON"); err == nil {
			t.Fatal("a wrong code was taken")
		}
	}
	if _, _, err := in.service.Claim(ctx, owner, "WRONG-WRONG-WRONG-WRON"); !errors.Is(err, auth.ErrSetupCodeLocked) {
		t.Fatalf("a wrong guess after the limit: %v, want ErrSetupCodeLocked", err)
	}
	if _, _, err := in.service.Claim(ctx, owner, in.code); err != nil {
		t.Fatalf("the right code after someone's wrong guesses: %v", err)
	}
	// The link the same way: wrong links don't stop the right one.
	link := in.mint()
	for range 3 * config.SetupCodeAttempts {
		if _, _, err := in.service.ClaimWithLink(ctx, owner, "not-the-link"); err == nil {
			t.Fatal("a wrong link was taken")
		}
	}
	if _, _, err := in.service.ClaimWithLink(ctx, owner, link); err != nil {
		t.Fatalf("the right link after wrong ones: %v", err)
	}
}

func TestTheSetupCodeIs80Bits(t *testing.T) {
	in := newInstall(t)
	groups := strings.Split(in.code, "-")
	if len(groups) != 4 || len(strings.Join(groups, "")) != 16 {
		t.Fatalf("code %q: want XXXX-XXXX-XXXX-XXXX (16 base32 characters, 80 bits)", in.code)
	}
}

// A new code never makes the printed one stale: an agent asking for codes can't take the owner's away.
func TestANewCodeKeepsThePrintedOneGood(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	owner := in.principal(nodeOwner)
	first := in.code
	for index := 1; index < config.SetupCodesLive; index++ {
		if err := in.service.RequestSetupCode(ctx, owner); err != nil {
			t.Fatalf("new code %d: %v", index, err)
		}
		in.clock.Advance(config.SetupCodeReissueGap)
	}
	if err := in.service.RequestSetupCode(ctx, owner); !errors.Is(err, auth.ErrTooManyCodes) {
		t.Fatalf("code %d: %v, want ErrTooManyCodes", config.SetupCodesLive+1, err)
	}
	last := in.code
	in.restart()
	for _, code := range []string{first, last} {
		if _, _, err := in.service.Claim(ctx, owner, code); err != nil {
			t.Fatalf("a printed code after new ones and a restart: %v", err)
		}
	}
	// A stored passkey spends every one of them.
	_, stepUp, err := in.service.Claim(ctx, owner, first)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.register(owner, stepUp, false); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{first, last} {
		if _, _, err := in.service.Claim(ctx, owner, code); !errors.Is(err, auth.ErrSetupClosed) {
			t.Fatalf("a code after the first passkey: %v, want ErrSetupClosed", err)
		}
	}
}

// Start over (no passkey ever stored) gives whoever connects next a fresh window.
func TestStartOverReopensTheWindow(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	in.clock.Advance(config.FirstRunWindow + 1)
	if state, err := in.service.FirstRunState(ctx); err != nil || state.Open {
		t.Fatalf("after the window: %+v %v", state, err)
	}
	if err := in.service.StartOver(ctx, func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if state, err := in.service.FirstRunState(ctx); err != nil || state.Open || state.Started {
		t.Fatalf("after Start over, before anyone connects: %+v %v", state, err)
	}
	if _, err := in.service.AdoptNodeOwner(ctx, neighbor); err != nil {
		t.Fatal(err)
	}
	if state, err := in.service.FirstRunState(ctx); err != nil || !state.Open {
		t.Fatalf("after Start over and a new owner: %+v %v", state, err)
	}
}

// An owner recorded with no passkey before the window existed gets it once, at the next adoption.
func TestAnOwnerFromBeforeTheWindowGetsItOnce(t *testing.T) {
	ctx := t.Context()
	store := fakes.New()
	clock := fakeauth.NewClock(time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC))
	before := auth.New(auth.Options{Store: store, Ceremony: passkey.Ceremony{}, Now: clock.Now, FirstRunWindow: -1})
	if adopted, err := before.AdoptNodeOwner(ctx, nodeOwner); err != nil || !adopted {
		t.Fatalf("adopt: %v %v", adopted, err)
	}
	after := auth.New(auth.Options{Store: store, Ceremony: passkey.Ceremony{}, Now: clock.Now})
	if _, err := after.AdoptNodeOwner(ctx, nodeOwner); err != nil { // the next start
		t.Fatal(err)
	}
	if state, err := after.FirstRunState(ctx); err != nil || !state.Open {
		t.Fatalf("an owner from before the window: %+v %v", state, err)
	}
	clock.Advance(config.FirstRunWindow)
	if _, err := after.AdoptNodeOwner(ctx, nodeOwner); err != nil { // and a start after that
		t.Fatal(err)
	}
	if state, err := after.FirstRunState(ctx); err != nil || state.Open {
		t.Fatalf("the window opened twice: %+v %v", state, err)
	}
}
