// Pitch use-cases: list the ten pitches, start one, edit its title and cue, add a version, pick the live one, delete.
// In the app: the Pitches page, the front page billboard, and agents suggesting a better wording (HTTP and MCP).
// Used by: internal/httpapi (routes_pitches.go), internal/mcpapi (tools_pitches.go).
// Uses: store.Store (one unit of work per write, with its activity line), internal/domain/pitch.go (who may do what).
//
// The owner-only rules (start, edit, live, delete) are the domain's: an agent actor gets
// domain.ErrOwnerOnly here even if a route forgot its owner check. Agents may only add versions.

package tracker

import (
	"context"
	"errors"
	"fmt"

	"github.com/bretperry/hussla/internal/app/store"
	"github.com/bretperry/hussla/internal/app/storeerr"
	"github.com/bretperry/hussla/internal/domain"
)

// ErrNoFreePitchSlot means all config.PitchSlots slots hold a pitch.
var ErrNoFreePitchSlot = errors.New("all pitch slots are taken: delete one or add a version to it instead")

// ListPitches returns every pitch by slot, each with its versions oldest first.
func (s *Service) ListPitches(ctx context.Context) ([]domain.Pitch, error) {
	var list []domain.Pitch
	err := s.store.View(ctx, func(tx store.Tx) error {
		var err error
		list, err = tx.Pitches().List(ctx)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list pitches: %w", err)
	}
	return list, nil
}

// NewPitchInput is a pitch to start: Slot 0 takes the lowest free slot.
type NewPitchInput struct {
	Slot  int
	Title string
	When  string
	First domain.PitchDraft
}

// CreatePitch starts a pitch with its first (live) version. Owner only. storeerr.ErrExists when the slot is taken.
func (s *Service) CreatePitch(ctx context.Context, actor Actor, input NewPitchInput) (domain.Pitch, error) {
	var pitch domain.Pitch
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		slot := input.Slot
		if slot == 0 {
			existing, err := tx.Pitches().List(ctx)
			if err != nil {
				return err
			}
			free, ok := domain.FirstFreePitchSlot(existing)
			if !ok {
				return ErrNoFreePitchSlot
			}
			slot = free
		}
		now := s.now()
		var err error
		pitch, err = domain.NewPitch(slot, input.Title, input.When, input.First, actor.Name, actor.Writer, now)
		if err != nil {
			return err
		}
		if err := tx.Pitches().Create(ctx, pitch); err != nil {
			return err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Started a pitch", pitchLabel(pitch), now)
		return err
	})
	if err != nil {
		return domain.Pitch{}, fmt.Errorf("create pitch: %w", err)
	}
	return pitch, nil
}

