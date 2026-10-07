/*
  A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
  In the app: nothing; test fixture for the tier-2 (fault injection) tests.
  Used by: usecases NoteSyncChaosTest (and any module's tests, via testFixtures(project(":usecases"))).
  Uses: domain acceptWrite (the real merge rule), notesync Ports (implements NoteRemote).

  Not a mock of HTTP: a model of behavior. It stores notes through the same acceptWrite the real
  far side runs, applies a write id at most once, and reads the clock the server would. So a test
  asserts the outcome (what the server holds, how often a write applied), not a call count.
  Faults are scripted by request index, so "the third request dies after the server applied it"
  is one line, and a failing run replays exactly.
*/
package com.example.usecases.chaos

import com.example.domain.Note
import com.example.domain.acceptWrite
import com.example.usecases.notesync.NoteRemote
import com.example.usecases.notesync.OutboxEntry
import com.example.usecases.notesync.RemoteAnswer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay

// Where a request dies. The split that matters is whether the server applied the write first.
sealed interface ServerFault {
    // The connection never reached the server: nothing applied.
    data object DropBeforeApply : ServerFault

    // The server applied the write and the answer was lost on the way back.
    data object DropAfterApply : ServerFault

    // The request takes `ms` in flight, then applies and answers.
    data class Delay(val ms: Long) : ServerFault

    // A 5xx before anything is applied.
    data class ServerError(val status: Int) : ServerFault

    // A 4xx: the server will never accept this write.
    data class Refused(val status: Int) : ServerFault
}

// Faults by zero-based request index; null answers normally.
fun interface FaultScript {
    fun faultFor(request: Int): ServerFault?
}

// A script that plays `faults` on the first requests, then answers normally.
fun firstRequests(vararg faults: ServerFault): FaultScript = FaultScript { request ->
    faults.getOrNull(request)
}

// The remote port itself, so a test passes the server where the adapter would go. `serverScope`
// runs the server's side of a slow request: a client that times out cancels its wait, not the
// server, which still applies the write later (as a real one would).
class FaultServer(
    private val now: () -> Long,
    private val serverScope: CoroutineScope,
    private val script: FaultScript = FaultScript { null },
) : NoteRemote {
    private val notes = mutableMapOf<String, Note>()
    private val seen = mutableSetOf<String>()

    // Requests received, failed ones included.
    var requests = 0
        private set

    // Writes actually applied; a replayed write id doesn't count again.
    var applies = 0
        private set

    fun note(id: String): Note? = notes[id]

    // The real far side's write path: a write id applies once; the merge is the domain's.
    private fun apply(entry: OutboxEntry) {
        if (!seen.add(entry.writeId)) return
        applies++
        notes[entry.note.id] = acceptWrite(notes[entry.note.id], entry.note, now())
    }

    override suspend fun put(entry: OutboxEntry): RemoteAnswer =
        when (val fault = script.faultFor(requests++)) {
            null -> {
                apply(entry)
                RemoteAnswer.Applied
            }
            // What the client's adapter reports when the connection drops: no answer.
            ServerFault.DropBeforeApply -> RemoteAnswer.Unreachable
            ServerFault.DropAfterApply -> {
                apply(entry)
                RemoteAnswer.Unreachable
            }
            is ServerFault.Delay ->
                serverScope
                    .async {
                        delay(fault.ms)
                        apply(entry)
                        RemoteAnswer.Applied
                    }
                    .await()
            // A 5xx or a 4xx: answered, nothing applied.
            is ServerFault.ServerError -> RemoteAnswer.ServerError(fault.status)
            is ServerFault.Refused -> RemoteAnswer.Refused(fault.status)
        }
}
