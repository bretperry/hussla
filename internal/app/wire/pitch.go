// Pitches as JSON: the Pitch and PitchList shapes of api/openapi.yaml, shared by the HTTP API and the MCP tools.
// In the app: GET /api/pitches, every pitch write's echo, and list_pitches / add_pitch_version for agents.
// Used by: internal/httpapi (routes_pitches.go), internal/mcpapi (tools_pitches.go).
// Uses: internal/domain/pitch.go, internal/config/pitches.go (the knobs the UI reads from the list).
//
// One encoder for both doors, so a pitch can't read differently to an agent than to the page.

package wire

import (
	"slices"
	"strings"

	"github.com/bretperry/hussla/internal/config"
	"github.com/bretperry/hussla/internal/domain"
)

// PitchVersionJSON is one version of a pitch.
type PitchVersionJSON struct {
	Version   int    `json:"version"`
	Text      string `json:"text"`
	Note      string `json:"note"`
	Author    string `json:"author"`
	Writer    string `json:"writer"`
	CreatedAt string `json:"createdAt"`
}

// PitchJSON is a pitch with its whole history, oldest version first.
type PitchJSON struct {
	Slot        int                `json:"slot"`
	Title       string             `json:"title"`
	When        string             `json:"when"`
	LiveVersion int                `json:"liveVersion"`
	Versions    []PitchVersionJSON `json:"versions"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
}

// PitchSettingsJSON are the pitch knobs the UI needs, sent with the list so page and server agree.
type PitchSettingsJSON struct {
	Slots          int `json:"slots"`
	MaxCharacters  int `json:"maxCharacters"`
	RotateSeconds  int `json:"rotateSeconds"`
	WordsPerMinute int `json:"wordsPerMinute"`
}

// PitchListJSON is GET /api/pitches: every pitch by slot, and the knobs.
type PitchListJSON struct {
	Pitches  []PitchJSON       `json:"pitches"`
	Settings PitchSettingsJSON `json:"settings"`
}

// PitchVersionObject encodes one version.
func PitchVersionObject(version domain.PitchVersion) PitchVersionJSON {
	return PitchVersionJSON{
		Version: version.Number, Text: version.Text, Note: version.Note, Author: version.Author,
		Writer: version.Writer.String(), CreatedAt: domain.FormatTimestamp(version.CreatedAt),
	}
}

// PitchObject encodes a pitch with its versions.
func PitchObject(pitch domain.Pitch) PitchJSON {
	versions := make([]PitchVersionJSON, 0, len(pitch.Versions))
	for _, version := range pitch.Versions {
		versions = append(versions, PitchVersionObject(version))
	}
	return PitchJSON{
		Slot: pitch.Slot, Title: pitch.Title, When: pitch.When, LiveVersion: pitch.Live, Versions: versions,
		CreatedAt: domain.FormatTimestamp(pitch.CreatedAt), UpdatedAt: domain.FormatTimestamp(pitch.UpdatedAt),
	}
}

// PitchList encodes the list with the knobs from internal/config.
func PitchList(list []domain.Pitch) PitchListJSON {
	encoded := make([]PitchJSON, 0, len(list))
	for _, pitch := range list {
		encoded = append(encoded, PitchObject(pitch))
	}
	return PitchListJSON{
		Pitches: encoded,
		Settings: PitchSettingsJSON{
			Slots: config.PitchSlots, MaxCharacters: config.PitchMaxCharacters,
			RotateSeconds: config.PitchRotateSeconds, WordsPerMinute: config.SpeakingWordsPerMinute,
		},
	}
}

// DecodeNewPitch reads POST /api/pitches: {slot?, title, when?, text, note?}. A missing slot is 0 (the lowest free one).
func DecodeNewPitch(object Object) (slot int, title, when string, first domain.PitchDraft, err error) {
	if err := onlyPitchKeys(object, "slot", "title", "when", "text", "note"); err != nil {
		return 0, "", "", domain.PitchDraft{}, err
	}
	decoder := &Decoder{}
	slotField, slotErr := wholeField(decoder, object, "slot")
	titleField, titleErr := textField(decoder, object, "title")
	whenField, whenErr := textField(decoder, object, "when")
	first, draftErr := decodePitchDraft(decoder, object)
	if err := firstError(slotErr, titleErr, whenErr, draftErr); err != nil {
		return 0, "", "", domain.PitchDraft{}, err
	}
	if number := slotField.Apply(nil); number != nil {
		slot = *number
		if err := domain.ValidatePitchSlot(slot); err != nil {
			return 0, "", "", domain.PitchDraft{}, err
		}
	}
	return slot, titleField.Apply(""), whenField.Apply(""), first, nil
}

// DecodePitchDraft reads a new version: {text, note?}.
func DecodePitchDraft(object Object) (domain.PitchDraft, error) {
	if err := onlyPitchKeys(object, "text", "note"); err != nil {
		return domain.PitchDraft{}, err
	}
	return decodePitchDraft(&Decoder{}, object)
}

// DecodePitchPatch reads an owner's edit: {title?, when?}; null clears the cue.
func DecodePitchPatch(object Object) (domain.PitchPatch, error) {
	if err := onlyPitchKeys(object, "title", "when"); err != nil {
		return domain.PitchPatch{}, err
	}
	decoder := &Decoder{}
	var patch domain.PitchPatch
	var errs [2]error
	patch.Title, errs[0] = textField(decoder, object, "title")
	patch.When, errs[1] = textField(decoder, object, "when")
	if err := firstError(errs[:]...); err != nil {
		return domain.PitchPatch{}, err
	}
	return patch, nil
}

// DecodePitchLive reads {version}: the version number to put on the billboard.
func DecodePitchLive(object Object) (int, error) {
	if err := onlyPitchKeys(object, "version"); err != nil {
		return 0, err
	}
	number, err := wholeField(&Decoder{}, object, "version")
	if err != nil {
		return 0, err
	}
	if value := number.Apply(nil); value != nil {
		return *value, nil
	}
	return 0, &domain.ValidationError{Field: "version", Problem: "is required"}
}

func decodePitchDraft(decoder *Decoder, object Object) (domain.PitchDraft, error) {
	text, textErr := textField(decoder, object, "text")
	note, noteErr := textField(decoder, object, "note")
	if err := firstError(textErr, noteErr); err != nil {
		return domain.PitchDraft{}, err
	}
	if !text.IsSet() {
		return domain.PitchDraft{}, &domain.ValidationError{Field: "text", Problem: "is required"}
	}
	return domain.PitchDraft{Text: text.Value(), Note: note.Apply("")}, nil
}

// onlyPitchKeys refuses a key a pitch write doesn't take, so a typo ("live": true) is a 400, not silently ignored.
func onlyPitchKeys(object Object, allowed ...string) error {
	for key := range object {
		if !slices.Contains(allowed, key) {
			return &domain.ValidationError{Field: key, Problem: "isn't a field this write takes (" + strings.Join(allowed, ", ") + ")"}
		}
	}
	return nil
}
