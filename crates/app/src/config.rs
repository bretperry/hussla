//! Knobs for delivering notes to the remote: retry budget, backoff, and request timeout.
//!
//! In the app: read by the note-sync use-case; retune here, never inline.
//! Used by: `note_sync`, the fault-injection tests.

/// How many times one flush tries a write before leaving it queued for the next flush.
pub const SYNC_MAX_ATTEMPTS: u32 = 4;

/// First retry waits this long; each later one doubles it.
pub const SYNC_BACKOFF_BASE_MS: u64 = 500;

/// A request with no answer by now is treated as dropped and retried (the write id keeps the retry a no-op).
pub const SYNC_REQUEST_TIMEOUT_MS: u64 = 5_000;
