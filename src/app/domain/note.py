"""A note and the rule that merges two statements of it: the later compose time wins.
In the app: the far side (a server, a store) applies every incoming write through accept_write.
Used by: app/services/note_sync.py (the type), tests/chaos/fault_server.py (the model server merges with it).
Uses: app/config.py (the skew tolerance).

Why compose time and not arrival time: a write queued offline arrives late, and must not
overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
so a device an hour fast would otherwise win every comparison for the next hour.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from app.config import MAX_COMPOSE_SKEW_AHEAD_MS


@dataclass(frozen=True, slots=True)
class Note:
    id: str
    text: str
    composed_at: int


# The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming one.
def merge_note(stored: Note | None, incoming: Note) -> Note:
    if stored is not None and stored.composed_at > incoming.composed_at:
        return stored
    return incoming


# A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
def clamp_composed_at(
    composed_at: int, server_now: int, max_ahead_ms: int = MAX_COMPOSE_SKEW_AHEAD_MS
) -> int:
    return server_now if composed_at > server_now + max_ahead_ms else composed_at


# Applies one incoming write on the far side: clamp its stamp, then merge.
def accept_write(stored: Note | None, incoming: Note, server_now: int) -> Note:
    clamped = replace(incoming, composed_at=clamp_composed_at(incoming.composed_at, server_now))
    return merge_note(stored, clamped)
