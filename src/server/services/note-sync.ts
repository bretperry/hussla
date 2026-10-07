/*
  Saves notes to a local outbox and delivers them to the remote, surviving drops, delays, 5xx, crashes, and a full disk.
  In the app: the write path for notes; a UI or API calls save(), a timer or reconnect calls flush().
  Used by: its tests (the template's tier-2 seed has no production caller yet).
  Uses: ports/note-sync.ts (outbox, remote, clock), src/config/sync.ts (retry knobs).

  Each fault has one handler here, and a fault-injection test that fails without it
  (note-sync.chaos.test.ts): full disk → save returns storage-full; drop (unreachable) → retried;
  delay → timed out and retried; 5xx → retried with backoff, then left queued; kill mid-write →
  the next flush releases dead claims. A fast clock is clamped on the far side (domain
  acceptWrite); a slow clock's later edit still loses (docs/deferred.md → compose-time LWW).
*/
import { SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS, SYNC_REQUEST_TIMEOUT_MS } from "@/config/sync";
import type { Note } from "@/domain/note";
import { ok, type Result } from "@/domain/result";
import type { Clock, NoteOutbox, NoteRemote, OutboxEntry, StorageError } from "@/server/ports/note-sync";

type Deps = {
  readonly outbox: NoteOutbox;
  readonly remote: NoteRemote;
  readonly clock: Clock;
  readonly newWriteId: () => string;
};

// What one flush did with each write it tried.
export type FlushReport = { delivered: number; refused: number; requeued: number };

// One send's outcome, after timeouts and transport failures are folded in.
type Attempt = { readonly kind: "applied" } | { readonly kind: "refused" } | { readonly kind: "transient" };

// Builds the use-case over its ports.
export const createNoteSync = ({ outbox, remote, clock, newWriteId }: Deps) => {
  // One request, bounded by the timeout; no answer in time, unreachable, and a 5xx all count as transient.
  //
  // The timeout's timer is cancelled as soon as the race settles, so a quick answer leaves nothing
  // pending. A timed-out request's late answer is ignored; the write id makes the retry a no-op if it did apply.
  const attempt = async (entry: OutboxEntry): Promise<Attempt> => {
    const timeout = new AbortController();
    const answered = remote.put(entry).then((answer): Attempt => {
      if (answer.kind === "applied") return { kind: "applied" };
      // A refusal (4xx) will never pass, so it isn't retried.
      if (answer.kind === "refused") return { kind: "refused" };
      // A 5xx or no connection may pass next time.
      return { kind: "transient" };
    });
    const timedOut = clock.sleep(SYNC_REQUEST_TIMEOUT_MS, timeout.signal).then((): Attempt => ({ kind: "transient" }));
    try {
      return await Promise.race([answered, timedOut]);
    } finally {
      timeout.abort();
    }
  };

  // Tries one write up to the attempt budget, backing off between tries.
  const deliver = async (entry: OutboxEntry): Promise<Attempt> => {
    for (let tried = 1; ; tried++) {
      const result = await attempt(entry);
      if (result.kind !== "transient" || tried >= SYNC_MAX_ATTEMPTS) return result;
      await clock.sleep(SYNC_BACKOFF_BASE_MS * 2 ** (tried - 1));
    }
  };

  // One pass over the outbox: dead claims back to pending first (a process killed mid-flush left them).
  const flushOnce = async (): Promise<FlushReport> => {
    await outbox.releaseClaims();
    const report: FlushReport = { delivered: 0, refused: 0, requeued: 0 };
    for (const entry of await outbox.pending()) {
      await outbox.claim(entry.writeId);
      const result = await deliver(entry);
      switch (result.kind) {
        case "applied":
          await outbox.remove(entry.writeId);
          report.delivered++;
          break;
        case "refused":
          await outbox.park(entry.writeId);
          report.refused++;
          break;
        case "transient":
          await outbox.release(entry.writeId);
          report.requeued++;
          break;
      }
    }
    return report;
  };
  let inFlight: Promise<FlushReport> | null = null;

  return {
    // Stamps and queues a note. Nothing is sent here, so a save works offline.
    save: async (id: string, text: string): Promise<Result<Note, StorageError>> => {
      const note: Note = { id, text, composedAt: clock.now() };
      const appended = await outbox.append({ writeId: newWriteId(), note });
      if (!appended.ok) return appended;
      return ok(note);
    },

    // Sends every queued write once through the retry budget; what is still failing stays queued.
    //
    // Single-flight: a call while one runs gets the running one's report. Two at once would both
    // send the same writes, and the second's releaseClaims would un-claim the first's in-flight row.
    flush: (): Promise<FlushReport> => {
      inFlight ??= flushOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};
