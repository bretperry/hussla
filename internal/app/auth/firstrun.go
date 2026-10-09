// The first run without the log: the first-run window's one-use link, a fresh setup code on request, "Start over", and who the setup pages name as the owner.
// In the app: the home-network page's "Make it mine" button, the setup screen's "Print a new code", the home page's "Start over", the "Owner: X, not you?" line.
// Used by: internal/app/setup (the home page), internal/httpapi (the setup routes).
// Uses: settings (the owner record, the window's start, the first-passkey marker, the setup code's hash), config.FirstRunWindow, config.SetupCodeReissueGap.
//
// The window (decision 0015): an install that has never stored a passkey, within
// config.FirstRunWindow of the node's owner first being adopted, lets that Tailscale user take the
// register step-up with a link from the home-network page instead of the setup code. Each part
// does one job:
//   - "never owned" keeps it from reopening a finished install;
//   - the start is stored, so the window opens once per install and a restart doesn't reopen it;
//   - the node owner's identity (WhoIs) keeps a neighbor who pressed the button out;
//   - the link is minted only by a form POST from the home-network page (never in a GET), is
//     good once, and a new one replaces the old, so nothing that only reads pages holds a live one.
//
// Residual risk, said plainly: an agent on a device that is both on the home network and signed
// in to Tailscale as the node's owner can, during that first window, POST the form itself, claim,
// and register its own passkey before the owner does. The setup code from the log is the
// recovery: the owner prints a new one, claims with it, and adds a passkey that the link's
// passkeys can't remove, while it can remove theirs (StoredPasskey.FirstRun). Whoever can read the
// container log (NAS admin access) can always take the install back. Outside the window the
// setup code is the only way in, and the owner (by identity) may ask for a new one to be printed,
// which also covers a log that was lost.

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
	// ErrFirstRunClosed: the first-run link no longer works (409): the window ended (it opens once per install), or a passkey exists.
	ErrFirstRunClosed = errors.New("the first-run button has closed: use the setup code from Hussla's log instead")
	// ErrStartOverClosed: this install already has a passkey, so its owner can't be reset from a page (409).
	ErrStartOverClosed = errors.New("this install already has a passkey, so its owner can't be changed here")
	// ErrCodeTooSoon: a new setup code was printed moments ago (429).
	ErrCodeTooSoon = errors.New("a new setup code was printed less than a minute ago: look for the newest \"Setup code\" line in the log")
	// ErrTooManyCodes: config.SetupCodesLive codes are already live (429): use one from the log.
	ErrTooManyCodes = errors.New("several setup codes are already in the log and all of them still work: use the newest \"Setup code\" line")
	// ErrWrongLink: the first-run link isn't the live one (403): already used, or replaced by a newer press.
	ErrWrongLink = errors.New("that setup link was already used or replaced: press Make it mine on the home-network page again, or use the setup code from the log")
	// ErrFirstRunPasskeyLimited: a passkey added through the first-run link can't remove one added
	// with the setup code (403), so the code from the log always wins a raced claim.
	ErrFirstRunPasskeyLimited = errors.New("a passkey added with the first-run link can't remove one added with the setup code: use that passkey, or the setup code from the log")
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

// settingFirstRunStarted records when the first-run window opened (the node's owner was first
// adopted on an install with no passkey). Set, the window never opens again, except that Start over
// (only possible before any passkey) resets it to null so the next owner adopted gets a fresh one.
const settingFirstRunStarted = "auth.firstRunStartedAt"

// FirstRun is the first-run window as the home-network page needs it.
type FirstRun struct {
	Open     bool
	Started  bool      // the window has opened at some point (so a closed one has timed out)
	ClosesAt time.Time // when the window ends (zero before it starts)
}

// FirstRunState reports whether the first-run window is open. It never returns a link: one is
// minted only by MintFirstRunLink, from a POST.
func (s *Service) FirstRunState(ctx context.Context) (FirstRun, error) {
	var state FirstRun
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		state, err = s.firstRunTx(ctx, tx)
		return err
	})
	if err != nil {
		return FirstRun{}, fmt.Errorf("first-run window: %w", err)
	}
	return state, nil
}

func (s *Service) firstRunTx(ctx context.Context, tx store.Tx) (FirstRun, error) {
	var started time.Time
	found, err := readJSON(ctx, tx, settingFirstRunStarted, &started)
	if err != nil || !found || started.IsZero() || s.firstRunWindow <= 0 {
		return FirstRun{}, err
	}
	state := FirstRun{Started: true, ClosesAt: started.Add(s.firstRunWindow)}
	if !s.now().Before(state.ClosesAt) {
		return state, nil
	}
	owned, err := everOwned(ctx, tx)
	if err != nil {
		return FirstRun{}, err
	}
	state.Open = !owned
	return state, nil
}

func (s *Service) firstRunOpen(ctx context.Context) (bool, error) {
	state, err := s.FirstRunState(ctx)
	return state.Open, err
}

// startFirstRunTx opens the first-run window, once per install: only when it is on, never
// started before, and no passkey was ever stored. Called where the node's owner is adopted.
func (s *Service) startFirstRunTx(ctx context.Context, tx store.Tx) error {
	if s.firstRunWindow <= 0 {
		return nil
	}
	var started time.Time
	found, err := readJSON(ctx, tx, settingFirstRunStarted, &started)
	if err != nil || (found && !started.IsZero()) { // null: Start over reset it
		return err
	}
	owned, err := everOwned(ctx, tx)
	if err != nil || owned {
		return err
	}
	return writeJSON(ctx, tx, settingFirstRunStarted, domain.NormalizeTime(s.now()))
}

