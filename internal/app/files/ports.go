// The files port: the record of each file an agent or the owner attached to a job (a cover letter, a résumé sent).
// In the app: the job page's file list and GET /api/files/:id.
// Used by: use-cases (Phase 3) through store.Tx. This stores the record only; where the bytes live is Phase 3's call (docs/deferred.md).

package files

import (
	"context"
	"time"
)

// File is the metadata of one attached file. JobID is empty for a file not tied to a job.
type File struct {
	ID        string
	JobID     string
	Name      string
	Kind      string // "file", "cover-letter", "resume" …
	Mime      string
	Size      int64
	CreatedAt time.Time
	Actor     string
}

// Repository stores file records. Errors: storeerr.ErrNotFound, storeerr.ErrExists.
type Repository interface {
	// Get returns the record, or storeerr.ErrNotFound.
	Get(ctx context.Context, id string) (File, error)
	// ListByJob returns a job's files, oldest first.
	ListByJob(ctx context.Context, jobID string) ([]File, error)
	// Create stores a new record; storeerr.ErrExists when the id is taken.
	Create(ctx context.Context, file File) error
	// Delete removes the record; storeerr.ErrNotFound when it is gone.
	Delete(ctx context.Context, id string) error
}
