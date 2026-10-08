// The jobs port: how a use-case stores and finds jobs.
// In the app: the jobs table, the job page, every agent write to a job.
// Used by: use-cases (Phases 3-4) through store.Tx; implemented by the SQLite adapter and the in-memory fake.
//
// The repository stores the record the domain computed; it never merges or validates. A patch is
// applied by domain.ApplyJobPatch on the value Get returned, then written whole with Update, all
// inside one unit of work, so "writes are patches" holds without the store knowing about patches.

package jobs

import (
	"context"

	"github.com/bretperry/hussla/internal/domain"
)

// Filter narrows List. The zero Filter lists everything.
type Filter struct {
	Status      *domain.JobStatus
	CompanySlug string
	Limit       int // 0 means no limit
}

// Repository stores jobs. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Get returns the job, or storeerr.ErrNotFound.
	Get(ctx context.Context, id string) (domain.Job, error)
	// List returns jobs newest first by creation time, ties by id.
	List(ctx context.Context, filter Filter) ([]domain.Job, error)
	// Create stores a new job; storeerr.ErrExists when the id is taken.
	Create(ctx context.Context, job domain.Job) error
	// Update replaces a stored job with the one the domain computed; storeerr.ErrNotFound when it is gone.
	Update(ctx context.Context, job domain.Job) error
	// Delete removes the job. Its activity events stay, as the audit trail. storeerr.ErrNotFound when it is gone.
	Delete(ctx context.Context, id string) error
}
