"""The ports the note-sync use-case depends on: a local outbox, the remote it delivers to, and a clock.
In the app: contracts only; an adapter per vendor implements each, wired in the composition root (app/container.py).
Used by: app/services/note_sync.py; the fakes in tests/chaos/.
Uses: domain types only (a port sits above the domain and below services and adapters in the `layers` contract).

The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
leaves claims behind that the next flush must release.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.domain.note import Note
from app.domain.result import Result


# One queued write: the note as stated, and the id that makes delivering it twice a no-op.
@dataclass(frozen=True, slots=True)
class OutboxEntry:
    write_id: str
    note: Note


# The only storage failure a caller handles; anything else is a bug and raises.
@dataclass(frozen=True, slots=True)
class StorageFull:
    pass


class NoteOutbox(Protocol):
    # Persists a write; StorageFull when the disk can't take it (nothing is half-written).
    async def append(self, entry: OutboxEntry) -> Result[None, StorageFull]: ...

    # Writes waiting to be sent, oldest first; claimed ones are not included.
    async def pending(self) -> list[OutboxEntry]: ...

    # Marks a write in flight.
    async def claim(self, write_id: str) -> None: ...

    # Puts a write back in the queue for a later flush.
    async def release(self, write_id: str) -> None: ...

    # Puts every claimed write back in the queue: claims left by a process that died mid-flush.
    async def release_claims(self) -> None: ...

    # Drops a write the remote applied.
    async def remove(self, write_id: str) -> None: ...

    # Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
    # kept for a person to look at, so a refusal never silently loses a save.
    async def park(self, write_id: str) -> None: ...


# What the remote said, or that it couldn't be reached. Expected failures are values
# (python.mdc -> Result), so the adapter maps a dropped connection to Unreachable; a raised
# exception means a bug. A real adapter also maps a 408 and 429 (and any other 4xx a retry can
# fix) to ServerError, not Refused: Refused is parked and never retried.
@dataclass(frozen=True, slots=True)
class Applied:
    pass


@dataclass(frozen=True, slots=True)
class Unreachable:
    pass


@dataclass(frozen=True, slots=True)
class ServerError:
    status: int


@dataclass(frozen=True, slots=True)
class Refused:
    status: int


RemoteAnswer = Applied | Unreachable | ServerError | Refused


class NoteRemote(Protocol):
    # Sends one write. The remote applies a write id at most once, so resending is always safe.
    async def put(self, entry: OutboxEntry) -> RemoteAnswer: ...


class Clock(Protocol):
    # Wall-clock milliseconds; may be wrong (skewed), which the far side's merge rule allows for.
    # Sleeping and timeouts are asyncio's, so a test drives them on a virtual-time loop.
    def now_ms(self) -> int: ...
