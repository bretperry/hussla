// The auth use-case: turns a proof (an agent key, a tailnet WhoIs answer, a session cookie) into a Principal, and manages each proof.
// In the app: every request; Settings → agent keys; the setup screen; `hussla open`; every passkey tap.
// Used by: internal/httpapi (identity, owner-only checks), cmd/hussla (setup code at startup).
// Uses: store.Store (tokens, settings), the ports in ports.go, config auth knobs.
//
// What lives where: agent keys are rows (tokens repository, hash only); the owner record, passkeys
// and sessions are JSON values in settings (one person's handful, read on each request through one
// unit of work). Challenges, step-up tokens and wrong setup-code guesses live in memory: they are
// minutes long, and a restart that forgets them only means one more tap. The setup code's hash is
// a settings value, so the code in the log stays good across a restart.

package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/app/tokens"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// AgentKeyPrefix starts every agent key, so a leaked one is recognizable in a log or a paste.
const AgentKeyPrefix = "hussla_"

// Options builds a Service.
type Options struct {
	Store    store.Store
	Ceremony Ceremony
	SignIn   SignInTokens     // nil when there is no local listener
	Now      func() time.Time // time.Now when nil
	// AnnounceSetupCode prints a new setup code where the owner will find it (the log). Required.
	AnnounceSetupCode func(code string)
	// RemindSetupCode says, at a start that finds a code an earlier run announced, that the code
	// printed then (at issuedAt) is still the live one. Only its hash is stored, so it can't be printed again.
	RemindSetupCode func(issuedAt time.Time)
	// OwnerLogin pins the owner to one tailnet login (HUSSLA_OWNER_LOGIN). When set, only that
	// login can claim with the setup code or be adopted as the node's owner; "" allows anyone
	// eligible. It never replaces an owner already recorded.
	OwnerLogin string
	// FirstRunWindow is how long after New the home-network page's first-run link works on an
	// install that never stored a passkey; zero means config.FirstRunWindow, negative turns it off.
	FirstRunWindow time.Duration
}

// Service is the auth use-case. It is safe for concurrent use.
type Service struct {
	store    store.Store
	ceremony Ceremony
	signIn   SignInTokens
	now      func() time.Time
	announce func(code string)
	remind   func(issuedAt time.Time)
	pinned   string
	// firstRunUntil ends the first-run window (the zero time when it is off); firstRunLink is the
	// window's one link secret, minted at New and never stored, so a restart mints a new one.
	firstRunUntil time.Time
	firstRunLink  string

	mu           sync.Mutex
	lastReissue  time.Time // the last "print a new setup code", for config.SetupCodeReissueGap
	setupHash    string    // the live setup code's hash ("" when none), mirrored from settings
	setupGuesses map[string]setupGuesses
	challenges   map[string]challenge
	stepUps      map[string]stepUp
	usedSignIn   map[string]time.Time
}

// New builds the Service.
func New(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	announce := options.AnnounceSetupCode
	if announce == nil {
		announce = func(string) {}
	}
	remind := options.RemindSetupCode
	if remind == nil {
		remind = func(time.Time) {}
	}
	window := options.FirstRunWindow
	if window == 0 {
		window = config.FirstRunWindow
	}
	var firstRunUntil time.Time
	if window > 0 {
		firstRunUntil = now().Add(window)
	}
	return &Service{
		store: options.Store, ceremony: options.Ceremony, signIn: options.SignIn, now: now, announce: announce, remind: remind,
		pinned:        strings.TrimSpace(options.OwnerLogin),
		firstRunUntil: firstRunUntil, firstRunLink: randomSecret(),
		setupGuesses: map[string]setupGuesses{},
		challenges:   map[string]challenge{}, stepUps: map[string]stepUp{}, usedSignIn: map[string]time.Time{},
	}
}

// allowedLogin reports whether a tailnet login may become the owner under the pin.
// Tailnet logins are email-like, so case is ignored.
func (s *Service) allowedLogin(login string) bool {
	return s.pinned == "" || strings.EqualFold(strings.TrimSpace(login), s.pinned)
}

