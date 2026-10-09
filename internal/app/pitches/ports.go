// The pitches port: the owner's ten pitches and each one's versions.
// In the app: the Pitches page, the front page billboard, agents adding a version.
// Used by: the pitch use-cases (internal/app/tracker/pitches.go) and the seed import, through store.Tx.

package pitches

import (
	"context"

	"github.com/bretperry/hussla/internal/domain"
)

// Repository stores pitches with their versions. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Get returns the pitch in a slot with every version, oldest first, or storeerr.ErrNotFound.
	Get(ctx context.Context, slot int) (domain.Pitch, error)
	// List returns every pitch by slot, each with its versions oldest first.
	List(ctx context.Context) ([]domain.Pitch, error)
	// Create stores a new pitch and its versions; storeerr.ErrExists when the slot is taken.
	Create(ctx context.Context, pitch domain.Pitch) error
	// Update replaces a stored pitch and its versions with what the domain computed; storeerr.ErrNotFound when it is gone.
	Update(ctx context.Context, pitch domain.Pitch) error
	// Delete removes the pitch and its versions; storeerr.ErrNotFound when it is gone.
	Delete(ctx context.Context, slot int) error
}
