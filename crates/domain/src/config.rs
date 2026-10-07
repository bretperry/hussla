//! Knobs for the note merge rule; retune here, never inline.
//!
//! In the app: read by `note::accept_write`.
//! Used by: `note`, its tests.

/// A stamp further ahead of the server's clock than this is clamped to the server's clock, so a
/// device whose clock runs fast can't win every later comparison.
pub const MAX_COMPOSE_SKEW_AHEAD_MS: i64 = 30_000;
