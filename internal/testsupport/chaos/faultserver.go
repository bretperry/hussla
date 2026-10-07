// A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
// In the app: nothing; test support for the tier-2 (fault injection) tests.
// Used by: internal/app/notesync/service_chaos_test.go.
// Uses: domain.AcceptWrite (the real merge rule), notesync.Remote (implements it).
//
// Not a mock of HTTP: a model of behavior. It stores notes through the same AcceptWrite the real
// far side runs, applies a write id at most once, and reads the clock the server would. So a test
// asserts the *outcome* (what the server holds, how often a write applied), not a call count.
// Faults are scripted by request index, so "the third request dies after the server applied it"
// is one line, and a failing run replays exactly. Delays use the real `time` package, so inside a
// testing/synctest bubble they cost nothing.

package chaos

import (
	"context"
	"fmt"
	"sync"
	"time"

	"example.com/app/internal/app/notesync"
	"example.com/app/internal/domain"
)

// FaultKind is how a request breaks. The split that matters is whether the server applied the write first.
type FaultKind int

const (
	// FaultDropBeforeApply: the connection never reached the server; nothing applied.
	FaultDropBeforeApply FaultKind = iota
	// FaultDropAfterApply: the server applied the write and the answer was lost on the way back.
	FaultDropAfterApply
	// FaultDelay: the request takes Delay in flight, then applies and answers.
	FaultDelay
	// FaultServerError: a 5xx before anything is applied.
	FaultServerError
	// FaultRefused: a 4xx; the server will never accept this write.
	FaultRefused
)

// ServerFault is one scripted failure. Delay is used by FaultDelay, Status by the two answers.
type ServerFault struct {
	Kind   FaultKind
	Delay  time.Duration
	Status int
}

// FaultScript picks the fault for a zero-based request index; false answers normally.
type FaultScript func(request int) (ServerFault, bool)

// First plays faults on the first requests, then answers normally.
func First(faults ...ServerFault) FaultScript {
	return func(request int) (ServerFault, bool) {
		if request < len(faults) {
			return faults[request], true
		}
		return ServerFault{}, false
	}
}

// FaultServer is the model remote; it implements notesync.Remote.
type FaultServer struct {
	now    func() time.Time
	script FaultScript

	mu       sync.Mutex
	notes    map[string]domain.Note
	seen     map[string]bool
	requests int
	applies  int
}

var _ notesync.Remote = (*FaultServer)(nil)

// NewFaultServer builds a server reading `now` as its clock; a nil script answers every request normally.
func NewFaultServer(now func() time.Time, script FaultScript) *FaultServer {
	if script == nil {
		script = func(int) (ServerFault, bool) { return ServerFault{}, false }
	}
	return &FaultServer{now: now, script: script, notes: map[string]domain.Note{}, seen: map[string]bool{}}
}

// apply is the real far side's write path: a write id applies once; the merge is the domain's.
func (s *FaultServer) apply(entry notesync.Entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[entry.WriteID] {
		return
	}
	s.seen[entry.WriteID] = true
	s.applies++
	var stored *domain.Note
	if existing, ok := s.notes[entry.Note.ID]; ok {
		stored = &existing
	}
	s.notes[entry.Note.ID] = domain.AcceptWrite(stored, entry.Note, s.now())
}

// nextFault counts the request and returns its scripted fault.
func (s *FaultServer) nextFault() (ServerFault, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	index := s.requests
	s.requests++
	return s.script(index)
}

// Put plays the script for this request.
func (s *FaultServer) Put(ctx context.Context, entry notesync.Entry) error {
	fault, faulted := s.nextFault()
	if !faulted {
		s.apply(entry)
		return nil
	}
	switch fault.Kind {
	case FaultDropBeforeApply:
		return domain.ErrUnreachable
	case FaultDropAfterApply:
		s.apply(entry)
		return domain.ErrUnreachable
	case FaultDelay:
		// The request is in flight: the server applies it when it lands, even if the client has
		// given up by then. That late arrival is the case the write id exists for.
		landed := make(chan struct{})
		time.AfterFunc(fault.Delay, func() {
			s.apply(entry)
			close(landed)
		})
		select {
		case <-landed:
			return nil
		case <-ctx.Done():
			return fmt.Errorf("request cancelled: %w", ctx.Err())
		}
	case FaultServerError, FaultRefused:
		// Answered, nothing applied.
		return &domain.RemoteError{Status: fault.Status}
	}
	return nil
}

// Note is what the server holds for id.
func (s *FaultServer) Note(id string) (domain.Note, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	note, ok := s.notes[id]
	return note, ok
}

// Requests is how many requests arrived, failed ones included.
func (s *FaultServer) Requests() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

// Applies is how many writes actually applied; a replayed write id doesn't count again.
func (s *FaultServer) Applies() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applies
}
