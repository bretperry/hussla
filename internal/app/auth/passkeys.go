// Passkey step-up: registering the owner's passkeys, and trading a fresh passkey tap for a one-action step-up token.
// In the app: setup's "add a passkey" step; the Face ID / Touch ID prompt before approve, delete, settings, keys.
// Used by: internal/httpapi (the passkey routes, and every owner-only route's ConsumeStepUp).
// Uses: the Ceremony port (WebAuthn in internal/adapters/passkey), settings for stored credentials.
//
// Why a token per action and not a "sudo mode" window: an agent on the owner's laptop can reach
// the owner's tailnet identity, and a window would let it ride on the owner's last tap. A step-up
// token is bound to the caller (its tailnet user or session), to one purpose ("POST
// /api/emails/e1/approve"), lives config.StepUpLifetime, and is spent by the first use.

package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// PurposeRegisterPasskey is the step-up purpose that starts a passkey registration: the setup
// code grants it once, and afterwards a tap with an existing passkey does.
const PurposeRegisterPasskey = "POST /api/passkeys/register/begin"

// challengeKind says which ceremony a pending challenge belongs to.
type challengeKind int

const (
	challengeRegister challengeKind = iota
	challengeAssert
)

type challenge struct {
	kind    challengeKind
	binding string
	purpose string
	rpID    string
	session []byte
	expires time.Time
}

type stepUp struct {
	binding string
	purpose string
	expires time.Time
}

func (s *Service) passkeys(ctx context.Context) ([]StoredPasskey, error) {
	var list []StoredPasskey
	err := s.store.View(ctx, func(tx store.Tx) error {
		_, err := readJSON(ctx, tx, settingPasskeys, &list)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("read passkeys: %w", err)
	}
	return list, nil
}

// Passkeys lists the registered passkeys for the owner (names and dates; credentials stay inside).
func (s *Service) Passkeys(ctx context.Context, owner Principal) ([]StoredPasskey, error) {
	if !owner.IsOwner() {
		return nil, ErrNotOwner
	}
	return s.passkeys(ctx)
}

func forRelyingParty(list []StoredPasskey, rpID string) []StoredPasskey {
	var matching []StoredPasskey
	for _, passkey := range list {
		if passkey.RPID == rpID {
			matching = append(matching, passkey)
		}
	}
	return matching
}

func (s *Service) passkeyUser(ctx context.Context) (PasskeyUser, error) {
	record, found, err := s.readOwner(ctx)
	if err != nil {
		return PasskeyUser{}, err
	}
	if !found {
		return PasskeyUser{}, ErrNotEnrolled
	}
	return PasskeyUser{Handle: record.Handle, Name: record.displayName()}, nil
}

// remember stores a pending challenge and returns its id; expired ones are dropped on the way.
func (s *Service) remember(pending challenge) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for id, old := range s.challenges {
		if now.After(old.expires) {
			delete(s.challenges, id)
		}
	}
	id := randomID()
	s.challenges[id] = pending
	return id
}

// takeChallenge spends a challenge that must belong to this caller, kind and relying party.
func (s *Service) takeChallenge(id string, kind challengeKind, caller Principal, rpID string) (challenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, found := s.challenges[id]
	delete(s.challenges, id)
	if !found || pending.kind != kind || pending.binding != caller.binding || pending.rpID != rpID || s.now().After(pending.expires) {
		return challenge{}, ErrChallengeUnknown
	}
	return pending, nil
}

// BeginRegistration starts adding a passkey. The caller has already spent a step-up token for
// PurposeRegisterPasskey (from the setup code, or a tap with an existing passkey).
func (s *Service) BeginRegistration(ctx context.Context, owner Principal, rp RelyingParty) (challengeID string, options []byte, err error) {
	if !owner.IsOwner() {
		return "", nil, ErrNotOwner
	}
	user, err := s.passkeyUser(ctx)
	if err != nil {
		return "", nil, err
	}
	existing, err := s.passkeys(ctx)
	if err != nil {
		return "", nil, err
	}
	options, session, err := s.ceremony.BeginRegistration(rp, user, forRelyingParty(existing, rp.ID))
	if err != nil {
		return "", nil, fmt.Errorf("begin passkey registration: %w", err)
	}
	id := s.remember(challenge{kind: challengeRegister, binding: owner.binding, rpID: rp.ID, session: session, expires: s.now().Add(config.PasskeyChallengeLifetime)})
	return id, options, nil
}

