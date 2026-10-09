// Seed import of pitches: each `{slot, title, when, text}` becomes a pitch with that text as version 1, live.
// In the app: the owner's own pitch drafts arrive with the seed file at install, never from git.
// Used by: importer.run in importseed.go.
// Uses: internal/domain/pitch.go (the same rules a new pitch passes on the Pitches page).
//
// Existing wins, as for every other record: a slot that already holds a pitch is left exactly as
// it is (no version added), so a second import adds nothing and never overwrites the owner's honing.
// The pitches are the owner's words from the owner's file (import is owner-only), so version 1 is
// owner-written, by "import".

package importseed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// pitchJSON is one pitch in the seed file.
type pitchJSON struct {
	Slot  int    `json:"slot"`
	Title string `json:"title"`
	When  string `json:"when"`
	Text  string `json:"text"`
}

func (i *importer) importPitch(ctx context.Context, tx store.Tx, index int, record json.RawMessage) error {
	where := fmt.Sprintf("pitch #%d", index+1)
	var seeded pitchJSON
	if err := json.Unmarshal(record, &seeded); err != nil {
		i.report.Pitches.Skipped++
		i.warn(where, "not a {slot, title, when, text} object; skipped")
		return nil
	}
	if err := domain.ValidatePitchSlot(seeded.Slot); err != nil {
		i.report.Pitches.Skipped++
		i.warn(where, "%v; skipped", err)
		return nil
	}
	if _, err := tx.Pitches().Get(ctx, seeded.Slot); err == nil {
		i.report.Pitches.Skipped++
		return nil
	} else if !errors.Is(err, storeerr.ErrNotFound) {
		return fmt.Errorf("look up pitch %d: %w", seeded.Slot, err)
	}
	pitch, err := domain.NewPitch(seeded.Slot, seeded.Title, seeded.When, domain.PitchDraft{Text: seeded.Text}, domain.ActorImport, domain.WriterOwner, i.now)
	if err != nil {
		i.report.Pitches.Skipped++
		i.warn(fmt.Sprintf("%s (slot %d)", where, seeded.Slot), "%v; skipped", err)
		return nil
	}
	if err := tx.Pitches().Create(ctx, pitch); err != nil {
		return fmt.Errorf("store pitch %d: %w", seeded.Slot, err)
	}
	i.report.Pitches.Created++
	return nil
}
