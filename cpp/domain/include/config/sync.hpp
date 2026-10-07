// Knobs for delivering notes to the remote: retry budget, backoff, request timeout, and clock-skew tolerance.
// In the app: read by the note-sync use-case and the note merge rule; retune here, never inline.
// Used by: usecases NoteSync, domain note.cpp (accept_write), their tests.
//
// In the domain layer because every layer may read a knob and domain depends on nothing.

#pragma once

#include <chrono>

namespace notes::config {

// How many times one flush tries a write before leaving it queued for the next flush.
inline constexpr int sync_max_attempts = 4;

// First retry waits this long; each later one doubles it.
inline constexpr std::chrono::milliseconds sync_backoff_base{500};

// A request with no answer by now is treated as dropped and retried (the write id keeps the retry a no-op).
inline constexpr std::chrono::milliseconds sync_request_timeout{5'000};

// A stamp further ahead of the server's clock than this is clamped to the server's clock, so a
// device whose clock runs fast can't win every later comparison.
inline constexpr std::chrono::milliseconds max_compose_skew_ahead{30'000};

}  // namespace notes::config
