"""Knobs for delivering notes to the remote: retry budget, backoff, request timeout, clock-skew tolerance.
In the app: read by the note-sync use-case and the note merge rule; retune here, never inline.
Used by: app/services/note_sync.py, app/domain/note.py, their tests.
"""

from __future__ import annotations

# How many times one flush tries a write before leaving it queued for the next flush.
SYNC_MAX_ATTEMPTS = 4

# First retry waits this long; each later one doubles it.
SYNC_BACKOFF_BASE_MS = 500

# A request with no answer by now is treated as dropped and retried (the write id keeps the retry a no-op).
SYNC_REQUEST_TIMEOUT_MS = 5_000

# A stamp further ahead of the server's clock than this is clamped to the server's clock, so a
# device whose clock runs fast can't win every later comparison.
MAX_COMPOSE_SKEW_AHEAD_MS = 30_000
