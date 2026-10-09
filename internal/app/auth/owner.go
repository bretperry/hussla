// The owner: who it is, how a tailnet identity is matched to it, and how an install is claimed with the setup code.
// In the app: the "enter setup code" screen; every tailnet request's identity check.
// Used by: internal/httpapi (TailnetPrincipal, Claim, SetupStatus), cmd/hussla (AdoptNodeOwner, PinRefuses, IssueSetupCode at startup).
//
// Fail closed: until an owner record exists nobody is the owner, and a tailnet identity is the
// owner only when its user id equals the recorded one and its device is not tagged. The setup code
// is needed to claim a tagged node (no owning user to adopt), and to register the first passkey on
// each address (so an agent with the owner's tailnet identity, or on the owner's laptop, can't
// register its own before the owner does). It is printed to the log only, stored only as a hash (so
// it stays the same across restarts until used), and spent by the first passkey stored, not by the
// claim: a cancelled Face ID prompt can be retried with the same code. Nobody can make the code in
// the owner's log stale or unusable: it never changes on a wrong guess, a new code is added beside
// it rather than replacing it, and the right code always passes. A caller (one tailnet user, or the
// local listener) with config.SetupCodeAttempts wrong guesses has further wrong guesses refused for
// config.SetupCodeLockout, but that lockout never stops the right code: an agent sharing the
// owner's tailnet identity could otherwise lock the owner out at will. What makes guessing hopeless
// is the code's length (80 bits), not the lockout.

package auth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// Settings keys this package owns. They never leave through the API: GET /api/config reads only the search config.
const (
	settingOwner     = "auth.owner"
	settingPasskeys  = "auth.passkeys"
	settingSessions  = "auth.sessions"
	settingSetupCode = "auth.setupCode"
	// settingFirstPasskey records when the first passkey was ever stored. Its presence closes the
	// first-run window and "Start over" for good, even if passkeys are later removed.
	settingFirstPasskey = "auth.firstPasskeyAt"
)

// ownerRecord is the claimed owner. TailnetUserID is empty for an install claimed from the local listener only.
type ownerRecord struct {
	TailnetUserID string    `json:"tailnetUserId,omitempty"`
	Login         string    `json:"login,omitempty"`
	Name          string    `json:"name,omitempty"`
	Handle        []byte    `json:"handle"` // the WebAuthn user handle, random
	ClaimedAt     time.Time `json:"claimedAt"`
	// Released marks an owner given up with "Start over" before any passkey existed: it reads as
	// no owner at all, so the next node owner is adopted. Kept, not deleted, for the history.
	Released bool `json:"released,omitempty"`
	// Node is the server's own node when the owner was set: its user (unless tagged) and tailnet.
	// The node-owner check compares against it, so a tagged node or a node logged in as someone
	// other than a pinned owner (HUSSLA_OWNER_LOGIN) is still checked. Nil on a record written
	// before it existed, or claimed only on the local listener.
	Node *nodeBinding `json:"node,omitempty"`
}

// nodeBinding is the node an owner was set on.
type nodeBinding struct {
	UserID  string `json:"userId,omitempty"` // empty when tagged
	Tagged  bool   `json:"tagged,omitempty"`
	Tailnet string `json:"tailnet,omitempty"`
}

// bindingOf records a logged-in node; nil when the node is logged out (nothing to bind).
func bindingOf(node TailnetPeer) *nodeBinding {
	if node.UserID == "" && !node.Tagged {
		return nil
	}
	binding := &nodeBinding{Tagged: node.Tagged, Tailnet: node.Tailnet}
	if !node.Tagged {
		binding.UserID = node.UserID
	}
	return binding
}

// currentNode is the server's own node now (logged out, or no tailnet: the zero peer).
func (s *Service) currentNode() TailnetPeer {
	if s.node == nil {
		return TailnetPeer{}
	}
	return s.node.NodeOwner()
}

