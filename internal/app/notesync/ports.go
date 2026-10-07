// The ports the notesync use-case depends on: a local outbox, the remote it delivers to, and a clock.
// In the app: contracts only; an adapter per vendor implements each, wired in the composition root.
// Used by: service.go; the fakes in internal/testsupport/chaos.
// Uses: domain types only (ports are contracts: docs/ports-and-adapters.md).
//
// The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
// A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
// leaves claims behind that the next flush must release.

package notesync

import (
	"context"
	"time"

	"example.com/app/internal/domain"
)

// Entry is one queued write: the note as stated, and the id that makes delivering it twice a no-op.
type Entry struct {
	WriteID string
	Note    domain.Note
}

// Outbox is the durable local queue. Any error other than the ones named is a bug.
type Outbox interface {
	// Append persists a write; domain.ErrStorageFull when the disk can't take it (nothing is half-written).
	Append(ctx context.Context, entry Entry) error
	// Pending lists writes waiting to be sent, oldest first; claimed ones are not included.
	Pending(ctx context.Context) ([]Entry, error)
	// Claim marks a write in flight.
	Claim(ctx context.Context, writeID string) error
	// Release puts a write back in the queue for a later flush.
	Release(ctx context.Context, writeID string) error
	// ReleaseClaims puts every claimed write back: claims left by a process that died mid-flush.
	ReleaseClaims(ctx context.Context) error
	// Remove drops a write the remote applied.
	Remove(ctx context.Context, writeID string) error
	// Park sets aside a write the remote refused for a reason a retry won't fix: out of the queue,
	// but kept for a person to look at, so a refusal never silently loses a save.
	Park(ctx context.Context, writeID string) error
}

// Remote is the far side. The remote applies a write id at most once, so resending is always safe.
type Remote interface {
	// Put sends one write and must return when ctx is done. nil means applied; the expected failures
	// are domain.ErrUnreachable (no answer) and *domain.RemoteError (an answer that was not success).
	Put(ctx context.Context, entry Entry) error
}

// Clock is wall time and waiting, so tests can skew one and run the other on virtual time.
type Clock interface {
	// Now is wall-clock time; it may be wrong (skewed), which the far side's merge rule allows for.
	Now() time.Time
	// Sleep waits d, or returns ctx's error as soon as ctx is done.
	Sleep(ctx context.Context, d time.Duration) error
}
