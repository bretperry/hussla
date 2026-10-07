/*
  A note and the rule that merges two statements of it: the later compose time wins.
  In the app: the far side (a server, a store) applies every incoming write through acceptWrite.
  Used by: usecases NoteSync (the type), usecases test fixture FaultServer (the model server merges with it).
  Uses: config MAX_COMPOSE_SKEW_AHEAD_MS.

  Why compose time and not arrival time: a write queued offline arrives late, and must not
  overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
  so a device an hour fast would otherwise win every comparison for the next hour.
*/
package com.example.domain

import com.example.config.MAX_COMPOSE_SKEW_AHEAD_MS

data class Note(val id: String, val text: String, val composedAt: Long)

// The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming
// one.
fun mergeNote(stored: Note?, incoming: Note): Note =
    if (stored != null && stored.composedAt > incoming.composedAt) stored else incoming

// A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
fun clampComposedAt(
    composedAt: Long,
    serverNow: Long,
    maxAheadMs: Long = MAX_COMPOSE_SKEW_AHEAD_MS,
): Long = if (composedAt > serverNow + maxAheadMs) serverNow else composedAt

// Applies one incoming write on the far side: clamp its stamp, then merge.
fun acceptWrite(stored: Note?, incoming: Note, serverNow: Long): Note =
    mergeNote(stored, incoming.copy(composedAt = clampComposedAt(incoming.composedAt, serverNow)))
