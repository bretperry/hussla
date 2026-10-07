// An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: internal/app/notesync/service_chaos_test.go.
// Uses: notesync.Outbox (implements it), domain.ErrStorageFull.
//
// The rows live in a Disk the test keeps, so "restart the process" is a new outbox over the same
// disk. Every step is atomic, like a transactional store: a kill lands between steps, never
// inside one, which is what a kill *is* to a store with a journal.

package chaos

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"example.com/app/internal/app/notesync"
	"example.com/app/internal/domain"
)

// RowState is where a queued write stands.
type RowState int

const (
	RowPending RowState = iota
	RowClaimed
	RowParked
)

// Row is one write on the disk.
type Row struct {
	Entry notesync.Entry
	State RowState
}

// Disk is what survives a process: the rows, in append order.
type Disk struct {
	mu   sync.Mutex
	rows []Row
}

// Rows is a copy of the rows, for assertions.
func (d *Disk) Rows() []Row {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Clone(d.rows)
}

// KillPoint is where a kill can land: after a claim commits (nothing sent yet), or after the send
// and before the remove commits (the server has it; the outbox doesn't know).
type KillPoint int

const (
	KillNone KillPoint = iota
	KillAfterClaim
	KillBeforeRemove
)

// Names a kill point in a failure message and a test name.
func (k KillPoint) String() string {
	switch k {
	case KillNone:
		return "never"
	case KillAfterClaim:
		return "after-claim"
	case KillBeforeRemove:
		return "before-remove"
	}
	return "unknown"
}

// OutboxFaults are the faults this outbox can play: refuse appends (full disk), or kill the
// process once at a point. The outbox reads it on every call, so a test can change it mid-run.
type OutboxFaults struct {
	Full bool
	Kill KillPoint
}

// ProcessKilledError is what the "process" returns when the script kills it; a test expects exactly this.
type ProcessKilledError struct {
	Point KillPoint
}

// Says where the kill landed.
func (e *ProcessKilledError) Error() string {
	return fmt.Sprintf("process killed %s", e.Point)
}

type memoryOutbox struct {
	disk   *Disk
	faults *OutboxFaults
}

var _ notesync.Outbox = (*memoryOutbox)(nil)

// NewOutbox is an outbox over disk; faults may be nil for none.
func NewOutbox(disk *Disk, faults *OutboxFaults) notesync.Outbox {
	if faults == nil {
		faults = &OutboxFaults{}
	}
	return &memoryOutbox{disk: disk, faults: faults}
}

// killed dies here if the script says so, once; the restarted process runs clean.
func (o *memoryOutbox) killed(point KillPoint) error {
	if o.faults.Kill != point {
		return nil
	}
	o.faults.Kill = KillNone
	return &ProcessKilledError{Point: point}
}

// setState moves one write to a state; a missing row is a bug in the caller.
func (o *memoryOutbox) setState(writeID string, state RowState) error {
	o.disk.mu.Lock()
	defer o.disk.mu.Unlock()
	for i := range o.disk.rows {
		if o.disk.rows[i].Entry.WriteID == writeID {
			o.disk.rows[i].State = state
			return nil
		}
	}
	return fmt.Errorf("no outbox row %s", writeID)
}

// Refuses with domain.ErrStorageFull while the full-disk fault is on; otherwise queues the write as pending.
func (o *memoryOutbox) Append(_ context.Context, entry notesync.Entry) error {
	if o.faults.Full {
		return domain.ErrStorageFull
	}
	o.disk.mu.Lock()
	defer o.disk.mu.Unlock()
	o.disk.rows = append(o.disk.rows, Row{Entry: entry, State: RowPending})
	return nil
}

// Lists pending rows only, oldest first: a claimed row is in flight and not offered again.
func (o *memoryOutbox) Pending(context.Context) ([]notesync.Entry, error) {
	var pending []notesync.Entry
	for _, row := range o.disk.Rows() {
		if row.State == RowPending {
			pending = append(pending, row.Entry)
		}
	}
	return pending, nil
}

// Marks the row claimed, then dies if the script kills the process here (the claim has committed, nothing is sent).
func (o *memoryOutbox) Claim(_ context.Context, writeID string) error {
	if err := o.setState(writeID, RowClaimed); err != nil {
		return err
	}
	return o.killed(KillAfterClaim)
}

// Puts one row back to pending.
func (o *memoryOutbox) Release(_ context.Context, writeID string) error {
	return o.setState(writeID, RowPending)
}

// Puts every claimed row back to pending: what a restarted process does about claims a dead one left.
func (o *memoryOutbox) ReleaseClaims(context.Context) error {
	o.disk.mu.Lock()
	defer o.disk.mu.Unlock()
	for i := range o.disk.rows {
		if o.disk.rows[i].State == RowClaimed {
			o.disk.rows[i].State = RowPending
		}
	}
	return nil
}

// Dies first if the script kills the process here (the server has the write, the outbox doesn't know), else drops the row.
func (o *memoryOutbox) Remove(_ context.Context, writeID string) error {
	if err := o.killed(KillBeforeRemove); err != nil {
		return err
	}
	o.disk.mu.Lock()
	defer o.disk.mu.Unlock()
	o.disk.rows = slices.DeleteFunc(o.disk.rows, func(row Row) bool { return row.Entry.WriteID == writeID })
	return nil
}

// Sets a refused row aside, kept on the disk for a person to look at.
func (o *memoryOutbox) Park(_ context.Context, writeID string) error {
	return o.setState(writeID, RowParked)
}

// DeviceClock is a device's clock on the test's time, SkewBy off true time: Now is skewed, Sleep is not.
type DeviceClock struct {
	SkewBy time.Duration
}

var _ notesync.Clock = DeviceClock{}

// Now is the device's idea of the time.
func (c DeviceClock) Now() time.Time {
	return time.Now().Add(c.SkewBy)
}

// Sleep waits d on the real `time` package (virtual inside a synctest bubble); an abort cancels the timer.
func (DeviceClock) Sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("sleep cancelled: %w", ctx.Err())
	}
}
