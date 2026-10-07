"""The composition root: the only place adapters are constructed and wired into use-cases.
In the app: an entry point (CLI, API, worker) calls these builders once at start-up.
Used by: the project's entry points (none in the seed).
Uses: app/adapters/*, app/services/*, app/ports/*.

The seed ships the clock adapter only. The outbox and remote are the project's: write an adapter
per vendor in app/adapters/, then construct it here instead of taking it as an argument.
"""

from __future__ import annotations

import uuid

from app.adapters.system_clock import SystemClock
from app.ports.note_sync import NoteOutbox, NoteRemote
from app.services.note_sync import NoteSync


# Wires the note-sync use-case over the real clock; `outbox` and `remote` come from the project's adapters.
def build_note_sync(outbox: NoteOutbox, remote: NoteRemote) -> NoteSync:
    return NoteSync(outbox, remote, SystemClock(), lambda: uuid.uuid4().hex)
