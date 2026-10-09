// The first run without the log: the first-start window's link, a fresh setup code on request, "Start over", and who the setup pages name as the owner.
// In the app: the home-network page's "Make it mine" link, the setup screen's "Print a new code", the home page's "Start over", the "Owner: X, not you?" line.
// Used by: internal/app/setup (the home page), internal/httpapi (the setup routes).
// Uses: settings (the owner record, the first-passkey marker, the setup code's hash), config.FirstRunWindow, config.SetupCodeReissueGap.
//
// The window (decision 0015): an install that has never stored a passkey, within
// config.FirstRunWindow of the server's start, lets the Tailscale user who owns the node take the
// register step-up with the home-network page's link instead of the setup code. Every part is
// needed: "never owned" keeps it from reopening a finished install; the time limit keeps a forgotten
// install from staying open; the node owner's identity (WhoIs) keeps a neighbor who saw the page
// out; the link (shown only on the home network) keeps an agent on the owner's laptop, which
// has the owner's tailnet identity but not the page, from registering its own passkey first. Outside
// the window the setup code from the log still works, and the owner (by identity) may ask for a
// new one to be printed, which also covers a log that was lost.

package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

var (
	// ErrFirstRunClosed: the first-run link no longer works (409): the window ended, or a passkey exists.
	ErrFirstRunClosed = errors.New("the first-run link has expired: restart Hussla to open it again for 15 minutes, or use the setup code from the log")
	// ErrStartOverClosed: this install already has a passkey, so its owner can't be reset from a page (409).
	ErrStartOverClosed = errors.New("this install already has a passkey, so its owner can't be changed here")
	// ErrCodeTooSoon: a new setup code was printed moments ago (429).
	ErrCodeTooSoon = errors.New("a new setup code was printed less than a minute ago: look for the newest \"Setup code\" line in the log")
	// ErrWrongLink: the first-run link isn't this start's (403); the home-network page has the current one.
	ErrWrongLink = errors.New("that setup link is from an earlier start: open the button on the home-network page again")
	// ErrLastPasskey: removing this passkey would leave its address with none (409).
	ErrLastPasskey = errors.New("that is the last passkey for this address: add another one first")
)

// everOwned reports whether a passkey was ever stored (the marker, or any passkey on file).
func everOwned(ctx context.Context, tx store.Tx) (bool, error) {
	var at time.Time
	marked, err := readJSON(ctx, tx, settingFirstPasskey, &at)
	if err != nil || marked {
		return marked, err
	}
	var list []StoredPasskey
	if _, err := readJSON(ctx, tx, settingPasskeys, &list); err != nil {
		return false, err
	}
	return len(list) > 0, nil
}

// FirstRun is the first-run window as the home-network page needs it.
type FirstRun struct {
	Open     bool
	Link     string    // the secret for the page's "Make it mine" link; empty when closed
	ClosesAt time.Time // when the window ends (zero when it is off)
}

// FirstRunState reports whether the first-run window is open, and its link while it is.
func (s *Service) FirstRunState(ctx context.Context) (FirstRun, error) {
	open, err := s.firstRunOpen(ctx)
	if err != nil || !open {
		return FirstRun{ClosesAt: s.firstRunUntil}, err
	}
	return FirstRun{Open: true, Link: s.firstRunLink, ClosesAt: s.firstRunUntil}, nil
}

func (s *Service) firstRunOpen(ctx context.Context) (bool, error) {
	if s.firstRunUntil.IsZero() || !s.now().Before(s.firstRunUntil) {
		return false, nil
	}
	owned := false
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		owned, err = everOwned(ctx, tx)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("first-run window: %w", err)
	}
	return !owned, nil
}

// ClaimWithLink is Claim with the home-network page's link instead of the setup code. Only the
// owner on the tailnet (the user who owns the node, already adopted) may use it, only inside
// the window, and it grants the one step-up that starts a passkey registration. Like the code, the
// link stays good until a passkey is stored, so a cancelled prompt can try again.
func (s *Service) ClaimWithLink(ctx context.Context, caller Principal, link string) (Principal, string, error) {
	if !caller.IsOwner() || caller.peer.UserID == "" {
		return Principal{}, "", ErrNotOwner
	}
	open, err := s.firstRunOpen(ctx)
	if err != nil {
		return Principal{}, "", err
	}
	if !open {
		return Principal{}, "", ErrFirstRunClosed
	}
	if err := s.checkGuess(setupGuesser(caller), ErrWrongLink, func() bool { return sameSecret(link, s.firstRunLink) }); err != nil {
		return Principal{}, "", err
	}
	return caller, s.grantStepUp(caller, PurposeRegisterPasskey), nil
}

