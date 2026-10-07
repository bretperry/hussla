/*
  Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
  In the app: the write path for notes; a UI or API calls save(), a timer or reconnect calls flush().
  Used by: its tests (the seed has no composition root yet).
  Uses: Ports.kt (outbox, remote, wall clock), config Sync.kt (retry knobs), kotlinx-coroutines (timeout, backoff).

  Each fault has one handler here, and a fault-injection test that fails without it
  (NoteSyncChaosTest): full disk → save returns StorageError.Full; drop (Unreachable) → retried;
  delay → timed out and retried; 5xx → retried with backoff, then left queued; 4xx → parked;
  kill mid-write → the next flush releases dead claims; overlapping flushes → one run. A fast
  clock is clamped on the far side (domain acceptWrite); a slow clock's later edit still loses
  (docs/deferred.md).
*/
package com.example.usecases.notesync

import com.example.config.SYNC_BACKOFF_BASE_MS
import com.example.config.SYNC_MAX_ATTEMPTS
import com.example.config.SYNC_REQUEST_TIMEOUT_MS
import com.example.domain.Note
import com.example.domain.Outcome
import com.example.domain.map
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

// What one flush did with each write it tried.
data class FlushReport(val delivered: Int = 0, val refused: Int = 0, val requeued: Int = 0)

// One send's outcome, after timeouts and transport failures are folded in.
private enum class Attempt {
    APPLIED,
    REFUSED,
    TRANSIENT,
}

class NoteSync(
    private val outbox: NoteOutbox,
    private val remote: NoteRemote,
    private val clock: WallClock,
    private val newWriteId: () -> String,
) {
    // The flush running now, if any; overlapping callers share it.
    private val inFlight = AtomicReference<CompletableDeferred<FlushReport>?>(null)

    // Stamps and queues a note. Nothing is sent here, so a save works offline.
    suspend fun save(id: String, text: String): Outcome<Note, StorageError> {
        val note = Note(id, text, clock.nowMillis())
        return outbox.append(OutboxEntry(newWriteId(), note)).map { note }
    }

    // Sends every queued write once through the retry budget; what is still failing stays queued.
    //
    // Single-flight: a call while one runs gets the running one's report. Two at once would both
    // send the same writes, and the second's releaseClaims would un-claim the first's in-flight
    // row.
    suspend fun flush(): FlushReport {
        val mine = CompletableDeferred<FlushReport>()
        // compareAndExchange returns what was there: null means this call owns the run.
        val running = inFlight.compareAndExchange(null, mine)
        if (running != null) return running.await()
        try {
            mine.complete(flushOnce())
        } catch (
            // Any failure (a killed process, a bug) is handed to the callers sharing this run, then
            // rethrown to this one by await() below; nothing is swallowed.
            @Suppress("TooGenericExceptionCaught") failure: Throwable) {
            mine.completeExceptionally(failure)
        } finally {
            inFlight.set(null)
        }
        return mine.await()
    }

    // One pass over the outbox: dead claims back to pending first (a process killed mid-flush left
    // them).
    private suspend fun flushOnce(): FlushReport {
        outbox.releaseClaims()
        var report = FlushReport()
        for (entry in outbox.pending()) {
            outbox.claim(entry.writeId)
            report =
                when (deliver(entry)) {
                    Attempt.APPLIED -> {
                        outbox.remove(entry.writeId)
                        report.copy(delivered = report.delivered + 1)
                    }
                    Attempt.REFUSED -> {
                        outbox.park(entry.writeId)
                        report.copy(refused = report.refused + 1)
                    }
                    Attempt.TRANSIENT -> {
                        outbox.release(entry.writeId)
                        report.copy(requeued = report.requeued + 1)
                    }
                }
        }
        return report
    }

    // Tries one write up to the attempt budget, backing off (doubling) between tries.
    private suspend fun deliver(entry: OutboxEntry): Attempt {
        var tried = 1
        while (true) {
            val result = attempt(entry)
            if (result != Attempt.TRANSIENT || tried >= SYNC_MAX_ATTEMPTS) return result
            delay(SYNC_BACKOFF_BASE_MS shl (tried - 1))
            tried++
        }
    }

    // One request, bounded by the timeout; no answer in time, unreachable, and a 5xx all count as
    // transient.
    //
    // The timeout cancels the request's coroutine, not the server: a request that did reach it may
    // still apply, and the write id makes the retry a no-op.
    private suspend fun attempt(entry: OutboxEntry): Attempt {
        val answer =
            withTimeoutOrNull(SYNC_REQUEST_TIMEOUT_MS) { remote.put(entry) }
                ?: return Attempt.TRANSIENT
        return when (answer) {
            RemoteAnswer.Applied -> Attempt.APPLIED
            // A refusal (4xx) will never pass, so it isn't retried.
            is RemoteAnswer.Refused -> Attempt.REFUSED
            // A 5xx or no connection may pass next time.
            RemoteAnswer.Unreachable,
            is RemoteAnswer.ServerError -> Attempt.TRANSIENT
        }
    }
}
