//! Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
//!
//! In the app: the write path for notes; a UI or API calls `save`, a timer or reconnect calls `flush`.
//! Used by: its tests (the template's tier-2 seed has no production caller yet).
//! Uses: `ports` (outbox, remote, clock), `config` (retry knobs).
//!
//! Each fault has one handler here, and a fault-injection test that fails without it
//! (`adapters/tests/note_sync_chaos.rs`): full disk → `save` returns `Full`; drop (`Unreachable`) →
//! retried; delay → timed out and retried; 5xx → retried with backoff, then left queued; kill
//! mid-write → the next flush releases dead claims; two flushes at once → one at a time.
//! A fast clock is clamped on the far side (`domain::note::accept_write`).

use tokio::sync::Mutex;

use domain::note::Note;

use crate::config::{SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS, SYNC_REQUEST_TIMEOUT_MS};
use crate::ports::{Clock, NoteOutbox, NoteRemote, OutboxEntry, RemoteAnswer, StorageError};

/// What one flush did with each write it tried.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FlushReport {
    pub delivered: u32,
    pub refused: u32,
    pub requeued: u32,
}

/// One send's outcome, after timeouts and transport failures are folded in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attempt {
    Applied,
    Refused,
    Transient,
}

/// The use-case over its ports. `new_write_id` mints ids unique across devices, as UUIDs are.
pub struct NoteSync<O, R, C, F> {
    outbox: O,
    remote: R,
    clock: C,
    new_write_id: F,
    // Held for the whole flush: see `flush`.
    flushing: Mutex<()>,
}

impl<O: NoteOutbox, R: NoteRemote, C: Clock, F: Fn() -> String> NoteSync<O, R, C, F> {
    pub fn new(outbox: O, remote: R, clock: C, new_write_id: F) -> Self {
        Self {
            outbox,
            remote,
            clock,
            new_write_id,
            flushing: Mutex::new(()),
        }
    }

    /// Stamps and queues a note. Nothing is sent here, so a save works offline.
    ///
    /// # Errors
    /// `StorageError::Full` when the disk can't take it; nothing is half-saved or sent.
    pub async fn save(&self, id: &str, text: &str) -> Result<Note, StorageError> {
        let note = Note {
            id: id.to_owned(),
            text: text.to_owned(),
            composed_at: self.clock.now_ms(),
        };
        self.outbox
            .append(OutboxEntry {
                write_id: (self.new_write_id)(),
                note: note.clone(),
            })
            .await?;
        Ok(note)
    }

    /// Sends every queued write once through the retry budget; what is still failing stays queued.
    ///
    /// One flush at a time: a second call waits for the first, then finds nothing left to send.
    /// Two at once would both send the same writes, and the second's `release_claims` would
    /// un-claim the first's in-flight row.
    ///
    /// # Errors
    /// A storage failure mid-flush (a kill); the outbox is as the last committed step left it,
    /// and the next flush recovers.
    pub async fn flush(&self) -> Result<FlushReport, StorageError> {
        let _one_at_a_time = self.flushing.lock().await;
        self.outbox.release_claims().await?;
        let mut report = FlushReport::default();
        for entry in self.outbox.pending().await? {
            self.outbox.claim(&entry.write_id).await?;
            match self.deliver(&entry).await {
                Attempt::Applied => {
                    self.outbox.remove(&entry.write_id).await?;
                    report.delivered += 1;
                }
                Attempt::Refused => {
                    self.outbox.park(&entry.write_id).await?;
                    report.refused += 1;
                }
                Attempt::Transient => {
                    self.outbox.release(&entry.write_id).await?;
                    report.requeued += 1;
                }
            }
        }
        Ok(report)
    }

    /// Tries one write up to the attempt budget, backing off between tries.
    async fn deliver(&self, entry: &OutboxEntry) -> Attempt {
        let mut tried = 1;
        loop {
            let result = self.attempt(entry).await;
            if result != Attempt::Transient || tried >= SYNC_MAX_ATTEMPTS {
                return result;
            }
            self.clock
                .sleep(SYNC_BACKOFF_BASE_MS.saturating_mul(2_u64.saturating_pow(tried - 1)))
                .await;
            tried += 1;
        }
    }

    /// One request, bounded by the timeout; no answer in time, unreachable, and a 5xx all count as transient.
    ///
    /// Losing the race drops the other future, which cancels it: a quick answer leaves no timer.
    /// A timed-out request's answer is ignored, but the far side may still apply it later (a real
    /// server does); the write id makes that, and the retry, a no-op.
    async fn attempt(&self, entry: &OutboxEntry) -> Attempt {
        tokio::select! {
            answer = self.remote.put(entry) => match answer {
                RemoteAnswer::Applied => Attempt::Applied,
                // A refusal (4xx) will never pass, so it isn't retried.
                RemoteAnswer::Refused { .. } => Attempt::Refused,
                // A 5xx or no connection may pass next time.
                RemoteAnswer::Unreachable | RemoteAnswer::ServerError { .. } => Attempt::Transient,
            },
            () = self.clock.sleep(SYNC_REQUEST_TIMEOUT_MS) => Attempt::Transient,
        }
    }
}
