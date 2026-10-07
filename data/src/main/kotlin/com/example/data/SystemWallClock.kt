/*
  The device's real wall clock, as the WallClock port.
  In the app: a composition root passes it to NoteSync; tests pass a skewed virtual clock instead.
  Used by: a composition root (none in the seed yet).
  Uses: usecases WallClock (the port).

  The seed's one adapter, so :data has a layer row with something in it; a vendor adapter (an HTTP
  remote, a database outbox) goes beside it.
*/
package com.example.data

import com.example.usecases.notesync.WallClock

class SystemWallClock : WallClock {
    // This is the wall-clock adapter: reading the system clock is its whole job.
    @Suppress("ForbiddenMethodCall") override fun nowMillis(): Long = System.currentTimeMillis()
}
