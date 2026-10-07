"""Fault injection (tier 2, testing.mdc) for note-sync: one test per fault kind, plus a property over random fault scripts.
In the app: nothing at runtime; runs in `uv run pytest` on every PR.
Used by: pytest.
Uses: tests/chaos (fault-script server, in-memory outbox, virtual-time loop), hypothesis.

Each test drives the real use-case against a model of the far side and asserts the outcome:
what the server holds, how many times a write applied, what is still queued. Remove a handler
from services/note_sync.py and its test goes red; that is the bar for a tier-2 test. Time is
virtual (tests/chaos/virtual_loop.py), so a 10-minute delay costs nothing and a failure replays
exactly (hypothesis prints the failing example and a seed to reproduce it).
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.config import SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS
from app.domain.note import Note
from app.domain.result import Err, Ok, Result
from app.ports.note_sync import StorageFull
from app.services.note_sync import FlushReport, NoteSync
from tests.chaos.fault_server import (
    Delay,
    Drop,
    FaultScript,
    FaultServer,
    Rejection,
    ServerFailure,
    ServerFault,
)
from tests.chaos.memory_outbox import Disk, MemoryOutbox, OutboxFaults, ProcessKilled
from tests.chaos.virtual_loop import run_virtual

T = TypeVar("T")

HOUR_MS = 3_600_000

# Virtual wall-clock zero: the loop starts at 0 s, which no real clock reads.
EPOCH_MS = 1_000_000_000

_devices = itertools.count(1)


# The server's clock, on the running loop's virtual time.
def server_now() -> int:
    return EPOCH_MS + round(asyncio.get_running_loop().time() * 1000)


# A device clock on virtual time, `skew_ms` off the server's.
@dataclass(frozen=True, slots=True)
class DeviceClock:
    skew_ms: int = 0

    def now_ms(self) -> int:
        return server_now() + self.skew_ms


# One device: its own disk and outbox faults, talking to `server`. start() is a process (re)start.
class Device:
    def __init__(
        self, server: FaultServer, faults: OutboxFaults | None = None, skew_ms: int = 0
    ) -> None:
        self.disk = Disk()
        self.faults = faults if faults is not None else OutboxFaults()
        self._server = server
        self._skew_ms = skew_ms
        # Write ids are unique across devices, as real ones (UUIDs) are; the server dedupes on them.
        self._name = f"d{next(_devices)}"
        self._ids = itertools.count(1)

    def start(self) -> NoteSync:
        return NoteSync(
            MemoryOutbox(self.disk, self.faults),
            self._server,
            DeviceClock(self._skew_ms),
            lambda: f"{self._name}-w{next(self._ids)}",
        )


# A script that plays `faults` on the first requests, then answers normally.
def first(*faults: ServerFault) -> FaultScript:
    return lambda request: faults[request] if request < len(faults) else None


# Runs one scenario on a virtual loop; returns what it returned and the virtual ms it took.
def play(scenario: Callable[[], Awaitable[T]]) -> tuple[T, int]:
    async def wrapped() -> T:
        return await scenario()

    return run_virtual(wrapped())


class TestOneTestPerFaultKind:
    def test_drop_retries_a_dropped_request_and_a_write_applied_before_the_drop_applies_once(
        self,
    ) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer, Device]:
            server = FaultServer(server_now, first(Drop("before-apply"), Drop("after-apply")))
            phone = Device(server)
            sync = phone.start()
            await sync.save("n", "hello")
            return await sync.flush(), server, phone

        (report, server, phone), _ = play(scenario)
        assert report == FlushReport(delivered=1, requeued=0)
        note = server.note("n")
        assert [
            note.text if note else None,
            server.applies(),
            server.requests(),
            phone.disk.rows,
        ] == [
            "hello",
            1,
            3,
            [],
        ]

    def test_delay_gives_up_on_a_hung_request_at_the_timeout_and_the_late_answer_applies_nothing_twice(
        self,
    ) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer, Device]:
            server = FaultServer(server_now, first(Delay(10 * 60_000)))
            phone = Device(server)
            sync = phone.start()
            await sync.save("n", "hello")
            return await sync.flush(), server, phone

        (report, server, phone), took_ms = play(scenario)
        assert report.delivered == 1
        assert took_ms < 60_000
        note = server.note("n")
        assert [note.text if note else None, server.applies(), phone.disk.rows] == ["hello", 1, []]

    def test_5xx_retries_with_backoff_and_delivers(self) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer]:
            server = FaultServer(server_now, first(ServerFailure(503), ServerFailure(502)))
            sync = Device(server).start()
            await sync.save("n", "hello")
            return await sync.flush(), server

        (report, server), took_ms = play(scenario)
        assert report.delivered == 1
        note = server.note("n")
        assert [note.text if note else None, server.requests()] == ["hello", 3]
        # Two backoffs actually waited: the first step, then double it.
        assert took_ms >= SYNC_BACKOFF_BASE_MS * (1 + 2)

    def test_5xx_past_the_attempt_budget_the_write_stays_queued_not_lost(self) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer, Device]:
            server = FaultServer(server_now, lambda _request: ServerFailure(503))
            phone = Device(server)
            sync = phone.start()
            await sync.save("n", "hello")
            return await sync.flush(), server, phone

        (report, server, phone), _ = play(scenario)
        assert report == FlushReport(delivered=0, requeued=1)
        assert [server.requests(), phone.disk.states()] == [SYNC_MAX_ATTEMPTS, ["pending"]]

    def test_4xx_is_not_retried_and_parked_rather_than_dropped(self) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer, Device]:
            server = FaultServer(server_now, first(Rejection(400)))
            phone = Device(server)
            sync = phone.start()
            await sync.save("n", "hello")
            return await sync.flush(), server, phone

        (report, server, phone), _ = play(scenario)
        assert report.refused == 1
        assert [server.requests(), phone.disk.states()] == [1, ["parked"]]

    @pytest.mark.parametrize("kill", ["after-claim", "before-remove"])
    def test_kill_mid_write_the_restarted_process_delivers_the_write_exactly_once(
        self, kill: str
    ) -> None:
        async def scenario() -> tuple[bool, FaultServer, Device]:
            server = FaultServer(server_now)
            phone = Device(
                server,
                OutboxFaults(kill="after-claim" if kill == "after-claim" else "before-remove"),
            )
            await phone.start().save("n", "hello")
            killed = False
            try:
                await phone.start().flush()
            except ProcessKilled:
                killed = True
            # The restarted process: a new NoteSync over the same disk.
            await phone.start().flush()
            return killed, server, phone

        (killed, server, phone), _ = play(scenario)
        assert killed
        note = server.note("n")
        assert [note.text if note else None, server.applies(), phone.disk.rows] == ["hello", 1, []]

    def test_clock_skew_a_device_an_hour_fast_doesnt_beat_a_later_statement_from_an_honest_one(
        self,
    ) -> None:
        async def scenario() -> FaultServer:
            server = FaultServer(server_now)
            fast = Device(server, skew_ms=HOUR_MS).start()
            honest = Device(server).start()
            await fast.save("n", "from the fast clock")
            await fast.flush()
            await asyncio.sleep(60)
            await honest.save("n", "said a minute later")
            await honest.flush()
            return server

        server, _ = play(scenario)
        note = server.note("n")
        assert note is not None
        assert note.text == "said a minute later"

    def test_clock_skew_the_other_way_a_device_an_hour_slow_loses_its_later_edit_and_is_told_delivered(
        self,
    ) -> None:
        # Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
        # clock from an old edit. When the project takes that on, this test flips to expect the later edit.
        async def scenario() -> tuple[FlushReport, FaultServer]:
            server = FaultServer(server_now)
            honest = Device(server).start()
            slow = Device(server, skew_ms=-HOUR_MS).start()
            await honest.save("n", "said first")
            await honest.flush()
            await asyncio.sleep(60)
            await slow.save("n", "said a minute later")
            return await slow.flush(), server

        (report, server), _ = play(scenario)
        note = server.note("n")
        assert report.delivered == 1
        assert note is not None
        assert note.text == "said first"

    def test_full_disk_the_save_is_refused_as_storage_full_nothing_half_saved_or_sent(self) -> None:
        async def scenario() -> tuple[object, Disk, FaultServer]:
            server = FaultServer(server_now)
            phone = Device(server, OutboxFaults(full=True))
            sync = phone.start()
            refused = await sync.save("n", "hello")
            await sync.flush()
            return refused, phone.disk, server

        (refused, disk, server), _ = play(scenario)
        assert refused == Err(StorageFull())
        assert [disk.rows, server.requests(), server.note("n")] == [[], 0, None]

    def test_full_disk_the_same_save_works_once_space_is_back(self) -> None:
        async def scenario() -> tuple[Result[Note, StorageFull], FaultServer]:
            server = FaultServer(server_now)
            phone = Device(server, OutboxFaults(full=True))
            sync = phone.start()
            await sync.save("n", "hello")
            phone.faults.full = False
            saved = await sync.save("n", "hello")
            await sync.flush()
            return saved, server

        (saved, server), _ = play(scenario)
        assert isinstance(saved, Ok)
        note = server.note("n")
        assert note is not None
        assert note.text == "hello"


class TestHousekeeping:
    def test_overlapping_flushes_share_one_run_so_nothing_is_sent_twice(self) -> None:
        async def scenario() -> tuple[list[FlushReport], FaultServer]:
            server = FaultServer(server_now, first(Delay(1_000)))
            sync = Device(server).start()
            await sync.save("n", "hello")
            reports = await asyncio.gather(sync.flush(), sync.flush())
            return list(reports), server

        (reports, server), _ = play(scenario)
        assert reports[0] is reports[1]
        assert [server.requests(), server.applies()] == [1, 1]

    def test_a_flush_that_joins_a_running_one_still_delivers_a_write_saved_after_it_started(
        self,
    ) -> None:
        async def scenario() -> tuple[FaultServer, Device, FlushReport]:
            server = FaultServer(server_now, first(Delay(1_000)))
            phone = Device(server)
            sync = phone.start()
            await sync.save("a", "first")
            running = asyncio.ensure_future(sync.flush())
            # Mid-flight: the first request is still delayed when "b" is saved and flush() is called again.
            await asyncio.sleep(0.1)
            await sync.save("b", "second")
            joined = await sync.flush()
            await running
            return server, phone, joined

        (server, phone, joined), _ = play(scenario)
        note_b = server.note("b")
        assert note_b is not None
        assert note_b.text == "second"
        assert (phone.disk.rows, server.applies(), joined.delivered) == ([], 2, 2)

    def test_one_caller_giving_up_on_flush_does_not_cancel_the_run_the_other_waits_on(self) -> None:
        async def scenario() -> tuple[FlushReport, FaultServer, Device]:
            server = FaultServer(server_now, first(Delay(1_000)))
            phone = Device(server)
            sync = phone.start()
            await sync.save("a", "first")
            patient = asyncio.ensure_future(sync.flush())
            await asyncio.sleep(0.01)
            # The impatient caller's wait_for cancels its own await; the shield keeps the shared run alive.
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(sync.flush(), 0.1)
            return await patient, server, phone

        (report, server, phone), _ = play(scenario)
        assert report.delivered == 1
        assert (phone.disk.rows, server.applies()) == ([], 1)


# Any one fault the random script can play (the 4xx is left out: it parks the write by design).
any_fault: st.SearchStrategy[ServerFault | None] = st.one_of(
    st.none(),
    st.sampled_from([Drop("before-apply"), Drop("after-apply")]),
    st.integers(min_value=1, max_value=20_000).map(Delay),
    st.sampled_from([500, 502, 503]).map(ServerFailure),
)


class TestRandomFaultScript:
    @settings(max_examples=60, deadline=None)
    @given(
        faults=st.lists(any_fault, max_size=12),
        saves=st.lists(
            st.tuples(st.sampled_from("abc"), st.text(max_size=8)), min_size=1, max_size=6
        ),
    )
    def test_every_save_lands_exactly_once_and_each_note_ends_as_its_last_statement(
        self, faults: list[ServerFault | None], saves: list[tuple[str, str]]
    ) -> None:
        async def scenario() -> tuple[FaultServer, Device]:
            server = FaultServer(
                server_now, lambda request: faults[request] if request < len(faults) else None
            )
            phone = Device(server)
            sync = phone.start()
            for note_id, text in saves:
                await sync.save(note_id, text)
                await asyncio.sleep(0.001)
            # Enough flushes to outlast the script: each one gives every write the full attempt budget.
            for _ in range(5):
                if not phone.disk.rows:
                    break
                await sync.flush()
            return server, phone

        (server, phone), _ = play(scenario)
        assert phone.disk.rows == []
        assert server.applies() == len(saves)
        for note_id, text in dict(saves).items():
            note = server.note(note_id)
            assert note is not None
            assert note.text == text