// RequestSetupCode prints a new setup code to the log, replacing the live one: for a lost log
// before setup is done, and for an owner who lost every passkey (recovery). The owner may ask
// (by tailnet identity or local session); before there is an owner, so may anyone who could
// claim with it. At most once per config.SetupCodeReissueGap.
func (s *Service) RequestSetupCode(ctx context.Context, caller Principal) error {
	switch caller.role {
	case RoleOwner:
	case RolePeer:
		record, found, err := s.readOwner(ctx)
		if err != nil {
			return err
		}
		if caller.peer.Tagged || caller.peer.UserID == "" || !s.allowedLogin(caller.peer.Login) || (found && record.TailnetUserID != "") {
			return ErrNotOwner
		}
	case RoleAgent:
		return ErrNotOwner
	case RoleNone:
		return ErrUnauthorized
	}
	s.mu.Lock()
	now := s.now()
	if !s.lastReissue.IsZero() && now.Before(s.lastReissue.Add(config.SetupCodeReissueGap)) {
		s.mu.Unlock()
		return ErrCodeTooSoon
	}
	s.lastReissue = now
	s.mu.Unlock()
	who := caller.login
	if who == "" {
		who = "the owner"
	}

	code := newSetupCode()
	record := setupCodeRecord{Hash: hashSecret(normalizeSetupCode(code)), IssuedAt: domain.NormalizeTime(now)}
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		if err := writeJSON(ctx, tx, settingSetupCode, record); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "New setup code printed to the log", "Asked for by "+who, now)
	})
	if err != nil {
		return fmt.Errorf("new setup code: %w", err)
	}
	s.mu.Lock()
	s.setupHash = record.Hash
	s.setupGuesses = map[string]setupGuesses{}
	s.mu.Unlock()
	s.announce(code)
	return nil
}

// StartOver gives up the recorded owner so the next Tailscale user who owns the node is adopted
// instead. Only before any passkey was ever stored: after that, the owner is fixed for good. The
// caller (the home-network page) logs the node out of Tailscale first.
func (s *Service) StartOver(ctx context.Context) error {
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		owned, err := everOwned(ctx, tx)
		if err != nil {
			return err
		}
		if owned {
			return ErrStartOverClosed
		}
		record, found, err := readOwnerTx(ctx, tx)
		if err != nil || !found {
			return err
		}
		record.Released = true
		if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "Setup started over", "Owner released: "+record.Login, s.now())
	})
	if err != nil {
		return fmt.Errorf("start over: %w", err)
	}
	return nil
}

// CanStartOver reports whether "Start over" is still possible (no passkey was ever stored).
func (s *Service) CanStartOver(ctx context.Context) (bool, error) {
	owned := false
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		owned, err = everOwned(ctx, tx)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("start over: %w", err)
	}
	return !owned, nil
}

// OwnerLogin is the recorded owner's tailnet login ("" when there is none, or it was claimed locally).
func (s *Service) OwnerLogin(ctx context.Context) (string, error) {
	record, found, err := s.readOwner(ctx)
	if err != nil || !found {
		return "", err
	}
	return record.Login, nil
}

// checkGuess runs one guess at a setup secret under the caller's wrong-guess limit (the same
// count and lockout as the setup code).
func (s *Service) checkGuess(guesser string, wrong error, right func() bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	guesses := s.setupGuesses[guesser]
	if now.Before(guesses.lockedUntil) {
		return ErrSetupCodeLocked
	}
	if right() {
		delete(s.setupGuesses, guesser)
		return nil
	}
	guesses.wrong++
	if guesses.wrong >= config.SetupCodeAttempts {
		guesses = setupGuesses{lockedUntil: now.Add(config.SetupCodeLockout)}
	}
	s.setupGuesses[guesser] = guesses
	return wrong
}
