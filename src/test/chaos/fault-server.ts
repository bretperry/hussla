/*
  A model of the remote, driven by a fault script: it merges like the real far side and breaks on command.
  In the app: nothing; test support for the tier-2 (fault injection) tests.
  Used by: src/server/services/note-sync.chaos.test.ts.
  Uses: domain acceptWrite (the real merge rule), ports/note-sync.ts (implements NoteRemote).

  Not a mock of HTTP: a model of behavior. It stores notes through the same acceptWrite the real
  far side runs, applies a write id at most once, and reads the clock the server would. So a test
  asserts the *outcome* (what the server holds, how often a write applied), not a call count.
  Faults are scripted by request index, so "the third request dies after the server applied it"
  is one line, and a failing run replays exactly.
*/
import { acceptWrite, type Note } from "@/domain/note";
import type { NoteRemote, OutboxEntry, RemoteAnswer } from "@/server/ports/note-sync";

// Where a request dies. The split that matters is whether the server applied the write first.
export type ServerFault =
  // The connection never reached the server: nothing applied.
  | { kind: "drop"; when: "before-apply" }
  // The server applied the write and the answer was lost on the way back.
  | { kind: "drop"; when: "after-apply" }
  // The request takes `ms` in flight, then applies and answers.
  | { kind: "delay"; ms: number }
  // A 5xx before anything is applied.
  | { kind: "server-error"; status: number }
  // A 4xx: the server will never accept this write.
  | { kind: "refused"; status: number };

// Faults by zero-based request index; undefined answers normally.
export type FaultScript = (request: number) => ServerFault | undefined;

export const faultServer = ({ now, script = () => undefined }: { now: () => number; script?: FaultScript }) => {
  const notes = new Map<string, Note>();
  const seen = new Set<string>();
  let requests = 0;
  let applies = 0;

  // The real far side's write path: a write id applies once; the merge is the domain's.
  const apply = (entry: OutboxEntry) => {
    if (seen.has(entry.writeId)) return;
    seen.add(entry.writeId);
    applies++;
    notes.set(entry.note.id, acceptWrite(notes.get(entry.note.id), entry.note, now()));
  };

  const remote: NoteRemote = {
    put: async (entry): Promise<RemoteAnswer> => {
      const fault = script(requests++);
      if (fault === undefined) {
        apply(entry);
        return { kind: "applied" };
      }
      if (fault.kind === "drop") {
        // What the client's adapter reports when the connection drops: no answer.
        if (fault.when === "after-apply") apply(entry);
        return { kind: "unreachable" };
      }
      if (fault.kind === "delay") {
        await new Promise((resolve) => setTimeout(resolve, fault.ms));
        apply(entry);
        return { kind: "applied" };
      }
      // A 5xx or a 4xx: answered, nothing applied.
      return { kind: fault.kind, status: fault.status };
    },
  };

  return {
    remote,
    note: (id: string) => notes.get(id),
    // Requests received, failed ones included.
    requests: () => requests,
    // Writes actually applied; a replayed write id doesn't count again.
    applies: () => applies,
  };
};
