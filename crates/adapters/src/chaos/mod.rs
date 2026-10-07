//! Models of the outside world that fail on command: the far side, a disk, and a clock.
//!
//! In the app: nothing at runtime; test support for the tier-2 (fault injection) tests.
//! Used by: `adapters/tests/note_sync_chaos.rs`.
//! Uses: `app::ports` (each model implements a port), `domain::note` (the real merge rule).

mod clock;
mod fault_server;
mod memory_outbox;

use std::sync::{Mutex, MutexGuard, PoisonError};

pub use clock::VirtualClock;
pub use fault_server::{DropWhen, FaultScript, FaultServer, ServerFault};
pub use memory_outbox::{Disk, KillPoint, MemoryOutbox, OutboxFaults, RowState};

/// Locks a std mutex. A panic elsewhere in a test poisons it; the data is still what the test wants to see.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
