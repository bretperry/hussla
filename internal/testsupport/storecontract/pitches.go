// The storage contract for pitches: round trip with versions, slot uniqueness, history rewrite, delete with versions.
// In the app: nothing at runtime (tests only).
// Used by: Run in contract.go (so SQLite and the in-memory fake are held to the same behaviour).
// Uses: internal/app/pitches through store.Tx, internal/domain.

package storecontract

import (
	"testing"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// fullPitch is a pitch with two versions (an owner's and an agent's), the second one live.
func fullPitch(slot int) domain.Pitch {
	return domain.Pitch{
		Slot: slot, Title: "Why now", When: "When they ask about timing", Live: 2, LastNumber: 2,
		Versions: []domain.PitchVersion{
			{Number: 1, Text: "First wording.", Author: "Sam Owner", Writer: domain.WriterOwner, CreatedAt: at(1)},
			{Number: 2, Text: "Second wording, tighter.", Note: "shorter opening", Author: "agent:laptop", Writer: domain.WriterAgent, CreatedAt: at(2)},
		},
		CreatedAt: at(1), UpdatedAt: at(2),
	}
}

func pitchesRoundTrip(t *testing.T, newStore NewStore) {
	s := newStore(t)
	write(t, s, func(tx store.Tx) error {
		if err := tx.Pitches().Create(background, fullPitch(3)); err != nil {
			return err
		}
		return tx.Pitches().Create(background, fullPitch(1))
	})
	err := s.Atomically(background, func(tx store.Tx) error { return tx.Pitches().Create(background, fullPitch(3)) })
	expectError(t, "a second pitch in a taken slot", err, storeerr.ErrExists)
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Pitches().Get(background, 3)
		mustEqual(t, "pitch 3", got, fullPitch(3))
		list, _ := tx.Pitches().List(background)
		mustEqual(t, "by slot", list, []domain.Pitch{fullPitch(1), fullPitch(3)})
		return nil
	})

	// Update rewrites the history: version 1 deleted, version 3 added, version 3 live.
	updated := fullPitch(3)
	updated.Title, updated.Live, updated.LastNumber, updated.UpdatedAt = "Why now, really", 3, 3, at(9)
	updated.Versions = []domain.PitchVersion{
		updated.Versions[1],
		{Number: 3, Text: "Third.", Author: "Sam Owner", Writer: domain.WriterOwner, CreatedAt: at(9)},
	}
	write(t, s, func(tx store.Tx) error { return tx.Pitches().Update(background, updated) })
	read(t, s, func(tx store.Tx) error {
		got, _ := tx.Pitches().Get(background, 3)
		mustEqual(t, "updated pitch", got, updated)
		untouched, _ := tx.Pitches().Get(background, 1)
		mustEqual(t, "the other pitch", untouched, fullPitch(1))
		return nil
	})
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Pitches().Update(background, fullPitch(7)) })
	expectError(t, "update missing", err, storeerr.ErrNotFound)

	// Delete takes the versions too: a new pitch in the same slot starts with none of the old history.
	write(t, s, func(tx store.Tx) error { return tx.Pitches().Delete(background, 3) })
	err = s.Atomically(background, func(tx store.Tx) error { return tx.Pitches().Delete(background, 3) })
	expectError(t, "delete twice", err, storeerr.ErrNotFound)
	fresh := domain.Pitch{
		Slot: 3, Title: "New", Live: 1, LastNumber: 1, CreatedAt: at(10), UpdatedAt: at(10),
		Versions: []domain.PitchVersion{{Number: 1, Text: "Fresh.", Author: "Sam Owner", Writer: domain.WriterOwner, CreatedAt: at(10)}},
	}
	write(t, s, func(tx store.Tx) error { return tx.Pitches().Create(background, fresh) })
	read(t, s, func(tx store.Tx) error {
		got, err := tx.Pitches().Get(background, 3)
		if err != nil {
			return err
		}
		mustEqual(t, "a new pitch in a freed slot", got, fresh)
		_, err = tx.Pitches().Get(background, 9)
		expectError(t, "get missing", err, storeerr.ErrNotFound)
		return nil
	})
}
