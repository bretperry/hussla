/*
  The composition root's wiring: the one place adapters from :data are constructed and handed to use-cases.
  In the app: NotesApplication builds one at start-up; screens read what they need from it.
  Used by: NotesApplication; AppGraphTest (host), MainActivityTest (device).
  Uses: data SystemWallClock (the WallClock adapter), usecases WallClock (the port).

  Plain Kotlin with no Android types, so the host tests reach it without an emulator. A use-case
  that needs a vendor adapter (an HTTP remote, a database outbox) is built here once that adapter
  exists in :data (docs/deferred.md → Kotlin pack: the seed has no vendor adapter).
*/
package com.example.app

import com.example.data.SystemWallClock
import com.example.usecases.notesync.WallClock

class AppGraph(val clock: WallClock = SystemWallClock())
