//! The ports the note-sync use-case depends on: a local outbox, the remote it delivers to, and a clock.
//!
//! In the app: contracts only; an adapter per vendor implements each, wired in the composition root.
//! Used by: `note_sync`; the fakes in `adapters::chaos`.
//! Uses: domain types only (ports-are-contracts).
//!
//! The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
//! A claim marks a write as in flight and is persisted, which is why a process killed mid-flush
//! leaves claims behind that the next flush must release.
//!
//! Methods return `impl Future + Send` rather than `async fn`: the same thing to implement, but
//! the `Send` bound is spelled out, so a use-case can run on a multi-threaded runtime.

use std::future::Future;

use domain::note::Note;

/// One queued write: the note as stated, and the id that makes delivering it twice a no-op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    pub write_id: String,
    pub note: Note,
}

/// How a store can fail, as a value. A caller handles both; anything else is a bug and crashes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StorageError {
    /// The disk can't take the write; nothing is half-written.
    #[error("storage is full")]
    Full,
    /// The store went away mid-step (the process was killed, the file vanished); state is as the last committed step left it.
    #[error("storage became unavailable")]
    Unavailable,
}

/// A durable queue of writes waiting to be sent.
pub trait NoteOutbox {
    /// Persists a write; `Full` when the disk can't take it.
    fn append(&self, entry: OutboxEntry) -> impl Future<Output = Result<(), StorageError>> + Send;
    /// Writes waiting to be sent, oldest first; claimed ones are not included.
    fn pending(&self) -> impl Future<Output = Result<Vec<OutboxEntry>, StorageError>> + Send;
    /// Marks a write in flight.
    fn claim(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
    /// Puts a write back in the queue for a later flush.
    fn release(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
    /// Puts every claimed write back in the queue: claims left by a process that died mid-flush.
    fn release_claims(&self) -> impl Future<Output = Result<(), StorageError>> + Send;
    /// Drops a write the remote applied.
    fn remove(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
    /// Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
    /// kept for a person to look at, so a refusal never silently loses a save.
    fn park(&self, write_id: &str) -> impl Future<Output = Result<(), StorageError>> + Send;
}

/// What the remote said, or that it couldn't be reached. A dropped connection is a value
/// (`Unreachable`), not a panic: the adapter maps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteAnswer {
    Applied,
    Unreachable,
    ServerError { status: u16 },
    Refused { status: u16 },
}

/// The far side writes are delivered to.
pub trait NoteRemote {
    /// Sends one write. The remote applies a write id at most once, so resending is always safe.
    fn put(&self, entry: &OutboxEntry) -> impl Future<Output = RemoteAnswer> + Send;
}

/// Time, as a port, so tests run on virtual time.
pub trait Clock {
    /// Wall-clock milliseconds; may be wrong (skewed), which the far side's merge rule allows for.
    fn now_ms(&self) -> i64;
    /// Resolves after `ms`. Dropping the future cancels it.
    fn sleep(&self, ms: u64) -> impl Future<Output = ()> + Send;
}
