//! A note and the rule that merges two statements of it: the later compose time wins.
//!
//! In the app: the far side (a server, a store) applies every incoming write through `accept_write`.
//! Used by: `app::note_sync` (the type), `adapters::chaos::fault_server` (the model server merges with it).
//! Uses: `config` (the skew tolerance).
//!
//! Why compose time and not arrival time: a write queued offline arrives late, and must not
//! overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
//! so a device an hour fast would otherwise win every comparison for the next hour.

use crate::config::MAX_COMPOSE_SKEW_AHEAD_MS;

/// One note as a device stated it; `composed_at` is the device's wall clock in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub text: String,
    pub composed_at: i64,
}

/// The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming one.
#[must_use]
pub fn merge_note(stored: Option<&Note>, incoming: Note) -> Note {
    match stored {
        Some(kept) if kept.composed_at > incoming.composed_at => kept.clone(),
        _ => incoming,
    }
}

/// A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
#[must_use]
pub const fn clamp_composed_at(composed_at: i64, server_now: i64, max_ahead_ms: i64) -> i64 {
    if composed_at > server_now.saturating_add(max_ahead_ms) {
        server_now
    } else {
        composed_at
    }
}

/// Applies one incoming write on the far side: clamp its stamp, then merge.
#[must_use]
pub fn accept_write(stored: Option<&Note>, incoming: Note, server_now: i64) -> Note {
    let composed_at = clamp_composed_at(incoming.composed_at, server_now, MAX_COMPOSE_SKEW_AHEAD_MS);
    merge_note(
        stored,
        Note {
            composed_at,
            ..incoming
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn note(text: &str, composed_at: i64) -> Note {
        Note {
            id: "n".into(),
            text: text.into(),
            composed_at,
        }
    }

    #[test]
    fn a_tie_goes_to_the_incoming_statement() {
        assert_eq!(merge_note(Some(&note("old", 5)), note("new", 5)).text, "new");
    }

    #[test]
    fn a_fast_clock_is_clamped_to_the_server() {
        let hour = 3_600_000;
        assert_eq!(accept_write(None, note("x", 1_000 + hour), 1_000).composed_at, 1_000);
    }

    proptest! {
        // The law: the winner is never older than what was stored, so a late arrival can't rewind a note.
        #[test]
        fn merge_never_goes_back_in_time(stored_at in any::<i64>(), incoming_at in any::<i64>()) {
            let merged = merge_note(Some(&note("s", stored_at)), note("i", incoming_at));
            prop_assert!(merged.composed_at >= stored_at);
        }

        // The law: applying the same write twice changes nothing the first application didn't.
        #[test]
        fn accepting_a_write_is_idempotent(stored_at in 0_i64..1_000_000, incoming_at in 0_i64..1_000_000, now in 0_i64..1_000_000) {
            let stored = note("s", stored_at);
            let once = accept_write(Some(&stored), note("i", incoming_at), now);
            let twice = accept_write(Some(&once), note("i", incoming_at), now);
            prop_assert_eq!(once, twice);
        }

        // The law: no stamp survives further ahead of the server than the tolerance.
        #[test]
        fn a_clamped_stamp_is_never_far_ahead(composed_at in any::<i64>(), now in 0_i64..i64::MAX / 2, max in 0_i64..1_000_000) {
            prop_assert!(clamp_composed_at(composed_at, now, max) <= now + max);
        }
    }
}
