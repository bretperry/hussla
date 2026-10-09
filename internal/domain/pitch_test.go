// Tests for pitches: exactly one live version through any sequence of changes, slots 1-10 and
// unique, and an agent writer refused the owner's part (live, delete, edit, start).

package domain_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"pgregory.net/rapid"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// newPitch takes rapid's T or testing's: both have Helper and Fatalf.
func newPitch(t interface {
	Helper()
	Fatalf(format string, args ...any)
}, slot int,
) domain.Pitch {
	t.Helper()
	pitch, err := domain.NewPitch(slot, "  Why me  ", "When they ask what sets me apart", domain.PitchDraft{Text: " I ship. "}, "Sam Owner", domain.WriterOwner, createdAt)
	if err != nil {
		t.Fatalf("NewPitch: %v", err)
	}
	return pitch
}

// liveCount is how many versions the pitch's Live names (it must be exactly one).
func liveCount(pitch domain.Pitch) int {
	count := 0
	for _, version := range pitch.Versions {
		if version.Number == pitch.Live {
			count++
		}
	}
	return count
}

func TestANewPitchHasOneLiveVersion(t *testing.T) {
	pitch := newPitch(t, 1)
	if pitch.Title != "Why me" || len(pitch.Versions) != 1 || pitch.Live != 1 || liveCount(pitch) != 1 {
		t.Fatalf("new pitch = %+v", pitch)
	}
	if live := pitch.LiveVersion(); live.Text != "I ship." || live.Writer != domain.WriterOwner || live.Author != "Sam Owner" {
		t.Errorf("live version = %+v", live)
	}
}

func TestPitchSlotsStayOneToTen(t *testing.T) {
	for _, slot := range []int{0, -1, config.PitchSlots + 1, 99} {
		if _, err := domain.NewPitch(slot, "T", "", domain.PitchDraft{Text: "x"}, "Sam", domain.WriterOwner, createdAt); err == nil {
			t.Errorf("slot %d was accepted", slot)
		}
	}
	for slot := 1; slot <= config.PitchSlots; slot++ {
		if err := domain.ValidatePitchSlot(slot); err != nil {
			t.Errorf("slot %d refused: %v", slot, err)
		}
	}
}

func TestFirstFreePitchSlotNeverHandsOutATakenSlot(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		taken := rapid.SliceOfDistinct(rapid.IntRange(1, config.PitchSlots), func(slot int) int { return slot }).Draw(t, "taken")
		var existing []domain.Pitch
		for _, slot := range taken {
			existing = append(existing, domain.Pitch{Slot: slot})
		}
		slot, ok := domain.FirstFreePitchSlot(existing)
		if len(taken) == config.PitchSlots {
			if ok {
				t.Fatalf("all slots taken, but got %d", slot)
			}
			return
		}
		if !ok || domain.ValidatePitchSlot(slot) != nil {
			t.Fatalf("got %d, %v with %v taken", slot, ok, taken)
		}
		takenSet := map[int]bool{}
		for _, used := range taken {
			takenSet[used] = true
		}
		if takenSet[slot] {
			t.Fatalf("slot %d is taken", slot)
		}
		for lower := 1; lower < slot; lower++ {
			if !takenSet[lower] {
				t.Fatalf("slot %d is free but %d was handed out", lower, slot)
			}
		}
	})
}

func TestAnAgentCannotTakeTheOwnersPart(t *testing.T) {
	pitch := newPitch(t, 2)
	pitch, version, err := domain.AddPitchVersion(pitch, domain.PitchDraft{Text: "Agent's better wording."}, "agent:laptop", domain.WriterAgent, patchedAt)
	if err != nil || version.Number != 2 || version.Writer != domain.WriterAgent {
		t.Fatalf("an agent may add a version: %+v, %v", version, err)
	}
	if pitch.Live != 1 {
		t.Fatalf("adding a version moved the live one to %d", pitch.Live)
	}
	refusals := map[string]error{}
	_, _, refusals["set live"] = domain.SetLivePitchVersion(pitch, 2, domain.WriterAgent, patchedAt)
	_, refusals["delete version"] = domain.DeletePitchVersion(pitch, 2, domain.WriterAgent, patchedAt)
	refusals["delete pitch"] = domain.CheckPitchDelete(domain.WriterAgent)
	_, _, refusals["edit"] = domain.ApplyPitchPatch(pitch, domain.PitchPatch{Title: domain.Set("Hijacked")}, domain.WriterAgent, patchedAt)
	_, refusals["start"] = domain.NewPitch(3, "T", "", domain.PitchDraft{Text: "x"}, "agent:laptop", domain.WriterAgent, patchedAt)
	for action, err := range refusals {
		if !errors.Is(err, domain.ErrOwnerOnly) {
			t.Errorf("%s as an agent: %v, want ErrOwnerOnly", action, err)
		}
	}
	// The owner can do each of them.
	live, changed, err := domain.SetLivePitchVersion(pitch, 2, domain.WriterOwner, patchedAt)
	if err != nil || !changed || live.Live != 2 {
		t.Fatalf("owner set live: %+v, %v, %v", live, changed, err)
	}
	if _, err := domain.DeletePitchVersion(live, 1, domain.WriterOwner, patchedAt); err != nil {
		t.Errorf("owner deletes an old version: %v", err)
	}
	if err := domain.CheckPitchDelete(domain.WriterOwner); err != nil {
		t.Errorf("owner deletes a pitch: %v", err)
	}
}

