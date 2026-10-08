// Local sign-in: `hussla open`'s one-time token traded for a session, and "sign out everywhere".
// In the app: a laptop without Tailscale, reached at http://localhost:<port>.
// Used by: internal/httpapi (GET /signin, the session cookie on the local listener, POST /api/sessions/revoke-all).
//
// Loopback alone grants nothing: the token is the proof, and it comes from a 0600 file in the data
// directory (the SignInTokens port). It is single-use (removed on success, and remembered in memory
// in case the removal failed) and expires after config.SignInTokenLifetime. A wrong guess doesn't
// burn the real token. Sessions are stored as hashes, so a leaked database holds no live cookie.

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

type sessionRecord struct {
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// SignIn trades a sign-in token for a new session secret (the cookie value) and its expiry.
func (s *Service) SignIn(ctx context.Context, presented string) (string, time.Time, error) {
	if s.signIn == nil || presented == "" {
		return "", time.Time{}, ErrSignInRefused
	}
	token, err := s.signIn.Read(ctx)
	if errors.Is(err, ErrNoSignInToken) {
		return "", time.Time{}, ErrSignInRefused
	}
	if err != nil {
		return "", time.Time{}, fmt.Errorf("read sign-in token: %w", err)
	}
	now := s.now()
	if !sameSecret(presented, token.Secret) || !now.Before(token.ExpiresAt) || token.ExpiresAt.Sub(now) > config.SignInTokenLifetime {
		return "", time.Time{}, ErrSignInRefused
	}
	hash := hashSecret(token.Secret)
	s.mu.Lock()
	if _, used := s.usedSignIn[hash]; used {
		s.mu.Unlock()
		return "", time.Time{}, ErrSignInRefused
	}
	s.usedSignIn[hash] = token.ExpiresAt
	for key, expires := range s.usedSignIn {
		if now.After(expires) {
			delete(s.usedSignIn, key)
		}
	}
	s.mu.Unlock()
	if err := s.signIn.Remove(ctx); err != nil {
		return "", time.Time{}, fmt.Errorf("remove used sign-in token: %w", err)
	}
	if _, err := s.ensureLocalOwner(ctx); err != nil {
		return "", time.Time{}, err
	}
	secret := randomSecret()
	expires := domain.NormalizeTime(now.Add(config.SessionLifetime))
	err = s.store.Atomically(ctx, func(tx store.Tx) error {
		var sessions []sessionRecord
		if _, err := readJSON(ctx, tx, settingSessions, &sessions); err != nil {
			return err
		}
		live := sessions[:0]
		for _, session := range sessions {
			if now.Before(session.ExpiresAt) {
				live = append(live, session)
			}
		}
		live = append(live, sessionRecord{Hash: hashSecret(secret), CreatedAt: domain.NormalizeTime(now), ExpiresAt: expires})
		if err := writeJSON(ctx, tx, settingSessions, live); err != nil {
			return err
		}
		return appendEvent(ctx, tx, domain.ActorSystem, "Signed in on this computer", "", now)
	})
	if err != nil {
		return "", time.Time{}, fmt.Errorf("start session: %w", err)
	}
	return secret, expires, nil
}

// SessionPrincipal resolves a session cookie to the owner, or ErrUnauthorized.
func (s *Service) SessionPrincipal(ctx context.Context, secret string) (Principal, error) {
	if secret == "" {
		return Principal{}, ErrUnauthorized
	}
	hash := hashSecret(secret)
	var sessions []sessionRecord
	var record ownerRecord
	var enrolled bool
	err := s.store.View(ctx, func(tx store.Tx) error {
		if _, err := readJSON(ctx, tx, settingSessions, &sessions); err != nil {
			return err
		}
		var err error
		enrolled, err = readJSON(ctx, tx, settingOwner, &record)
		return err
	})
	if err != nil {
		return Principal{}, fmt.Errorf("check session: %w", err)
	}
	now := s.now()
	for _, session := range sessions {
		if sameSecret(session.Hash, hash) && now.Before(session.ExpiresAt) && enrolled {
			return Principal{role: RoleOwner, name: record.displayName(), login: record.Login, binding: "session:" + hash}, nil
		}
	}
	return Principal{}, ErrUnauthorized
}

// SignOutEverywhere ends every local session; the owner signs in again with `hussla open`.
func (s *Service) SignOutEverywhere(ctx context.Context, owner Principal) error {
	if !owner.IsOwner() {
		return ErrNotOwner
	}
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		if err := writeJSON(ctx, tx, settingSessions, []sessionRecord{}); err != nil {
			return err
		}
		return appendEvent(ctx, tx, owner.Actor(), "Signed out everywhere", "", s.now())
	})
	if err != nil {
		return fmt.Errorf("sign out everywhere: %w", err)
	}
	return nil
}
