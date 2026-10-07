/*
  Knobs for delivering notes to the remote: retry budget, backoff, request timeout, and clock-skew tolerance.
  In the app: read by the note-sync use-case and the note merge rule; retune here, never inline.
  Used by: usecases NoteSync, domain Note (acceptWrite), their tests.

  In :domain because every layer may read a knob and :domain depends on nothing.
*/
package com.example.config

// How many times one flush tries a write before leaving it queued for the next flush.
const val SYNC_MAX_ATTEMPTS = 4

// First retry waits this long; each later one doubles it.
const val SYNC_BACKOFF_BASE_MS = 500L

// A request with no answer by now is treated as dropped and retried (the write id keeps the retry a
// no-op).
const val SYNC_REQUEST_TIMEOUT_MS = 5_000L

// A stamp further ahead of the server's clock than this is clamped to the server's clock, so a
// device whose clock runs fast can't win every later comparison.
const val MAX_COMPOSE_SKEW_AHEAD_MS = 30_000L