// PatchPitch edits a pitch's title or "when to use it" cue. Owner only.
func (s *Service) PatchPitch(ctx context.Context, actor Actor, slot int, patch domain.PitchPatch) (domain.Pitch, error) {
	return s.changePitch(ctx, slot, func(tx store.Tx, current domain.Pitch) (domain.Pitch, error) {
		now := s.now()
		next, changed, err := domain.ApplyPitchPatch(current, patch, actor.Writer, now)
		if err != nil || len(changed) == 0 {
			return next, err
		}
		if err := tx.Pitches().Update(ctx, next); err != nil {
			return domain.Pitch{}, err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Edited a pitch", pitchLabel(next)+": "+changeDetail(actor.Writer, changed, nil), now)
		return next, err
	})
}

// AddPitchVersion adds a wording to a pitch; the owner or an agent may. The live version doesn't
// move. A retry that sends the same words as the newest version by the same author adds nothing.
func (s *Service) AddPitchVersion(ctx context.Context, actor Actor, slot int, draft domain.PitchDraft) (domain.Pitch, domain.PitchVersion, error) {
	var added domain.PitchVersion
	pitch, err := s.changePitch(ctx, slot, func(tx store.Tx, current domain.Pitch) (domain.Pitch, error) {
		now := s.now()
		next, version, err := domain.AddPitchVersion(current, draft, actor.Name, actor.Writer, now)
		if err != nil {
			return domain.Pitch{}, err
		}
		if newest := current.Versions[len(current.Versions)-1]; newest.Text == version.Text && newest.Note == version.Note && newest.Author == version.Author {
			added = newest
			return current, nil
		}
		added = version
		if err := tx.Pitches().Update(ctx, next); err != nil {
			return domain.Pitch{}, err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Added a pitch version", fmt.Sprintf("%s: version %d", pitchLabel(next), version.Number), now)
		return next, err
	})
	if err != nil {
		return domain.Pitch{}, domain.PitchVersion{}, err
	}
	return pitch, added, nil
}

// SetLivePitchVersion puts a version on the billboard. Owner only, and the HTTP route asks for a passkey tap.
func (s *Service) SetLivePitchVersion(ctx context.Context, actor Actor, slot, number int) (domain.Pitch, error) {
	return s.changePitch(ctx, slot, func(tx store.Tx, current domain.Pitch) (domain.Pitch, error) {
		now := s.now()
		next, changed, err := domain.SetLivePitchVersion(current, number, actor.Writer, now)
		if err != nil || !changed {
			return next, err
		}
		if err := tx.Pitches().Update(ctx, next); err != nil {
			return domain.Pitch{}, err
		}
		_, err = logEvent(ctx, tx, "", actor.Name, "Made a pitch version live", fmt.Sprintf("%s: version %d (was %d)", pitchLabel(next), number, current.Live), now)
		return next, err
	})
}

// DeletePitchVersion removes one version (never the live one). Owner only. found is false when there was no such pitch or version.
func (s *Service) DeletePitchVersion(ctx context.Context, actor Actor, slot, number int) (bool, error) {
	found := true
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Pitches().Get(ctx, slot)
		if errors.Is(err, storeerr.ErrNotFound) {
			found = false
			return domain.CheckPitchDelete(actor.Writer)
		}
		if err != nil {
			return err
		}
		if _, exists := current.Version(number); !exists {
			found = false
			return domain.CheckPitchDelete(actor.Writer)
		}
		now := s.now()
		next, err := domain.DeletePitchVersion(current, number, actor.Writer, now)
		if err != nil {
			return err
		}
		if err := tx.Pitches().Update(ctx, next); err != nil {
			return err
		}
		removed, _ := current.Version(number)
		_, err = logEvent(ctx, tx, "", actor.Name, "Deleted a pitch version", fmt.Sprintf("%s: version %d\nbefore: %s", pitchLabel(current), number, removed.Text), now)
		return err
	})
	if err != nil {
		return false, fmt.Errorf("delete pitch %d version %d: %w", slot, number, err)
	}
	return found, nil
}

// DeletePitch removes a pitch and its history. Owner only. found is false when the slot was empty.
func (s *Service) DeletePitch(ctx context.Context, actor Actor, slot int) (bool, error) {
	found := true
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		if err := domain.CheckPitchDelete(actor.Writer); err != nil {
			return err
		}
		current, err := tx.Pitches().Get(ctx, slot)
		if errors.Is(err, storeerr.ErrNotFound) {
			found = false
			return nil
		}
		if err != nil {
			return err
		}
		if err := tx.Pitches().Delete(ctx, slot); err != nil {
			return err
		}
		// The live words go in the log line, so a deleted pitch can still be typed back in.
		_, err = logEvent(ctx, tx, "", actor.Name, "Deleted a pitch", fmt.Sprintf("%s (%d versions)\nlive: %s", pitchLabel(current), len(current.Versions), current.LiveVersion().Text), s.now())
		return err
	})
	if err != nil {
		return false, fmt.Errorf("delete pitch %d: %w", slot, err)
	}
	return found, nil
}

// changePitch runs one read-rule-write on a stored pitch in a unit of work. A slot outside 1..10
// is a ValidationError; an empty slot is storeerr.ErrNotFound.
func (s *Service) changePitch(ctx context.Context, slot int, change func(tx store.Tx, current domain.Pitch) (domain.Pitch, error)) (domain.Pitch, error) {
	if err := domain.ValidatePitchSlot(slot); err != nil {
		return domain.Pitch{}, err
	}
	var pitch domain.Pitch
	err := s.store.Atomically(ctx, func(tx store.Tx) error {
		current, err := tx.Pitches().Get(ctx, slot)
		if err != nil {
			return err
		}
		pitch, err = change(tx, current)
		return err
	})
	if err != nil {
		return domain.Pitch{}, fmt.Errorf("pitch %d: %w", slot, err)
	}
	return pitch, nil
}

// pitchLabel names a pitch in the activity log: "#3 Why now".
func pitchLabel(pitch domain.Pitch) string { return fmt.Sprintf("#%d %s", pitch.Slot, pitch.Title) }
