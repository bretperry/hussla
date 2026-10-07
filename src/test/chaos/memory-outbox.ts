/*
  An in-memory outbox with a fault script: a full disk, or the process killed at a chosen step.
  In the app: nothing; test support for the tier-2 (fault injection) tests.
  Used by: src/server/services/note-sync.chaos.test.ts.
  Uses: ports/note-sync.ts (implements NoteOutbox).

  The rows live in a `disk` object the test keeps, so "restart the process" is a new outbox over
  the same disk. Every step is atomic, like a transactional store: a kill lands between steps,
  never inside one, which is what a kill *is* to a store with a journal.
*/
import { err, ok } from "@/domain/result";
import type { NoteOutbox, OutboxEntry } from "@/server/ports/note-sync";

type Row = { entry: OutboxEntry; state: "pending" | "claimed" | "parked" };

// What survives a process: the rows, in append order.
export type Disk = { rows: Row[] };

// Where a kill can land: after a claim commits (nothing sent yet), or after the send and before
// the remove commits (the server has it; the outbox doesn't know).
type KillPoint = "after-claim" | "before-remove";

// Faults this outbox can play: refuse appends (full disk), or kill the process once at a point.
export type OutboxFaults = { full?: boolean; kill?: KillPoint };

// What the "process" throws when the script kills it; a test expects exactly this.
export class ProcessKilled extends Error {
  constructor(point: KillPoint) {
    super(`process killed ${point}`);
  }
}

export const newDisk = (): Disk => ({ rows: [] });

// An outbox over `disk`; `faults` is read on every call, so a test can change it mid-run.
export const memoryOutbox = (disk: Disk, faults: OutboxFaults = {}): NoteOutbox => {
  const row = (writeId: string): Row => {
    const found = disk.rows.find((r) => r.entry.writeId === writeId);
    if (found === undefined) throw new Error(`no outbox row ${writeId}`);
    return found;
  };
  // Dies here if the script says so, once; the restarted process runs clean.
  const killed = (point: KillPoint): boolean => {
    if (faults.kill !== point) return false;
    delete faults.kill;
    return true;
  };
  return {
    append: (entry) => {
      if (faults.full === true) return Promise.resolve(err({ kind: "storage-full" }));
      disk.rows.push({ entry, state: "pending" });
      return Promise.resolve(ok(undefined));
    },
    pending: () => Promise.resolve(disk.rows.filter((r) => r.state === "pending").map((r) => r.entry)),
    claim: (writeId) => {
      row(writeId).state = "claimed";
      return killed("after-claim") ? Promise.reject(new ProcessKilled("after-claim")) : Promise.resolve();
    },
    release: (writeId) => {
      row(writeId).state = "pending";
      return Promise.resolve();
    },
    releaseClaims: () => {
      for (const r of disk.rows) if (r.state === "claimed") r.state = "pending";
      return Promise.resolve();
    },
    remove: (writeId) => {
      if (killed("before-remove")) return Promise.reject(new ProcessKilled("before-remove"));
      disk.rows = disk.rows.filter((r) => r.entry.writeId !== writeId);
      return Promise.resolve();
    },
    park: (writeId) => {
      row(writeId).state = "parked";
      return Promise.resolve();
    },
  };
};
