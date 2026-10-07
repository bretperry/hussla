//! Adapters: implementations of the app's ports against one vendor or device each.
//!
//! In the app: the only layer that touches the outside world; the composition root wires these into use-cases.
//! Used by: the composition root; the tests (which may wire an adapter or a fake directly).
//! Uses: `app` (the ports it implements), `domain`.
//!
//! The seed has no real vendor yet, only `chaos` (behind the `test-support` feature): models of the far side, a disk, and a clock for
//! the tier-2 (fault injection) tests. Real adapters (HTTP, `SQLite`) go beside it.

#[cfg(feature = "test-support")]
pub mod chaos;
