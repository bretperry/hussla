// The owner: who it is, how a tailnet identity is matched to it, and how an install is claimed with the setup code.
// In the app: the "enter setup code" screen; every tailnet request's identity check.
// Used by: internal/httpapi (TailnetPrincipal, Claim, SetupStatus), cmd/hussla (AdoptNodeOwner, IssueSetupCode at startup).
//
// Fail closed: until an owner record exists nobody is the owner, and a tailnet identity is the
// owner only when its user id equals the recorded one and its device is not tagged. The setup code
// is needed twice in a life: to claim a tagged node (no owning user to adopt), and to register the
// first passkey (so an agent with the owner's tailnet identity can't register its own before the
// owner does). It is printed to the log only, guessed at most config.SetupCodeAttempts times, and
// used once.

package auth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// Settings keys this package owns. They never leave through the API: GET /api/config reads only the search config.
const (
	settingOwner    = "auth.owner"
	settingPasskeys = "auth.passkeys"
	settingSessions = "auth.sessions"
)

// ownerRecord is the claimed owner. TailnetUserID is empty for an install claimed from the local listener only.
type ownerRecord struct {
	TailnetUserID string    `json:"tailnetUserId,omitempty"`
	Login         string    `json:"login,omitempty"`
	Name          string    `json:"name,omitempty"`
	Handle        []byte    `json:"handle"` // the WebAuthn user handle, random
	ClaimedAt     time.Time `json:"claimedAt"`
}

// displayName is how the owner shows in the log: their name, else their login, else "owner".
func (record ownerRecord) displayName() string {
	for _, candidate := range []string{record.Name, record.Login} {
		if strings.TrimSpace(candidate) != "" {
			return candidate
		}
	}
	return "owner"
}

// readJSON reads one settings value into target; found is false when the key is unset.
func readJSON(ctx context.Context, tx store.Tx, key string, target any) (bool, error) {
	text, err := tx.Settings().Get(ctx, key)
	if errors.Is(err, storeerr.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s: %w", key, err)
	}
	if err := json.Unmarshal([]byte(text), target); err != nil {
		// A damaged auth record must not read as "no owner" (that would reopen setup to anyone).
		return false, fmt.Errorf("read %s: damaged: %w", key, err)
	}
	return true, nil
}

func writeJSON(ctx context.Context, tx store.Tx, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", key, err)
	}
	if err := tx.Settings().Set(ctx, key, string(encoded)); err != nil {
		return fmt.Errorf("write %s: %w", key, err)
	}
	return nil
}

func (s *Service) readOwner(ctx context.Context) (ownerRecord, bool, error) {
	var record ownerRecord
	var found bool
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		found, err = readJSON(ctx, tx, settingOwner, &record)
		return err
	})
	if err != nil {
		return ownerRecord{}, false, fmt.Errorf("read owner: %w", err)
	}
	return record, found, nil
}

// Enrolled is true once an owner is recorded.
func (s *Service) Enrolled(ctx context.Context) (bool, error) {
	_, found, err := s.readOwner(ctx)
	return found, err
}

// AdoptNodeOwner records the user who owns an untagged Hussla node as the owner, when no owner
// is recorded yet. A recorded owner is never replaced (a node re-authenticated by someone else
// doesn't hand them the data); adopted is false then.
func (s *Service) AdoptNodeOwner(ctx context.Context, nodeOwner TailnetPeer) (adopted bool, err error) {
	if nodeOwner.Tagged || nodeOwner.UserID == "" {
		return false, nil
	}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		var record ownerRecord
		found, err := readJSON(ctx, tx, settingOwner, &record)
		if err != nil || found {
			return err
		}
		adopted = true
		record = ownerRecord{TailnetUserID: nodeOwner.UserID, Login: nodeOwner.Login, Name: nodeOwner.Name, Handle: randomHandle(), ClaimedAt: domain.NormalizeTime(s.now())}
		if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "Owner set", "The tailnet user who owns this node: "+nodeOwner.Login, s.now())
	})
	if err != nil {
		return false, fmt.Errorf("adopt node owner: %w", err)
	}
	return adopted, nil
}

func randomHandle() []byte {
	handle := make([]byte, 32)
	_, _ = rand.Read(handle)
	return handle
}

// TailnetPrincipal turns a WhoIs answer into a principal: the owner when the user id matches the
// recorded owner and the device is untagged, a peer otherwise (and always before enrollment).
func (s *Service) TailnetPrincipal(ctx context.Context, peer TailnetPeer) (Principal, error) {
	record, found, err := s.readOwner(ctx)
	if err != nil {
		return Principal{}, err
	}
	asPeer := Principal{role: RolePeer, name: peer.Login, login: peer.Login, peer: peer, binding: "peer:" + peer.UserID}
	if !found || peer.Tagged || peer.UserID == "" || record.TailnetUserID == "" || !sameSecret(peer.UserID, record.TailnetUserID) {
		return asPeer, nil
	}
	return Principal{role: RoleOwner, name: record.displayName(), login: peer.Login, peer: peer, binding: "tailnet:" + peer.UserID}, nil
}

// ---- Setup code

// setupCode is the one live code (empty when none). Guarded by Service.mu.
type setupCode struct {
	code     string
	attempts int
}

// setupAlphabet is Crockford's base32: no I, L, O or U, so a code read off a log can't be misread.
const setupAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newSetupCode is 12 characters (60 bits) as XXXX-XXXX-XXXX.
func newSetupCode() string {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	var builder strings.Builder
	for index, value := range buffer {
		if index > 0 && index%4 == 0 {
			builder.WriteByte('-')
		}
		builder.WriteByte(setupAlphabet[int(value)%len(setupAlphabet)]) // 256 is a multiple of 32: no bias
	}
	return builder.String()
}

