// The events port: the append-only activity log.
// In the app: the job page's activity list, the Activity page, and what each agent key did.
// Used by: every use-case that writes (in the same unit of work as the write); the seed import.
//
// Append-only on purpose: there is no update and no delete, so the log can be trusted after the fact.

package events

import (
	"context"
	"time"

	"github.com/bretperry/hussla/internal/domain"
)

// Filter narrows List. The zero Filter lists the newest events.
type Filter struct {
	JobID string // only this job's events; empty means all
	Actor string // only this actor's; empty means all
	Since time.Time
	Limit int // 0 means DefaultLimit
}

// DefaultLimit is how many events List returns when the filter names no limit.
const DefaultLimit = 200

// Repository stores events.
type Repository interface {
	// Append stores the event and returns it with its ID set. IDs only grow.
	Append(ctx context.Context, event domain.Event) (domain.Event, error)
	// AppendOnce stores the event unless one with the same key is already stored (inserted is
	// false then). The key is the caller's identity for the event, e.g. a hash of its content;
	// it makes importing the same bundle twice add nothing.
	AppendOnce(ctx context.Context, key string, event domain.Event) (inserted bool, err error)
	// List returns events newest first (by time, then id).
	List(ctx context.Context, filter Filter) ([]domain.Event, error)
}
