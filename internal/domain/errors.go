// The expected failures of delivering a note, as values a caller tests with errors.Is / errors.As.
// In the app: ports return these; the use-case turns them into an Outcome (outcome.go).
// Used by: internal/app/notesync, internal/testsupport/chaos.
//
// Go's `Result` is `(T, error)`. An expected failure is a sentinel (`ErrStorageFull`: no fields,
// compare with errors.Is) or a typed error (`*RemoteError`: carries data, extract with errors.As).
// Wrap with `%w` as it crosses a layer, so the cause survives. Anything else an adapter returns
// is a bug and surfaces to the top, loud.

package domain

import (
	"errors"
	"strconv"
)

// ErrStorageFull means the outbox's disk can't take another write; nothing was half-written.
var ErrStorageFull = errors.New("storage full")

// ErrUnreachable means the remote never answered: a dropped connection, not a refusal.
var ErrUnreachable = errors.New("remote unreachable")

// RemoteError is an answer from the remote that was not success.
type RemoteError struct {
	Status int
}

func (e *RemoteError) Error() string {
	return "remote answered " + strconv.Itoa(e.Status)
}

// Retryable reports whether a later try may pass: a 5xx may, a 4xx never will.
func (e *RemoteError) Retryable() bool {
	return e.Status >= 500
}