// nodeMismatch reports whether a logged-in node isn't the owner's: on another tailnet than the one
// the owner was set on (tagged or not), or untagged as a user who is neither the owner nor the
// node's user when the owner was set (the HUSSLA_OWNER_LOGIN case).
func (record ownerRecord) nodeMismatch(node TailnetPeer) bool {
	bound := record.Node
	if bound != nil && bound.Tailnet != "" && !sameSecret(node.Tailnet, bound.Tailnet) {
		return true
	}
	if node.Tagged || node.UserID == "" {
		return false // a tagged node on the owner's tailnet (or one recorded before tailnets were)
	}
	if record.TailnetUserID != "" && sameSecret(node.UserID, record.TailnetUserID) {
		return false
	}
	if bound != nil && bound.UserID != "" && sameSecret(node.UserID, bound.UserID) {
		return false
	}
	return record.TailnetUserID != ""
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

// readOwnerTx reads the owner record inside a unit of work; a released record counts as none.
func readOwnerTx(ctx context.Context, tx store.Tx) (ownerRecord, bool, error) {
	var record ownerRecord
	found, err := readJSON(ctx, tx, settingOwner, &record)
	if err != nil || !found || record.Released {
		return ownerRecord{}, false, err
	}
	return record, true, nil
}

func (s *Service) readOwner(ctx context.Context) (ownerRecord, bool, error) {
	var record ownerRecord
	var found bool
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		record, found, err = readOwnerTx(ctx, tx)
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
	if nodeOwner.Tagged || nodeOwner.UserID == "" || !s.allowedLogin(nodeOwner.Login) {
		return false, nil
	}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		existing, found, err := readOwnerTx(ctx, tx)
		if err != nil {
			return err
		}
		if found {
			// An owner recorded before the first-run window existed gets it once, when this node is theirs.
			if existing.TailnetUserID != "" && sameSecret(existing.TailnetUserID, nodeOwner.UserID) && !existing.nodeMismatch(nodeOwner) {
				return s.startFirstRunTx(ctx, tx)
			}
			return nil
		}
		adopted = true
		record := ownerRecord{
			TailnetUserID: nodeOwner.UserID, Login: nodeOwner.Login, Name: nodeOwner.Name, Handle: randomHandle(),
			ClaimedAt: domain.NormalizeTime(s.now()), Node: bindingOf(nodeOwner),
		}
		if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
			return err
		}
		// The first adoption on an install with no passkey is when "Make it mine" can first work.
		if err := s.startFirstRunTx(ctx, tx); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "Owner set", "The tailnet user who owns this node: "+nodeOwner.Login, s.now())
	})
	if err != nil {
		return false, fmt.Errorf("adopt node owner: %w", err)
	}
	return adopted, nil
}

// NodeOwnerMismatch reports whether the node is logged in to Tailscale as someone other than the
// owner: someone signed it in again (after a key expiry, say) with their own account, or moved it
// to their own tailnet, tagged or not. The server then fails closed on the tailnet and the
// home-network page offers to log the node out so the owner can connect again. The tailnet is
// compared when the owner record holds one (every owner set since it was added); a logged-out node
// is never a mismatch.
func (s *Service) NodeOwnerMismatch(ctx context.Context, nodeOwner TailnetPeer) (bool, error) {
	if nodeOwner.UserID == "" && !nodeOwner.Tagged {
		return false, nil
	}
	record, found, err := s.readOwner(ctx)
	if err != nil || !found {
		return false, err
	}
	return record.nodeMismatch(nodeOwner), nil
}