func TestTheLiveVersionCantBeDeleted(t *testing.T) {
	pitch := newPitch(t, 1)
	_, err := domain.DeletePitchVersion(pitch, 1, domain.WriterOwner, patchedAt)
	var validation *domain.ValidationError
	if !errors.As(err, &validation) || !strings.Contains(validation.Problem, "live") {
		t.Fatalf("deleting the live version: %v", err)
	}
}

func TestPitchTextBounds(t *testing.T) {
	pitch := newPitch(t, 1)
	for name, draft := range map[string]domain.PitchDraft{
		"empty":     {Text: "   "},
		"too long":  {Text: strings.Repeat("a", config.PitchMaxCharacters+1)},
		"long note": {Text: "ok", Note: strings.Repeat("n", config.PitchNoteMaxCharacters+1)},
		"nul":       {Text: "a\x00b"},
	} {
		if _, _, err := domain.AddPitchVersion(pitch, draft, "Sam", domain.WriterOwner, patchedAt); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// The limit counts characters, not bytes: a pitch at the limit in a multi-byte script fits.
	if _, _, err := domain.AddPitchVersion(pitch, domain.PitchDraft{Text: strings.Repeat("é", config.PitchMaxCharacters)}, "Sam", domain.WriterOwner, patchedAt); err != nil {
		t.Errorf("a pitch at the limit: %v", err)
	}
}

func TestVersionNumbersAreNeverReused(t *testing.T) {
	pitch := newPitch(t, 1)
	pitch, _, _ = domain.AddPitchVersion(pitch, domain.PitchDraft{Text: "two"}, "Sam", domain.WriterOwner, patchedAt)
	pitch, _ = domain.DeletePitchVersion(pitch, 2, domain.WriterOwner, patchedAt)
	_, version, err := domain.AddPitchVersion(pitch, domain.PitchDraft{Text: "three"}, "Sam", domain.WriterOwner, patchedAt)
	if err != nil || version.Number != 3 {
		t.Fatalf("after deleting 2, the next version is %d (%v), want 3", version.Number, err)
	}
}

// Property: whatever mix of adds, live picks and deletes (by the owner or an agent) runs, a pitch
// keeps exactly one live version, at least one version, and increasing version numbers it never reuses.
func TestAPitchAlwaysHasExactlyOneLiveVersion(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		pitch := newPitch(t, rapid.IntRange(1, config.PitchSlots).Draw(t, "slot"))
		steps := rapid.IntRange(1, 40).Draw(t, "steps")
		highest := 1
		for step := range steps {
			writer := rapid.SampledFrom([]domain.Writer{domain.WriterOwner, domain.WriterAgent}).Draw(t, "writer")
			target := rapid.IntRange(0, len(pitch.Versions)+2).Draw(t, "target")
			var next domain.Pitch
			var err error
			switch rapid.IntRange(0, 2).Draw(t, "operation") {
			case 0:
				var added domain.PitchVersion
				next, added, err = domain.AddPitchVersion(pitch, domain.PitchDraft{Text: fmt.Sprintf("v%d", step)}, "someone", writer, patchedAt)
				if err == nil && added.Number <= highest {
					t.Fatalf("step %d: version %d reuses a number (highest so far %d)", step, added.Number, highest)
				}
				highest = max(highest, added.Number)
			case 1:
				next, _, err = domain.SetLivePitchVersion(pitch, target, writer, patchedAt)
			default:
				next, err = domain.DeletePitchVersion(pitch, target, writer, patchedAt)
			}
			if err == nil {
				pitch = next
			}
			if liveCount(pitch) != 1 || len(pitch.Versions) == 0 {
				t.Fatalf("step %d: live=%d versions=%+v", step, pitch.Live, pitch.Versions)
			}
			for index := 1; index < len(pitch.Versions); index++ {
				if pitch.Versions[index].Number <= pitch.Versions[index-1].Number {
					t.Fatalf("step %d: version numbers out of order: %+v", step, pitch.Versions)
				}
			}
		}
	})
}

func TestPitchPatchEditsTitleAndCue(t *testing.T) {
	pitch := newPitch(t, 1)
	next, changed, err := domain.ApplyPitchPatch(pitch, domain.PitchPatch{When: domain.Clear[string]()}, domain.WriterOwner, patchedAt)
	if err != nil || next.When != "" || len(changed) != 1 || changed[0] != "when" {
		t.Fatalf("clearing the cue: %+v, %v, %v", next, changed, err)
	}
	if _, _, err := domain.ApplyPitchPatch(pitch, domain.PitchPatch{Title: domain.Clear[string]()}, domain.WriterOwner, patchedAt); err == nil {
		t.Error("a pitch with no title was accepted")
	}
	same, changed, err := domain.ApplyPitchPatch(pitch, domain.PitchPatch{Title: domain.Set("Why me")}, domain.WriterOwner, patchedAt)
	if err != nil || len(changed) != 0 || !same.UpdatedAt.Equal(pitch.UpdatedAt) {
		t.Errorf("an unchanged title: %v, %v", changed, err)
	}
}
