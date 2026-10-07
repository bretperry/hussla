"""An asyncio event loop on virtual time: sleeps and timeouts cost nothing, and a run replays exactly.
In the app: nothing; test support for the tier-2 (fault injection) tests.
Used by: tests/services/test_note_sync_chaos.py.
Uses: asyncio, selectors (stdlib only).

Python has no fake-timer library in the stdlib, so the loop itself fakes the clock: when nothing
is runnable it jumps its own time to the next timer instead of waiting for it. A 10-minute delay
costs microseconds. If nothing is runnable and no timer is pending the test would hang forever on
a real loop; here it raises, so a deadlock is a failure, not a CI timeout.
"""

from __future__ import annotations

import asyncio
import selectors
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


class _JumpingSelector(selectors.BaseSelector):
    """Wraps the real selector; `select(timeout)` advances virtual time instead of blocking."""

    def __init__(self, inner: selectors.BaseSelector, loop: VirtualLoop) -> None:
        self._inner = inner
        self._loop = loop

    def select(self, timeout: float | None = None) -> list[tuple[selectors.SelectorKey, int]]:
        # The loop passes None only when it has no timer and nothing ready: it would block forever.
        if timeout is None:
            raise RuntimeError("virtual loop deadlock: nothing runnable and no timer pending")
        # Jump to the next timer; ready callbacks pass timeout 0 and don't move the clock.
        self._loop.advance(timeout)
        return self._inner.select(0)

    def register(self, fileobj: Any, events: int, data: Any = None) -> selectors.SelectorKey:
        return self._inner.register(fileobj, events, data)

    def unregister(self, fileobj: Any) -> selectors.SelectorKey:
        return self._inner.unregister(fileobj)

    def modify(self, fileobj: Any, events: int, data: Any = None) -> selectors.SelectorKey:
        return self._inner.modify(fileobj, events, data)

    def close(self) -> None:
        self._inner.close()

    def get_map(self) -> Any:
        return self._inner.get_map()


class VirtualLoop(asyncio.SelectorEventLoop):
    def __init__(self) -> None:
        self._virtual_now = 0.0
        super().__init__(_JumpingSelector(selectors.DefaultSelector(), self))

    # Virtual seconds since the loop started; asyncio.sleep and asyncio.timeout read this.
    def time(self) -> float:
        return self._virtual_now

    def advance(self, seconds: float) -> None:
        self._virtual_now += max(seconds, 0.0)

    # Virtual milliseconds since the loop started.
    def elapsed_ms(self) -> int:
        return round(self._virtual_now * 1000)


# Runs `work` to completion on a fresh virtual loop; returns its result and the virtual ms it took.
def run_virtual(work: Coroutine[Any, Any, T]) -> tuple[T, int]:
    loop = VirtualLoop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(work), loop.elapsed_ms()
    finally:
        asyncio.set_event_loop(None)
        loop.close()
