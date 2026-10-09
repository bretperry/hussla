// Pitches: the owner's ten short, sayable answers ("who I am", "why now"), each with a history of versions and one live version.
// In the app: the Pitches page (history, writer, compare), the front page billboard, and agents suggesting a better wording.
// Used by: the pitch use-cases in internal/app/tracker, storage (internal/adapters/sqlite, the fake), the seed import.
// Uses: internal/config (slots and length bounds).
//
// Security model (docs/plans/hussla-v1.md): agents may add versions; only the owner picks the live
// one, edits a pitch's title and cue, or deletes. The rules below refuse an agent writer
// themselves (ErrOwnerOnly), so the HTTP route's owner check is not the only thing in the way.
//
// Invariants every function here keeps: a pitch has at least one version, its versions are
// numbered 1, 2, 3 … in the order they were written (a deleted number is never reused), and Live
// names exactly one of them.

package domain

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bretperry/hussla/internal/config"
)

// ErrOwnerOnly is an agent asking for the owner's part of a record (picking the live pitch, deleting).
var ErrOwnerOnly = errors.New("only the owner can do this")

// PitchVersion is one wording of a pitch. Author is how the activity log names the writer
// ("Bret", "agent:laptop", "import"); Writer says which kind they were.
type PitchVersion struct {
	Number    int
	Text      string
	Note      string
	Author    string
	Writer    Writer
	CreatedAt time.Time
}

