// The first run without the log: the setup code across a cancelled prompt and a restart, the first-run window's link, a new code on request, Start over, and removing a passkey.
// In the app: a NAS owner adding the first passkey from the home-network page; a lost log; a lost phone.
// Used by: `go test ./internal/app/auth/...` (the plan's Phase 6 Done-when).
// Uses: the auth use-case over the in-memory store, the real WebAuthn ceremony with a virtual authenticator, a fake clock.

package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/adapters/passkey"
	"github.com/bretperry/hussla/internal/app/auth"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/testsupport/fakeauth"
	"github.com/bretperry/hussla/internal/testsupport/fakes"
	"github.com/bretperry/hussla/internal/testsupport/virtualauthn"
)

var (
	nodeOwner = auth.TailnetPeer{UserID: "1001", Login: "owner@example.com", Name: "Pat Owner"}
	neighbor  = auth.TailnetPeer{UserID: "2002", Login: "neighbor@example.com", Name: "Neighbor"}
	site      = auth.RelyingParty{ID: "hussla.tail0000.ts.net", Origin: "https://hussla.tail0000.ts.net"}
)

// install is one data directory: the store and clock survive a restart; the service doesn't.
type install struct {
	t       *testing.T
	store   *fakes.Store
	clock   *fakeauth.Clock
	service *auth.Service
	code    string // the last code printed
	printed int
	key     *virtualauthn.Authenticator
}

func newInstall(t *testing.T) *install {
	t.Helper()
	in := &install{t: t, store: fakes.New(), clock: fakeauth.NewClock(time.Date(2026, 10, 9, 9, 0, 0, 0, time.UTC)), key: virtualauthn.New()}
	in.restart()
	if _, err := in.service.AdoptNodeOwner(t.Context(), nodeOwner); err != nil {
		t.Fatal(err)
	}
	return in
}

// restart is a new process on the same storage: nothing in memory survives.
func (in *install) restart() {
	in.t.Helper()
	in.service = auth.New(auth.Options{
		Store: in.store, Ceremony: passkey.Ceremony{}, Now: in.clock.Now,
		AnnounceSetupCode: func(code string) { in.code = code; in.printed++ },
	})
	if err := in.service.IssueSetupCode(in.t.Context()); err != nil {
		in.t.Fatal(err)
	}
}

func (in *install) principal(peer auth.TailnetPeer) auth.Principal {
	in.t.Helper()
	principal, err := in.service.TailnetPrincipal(in.t.Context(), peer)
	if err != nil {
		in.t.Fatal(err)
	}
	return principal
}

// register spends a register step-up on a passkey; cancel stops before the browser answers.
func (in *install) register(owner auth.Principal, stepUp string, cancel bool) error {
	in.t.Helper()
	ctx := in.t.Context()
	if err := in.service.ConsumeStepUp(owner, auth.PurposeRegisterPasskey, stepUp); err != nil {
		return err
	}
	challenge, options, err := in.service.BeginRegistration(ctx, owner, site)
	if err != nil {
		return err
	}
	if cancel {
		return nil
	}
	response, err := in.key.Register(options, site.Origin)
	if err != nil {
		in.t.Fatal(err)
	}
	_, err = in.service.FinishRegistration(ctx, owner, site, challenge, "Phone", response)
	return err
}

