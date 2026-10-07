// What one delivery attempt amounted to, from the error the remote port returned.
// In the app: the use-case switches on an Outcome to decide whether to remove, park, or requeue a write.
// Used by: internal/app/notesync; tested by outcome_test.go.
// Uses: errors.go.
//
// An enum with a `switch` over it must name every member: `exhaustive` (.golangci.yml) fails the
// build of a switch that misses one, so adding a member can't leave a case unhandled.

package domain

import (
	"context"
	"errors"
)

// Outcome is what an attempt to deliver a write came to.
type Outcome int

const (
	// OutcomeApplied: the remote has the write.
	OutcomeApplied Outcome = iota
	// OutcomeRefused: the remote will never accept it, so retrying is pointless.
	OutcomeRefused
	// OutcomeTransient: it may pass next time (no answer, timeout, 5xx).
	OutcomeTransient
)

func (o Outcome) String() string {
	switch o {
	case OutcomeApplied:
		return "applied"
	case OutcomeRefused:
		return "refused"
	case OutcomeTransient:
		return "transient"
	}
	return "unknown"
}

// OutcomeOf classifies the error a remote Put returned. ok is false for an error that is none of
// the expected ones: a bug, which the caller must not retry or hide.
func OutcomeOf(err error) (outcome Outcome, ok bool) {
	var remote *RemoteError
	switch {
	case err == nil:
		return OutcomeApplied, true
	case errors.As(err, &remote) && remote.Retryable():
		return OutcomeTransient, true
	case errors.As(err, &remote):
		return OutcomeRefused, true
	case errors.Is(err, ErrUnreachable), errors.Is(err, context.DeadlineExceeded):
		return OutcomeTransient, true
	}
	return OutcomeTransient, false
}
