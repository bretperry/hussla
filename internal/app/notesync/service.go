// Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
// In the app: the write path for notes; a UI or API calls Save, a timer or reconnect calls Flush.
// Used by: its tests (the template's tier-2 seed has no production caller yet).
// Uses: ports.go (outbox, remote, clock), internal/config (retry knobs), internal/domain (errors, Outcome).
//
// Each fault has one handler here, and a fault-injection test that fails without it
// (service_chaos_test.go): full disk → Save returns ErrStorageFull; drop (unreachable) → retried;
// delay → timed out and retried; 5xx → retried with backoff, then left queued; kill mid-write →
// the next Flush releases dead claims. A fast clock is clamped on the far side (domain
// AcceptWrite); a slow clock's later edit still loses (docs/deferred.md → Go pack: a slow clock's later edit loses).

package notesync

import (
	"context"
	"fmt"
	"sync"

	"example.com/app/internal/config"
	"example.com/app/internal/domain"
)

// Deps are the ports and the id source the use-case is built over.
type Deps struct {
	Outbox     Outbox
	Remote     Remote
	Clock      Clock
	NewWriteID func() string
}

// FlushReport is what one flush did with each write it tried.
type FlushReport struct {
	Delivered int
	Refused   int
	Requeued  int
}

// flight is one running flush that overlapping callers share.
type flight struct {
	done   chan struct{}
	report FlushReport
	err    error
}

// Service is the notesync use-case.
type Service struct {
	deps Deps

	mu       sync.Mutex
	inFlight *flight
}

// New builds the use-case over its ports.
func New(deps Deps) *Service {
	return &Service{deps: deps}
}

// Save stamps and queues a note. Nothing is sent here, so a save works offline.
// A full disk is domain.ErrStorageFull, wrapped; test it with errors.Is.
func (s *Service) Save(ctx context.Context, id, text string) (domain.Note, error) {
	note := domain.Note{ID: id, Text: text, ComposedAt: s.deps.Clock.Now()}
	if err := s.deps.Outbox.Append(ctx, Entry{WriteID: s.deps.NewWriteID(), Note: note}); err != nil {
		return domain.Note{}, fmt.Errorf("save note %q: %w", id, err)
	}
	return note, nil
}

// Flush sends every queued write once through the retry budget; what is still failing stays queued.
//
// Single-flight: a call while one runs gets the running one's report. Two at once would both
// send the same writes, and the second's ReleaseClaims would un-claim the first's in-flight row.
// A waiting caller still honours its own ctx.
func (s *Service) Flush(ctx context.Context) (FlushReport, error) {
	s.mu.Lock()
	if running := s.inFlight; running != nil {
		s.mu.Unlock()
		// The running flush belongs to its first caller; this one waits for it only as long as its own ctx lasts.
		select {
		case <-running.done:
			return running.report, running.err
		case <-ctx.Done():
			return FlushReport{}, fmt.Errorf("waiting for the running flush: %w", ctx.Err())
		}
	}
	run := &flight{done: make(chan struct{})}
	s.inFlight = run
	s.mu.Unlock()

	run.report, run.err = s.flushOnce(ctx)

	s.mu.Lock()
	s.inFlight = nil
	s.mu.Unlock()
	close(run.done)
	return run.report, run.err
}

// attempt sends one request, bounded by the timeout. No answer in time, unreachable, and a 5xx
// all come back as transient; a stranger error is returned as a bug. A caller who cancels gets
// context.Canceled back through that last path, and the write stays claimed for the next flush
// to release; a caller's expired deadline reads as a timeout and ends in the backoff's own error.
//
// The timeout's context is cancelled as soon as the call returns, so a quick answer leaves
// nothing pending. A timed-out request's late answer is ignored; the write id makes the retry a
// no-op if it did apply.
func (s *Service) attempt(ctx context.Context, entry Entry) (domain.Outcome, error) {
	requestCtx, cancel := context.WithTimeout(ctx, config.SyncRequestTimeout)
	defer cancel()
	err := s.deps.Remote.Put(requestCtx, entry)
	outcome, known := domain.OutcomeOf(err)
	if !known {
		return domain.OutcomeTransient, fmt.Errorf("put %s: %w", entry.WriteID, err)
	}
	return outcome, nil
}

// deliver tries one write up to the attempt budget, backing off between tries.
func (s *Service) deliver(ctx context.Context, entry Entry) (domain.Outcome, error) {
	for tried := 1; ; tried++ {
		outcome, err := s.attempt(ctx, entry)
		if err != nil || outcome != domain.OutcomeTransient || tried >= config.SyncMaxAttempts {
			return outcome, err
		}
		backoff := config.SyncBackoffBase << (tried - 1)
		if err := s.deps.Clock.Sleep(ctx, backoff); err != nil {
			return outcome, fmt.Errorf("backoff before retrying %s: %w", entry.WriteID, err)
		}
	}
}

// flushOnce is one pass over the outbox: dead claims back to pending first (a process killed mid-flush left them).
func (s *Service) flushOnce(ctx context.Context) (FlushReport, error) {
	var report FlushReport
	if err := s.deps.Outbox.ReleaseClaims(ctx); err != nil {
		return report, fmt.Errorf("release dead claims: %w", err)
	}
	pending, err := s.deps.Outbox.Pending(ctx)
	if err != nil {
		return report, fmt.Errorf("list pending writes: %w", err)
	}
	for _, entry := range pending {
		if err := s.deps.Outbox.Claim(ctx, entry.WriteID); err != nil {
			return report, fmt.Errorf("claim %s: %w", entry.WriteID, err)
		}
		outcome, err := s.deliver(ctx, entry)
		if err != nil {
			return report, err
		}
		if err := s.settle(ctx, entry, outcome, &report); err != nil {
			return report, err
		}
	}
	return report, nil
}

// settle records what became of a write: removed, parked, or back in the queue. It counts the
// write only once the outbox has taken the change, so a kill mid-settle never reports a delivery.
func (s *Service) settle(ctx context.Context, entry Entry, outcome domain.Outcome, report *FlushReport) error {
	var err error
	switch outcome {
	case domain.OutcomeApplied:
		if err = s.deps.Outbox.Remove(ctx, entry.WriteID); err == nil {
			report.Delivered++
		}
	case domain.OutcomeRefused:
		if err = s.deps.Outbox.Park(ctx, entry.WriteID); err == nil {
			report.Refused++
		}
	case domain.OutcomeTransient:
		if err = s.deps.Outbox.Release(ctx, entry.WriteID); err == nil {
			report.Requeued++
		}
	}
	if err != nil {
		return fmt.Errorf("settle %s as %s: %w", entry.WriteID, outcome, err)
	}
	return nil
}
