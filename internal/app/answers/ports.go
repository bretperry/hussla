// The answers port: saved replies to application-form questions.
// In the app: the Answers page and every agent filling a form.
// Used by: use-cases (Phases 3-4) and the seed import, through store.Tx.

package answers

import (
	"context"

	"github.com/bretperry/hussla/internal/domain"
)

// Repository stores answers. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Get returns the answer, or storeerr.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Answer, error)
	// List returns every answer, oldest first by creation time, ties by id (the page sorts unanswered up).
	List(ctx context.Context) ([]domain.Answer, error)
	// Create stores a new answer; storeerr.ErrExists when the id is taken.
	Create(ctx context.Context, answer domain.Answer) error
	// Update replaces a stored answer with the one the domain computed; storeerr.ErrNotFound when it is gone.
	Update(ctx context.Context, answer domain.Answer) error
	// Delete removes the answer; storeerr.ErrNotFound when it is gone.
	Delete(ctx context.Context, id string) error
}
