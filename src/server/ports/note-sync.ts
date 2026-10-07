/*
  The ports the note-sync use-case depends on: a local outbox, the remote it delivers to, and a clock.
  In the app: contracts only; an adapter per vendor implements each, wired in the composition root.
  Used by: src/server/services/note-sync.ts; the fakes in src/test/chaos/.
  Uses: domain types only (ports-are-contracts).

  The outbox is durable: a write is in it before anything is sent, so a crash never loses a save.
  A claim marks a write as in flight, and is persisted, which is why a process killed mid-flush
  leaves claims behind that the next flush must release.
*/
import type { Note } from "@/domain/note";
import type { Result } from "@/domain/result";

// One queued write: the note as stated, and the id that makes delivering it twice a no-op.
export type OutboxEntry = { readonly writeId: string; readonly note: Note };

// The only storage failure a caller handles; anything else is a bug and throws.
export type StorageError = { readonly kind: "storage-full" };

export interface NoteOutbox {
  // Persists a write; storage-full when the disk can't take it (nothing is half-written).
  append(entry: OutboxEntry): Promise<Result<void, StorageError>>;
  // Writes waiting to be sent, oldest first; claimed ones are not included.
  pending(): Promise<readonly OutboxEntry[]>;
  // Marks a write in flight.
  claim(writeId: string): Promise<void>;
  // Puts a write back in the queue for a later flush.
  release(writeId: string): Promise<void>;
  // Puts every claimed write back in the queue: claims left by a process that died mid-flush.
  releaseClaims(): Promise<void>;
  // Drops a write the remote applied.
  remove(writeId: string): Promise<void>;
  // Sets aside a write the remote refused for a reason a retry won't fix: out of the queue, but
  // kept for a person to look at, so a refusal never silently loses a save.
  park(writeId: string): Promise<void>;
}

// What the remote said, or that it couldn't be reached. Expected failures are values
// (typescript.mdc → Result), so the adapter maps a dropped connection to `unreachable`; a
// rejected promise means a bug.
export type RemoteAnswer =
  | { readonly kind: "applied" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "server-error"; readonly status: number }
  | { readonly kind: "refused"; readonly status: number };

export interface NoteRemote {
  // Sends one write. The remote applies a write id at most once, so resending is always safe.
  put(entry: OutboxEntry): Promise<RemoteAnswer>;
}

export interface Clock {
  // Wall-clock milliseconds; may be wrong (skewed), which the far side's merge rule allows for.
  now(): number;
  // Resolves after `ms`; an abort cancels the timer and rejects. Tests drive it on virtual time.
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
