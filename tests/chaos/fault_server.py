"""A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
In the app: nothing; test support for the tier-2 (fault injection) tests.
Used by: tests/services/test_note_sync_chaos.py.
Uses: domain accept_write (the real merge rule), app/ports/note_sync.py (implements NoteRemote).

Not a mock of HTTP: a model of behavior. It stores notes through the same accept_write the real
far side runs, applies a write id at most once, and reads the clock the server would. So a test
asserts the *outcome* (what the server holds, how often a write applied), not a call count.
Faults are scripted by request index, so "the third request dies after the server applied it"
is one line, and a failing run replays exactly.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from app.domain.note import Note, accept_write
from app.ports.note_sync import (
    Applied,
    OutboxEntry,
    Refused,
    RemoteAnswer,
    ServerError,
    Unreachable,
)


# The connection dies. The split that matters is whether the server applied the write first.
@dataclass(frozen=True, slots=True)
class Drop:
    when: Literal["before-apply", "after-apply"]


# The request takes `ms` in flight, then answers; the server applies it on arrival.
@dataclass(frozen=True, slots=True)
class Delay:
    ms: int


# A 5xx before anything is applied.
@dataclass(frozen=True, slots=True)
class ServerFailure:
    status: int


# A 4xx: the server will never accept this write.
@dataclass(frozen=True, slots=True)
class Rejection:
    status: int


ServerFault = Drop | Delay | ServerFailure | Rejection

# Faults by zero-based request index; None answers normally.
FaultScript = Callable[[int], ServerFault | None]


def no_faults(_request: int) -> ServerFault | None:
    return None


class FaultServer:
    def __init__(self, now: Callable[[], int], script: FaultScript = no_faults) -> None:
        self._now = now
        self._script = script
        self._notes: dict[str, Note] = {}
        self._seen: set[str] = set()
        self._requests = 0
        self._applies = 0

    # The real far side's write path: a write id applies once; the merge is the domain's.
    def _apply(self, entry: OutboxEntry) -> None:
        if entry.write_id in self._seen:
            return
        self._seen.add(entry.write_id)
        self._applies += 1
        self._notes[entry.note.id] = accept_write(
            self._notes.get(entry.note.id), entry.note, self._now()
        )

    # The NoteRemote port.
    async def put(self, entry: OutboxEntry) -> RemoteAnswer:
        fault = self._script(self._requests)
        self._requests += 1
        match fault:
            case None:
                self._apply(entry)
                return Applied()
            case Drop(when):
                # What the client's adapter reports when the connection drops: no answer.
                if when == "after-apply":
                    self._apply(entry)
                return Unreachable()
            case Delay(ms):
                # Applied on arrival, answered late: a client that gave up has already retried,
                # and the write id makes the second arrival a no-op.
                self._apply(entry)
                await asyncio.sleep(ms / 1000)
                return Applied()
            case ServerFailure(status):
                return ServerError(status)
            case Rejection(status):
                return Refused(status)

    def note(self, note_id: str) -> Note | None:
        return self._notes.get(note_id)

    # Requests received, failed ones included.
    def requests(self) -> int:
        return self._requests

    # Writes actually applied; a replayed write id doesn't count again.
    def applies(self) -> int:
        return self._applies