// normalizeSetupCode reads what a person typed: case, dashes and spaces don't matter, and the
// letters people confuse with digits count as those digits.
func normalizeSetupCode(typed string) string {
	replacer := strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1")
	return replacer.Replace(strings.ToUpper(strings.TrimSpace(typed)))
}

// SetupStatus is what the setup screen needs.
type SetupStatus struct {
	Enrolled bool
	Passkeys int  // registered for this relying party
	CodeLive bool // a setup code is waiting in the log
}

// SetupNeeded reports whether this install still needs the setup code (no owner, or no passkey at all).
func (s *Service) SetupNeeded(ctx context.Context) (bool, error) {
	_, enrolled, err := s.readOwner(ctx)
	if err != nil || !enrolled {
		return !enrolled, err
	}
	passkeys, err := s.passkeys(ctx)
	return len(passkeys) == 0, err
}

// IssueSetupCode makes and announces a setup code when setup is still needed and none is live.
func (s *Service) IssueSetupCode(ctx context.Context) error {
	needed, err := s.SetupNeeded(ctx)
	if err != nil || !needed {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setup.code == "" {
		s.setup = setupCode{code: newSetupCode()}
		s.announce(s.setup.code)
	}
	return nil
}

// Status reports the setup state for a relying party, issuing a code if setup needs one.
func (s *Service) Status(ctx context.Context, rp RelyingParty) (SetupStatus, error) {
	if err := s.IssueSetupCode(ctx); err != nil {
		return SetupStatus{}, err
	}
	enrolled, err := s.Enrolled(ctx)
	if err != nil {
		return SetupStatus{}, err
	}
	passkeys, err := s.passkeys(ctx)
	if err != nil {
		return SetupStatus{}, err
	}
	count := 0
	for _, passkey := range passkeys {
		if passkey.RPID == rp.ID {
			count++
		}
	}
	s.mu.Lock()
	live := s.setup.code != ""
	s.mu.Unlock()
	return SetupStatus{Enrolled: enrolled, Passkeys: count, CodeLive: live}, nil
}

// Claim spends the setup code. Before enrollment a tailnet peer on an untagged device becomes the
// owner (a local session caller does too, with no tailnet user). After enrollment only the owner
// may spend it. Either way it returns a step-up token for registering a passkey, and the caller
// as the owner.
func (s *Service) Claim(ctx context.Context, caller Principal, typed string) (Principal, string, error) {
	if caller.role == RoleAgent || caller.role == RoleNone {
		return Principal{}, "", ErrNotOwner
	}
	if err := s.spendSetupCode(typed); err != nil {
		return Principal{}, "", err
	}
	owner := caller
	if caller.role == RolePeer {
		if caller.peer.Tagged || caller.peer.UserID == "" {
			return Principal{}, "", ErrNotOwner
		}
		claimed := false
		err := s.store.Atomically(ctx, func(tx store.Tx) error {
			var record ownerRecord
			found, err := readJSON(ctx, tx, settingOwner, &record)
			// An owner recorded from the local listener has no tailnet user yet; the code binds one.
			if err != nil || (found && record.TailnetUserID != "") {
				return err
			}
			claimed = true
			handle := record.Handle
			if !found {
				handle = randomHandle()
			}
			record = ownerRecord{TailnetUserID: caller.peer.UserID, Login: caller.peer.Login, Name: caller.peer.Name, Handle: handle, ClaimedAt: domain.NormalizeTime(s.now())}
			if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
				return err
			}
			return appendEvent(ctx, tx, domain.ActorSystem, "Owner set", "Claimed with the setup code by "+caller.peer.Login, s.now())
		})
		if err != nil {
			return Principal{}, "", fmt.Errorf("claim: %w", err)
		}
		if !claimed {
			// Someone else is the owner: a peer can't spend the code to take over.
			return Principal{}, "", ErrNotOwner
		}
		var err2 error
		owner, err2 = s.TailnetPrincipal(ctx, caller.peer)
		if err2 != nil {
			return Principal{}, "", err2
		}
	}
	if !owner.IsOwner() {
		return Principal{}, "", ErrNotOwner
	}
	return owner, s.grantStepUp(owner, PurposeRegisterPasskey), nil
}

// spendSetupCode checks a typed code against the live one, burning it on success and replacing it
// after too many wrong tries.
func (s *Service) spendSetupCode(typed string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setup.code == "" {
		return ErrSetupClosed
	}
	if sameSecret(normalizeSetupCode(typed), normalizeSetupCode(s.setup.code)) {
		s.setup = setupCode{}
		return nil
	}
	s.setup.attempts++
	if s.setup.attempts >= config.SetupCodeAttempts {
		s.setup = setupCode{code: newSetupCode()}
		s.announce(s.setup.code)
	}
	return ErrWrongSetupCode
}

// ensureLocalOwner records an owner for an install first reached through the local listener: a
// sign-in proves access to the data directory, which is ownership. The record has no tailnet user
// until the owner spends a setup code from the tailnet.
func (s *Service) ensureLocalOwner(ctx context.Context) (ownerRecord, error) {
	var record ownerRecord
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		found, err := readJSON(ctx, tx, settingOwner, &record)
		if err != nil || found {
			return err
		}
		record = ownerRecord{Handle: randomHandle(), ClaimedAt: domain.NormalizeTime(s.now())}
		if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "Owner set", "Signed in on this computer with hussla open", s.now())
	})
	if err != nil {
		return ownerRecord{}, fmt.Errorf("record local owner: %w", err)
	}
	return record, nil
}