// MintFirstRunLink makes the one live "Make it mine" secret, replacing any earlier one, while the
// window is open. Only the home-network page's form POST calls it, so the secret is never in a
// page anyone can just read.
func (s *Service) MintFirstRunLink(ctx context.Context) (string, error) {
	open, err := s.firstRunOpen(ctx)
	if err != nil {
		return "", err
	}
	if !open {
		return "", ErrFirstRunClosed
	}
	secret := randomSecret()
	s.mu.Lock()
	s.firstRunLinkHash = hashSecret(secret)
	s.mu.Unlock()
	return secret, nil
}

// ClaimWithLink is Claim with the home-network page's link instead of the setup code. Only the
// owner on the tailnet (the user who owns the node, already adopted) may use it, only inside
// the window, and it grants the one step-up that starts a passkey registration. The link is good
// once: a cancelled prompt means pressing Make it mine again. A passkey it leads to is marked
// FirstRun (see the file comment).
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
	// right runs under s.mu (checkGuess holds it), so spending the link is atomic with checking it.
	right := func() bool {
		if s.firstRunLinkHash == "" || !sameSecret(hashSecret(link), s.firstRunLinkHash) {
			return false
		}
		s.firstRunLinkHash = ""
		return true
	}
	if err := s.checkGuess(setupGuesser(caller), ErrWrongLink, right); err != nil {
		return Principal{}, "", err
	}
	return caller, s.grantStepUp(caller, PurposeRegisterPasskey, true), nil
}

// RequestSetupCode prints a new setup code to the log, beside the live ones: for a lost log
// before setup is done, and for an owner who lost every passkey (recovery). The owner may ask
// (by tailnet identity or local session); before there is an owner, so may anyone who could
// claim with it. At most once per config.SetupCodeReissueGap, and at most config.SetupCodesLive
// codes live at once. A new code never invalidates one already printed: an agent sharing the
// owner's tailnet identity could otherwise make the code in the owner's log stale every minute.
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
	if len(s.setupHashes) >= config.SetupCodesLive {
		s.mu.Unlock()
		return ErrTooManyCodes
	}
	s.lastReissue = now
	s.mu.Unlock()
	who := caller.login
	if who == "" {
		who = "the owner"
	}

	code := newSetupCode()
	var record setupCodeRecord
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		var stored setupCodeRecord
		if _, err := readJSON(ctx, tx, settingSetupCode, &stored); err != nil {
			return err
		}
		if len(stored.live()) >= config.SetupCodesLive {
			return ErrTooManyCodes
		}
		record = setupCodeRecord{Hash: hashSecret(normalizeSetupCode(code)), Earlier: stored.live(), IssuedAt: domain.NormalizeTime(now)}
		if err := writeJSON(ctx, tx, settingSetupCode, record); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "New setup code printed to the log", "Asked for by "+who, now)
	})
	if err != nil {
		return fmt.Errorf("new setup code: %w", err)
	}
	// Wrong-guess lockouts stay: a new code is no reason to let someone who was guessing guess again.
	s.mu.Lock()
	s.setupHashes = record.live()
	s.mu.Unlock()
	s.announce(code)
	return nil
}

// StartOver gives up the recorded owner so the next Tailscale user who owns the node is adopted
// instead. Only before any passkey was ever stored: after that, the owner is fixed for good.
// logout (the node's Tailscale logout) runs last inside the unit of work, after the check and the
// release are written: a passkey stored a moment earlier makes the write fail before logout runs,
// and one stored a moment later waits for this commit, so the node is never logged out while
// its owner stays recorded.
func (s *Service) StartOver(ctx context.Context, logout func(context.Context) error) error {
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		owned, err := everOwned(ctx, tx)
		if err != nil {
			return err
		}
		if owned {
			return ErrStartOverClosed
		}
		record, found, err := readOwnerTx(ctx, tx)
		if err != nil {
			return err
		}
		if found {
			record.Released = true
			if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
				return err
			}
			// Whoever connects next gets a fresh first-run window (docs/install/nas.md step 4.1):
			// the start reads as never set, so the next adoption opens it again.
			if err := writeJSON(ctx, tx, settingFirstRunStarted, nil); err != nil {
				return err
			}
			if err := appendEvent(ctx, tx, domain.ActorSystem, "Setup started over", "Owner released: "+record.Login, s.now()); err != nil {
				return err
			}
		}
		return logout(ctx)
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
// count and lockout as the setup code). The right secret always passes, locked or not: callers are
// keyed by tailnet user, and an agent sharing the owner's identity must not be able to lock the
// owner out. The lockout only refuses more wrong guesses; the secrets' length is what stops guessing.
func (s *Service) checkGuess(guesser string, wrong error, right func() bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	guesses := s.setupGuesses[guesser]
	if right() {
		delete(s.setupGuesses, guesser)
		return nil
	}
	if now.Before(guesses.lockedUntil) {
		return ErrSetupCodeLocked
	}
	guesses.wrong++
	if guesses.wrong >= config.SetupCodeAttempts {
		guesses = setupGuesses{lockedUntil: now.Add(config.SetupCodeLockout)}
	}
	s.setupGuesses[guesser] = guesses
	return wrong
}
