"""The real clock: wall-clock milliseconds from the operating system.
In the app: the one Clock adapter the composition root hands to use-cases.
Used by: app/container.py.
Uses: time (an I/O package, which is why this lives in an adapter and not the domain).
"""

from __future__ import annotations

import time


class SystemClock:
    # Wall-clock milliseconds, as the Clock port asks.
    def now_ms(self) -> int:
        return time.time_ns() // 1_000_000