// Pitch is one slot of the owner's ten. When is the "when to use it" cue.
type Pitch struct {
	Slot     int
	Title    string
	When     string
	Live     int            // the Number of the live version
	Versions []PitchVersion // oldest first
	// LastNumber is the highest version number ever given, so a deleted number is never handed out again.
	LastNumber int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// PitchDraft is a new version's words and the optional note on why it changed.
type PitchDraft struct {
	Text string
	Note string
}

// PitchPatch names the pitch fields an owner edit speaks for.
type PitchPatch struct {
	Title Field[string]
	When  Field[string]
}

// LiveVersion is the version on the billboard.
func (pitch Pitch) LiveVersion() PitchVersion {
	version, _ := pitch.Version(pitch.Live)
	return version
}

// Version finds a version by number.
func (pitch Pitch) Version(number int) (PitchVersion, bool) {
	for _, version := range pitch.Versions {
		if version.Number == number {
			return version, true
		}
	}
	return PitchVersion{}, false
}

// ValidatePitchSlot refuses a slot outside 1..config.PitchSlots.
func ValidatePitchSlot(slot int) error {
	if slot < 1 || slot > config.PitchSlots {
		return invalid("slot", fmt.Sprintf("must be 1-%d", config.PitchSlots))
	}
	return nil
}

// FirstFreePitchSlot is the lowest slot no pitch holds; ok is false when all are taken.
func FirstFreePitchSlot(pitches []Pitch) (slot int, ok bool) {
	taken := make(map[int]bool, len(pitches))
	for _, pitch := range pitches {
		taken[pitch.Slot] = true
	}
	for candidate := 1; candidate <= config.PitchSlots; candidate++ {
		if !taken[candidate] {
			return candidate, true
		}
	}
	return 0, false
}

// requireOwner refuses an agent writer: an agent key is never upgraded, whatever it asks.
func requireOwner(writer Writer, action string) error {
	if writer != WriterOwner {
		return fmt.Errorf("%s: %w", action, ErrOwnerOnly)
	}
	return nil
}

// NewPitch starts a pitch in a slot with its first version, which is live. Owner only: a new
// pitch's first words go straight onto the billboard.
func NewPitch(slot int, title, when string, first PitchDraft, author string, writer Writer, now time.Time) (Pitch, error) {
	if err := requireOwner(writer, "start a pitch"); err != nil {
		return Pitch{}, err
	}
	if err := ValidatePitchSlot(slot); err != nil {
		return Pitch{}, err
	}
	now = NormalizeTime(now)
	pitch := Pitch{Slot: slot, CreatedAt: now, UpdatedAt: now}
	var err error
	if pitch.Title, err = pitchTitle(title); err != nil {
		return Pitch{}, err
	}
	if pitch.When, err = boundedText("when", when, config.PitchWhenMaxCharacters); err != nil {
		return Pitch{}, err
	}
	version, err := newPitchVersion(1, first, author, writer, now)
	if err != nil {
		return Pitch{}, err
	}
	pitch.Versions = []PitchVersion{version}
	pitch.Live, pitch.LastNumber = 1, 1
	return pitch, nil
}

// AddPitchVersion appends a new wording; the owner or an agent may. The live version stays as it is.
func AddPitchVersion(pitch Pitch, draft PitchDraft, author string, writer Writer, now time.Time) (Pitch, PitchVersion, error) {
	if len(pitch.Versions) >= config.PitchMaxVersions {
		return Pitch{}, PitchVersion{}, invalid("versions", fmt.Sprintf("this pitch already has %d; the owner deletes old ones to make room", config.PitchMaxVersions))
	}
	now = NormalizeTime(now)
	version, err := newPitchVersion(nextPitchVersionNumber(pitch), draft, author, writer, now)
	if err != nil {
		return Pitch{}, PitchVersion{}, err
	}
	next := clonePitch(pitch)
	next.Versions = append(next.Versions, version)
	next.LastNumber = version.Number
	next.UpdatedAt = now
	return next, version, nil
}

// SetLivePitchVersion puts version `number` on the billboard. Owner only. changed is false when it already was.
func SetLivePitchVersion(pitch Pitch, number int, writer Writer, now time.Time) (next Pitch, changed bool, err error) {
	if err := requireOwner(writer, "pick the live pitch"); err != nil {
		return Pitch{}, false, err
	}
	if _, found := pitch.Version(number); !found {
		return Pitch{}, false, invalid("version", fmt.Sprintf("pitch %d has no version %d", pitch.Slot, number))
	}
	if pitch.Live == number {
		return pitch, false, nil
	}
	next = clonePitch(pitch)
	next.Live = number
	next.UpdatedAt = NormalizeTime(now)
	return next, true, nil
}

// DeletePitchVersion removes one version from the history. Owner only; the live version can't
// go (make another live first), so a pitch always keeps exactly one live version.
func DeletePitchVersion(pitch Pitch, number int, writer Writer, now time.Time) (Pitch, error) {
	if err := requireOwner(writer, "delete a pitch version"); err != nil {
		return Pitch{}, err
	}
	if _, found := pitch.Version(number); !found {
		return Pitch{}, invalid("version", fmt.Sprintf("pitch %d has no version %d", pitch.Slot, number))
	}
	if pitch.Live == number {
		return Pitch{}, invalid("version", fmt.Sprintf("version %d is live: make another version live first", number))
	}
	next := clonePitch(pitch)
	next.Versions = slices.DeleteFunc(next.Versions, func(version PitchVersion) bool { return version.Number == number })
	next.UpdatedAt = NormalizeTime(now)
	return next, nil
}

// CheckPitchDelete says whether `writer` may delete a whole pitch: owner only.
func CheckPitchDelete(writer Writer) error {
	return requireOwner(writer, "delete a pitch")
}

// ApplyPitchPatch edits a pitch's title or cue. Owner only. changed lists the API names that changed.
func ApplyPitchPatch(pitch Pitch, patch PitchPatch, writer Writer, now time.Time) (next Pitch, changed []string, err error) {
	if err := requireOwner(writer, "edit a pitch"); err != nil {
		return Pitch{}, nil, err
	}
	next = clonePitch(pitch)
	if patch.Title.IsCleared() {
		return Pitch{}, nil, invalid("title", "can't be empty")
	}
	if patch.Title.IsSet() {
		if next.Title, err = pitchTitle(patch.Title.Value()); err != nil {
			return Pitch{}, nil, err
		}
	}
	if next.When, err = boundedText("when", patch.When.Apply(pitch.When), config.PitchWhenMaxCharacters); err != nil {
		return Pitch{}, nil, err
	}
	if next.Title != pitch.Title {
		changed = append(changed, "title")
	}
	if next.When != pitch.When {
		changed = append(changed, "when")
	}
	if len(changed) > 0 {
		next.UpdatedAt = NormalizeTime(now)
	}
	return next, changed, nil
}

func newPitchVersion(number int, draft PitchDraft, author string, writer Writer, now time.Time) (PitchVersion, error) {
	text := strings.TrimSpace(draft.Text)
	if text == "" {
		return PitchVersion{}, invalid("text", "is required")
	}
	text, err := boundedText("text", text, config.PitchMaxCharacters)
	if err != nil {
		return PitchVersion{}, err
	}
	note, err := boundedText("note", draft.Note, config.PitchNoteMaxCharacters)
	if err != nil {
		return PitchVersion{}, err
	}
	if strings.TrimSpace(author) == "" {
		return PitchVersion{}, invalid("author", "is required")
	}
	return PitchVersion{Number: number, Text: text, Note: note, Author: author, Writer: writer, CreatedAt: now}, nil
}

// nextPitchVersionNumber is one past the highest number ever given, so a deleted number never comes back.
func nextPitchVersionNumber(pitch Pitch) int {
	highest := pitch.LastNumber
	for _, version := range pitch.Versions {
		highest = max(highest, version.Number)
	}
	return highest + 1
}

func pitchTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", invalid("title", "is required")
	}
	return boundedText("title", title, config.PitchTitleMaxCharacters)
}

// boundedText trims the text and refuses one longer than limit characters, or one carrying a NUL.
func boundedText(field, text string, limit int) (string, error) {
	text = strings.TrimSpace(text)
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", invalid(field, "must be plain text")
	}
	if count := utf8.RuneCountInString(text); count > limit {
		return "", invalid(field, fmt.Sprintf("is %d characters; the limit is %d", count, limit))
	}
	return text, nil
}

func clonePitch(pitch Pitch) Pitch {
	next := pitch
	next.Versions = slices.Clone(pitch.Versions)
	return next
}
