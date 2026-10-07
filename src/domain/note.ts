/*
  A note and the rule that merges two statements of it: the later compose time wins.
  In the app: the far side (a server, a store) applies every incoming write through acceptWrite.
  Used by: src/server/services/note-sync.ts (the type), src/test/chaos/fault-server.ts (the model server merges with it).
  Uses: src/config/sync.ts (the skew tolerance).

  Why compose time and not arrival time: a write queued offline arrives late, and must not
  overwrite something stated after it. Why the clamp: compose time comes from the device's clock,
  so a device an hour fast would otherwise win every comparison for the next hour.
*/
import { MAX_COMPOSE_SKEW_AHEAD_MS } from "@/config/sync";

export type Note = { readonly id: string; readonly text: string; readonly composedAt: number };

// The stored note after `incoming` is applied: the later statement wins, a tie goes to the incoming one.
export const mergeNote = (stored: Note | undefined, incoming: Note): Note =>
  stored !== undefined && stored.composedAt > incoming.composedAt ? stored : incoming;

// A stamp too far ahead of the server's clock becomes the server's clock; anything else is kept.
export const clampComposedAt = (composedAt: number, serverNow: number, maxAheadMs = MAX_COMPOSE_SKEW_AHEAD_MS): number =>
  composedAt > serverNow + maxAheadMs ? serverNow : composedAt;

// Applies one incoming write on the far side: clamp its stamp, then merge.
export const acceptWrite = (stored: Note | undefined, incoming: Note, serverNow: number): Note =>
  mergeNote(stored, { ...incoming, composedAt: clampComposedAt(incoming.composedAt, serverNow) });
