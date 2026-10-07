//! An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
//!
//! In the app: nothing at runtime; test support for the tier-2 (fault injection) tests.
//! Used by: `adapters/tests/note_sync_chaos.rs`.
//! Uses: `app::ports` (implements `NoteOutbox`).
//!
//! The rows live in a `Disk` the test keeps, so "restart the process" is a new outbox over the same
//! disk. Every step is atomic, like a transactional store: a kill lands between steps, never inside
//! one, which is what a kill *is* to a store with a journal. A kill reaches the use-case as
//! `StorageError::Unavailable`, which stops the flush where the process would have stopped.

use std::future::{Future, ready};
use std::sync::{Arc, Mutex};

use app::ports::{NoteOutbox, OutboxEntry, StorageError};

use super::locked;

/// Where a row is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowState {
    Pending,
    Claimed,
    Parked,
}

/// What survives a process: the rows, in append order. Cloning shares one disk.
#[derive(Debug, Clone, Default)]
pub struct Disk(Arc<Mutex<Vec<(OutboxEntry, RowState)>>>);

impl Disk {
    /// Each row's state, in append order.
    #[must_use]
    pub fn states(&self) -> Vec<RowState> {
        locked(&self.0).iter().map(|(_, state)| *state).collect()
    }

    /// How many rows are on the disk, whatever their state.
    #[must_use]
    pub fn len(&self) -> usize {
        locked(&self.0).len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
/// the remove commits (the server has it; the outbox doesn't know).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillPoint {
    AfterClaim,
    BeforeRemove,
}

/// Faults this outbox can play: refuse appends (full disk), or kill the process once at a point.
#[derive(Debug, Clone, Copy, Default)]
pub struct OutboxFaults {
    pub full: bool,
    pub kill: Option<KillPoint>,
}

/// An outbox over a `Disk`. Cloning shares the faults, so a test can change them mid-run.
#[derive(Debug, Clone)]
pub struct MemoryOutbox {
    disk: Disk,
    faults: Arc<Mutex<OutboxFaults>>,
}

impl MemoryOutbox {
    #[must_use]
    pub fn new(disk: Disk, faults: Arc<Mutex<OutboxFaults>>) -> Self {
        Self { disk, faults }
    }

    /// Dies here if the script says so, once; the restarted process runs clean.
    fn killed(&self, point: KillPoint) -> bool {
        let mut faults = locked(&self.faults);
        let hit = faults.kill == Some(point);
        if hit {
            faults.kill = None;
        }
        hit
    }

    /// Sets a row's state. A row that isn't there is left alone, so a repeated step is a no-op.
    fn set_state(&self, write_id: &str, state: RowState) {
        for (entry, row_state) in locked(&self.disk.0).iter_mut() {
            if entry.write_id == write_id {
                *row_state = state;
            }
        }
    }
}

impl NoteOutbox for MemoryOutbox {
    fn append(&self, entry: OutboxEntry) -> impl Future<Output = Result<(), StorageError>> + Send {
        let full = locked(&self.faults).full;
        if !full {
            locked(&self.disk.0).push((entry, RowState::Pending));
        }
        ready(if full { Err(StorageError::Full) } else { Ok(()) })
    }

    fn pending(&self) -> impl Future<Output = Result<Vec<OutboxEntry>, StorageError>> + Send {
        let rows = locked(&self.disk.0);
        let pending = rows
            .iter()
            .filter(|(_, state)| *state == RowState::Pending)
            .map(|(entry, _)| entry.clone());
        ready(Ok(pending.collect()))
    }

    fn claim(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send {
        self.set_state(write_id, RowState::Claimed);
        ready(if self.killed(KillPoint::AfterClaim) {
            Err(StorageError::Unavailable)
        } else {
            Ok(())
        })
    }

    fn release(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send {
        self.set_state(write_id, RowState::Pending);
        ready(Ok(()))
    }

    fn release_claims(&self) -> impl Future<Output = Result<(), StorageError>> + Send {
        for (_, state) in locked(&self.disk.0).iter_mut() {
            if *state == RowState::Claimed {
                *state = RowState::Pending;
            }
        }
        ready(Ok(()))
    }

    fn remove(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send {
        if self.killed(KillPoint::BeforeRemove) {
            return ready(Err(StorageError::Unavailable));
        }
        locked(&self.disk.0).retain(|(entry, _)| entry.write_id != write_id);
        ready(Ok(()))
    }

    fn park(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send {
        self.set_state(write_id, RowState::Parked);
        ready(Ok(()))
    }
}
