// Pitch knobs: how many pitches there are, how long one may be, how often the billboard turns, and how fast the owner speaks.
// In the app: the Pitches page (word count and speaking time), the front page billboard, and every pitch write.
// Used by: internal/domain/pitch.go (the bounds), internal/httpapi and internal/mcpapi (sent with GET /api/pitches so the UI reads the same numbers).
//
// The UI gets these from the server, not from a copy in TypeScript, so a retune here reaches the
// billboard and the compare view together.

package config

// PitchSlots is how many pitches the owner keeps; slots run 1..PitchSlots.
const PitchSlots = 10

// PitchMaxCharacters bounds one version's text: about 70 spoken words, a 30-second answer.
// The billboard's quote box is sized so this many characters fit at its smaller type size.
const PitchMaxCharacters = 420

// PitchTitleMaxCharacters bounds a pitch's title ("Why me", "Why now").
const PitchTitleMaxCharacters = 80

// PitchWhenMaxCharacters bounds the "when to use it" cue.
const PitchWhenMaxCharacters = 280

// PitchNoteMaxCharacters bounds the note on a version ("tighter opening").
const PitchNoteMaxCharacters = 280

// PitchMaxVersions caps one pitch's history, so an agent stuck in a loop can't grow it without end;
// the owner deletes old versions to make room.
const PitchMaxVersions = 100

// PitchRotateSeconds is how long the billboard shows one pitch before the next.
const PitchRotateSeconds = 180

// SpeakingWordsPerMinute turns a word count into speaking time on the Pitches page.
const SpeakingWordsPerMinute = 150