// randomSecret is 32 random bytes as unpadded base64url (256 bits: no guessing, no rate limit needed).
func randomSecret() string {
	buffer := make([]byte, 32)
	_, _ = rand.Read(buffer) // crypto/rand.Read never fails (Go 1.24+); it crashes the process instead
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// hashSecret is how a secret is stored and looked up: SHA-256 hex. Plain SHA-256 is enough for
// 256-bit random secrets; a slow hash only matters for secrets a person chose.
func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// sameSecret compares two secrets in constant time.
func sameSecret(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// ---- Agent keys

// Agent resolves a bearer key. A revoked or unknown key is ErrUnauthorized; a good one records its use.
func (s *Service) Agent(ctx context.Context, secret string) (Principal, error) {
	if !strings.HasPrefix(secret, AgentKeyPrefix) {
		return Principal{}, ErrUnauthorized
	}
	hash := hashSecret(secret)
	var token tokens.Token
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		found, err := tx.Tokens().GetByHash(ctx, hash)
		if err != nil {
			return err
		}
		if found.IsRevoked() {
			return ErrUnauthorized
		}
		token = found
		return tx.Tokens().Touch(ctx, found.ID, s.now())
	})
	switch {
	case errors.Is(err, storeerr.ErrNotFound), errors.Is(err, ErrUnauthorized):
		return Principal{}, ErrUnauthorized
	case err != nil:
		return Principal{}, fmt.Errorf("check agent key: %w", err)
	}
	return Principal{role: RoleAgent, name: token.Name, keyID: token.ID, binding: "agent:" + token.ID}, nil
}

// AgentKeyName validates a key's name: trimmed, the default when empty, printable, capped.
func AgentKeyName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = config.DefaultAgentKeyName
	}
	if len(name) > config.AgentKeyNameMaxLength {
		return "", &domain.ValidationError{Field: "name", Problem: "is too long"}
	}
	for _, character := range name {
		if !unicode.IsPrint(character) {
			return "", &domain.ValidationError{Field: "name", Problem: "must be printable text"}
		}
	}
	return name, nil
}

// CreateKey makes an agent key and logs it. The secret is returned here and nowhere else.
func (s *Service) CreateKey(ctx context.Context, owner Principal, name string) (tokens.Token, string, error) {
	if !owner.IsOwner() {
		return tokens.Token{}, "", ErrNotOwner
	}
	name, err := AgentKeyName(name)
	if err != nil {
		return tokens.Token{}, "", err
	}
	secret := AgentKeyPrefix + randomSecret()
	now := domain.NormalizeTime(s.now())
	token := tokens.Token{ID: randomID(), Name: name, Hash: hashSecret(secret), CreatedAt: now}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		if err := tx.Tokens().Create(ctx, token); err != nil {
			return err
		}
		return appendEvent(ctx, tx, owner.Actor(), "Created agent key", name, now)
	})
	if err != nil {
		return tokens.Token{}, "", fmt.Errorf("create agent key: %w", err)
	}
	return token, secret, nil
}

// ListKeys returns every agent key (hashes stay inside: the caller encodes only id, name and times).
func (s *Service) ListKeys(ctx context.Context, owner Principal) ([]tokens.Token, error) {
	if !owner.IsOwner() {
		return nil, ErrNotOwner
	}
	var list []tokens.Token
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		list, err = tx.Tokens().List(ctx)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list agent keys: %w", err)
	}
	return list, nil
}

// RevokeKey revokes a key; changed is false when it was already revoked or never existed.
func (s *Service) RevokeKey(ctx context.Context, owner Principal, id string) (bool, error) {
	if !owner.IsOwner() {
		return false, ErrNotOwner
	}
	changed := false
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		var err error
		changed, err = tx.Tokens().Revoke(ctx, id, s.now())
		if errors.Is(err, storeerr.ErrNotFound) {
			return nil
		}
		if err != nil || !changed {
			return err
		}
		return appendEvent(ctx, tx, owner.Actor(), "Revoked agent key", id, s.now())
	})
	if err != nil {
		return false, fmt.Errorf("revoke agent key: %w", err)
	}
	return changed, nil
}

// randomID is a short random id for keys and passkey prompts.
func randomID() string {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// appendEvent writes one search-wide activity line inside the caller's unit of work.
func appendEvent(ctx context.Context, tx store.Tx, actor, action, detail string, at time.Time) error {
	event, err := domain.NewEvent("", actor, action, detail, at)
	if err != nil {
		return fmt.Errorf("event: %w", err)
	}
	if _, err := tx.Events().Append(ctx, event); err != nil {
		return fmt.Errorf("append event: %w", err)
	}
	return nil
}
