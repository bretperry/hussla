// The tokens port: agent keys, stored only as hashes.
// In the app: Settings -> agents (create, list, revoke) and the bearer check on every agent request.
// Used by: the auth layer and use-cases (Phase 3) through store.Tx.
//
// The secret is shown once at creation and never stored: Hash is whatever digest the auth layer
// computes (it owns the algorithm), and the repository only compares it for equality.

package tokens

import (
	"context"
	"time"
)

// Token is one agent key. LastUsedAt and RevokedAt are zero until they happen.
type Token struct {
	ID         string
	Name       string
	Hash       string
	CreatedAt  time.Time
	LastUsedAt time.Time
	RevokedAt  time.Time
}

// IsRevoked is true once the owner has revoked the key.
func (token Token) IsRevoked() bool { return !token.RevokedAt.IsZero() }

// Repository stores agent keys. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Create stores a new key; storeerr.ErrExists when the id or the hash is taken.
	Create(ctx context.Context, token Token) error
	// GetByHash finds the key whose secret hashes to `hash` (revoked ones too, so the caller can say why), or storeerr.ErrNotFound.
	GetByHash(ctx context.Context, hash string) (Token, error)
	// List returns every key, oldest first.
	List(ctx context.Context) ([]Token, error)
	// Revoke marks the key revoked at `at`. It is a conditional update: changed is false when the
	// key was already revoked (the first revocation time stays). storeerr.ErrNotFound for an unknown id.
	Revoke(ctx context.Context, id string, at time.Time) (changed bool, err error)
	// Touch records a use at `at`, never moving LastUsedAt backwards. storeerr.ErrNotFound for an unknown id.
	Touch(ctx context.Context, id string, at time.Time) error
}
