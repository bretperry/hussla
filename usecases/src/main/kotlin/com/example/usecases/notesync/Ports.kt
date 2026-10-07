/*
  The ports the note-sync use-case depends on: a local outbox, the remote it delivers to, and a wall clock.
  In the app: contracts only; an adapter per vendor in :data implements each, wired in the composition root.
  Used by: NoteSync; the fakes in usecases/src/testFixtures (chaos); data SystemWallClock.
  Uses: domain types only.

  The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
  A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
  leaves claims behind that the next flush must release. No sleep/timer port: kotlinx-coroutines'
  delay and withTimeout run on the caller's dispatcher, which tests replace with virtual time.
*/
package com.example.usecases.notesync

import com.example.domain.Note
import com.example.domain.Outcome

// One queued write: the note as stated, and the id that makes delivering it twice a no-op.
data class OutboxEntry(val writeId: String, val note: Note)

// The storage failures a caller handles; anything else is a bug and throws.
sealed interface StorageError {
    data object Full : StorageError
}

interface NoteOutbox {
    // Persists a write; Full when the disk can't take it (nothing is half-written).
    suspend fun append(entry: OutboxEntry): Outcome<Unit, StorageError>

    // Writes waiting to be sent, oldest first; claimed ones are not included.
    suspend fun pending(): List<OutboxEntry>

    // Marks a write in flight.
    suspend fun claim(writeId: String)

    // Puts a write back in the queue for a later flush.
    suspend fun release(writeId: String)

    // Puts every claimed write back in the queue: claims left by a process that died mid-flush.
    suspend fun releaseClaims()

    // Drops a write the remote applied.
    suspend fun remove(writeId: String)

    // Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
    // kept for a person to look at, so a refusal never silently loses a save.
    suspend fun park(writeId: String)
}

// What the remote said, or that it couldn't be reached. Expected failures are values, so the
// adapter maps a dropped connection to Unreachable; a thrown exception means a bug.
sealed interface RemoteAnswer {
    data object Applied : RemoteAnswer

    data object Unreachable : RemoteAnswer

    data class ServerError(val status: Int) : RemoteAnswer

    data class Refused(val status: Int) : RemoteAnswer
}

interface NoteRemote {
    // Sends one write. The remote applies a write id at most once, so resending is always safe.
    suspend fun put(entry: OutboxEntry): RemoteAnswer
}

// Wall-clock milliseconds; may be wrong (skewed), which the far side's merge rule allows for.
fun interface WallClock {
    fun nowMillis(): Long
}
