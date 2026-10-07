"""An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
In the app: nothing; test support for the tier-2 (fault injection) tests.
Used by: tests/services/test_note_sync_chaos.py.
Uses: app/ports/note_sync.py (implements NoteOutbox).

The rows live in a `Disk` object the test keeps, so "restart the process" is a new outbox over
the same disk. Every step is atomic, like a transactional store: a kill lands between steps,
never inside one, which is what a kill *is* to a store with a journal.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from app.domain.result import Err, Ok, Result
from app.ports.note_sync import OutboxEntry, StorageFull

RowState = Literal["pending", "claimed", "parked"]

# Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
# the remove commits (the server has it; the outbox doesn't know).
KillPoint = Literal["after-claim", "before-remove"]


@dataclass(slots=True)
class Row:
    entry: OutboxEntry
    state: RowState


# What survives a process: the rows, in append order.
@dataclass(slots=True)
class Disk:
    rows: list[Row] = field(default_factory=lambda: [])  # noqa: PIE807 (pyright strict needs the element type)

    def states(self) -> list[RowState]:
        return [row.state for row in self.rows]


# Faults this outbox can play: refuse appends (full disk), or kill the process once at a point.
# Read on every call, so a test can change them mid-run.
@dataclass(slots=True)
class OutboxFaults:
    full: bool = False
    kill: KillPoint | None = None


# What the "process" raises when the script kills it; a test expects exactly this.
class ProcessKilled(Exception):  # noqa: N818 (named for what happened, like KeyboardInterrupt)
    def __init__(self, point: KillPoint) -> None:
        super().__init__(f"process killed {point}")


class MemoryOutbox:
    def __init__(self, disk: Disk, faults: OutboxFaults | None = None) -> None:
        self._disk = disk
        self._faults = faults if faults is not None else OutboxFaults()

    def _row(self, write_id: str) -> Row:
        for row in self._disk.rows:
            if row.entry.write_id == write_id:
                return row
        raise KeyError(f"no outbox row {write_id}")

    # Dies here if the script says so, once; the restarted process runs clean.
    def _killed(self, point: KillPoint) -> bool:
        if self._faults.kill != point:
            return False
        self._faults.kill = None
        return True

    async def append(self, entry: OutboxEntry) -> Result[None, StorageFull]:
        if self._faults.full:
            return Err(StorageFull())
        self._disk.rows.append(Row(entry, "pending"))
        return Ok(None)

    async def pending(self) -> list[OutboxEntry]:
        return [row.entry for row in self._disk.rows if row.state == "pending"]

    async def claim(self, write_id: str) -> None:
        self._row(write_id).state = "claimed"
        if self._killed("after-claim"):
            raise ProcessKilled("after-claim")

    async def release(self, write_id: str) -> None:
        self._row(write_id).state = "pending"

    async def release_claims(self) -> None:
        for row in self._disk.rows:
            if row.state == "claimed":
                row.state = "pending"

    async def remove(self, write_id: str) -> None:
        if self._killed("before-remove"):
            raise ProcessKilled("before-remove")
        self._disk.rows = [row for row in self._disk.rows if row.entry.write_id != write_id]

    async def park(self, write_id: str) -> None:
        self._row(write_id).state = "parked"
