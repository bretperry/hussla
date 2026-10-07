// A note and the rule that merges two statements of it: the later compose time wins.
// In the app: the far side (a server, a store) applies every incoming write through AcceptWrite.
// Used by: internal/app/notesync (the type), internal/testsupport/chaos (the model server merges with it).
// Uses: internal/config (the skew tolerance).
//
// Why compose time and not arrival time: a write queued offline arrives late, and must not
// overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
// so a device an hour fast would otherwise win every comparison for the next hour.

package domain

import (
	"time"

	"example.com/app/internal/config"
)

// Note is one note as a device stated it.
type Note struct {
	ID         string
	Text       string
	ComposedAt time.Time
}

// Merge returns the stored note after incoming is applied: the later statement wins, a tie goes to the incoming one.
func Merge(stored *Note, incoming Note) Note {
	if stored != nil && stored.ComposedAt.After(incoming.ComposedAt) {
		return *stored
	}
	return incoming
}

// ClampComposedAt turns a stamp too far ahead of the server's clock into the server's clock; anything else is kept.
func ClampComposedAt(composedAt, serverNow time.Time, maxAhead time.Duration) time.Time {
	if composedAt.After(serverNow.Add(maxAhead)) {
		return serverNow
	}
	return composedAt
}

// AcceptWrite applies one incoming write on the far side: clamp its stamp, then merge.
func AcceptWrite(stored *Note, incoming Note, serverNow time.Time) Note {
	incoming.ComposedAt = ClampComposedAt(incoming.ComposedAt, serverNow, config.MaxComposeSkewAhead)
	return Merge(stored, incoming)
}