func TestCancelledPromptAndRestartKeepTheSameCode(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	code := in.code
	owner := in.principal(nodeOwner)

	// Face ID cancelled: the same code works again.
	_, stepUp, err := in.service.Claim(ctx, owner, code)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.register(owner, stepUp, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := in.service.Claim(ctx, owner, code); err != nil {
		t.Fatalf("the code after a cancelled prompt: %v", err)
	}

	// A restart mid-setup: no new code is printed, and the one in the log still works.
	in.restart()
	if in.printed != 1 {
		t.Fatalf("%d codes printed across a restart, want 1", in.printed)
	}
	owner = in.principal(nodeOwner)
	_, stepUp, err = in.service.Claim(ctx, owner, code)
	if err != nil {
		t.Fatalf("the code after a restart: %v", err)
	}
	if err := in.register(owner, stepUp, false); err != nil {
		t.Fatal(err)
	}
	// The stored passkey spent it.
	if _, _, err := in.service.Claim(ctx, owner, code); !errors.Is(err, auth.ErrSetupClosed) {
		t.Fatalf("the code after a passkey: %v, want ErrSetupClosed", err)
	}
}

func TestFirstRunLinkWorksOnlyForTheNodeOwnerInsideTheWindow(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	state, err := in.service.FirstRunState(ctx)
	if err != nil || !state.Open || state.Link == "" {
		t.Fatalf("a fresh install's window: %+v %v", state, err)
	}
	owner := in.principal(nodeOwner)

	// Someone else on the tailnet, with the link, gets nothing; nor does a wrong link.
	if _, _, err := in.service.ClaimWithLink(ctx, in.principal(neighbor), state.Link); !errors.Is(err, auth.ErrNotOwner) {
		t.Fatalf("neighbor: %v", err)
	}
	if _, _, err := in.service.ClaimWithLink(ctx, owner, "not-the-link"); !errors.Is(err, auth.ErrWrongLink) {
		t.Fatalf("wrong link: %v", err)
	}
	// The owner: a cancelled prompt, then the same link again, then a passkey.
	_, stepUp, err := in.service.ClaimWithLink(ctx, owner, state.Link)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.register(owner, stepUp, true); err != nil {
		t.Fatal(err)
	}
	_, stepUp, err = in.service.ClaimWithLink(ctx, owner, state.Link)
	if err != nil {
		t.Fatalf("the link after a cancelled prompt: %v", err)
	}
	if err := in.register(owner, stepUp, false); err != nil {
		t.Fatal(err)
	}
	// Owned now: closed for good, a restart inside the window included.
	in.restart()
	if state, err := in.service.FirstRunState(ctx); err != nil || state.Open {
		t.Fatalf("after a passkey, restarted: %+v %v", state, err)
	}
}

func TestFirstRunWindowCloses(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	state, err := in.service.FirstRunState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	in.clock.Advance(config.FirstRunWindow)
	if _, _, err := in.service.ClaimWithLink(ctx, in.principal(nodeOwner), state.Link); !errors.Is(err, auth.ErrFirstRunClosed) {
		t.Fatalf("after the window: %v", err)
	}
	// The setup code still works, and a restart opens a new window with a new link.
	if _, _, err := in.service.Claim(ctx, in.principal(nodeOwner), in.code); err != nil {
		t.Fatalf("the code after the window: %v", err)
	}
	in.restart()
	again, err := in.service.FirstRunState(ctx)
	if err != nil || !again.Open || again.Link == state.Link {
		t.Fatalf("after a restart: %+v %v", again, err)
	}
}

func TestANewCodeOnRequestReplacesALostOne(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	lost := in.code
	owner := in.principal(nodeOwner)

	agent, err := in.service.Agent(ctx, "hussla_not-a-key")
	if !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("agent: %v", err)
	}
	if err := in.service.RequestSetupCode(ctx, agent); err == nil {
		t.Fatal("no proof at all printed a code")
	}
	if err := in.service.RequestSetupCode(ctx, in.principal(neighbor)); !errors.Is(err, auth.ErrNotOwner) {
		t.Fatalf("a non-owner asked: %v", err)
	}
	if err := in.service.RequestSetupCode(ctx, owner); err != nil {
		t.Fatal(err)
	}
	if in.printed != 2 || in.code == lost {
		t.Fatalf("printed %d codes; new %q, lost %q", in.printed, in.code, lost)
	}
	if _, _, err := in.service.Claim(ctx, owner, lost); !errors.Is(err, auth.ErrWrongSetupCode) {
		t.Fatalf("the lost code: %v", err)
	}
	if _, _, err := in.service.Claim(ctx, owner, in.code); err != nil {
		t.Fatalf("the new code: %v", err)
	}
	if err := in.service.RequestSetupCode(ctx, owner); !errors.Is(err, auth.ErrCodeTooSoon) {
		t.Fatalf("asked twice in a minute: %v", err)
	}
	in.clock.Advance(config.SetupCodeReissueGap)
	if err := in.service.RequestSetupCode(ctx, owner); err != nil {
		t.Fatalf("a minute later: %v", err)
	}
}

func TestRecoveryCodeAddsAPasskeyAfterSetup(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	owner := in.principal(nodeOwner)
	_, stepUp, err := in.service.Claim(ctx, owner, in.code)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.register(owner, stepUp, false); err != nil {
		t.Fatal(err)
	}
	// Every passkey lost: the owner (by identity) asks for a recovery code and adds a new one.
	in.key = virtualauthn.New()
	if err := in.service.RequestSetupCode(ctx, owner); err != nil {
		t.Fatal(err)
	}
	_, stepUp, err = in.service.Claim(ctx, owner, in.code)
	if err != nil {
		t.Fatalf("recovery claim: %v", err)
	}
	if err := in.register(owner, stepUp, false); err != nil {
		t.Fatalf("recovery passkey: %v", err)
	}
	list, err := in.service.Passkeys(ctx, owner)
	if err != nil || len(list) != 2 {
		t.Fatalf("passkeys: %d %v", len(list), err)
	}
	// The old one can go now; the last one can't.
	if err := in.service.RemovePasskey(ctx, owner, list[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := in.service.RemovePasskey(ctx, owner, list[1].ID); !errors.Is(err, auth.ErrLastPasskey) {
		t.Fatalf("removing the last passkey: %v", err)
	}
	if err := in.service.RemovePasskey(ctx, in.principal(neighbor), list[1].ID); !errors.Is(err, auth.ErrNotOwner) {
		t.Fatalf("a non-owner removing: %v", err)
	}
}

func TestStartOverOnlyBeforeAnyPasskey(t *testing.T) {
	in := newInstall(t)
	ctx := t.Context()
	if login, err := in.service.OwnerLogin(ctx); err != nil || login != nodeOwner.Login {
		t.Fatalf("owner login %q %v", login, err)
	}
	if err := in.service.StartOver(ctx); err != nil {
		t.Fatal(err)
	}
	if enrolled, err := in.service.Enrolled(ctx); err != nil || enrolled {
		t.Fatalf("after start over, enrolled = %v %v", enrolled, err)
	}
	// The next person who owns the node is adopted; the first is now just a peer.
	if adopted, err := in.service.AdoptNodeOwner(ctx, neighbor); err != nil || !adopted {
		t.Fatalf("adopt the next owner: %v %v", adopted, err)
	}
	if in.principal(nodeOwner).IsOwner() || !in.principal(neighbor).IsOwner() {
		t.Fatal("ownership didn't move")
	}
	newOwner := in.principal(neighbor)
	_, stepUp, err := in.service.Claim(ctx, newOwner, in.code)
	if err != nil {
		t.Fatal(err)
	}
	if err := in.register(newOwner, stepUp, false); err != nil {
		t.Fatal(err)
	}
	if err := in.service.StartOver(ctx); !errors.Is(err, auth.ErrStartOverClosed) {
		t.Fatalf("start over after a passkey: %v", err)
	}
	if allowed, err := in.service.CanStartOver(context.Background()); err != nil || allowed {
		t.Fatalf("can start over after a passkey: %v %v", allowed, err)
	}
}