// FinishRegistration verifies the browser's new credential and stores it under `name`.
func (s *Service) FinishRegistration(ctx context.Context, owner Principal, rp RelyingParty, challengeID, name string, response []byte) (StoredPasskey, error) {
	if !owner.IsOwner() {
		return StoredPasskey{}, ErrNotOwner
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Passkey"
	}
	if len(name) > config.PasskeyNameMaxLength {
		return StoredPasskey{}, &domain.ValidationError{Field: "name", Problem: "is too long"}
	}
	pending, err := s.takeChallenge(challengeID, challengeRegister, owner, rp.ID)
	if err != nil {
		return StoredPasskey{}, err
	}
	user, err := s.passkeyUser(ctx)
	if err != nil {
		return StoredPasskey{}, err
	}
	id, credential, err := s.ceremony.FinishRegistration(rp, user, pending.session, response)
	if err != nil {
		return StoredPasskey{}, fmt.Errorf("%w: %w", ErrPasskeyRejected, err)
	}
	now := domain.NormalizeTime(s.now())
	stored := StoredPasskey{ID: id, RPID: rp.ID, Name: name, Credential: credential, CreatedAt: now}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		var list []StoredPasskey
		if _, err := readJSON(ctx, tx, settingPasskeys, &list); err != nil {
			return err
		}
		for _, existing := range list {
			if existing.ID == id {
				return ErrPasskeyRejected
			}
		}
		if err := writeJSON(ctx, tx, settingPasskeys, append(list, stored)); err != nil {
			return err
		}
		// A stored passkey is what spends the setup code: setup is done, no code stays live.
		if err := writeJSON(ctx, tx, settingSetupCode, setupCodeRecord{}); err != nil {
			return err
		}
		return appendEvent(ctx, tx, owner.Actor(), "Added a passkey", name+" ("+rp.ID+")", now)
	})
	if err != nil {
		return StoredPasskey{}, fmt.Errorf("store passkey: %w", err)
	}
	s.mu.Lock()
	s.setupHash = ""
	s.mu.Unlock()
	return stored, nil
}

// BeginStepUp asks for a passkey tap that will authorize one action (`purpose`).
func (s *Service) BeginStepUp(ctx context.Context, owner Principal, rp RelyingParty, purpose string) (challengeID string, options []byte, err error) {
	if !owner.IsOwner() {
		return "", nil, ErrNotOwner
	}
	if strings.TrimSpace(purpose) == "" {
		return "", nil, &domain.ValidationError{Field: "path", Problem: "names the action to confirm"}
	}
	user, err := s.passkeyUser(ctx)
	if err != nil {
		return "", nil, err
	}
	all, err := s.passkeys(ctx)
	if err != nil {
		return "", nil, err
	}
	matching := forRelyingParty(all, rp.ID)
	if len(matching) == 0 {
		return "", nil, ErrNoPasskey
	}
	options, session, err := s.ceremony.BeginAssertion(rp, user, matching)
	if err != nil {
		return "", nil, fmt.Errorf("begin passkey check: %w", err)
	}
	id := s.remember(challenge{kind: challengeAssert, binding: owner.binding, purpose: purpose, rpID: rp.ID, session: session, expires: s.now().Add(config.PasskeyChallengeLifetime)})
	return id, options, nil
}

// FinishStepUp verifies the tap and returns a step-up token for the purpose the prompt was begun for.
func (s *Service) FinishStepUp(ctx context.Context, owner Principal, rp RelyingParty, challengeID string, response []byte) (string, time.Time, error) {
	if !owner.IsOwner() {
		return "", time.Time{}, ErrNotOwner
	}
	pending, err := s.takeChallenge(challengeID, challengeAssert, owner, rp.ID)
	if err != nil {
		return "", time.Time{}, err
	}
	user, err := s.passkeyUser(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	all, err := s.passkeys(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	id, credential, err := s.ceremony.FinishAssertion(rp, user, forRelyingParty(all, rp.ID), pending.session, response)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("%w: %w", ErrPasskeyRejected, err)
	}
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		var list []StoredPasskey
		if _, err := readJSON(ctx, tx, settingPasskeys, &list); err != nil {
			return err
		}
		for index := range list {
			if list[index].ID == id && list[index].RPID == rp.ID {
				list[index].Credential = credential // the sign count moved on
				list[index].LastUsedAt = domain.NormalizeTime(s.now())
				return writeJSON(ctx, tx, settingPasskeys, list)
			}
		}
		return ErrPasskeyRejected
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("record passkey use: %w", err)
	}
	token := s.grantStepUp(owner, pending.purpose)
	return token, s.now().Add(config.StepUpLifetime), nil
}

func (s *Service) grantStepUp(owner Principal, purpose string) string {
	token := randomSecret()
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, old := range s.stepUps {
		if now.After(old.expires) {
			delete(s.stepUps, key)
		}
	}
	s.stepUps[hashSecret(token)] = stepUp{binding: owner.binding, purpose: purpose, expires: now.Add(config.StepUpLifetime)}
	return token
}

// ConsumeStepUp spends a step-up token for `purpose`. It must be the owner's, for exactly this
// purpose, unexpired and unused; anything else is ErrStepUpRequired. A token offered for the wrong
// purpose is spent anyway, so a stolen token can't be tried against several actions.
func (s *Service) ConsumeStepUp(owner Principal, purpose, token string) error {
	if !owner.IsOwner() {
		return ErrNotOwner
	}
	if token == "" {
		return ErrStepUpRequired
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := hashSecret(token)
	granted, found := s.stepUps[key]
	delete(s.stepUps, key)
	if !found || granted.binding != owner.binding || granted.purpose != purpose || s.now().After(granted.expires) {
		return ErrStepUpRequired
	}
	return nil
}

// IsAuthError reports whether err is one of this package's refusals (for the HTTP layer's mapping).
func IsAuthError(err error) bool {
	for _, known := range []error{ErrUnauthorized, ErrNotOwner, ErrNotEnrolled, ErrStepUpRequired, ErrNoPasskey, ErrPasskeyRejected, ErrChallengeUnknown, ErrWrongSetupCode, ErrSetupCodeLocked, ErrSetupClosed, ErrSignInRefused} {
		if errors.Is(err, known) {
			return true
		}
	}
	return false
}
