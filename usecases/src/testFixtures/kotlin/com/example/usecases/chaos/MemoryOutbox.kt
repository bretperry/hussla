/*
  An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
  In the app: nothing; test fixture for the tier-2 (fault injection) tests.
  Used by: usecases NoteSyncChaosTest (and any module's tests, via testFixtures(project(":usecases"))).
  Uses: notesync Ports (implements NoteOutbox).

  The rows live in a Disk the test keeps, so "restart the process" is a new outbox over the same
  disk. Every step is atomic, like a transactional store: a kill lands between steps, never
  inside one, which is what a kill is to a store with a journal.
*/
package com.example.usecases.chaos

import com.example.domain.Outcome
import com.example.usecases.notesync.NoteOutbox
import com.example.usecases.notesync.OutboxEntry
import com.example.usecases.notesync.StorageError

enum class RowState {
    PENDING,
    CLAIMED,
    PARKED,
}

data class Row(val entry: OutboxEntry, var state: RowState)

// What survives a process: the rows, in append order.
class Disk {
    val rows = mutableListOf<Row>()
}

// Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
// the remove commits (the server has it; the outbox doesn't know).
enum class KillPoint {
    AFTER_CLAIM,
    BEFORE_REMOVE,
}

// Faults this outbox can play, read on every call so a test can change them mid-run: refuse
// appends (full disk), or kill the process once at a point.
class OutboxFaults(var full: Boolean = false, var kill: KillPoint? = null)

// What the "process" throws when the script kills it; a test expects exactly this.
class ProcessKilled(point: KillPoint) : RuntimeException("process killed $point")

class MemoryOutbox(private val disk: Disk, private val faults: OutboxFaults = OutboxFaults()) :
    NoteOutbox {
    private fun row(writeId: String): Row =
        checkNotNull(disk.rows.find { it.entry.writeId == writeId }) { "no outbox row $writeId" }

    // Dies here if the script says so, once; the restarted process runs clean.
    private fun dieIfScripted(point: KillPoint) {
        if (faults.kill != point) return
        faults.kill = null
        throw ProcessKilled(point)
    }

    override suspend fun append(entry: OutboxEntry): Outcome<Unit, StorageError> {
        if (faults.full) return Outcome.Err(StorageError.Full)
        disk.rows += Row(entry, RowState.PENDING)
        return Outcome.Ok(Unit)
    }

    override suspend fun pending(): List<OutboxEntry> =
        disk.rows.filter { it.state == RowState.PENDING }.map { it.entry }

    override suspend fun claim(writeId: String) {
        row(writeId).state = RowState.CLAIMED
        dieIfScripted(KillPoint.AFTER_CLAIM)
    }

    override suspend fun release(writeId: String) {
        row(writeId).state = RowState.PENDING
    }

    override suspend fun releaseClaims() {
        for (row in disk.rows) if (row.state == RowState.CLAIMED) row.state = RowState.PENDING
    }

    override suspend fun remove(writeId: String) {
        dieIfScripted(KillPoint.BEFORE_REMOVE)
        disk.rows.removeAll { it.entry.writeId == writeId }
    }

    override suspend fun park(writeId: String) {
        row(writeId).state = RowState.PARKED
    }
}
