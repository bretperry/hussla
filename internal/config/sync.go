// Knobs for delivering notes to the remote: retry budget, backoff, request timeout, and clock-skew tolerance.
// In the app: read by the notesync use-case and the note merge rule; retune here, never inline.
// Used by: internal/app/notesync, internal/domain/note.go, their tests.

package config

import "time"

// SyncMaxAttempts is how many times one flush tries a write before leaving it queued for the next flush.
const SyncMaxAttempts = 4

// SyncBackoffBase is the first retry's wait; each later one doubles it.
const SyncBackoffBase = 500 * time.Millisecond

// SyncRequestTimeout bounds one request: no answer by then is treated as dropped and retried (the write id keeps the retry a no-op).
const SyncRequestTimeout = 5 * time.Second

// MaxComposeSkewAhead is how far past the server's clock a stamp may be before it is clamped to the
// server's clock, so a device whose clock runs fast can't win every later comparison.
const MaxComposeSkewAhead = 30 * time.Second
