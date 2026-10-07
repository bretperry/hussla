"""Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
In the app: the write path for notes; a UI or API calls save(), a timer or reconnect calls flush().
Used by: app/container.py builds it; its tests (the tier-2 seed has no entry point calling it yet).
Uses: app/ports/note_sync.py (outbox, remote, clock), app/config.py (retry knobs).

Each fault has one handler here, and a fault-injection test that fails without it
(tests/services/test_note_sync_chaos.py): full disk -> save returns StorageFull; drop
(Unreachable) -> retried; delay -> timed out and retried; 5xx -> retried with backoff, then left
queued; kill mid-write -> the next flush releases dead claims. A fast clock is clamped on the far
side (domain accept_write); a slow clock's later edit still loses (compose-time last-writer-wins).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, assert_never

from app.config import SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS, SYNC_REQUEST_TIMEOUT_MS
from app.domain.note import Note
from app.domain.result import Err, Ok, Result
from app.ports.note_sync import (
    Applied,
    Clock,
    NoteOutbox,
    NoteRemote,
    OutboxEntry,
    Refused,
    ServerError,
    StorageFull,
    Unreachable,
)


# What one flush did with each write it tried.
@dataclass(slots=True)
class FlushReport:
    delivered: int = 0
    refused: int = 0
    requeued: int = 0


# One send's outcome, after timeouts and transport failures are folded in.
Attempt = Literal["applied", "refused", "transient"]


class NoteSync:
    def __init__(
        self,
        outbox: NoteOutbox,
        remote: NoteRemote,
        clock: Clock,
        new_write_id: Callable[[], str],
    ) -> None:
        self._outbox = outbox
        self._remote = remote
        self._clock = clock
        self._new_write_id = new_write_id
        self._in_flight: asyncio.Task[FlushReport] | None = None
        # Set when flush() is called while a run is going: writes saved after that run read the
        # outbox need one more pass, or they would sit until the next flush call.
        self._again = False

    # Stamps and queues a note. Nothing is sent here, so a save works offline.
    async def save(self, note_id: str, text: str) -> Result[Note, StorageFull]:
        note = Note(id=note_id, text=text, composed_at=self._clock.now_ms())
        appended = await self._outbox.append(OutboxEntry(self._new_write_id(), note))
        match appended:
            case Err():
                return appended
            case Ok():
                return Ok(note)

    # Sends every queued write once through the retry budget; what is still failing stays queued.
    #
    # Single-flight: a call while one runs joins it and gets its report. Two at once would both
    # send the same writes, and the second's release_claims would un-claim the first's in-flight row.
    # A joiner also asks the running one for one more pass, so a write saved after it started is delivered.
    async def flush(self) -> FlushReport:
        if self._in_flight is None:
            self._in_flight = asyncio.ensure_future(self._flush_until_quiet())
            self._in_flight.add_done_callback(self._clear_in_flight)
        else:
            self._again = True
        # Shielded: one caller giving up must not cancel the run the others are waiting on.
        return await asyncio.shield(self._in_flight)

    # Passes over the outbox until nobody asked for another; the report is the sum of the passes.
    async def _flush_until_quiet(self) -> FlushReport:
        total = FlushReport()
        while True:
            self._again = False
            report = await self._flush_once()
            total.delivered += report.delivered
            total.refused += report.refused
            total.requeued += report.requeued
            if not self._again:
                return total

    def _clear_in_flight(self, _done: asyncio.Future[FlushReport]) -> None:
        self._in_flight = None

    # One request, bounded by the timeout; no answer in time, Unreachable, and a 5xx all count as transient.
    #
    # A timed-out request's late answer is ignored; the write id makes the retry a no-op if it did apply.
    async def _attempt(self, entry: OutboxEntry) -> Attempt:
        try:
            async with asyncio.timeout(SYNC_REQUEST_TIMEOUT_MS / 1000):
                answer = await self._remote.put(entry)
        except TimeoutError:
            return "transient"
        match answer:
            case Applied():
                return "applied"
            # A refusal (4xx) will never pass, so it isn't retried.
            case Refused():
                return "refused"
            # A 5xx or no connection may pass next time.
            case ServerError() | Unreachable():
                return "transient"
            case _:
                assert_never(answer)

    # Tries one write up to the attempt budget, backing off between tries.
    async def _deliver(self, entry: OutboxEntry) -> Attempt:
        tried = 1
        while True:
            result = await self._attempt(entry)
            if result != "transient" or tried >= SYNC_MAX_ATTEMPTS:
                return result
            await asyncio.sleep(SYNC_BACKOFF_BASE_MS * 2 ** (tried - 1) / 1000)
            tried += 1

    # One pass over the outbox: dead claims back to pending first (a process killed mid-flush left them).
    async def _flush_once(self) -> FlushReport:
        await self._outbox.release_claims()
        report = FlushReport()
        for entry in await self._outbox.pending():
            await self._outbox.claim(entry.write_id)
            result = await self._deliver(entry)
            match result:
                case "applied":
                    await self._outbox.remove(entry.write_id)
                    report.delivered += 1
                case "refused":
                    await self._outbox.park(entry.write_id)
                    report.refused += 1
                case "transient":
                    await self._outbox.release(entry.write_id)
                    report.requeued += 1
                case _:
                    assert_never(result)
        return report
