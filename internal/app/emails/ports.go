// The emails port: the outbox, with every state change a conditional update.
// In the app: the Outbox page, the job and company email editors, the dispatcher that sends approved mail.
// Used by: use-cases (Phases 3-4) through store.Tx.
//
// The security model's rule "every state change is a conditional update" lives here: Replace
// writes the next email only if the stored row is still the one the caller read (same status,
// version and attempts). Two clicks on Approve, or an agent edit between the owner's read and
// their click, lose the race with storeerr.ErrConflict instead of overwriting each other.

package emails

import (
	"context"
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

// Filter narrows List. The zero Filter lists the newest emails.
type Filter struct {
	Status      *domain.EmailStatus
	JobID       string
	CompanySlug string
	Limit       int // 0 means no limit
}

// SendHistory is what the pacing rule needs, derived from the sent rows and nothing else.
type SendHistory struct {
	LastSentAt time.Time // zero when nothing was ever sent
	SentSince  int       // how many were sent at or after the `since` asked for
}

// Repository stores emails. Errors: storeerr.ErrNotFound, storeerr.ErrExists, storeerr.ErrConflict.
type Repository interface {
	// Get returns the email, or storeerr.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Email, error)
	// List returns emails newest first by creation time, ties by id.
	List(ctx context.Context, filter Filter) ([]domain.Email, error)
	// Create stores a new email; storeerr.ErrExists when the id is taken.
	Create(ctx context.Context, email domain.Email) error
	// Replace stores `next` only if the stored email still has `was`'s status, version and
	// attempts; otherwise storeerr.ErrConflict (storeerr.ErrNotFound when it is gone).
	Replace(ctx context.Context, was, next domain.Email) error
	// NextApproved returns the approved email that has waited longest (oldest approval, ties by
	// id), or storeerr.ErrNotFound when the queue is empty.
	NextApproved(ctx context.Context) (domain.Email, error)
	// ListSending returns emails found in `sending`, for the startup recovery that marks them uncertain.
	ListSending(ctx context.Context) ([]domain.Email, error)
	// SentHistory reads the last send time and the count of sends at or after `since` from the sent rows.
	SentHistory(ctx context.Context, since time.Time) (SendHistory, error)
}