// PinRefuses reports whether HUSSLA_OWNER_LOGIN keeps the untagged user who owns this node from
// being adopted as the owner, and the pinned login (for the log line that names both).
func (s *Service) PinRefuses(nodeOwner TailnetPeer) (pinned string, refuses bool) {
	return s.pinned, !nodeOwner.Tagged && nodeOwner.UserID != "" && !s.allowedLogin(nodeOwner.Login)
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

// setupCodeRecord is the live setup codes as stored (settings auth.setupCode): hashes only, so a
// leaked backup doesn't hold a code. Hash is the newest; Earlier holds codes printed before it,
// still good (a new code never invalidates a printed one). An empty Hash means no code is live.
type setupCodeRecord struct {
	Hash     string    `json:"hash,omitempty"`
	Earlier  []string  `json:"earlier,omitempty"`
	IssuedAt time.Time `json:"issuedAt,omitzero"`
}

// live is every hash that still claims, newest first.
func (record setupCodeRecord) live() []string {
	if record.Hash == "" {
		return nil
	}
	return append([]string{record.Hash}, record.Earlier...)
}

// setupGuesses counts one caller's wrong setup codes. Guarded by Service.mu.
type setupGuesses struct {
	wrong       int
	lockedUntil time.Time
}

// setupAlphabet is Crockford's base32: no I, L, O or U, so a code read off a log can't be misread.
const setupAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newSetupCode is 16 characters (80 bits) as XXXX-XXXX-XXXX-XXXX: long enough that guessing is
// hopeless even with no lockout at all (at a million guesses a second, about 38,000 years on average).
func newSetupCode() string {
	buffer := make([]byte, 16)
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
	// OwnerLogin names the recorded owner's tailnet login ("" with no tailnet owner yet), for the
	// setup pages' "Owner: X" and the refusal page's "this Hussla belongs to X".
	OwnerLogin string
	// CanStartOver: no passkey was ever stored, so the home-network page can still release the owner.
	CanStartOver bool
	// FirstRunOpen: the first-run window is open (the home-network page's link works).
	FirstRunOpen bool
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
// A code stored by an earlier run is kept (and only reminded of), so the code in the log stays
// good across restarts until a passkey is stored.
func (s *Service) IssueSetupCode(ctx context.Context) error {
	needed, err := s.SetupNeeded(ctx)
	if err != nil || !needed {
		return err
	}
	return s.issueSetupCode(ctx)
}

func (s *Service) issueSetupCode(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.setupHashes) > 0 {
		return nil
	}
	var stored setupCodeRecord
	err := s.store.View(ctx, func(tx store.Tx) error {
		_, err := readJSON(ctx, tx, settingSetupCode, &stored)
		return err
	})
	if err != nil {
		return fmt.Errorf("read setup code: %w", err)
	}
	if stored.Hash != "" {
		s.setupHashes = stored.live()
		s.remind(stored.IssuedAt)
		return nil
	}
	code := newSetupCode()
	record := setupCodeRecord{Hash: hashSecret(normalizeSetupCode(code)), IssuedAt: domain.NormalizeTime(s.now())}
	if err := s.store.Atomically(ctx, func(tx store.Tx) error { return writeJSON(ctx, tx, settingSetupCode, record) }); err != nil {
		return fmt.Errorf("store setup code: %w", err)
	}
	s.setupHashes = record.live()
	s.announce(code)
	return nil
}

// Status reports the setup state for a relying party. It issues a code when this address has no
// passkey yet: a passkey works on one address only, so the owner's first passkey on a second
// address (the local listener after the tailnet one) needs the code from the log again.
func (s *Service) Status(ctx context.Context, rp RelyingParty) (SetupStatus, error) {
	enrolled, err := s.Enrolled(ctx)
	if err != nil {
		return SetupStatus{}, err
	}
	passkeys, err := s.passkeys(ctx)
	if err != nil {
		return SetupStatus{}, err
	}
	count := len(forRelyingParty(passkeys, rp.ID))
	if !enrolled || count == 0 {
		if err := s.issueSetupCode(ctx); err != nil {
			return SetupStatus{}, err
		}
	}
	s.mu.Lock()
	live := len(s.setupHashes) > 0
	s.mu.Unlock()
	status := SetupStatus{Enrolled: enrolled, Passkeys: count, CodeLive: live}
	if status.FirstRunOpen, err = s.firstRunOpen(ctx); err != nil {
		return SetupStatus{}, err
	}
	if status.CanStartOver, err = s.CanStartOver(ctx); err != nil {
		return SetupStatus{}, err
	}
	if status.OwnerLogin, err = s.OwnerLogin(ctx); err != nil {
		return SetupStatus{}, err
	}
	return status, nil
}

// Claim checks the setup code. Before enrollment a tailnet peer on an untagged device becomes the
// owner (a local session caller does too, with no tailnet user). After enrollment only the owner
// may use it. Either way it returns a step-up token for registering a passkey, and the caller
// as the owner. The code stays live until a passkey is stored (FinishRegistration), so a
// cancelled passkey prompt can claim again with the same code.
func (s *Service) Claim(ctx context.Context, caller Principal, typed string) (Principal, string, error) {
	if caller.role == RoleAgent || caller.role == RoleNone {
		return Principal{}, "", ErrNotOwner
	}
	// Refuse whoever could never claim before touching the code, so they can't use up guesses.
	if caller.role == RolePeer {
		record, found, err := s.readOwner(ctx)
		if err != nil {
			return Principal{}, "", err
		}
		if caller.peer.Tagged || caller.peer.UserID == "" || !s.allowedLogin(caller.peer.Login) || (found && record.TailnetUserID != "") {
			return Principal{}, "", ErrNotOwner
		}
	}
	if err := s.checkSetupCode(setupGuesser(caller), typed); err != nil {
		return Principal{}, "", err
	}
	owner := caller
	if caller.role == RolePeer {
		claimed := false
		err := s.store.Atomically(ctx, func(tx store.Tx) error {
			record, found, err := readOwnerTx(ctx, tx)
			// An owner recorded from the local listener has no tailnet user yet; the code binds one.
			if err != nil || (found && record.TailnetUserID != "") {
				return err
			}
			claimed = true
			handle := record.Handle
			if !found {
				handle = randomHandle()
			}
			// The node as it is now: a tagged node, or one logged in as someone other than a pinned
			// owner, is still the owner's node for the node-owner check.
			record = ownerRecord{
				TailnetUserID: caller.peer.UserID, Login: caller.peer.Login, Name: caller.peer.Name, Handle: handle,
				ClaimedAt: domain.NormalizeTime(s.now()), Node: bindingOf(s.currentNode()),
			}
			if err := writeJSON(ctx, tx, settingOwner, record); err != nil {
				return err
			}
			return appendEvent(ctx, tx, domain.ActorSystem, "Owner set", "Claimed with the setup code by "+caller.peer.Login, s.now())
		})
		if err != nil {
			return Principal{}, "", fmt.Errorf("claim: %w", err)
		}
		if !claimed {
			// Someone else is the owner: a peer can't use the code to take over.
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
	return owner, s.grantStepUp(owner, PurposeRegisterPasskey, false), nil
}

// setupGuesser is whose wrong guesses a claim counts against: the tailnet user, or the local
// listener as a whole (reaching it already takes the data directory).
func setupGuesser(caller Principal) string {
	if caller.peer.UserID != "" {
		return "tailnet:" + caller.peer.UserID
	}
	return "local"
}

// checkSetupCode checks a typed code against every live one. It doesn't spend it (a stored passkey
// does). The right code always passes; wrong guesses count toward the caller's lockout (checkGuess).
func (s *Service) checkSetupCode(guesser, typed string) error {
	s.mu.Lock()
	live := slices.Clone(s.setupHashes)
	s.mu.Unlock()
	if len(live) == 0 {
		return ErrSetupClosed
	}
	typedHash := hashSecret(normalizeSetupCode(typed))
	return s.checkGuess(guesser, ErrWrongSetupCode, func() bool {
		matched := false
		for _, hash := range live {
			matched = sameSecret(typedHash, hash) || matched // no early exit: the same work for every code
		}
		return matched
	})
}

// ensureLocalOwner records an owner for an install first reached through the local listener: a
// sign-in proves access to the data directory, which is ownership. The record has no tailnet user
// until the owner spends a setup code from the tailnet.
func (s *Service) ensureLocalOwner(ctx context.Context) (ownerRecord, error) {
	var record ownerRecord
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		var found bool
		var err error
		record, found, err = readOwnerTx(ctx, tx)
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
