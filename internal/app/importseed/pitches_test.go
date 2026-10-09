// Tests for importing pitches: version 1 of each, live; a second import adds nothing; an existing pitch is never overwritten.

package importseed_test

import (
	"strings"
	"testing"
	"time"

	"github.com/bretperry/hussla/internal/app/importseed"
	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/domain"
)

// pitchSeed is synthetic: two good pitches, one in a slot that doesn't exist, one with no text.
const pitchSeed = `{"pitches": [
  {"slot": 1, "title": "Who I am", "when": "Opening a call", "text": "I build calm tools for busy people."},
  {"slot": 4, "title": "Why now", "when": "", "text": "The timing is right for a change."},
  {"slot": 11, "title": "Out of range", "when": "", "text": "Never stored."},
  {"slot": 5, "title": "Empty", "when": "", "text": "   "}
]}`

func listPitches(t *testing.T, target store.Store) []domain.Pitch {
	t.Helper()
	var list []domain.Pitch
	if err := target.View(t.Context(), func(tx store.Tx) (err error) {
		list, err = tx.Pitches().List(t.Context())
		return err
	}); err != nil {
		t.Fatalf("list pitches: %v", err)
	}
	return list
}

func TestImportedPitchesAreVersionOneAndLive(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			report, err := importseed.Import(t.Context(), target, strings.NewReader(pitchSeed), now)
			if err != nil {
				t.Fatalf("import: %v", err)
			}
			if report.Pitches.Created != 2 || report.Pitches.Skipped != 2 || len(report.Warnings) != 2 {
				t.Fatalf("report = %+v", report)
			}
			list := listPitches(t, target)
			if len(list) != 2 || list[0].Slot != 1 || list[1].Slot != 4 {
				t.Fatalf("pitches = %+v", list)
			}
			first := list[0]
			if first.Title != "Who I am" || first.When != "Opening a call" || first.Live != 1 || len(first.Versions) != 1 {
				t.Fatalf("pitch 1 = %+v", first)
			}
			if version := first.LiveVersion(); version.Text != "I build calm tools for busy people." || version.Author != domain.ActorImport || version.Writer != domain.WriterOwner {
				t.Errorf("version 1 = %+v", version)
			}

			second, err := importseed.Import(t.Context(), target, strings.NewReader(pitchSeed), now.Add(time.Hour))
			if err != nil {
				t.Fatalf("second import: %v", err)
			}
			if second.Pitches.Created != 0 {
				t.Fatalf("the second import added pitches: %+v", second)
			}
			if again := listPitches(t, target); len(again) != 2 || len(again[0].Versions) != 1 || len(again[1].Versions) != 1 {
				t.Fatalf("a second import changed the pitches: %+v", again)
			}
		})
	}
}

func TestImportNeverOverwritesAnExistingPitch(t *testing.T) {
	for name, target := range stores(t) {
		t.Run(name, func(t *testing.T) {
			honed, err := domain.NewPitch(1, "My own title", "", domain.PitchDraft{Text: "Words the owner honed."}, "Sam Owner", domain.WriterOwner, now)
			if err != nil {
				t.Fatal(err)
			}
			if err := target.Atomically(t.Context(), func(tx store.Tx) error { return tx.Pitches().Create(t.Context(), honed) }); err != nil {
				t.Fatal(err)
			}
			report, err := importseed.Import(t.Context(), target, strings.NewReader(pitchSeed), now)
			if err != nil {
				t.Fatalf("import: %v", err)
			}
			if report.Pitches.Created != 1 {
				t.Fatalf("report = %+v", report)
			}
			list := listPitches(t, target)
			if list[0].Title != "My own title" || len(list[0].Versions) != 1 || list[0].LiveVersion().Text != "Words the owner honed." {
				t.Fatalf("the owner's pitch was touched: %+v", list[0])
			}
		})
	}
}
