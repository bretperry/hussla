/*
  Fault injection (tier 2, testing.mdc) for note-sync: one test per fault kind, plus a property over random fault scripts.
  In the app: nothing at runtime; runs in `pnpm test` on every PR.
  Used by: vitest.
  Uses: src/test/chaos (fault-script server, in-memory outbox), fast-check, Vitest's fake timers (virtual time).

  Each test drives the real use-case against a model of the far side and asserts the outcome:
  what the server holds, how many times a write applied, what is still queued. Remove a handler
  from note-sync.ts and its test goes red; that is the bar for a tier-2 test. Time is virtual, so a
  10-minute delay costs nothing and a failure replays exactly (fast-check prints its seed).
*/
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SYNC_BACKOFF_BASE_MS, SYNC_MAX_ATTEMPTS } from "@/config/sync";
import { err } from "@/domain/result";
import type { Clock } from "@/server/ports/note-sync";
import { faultServer, type FaultScript, type ServerFault } from "@/test/chaos/fault-server";
import { memoryOutbox, newDisk, ProcessKilled, type OutboxFaults } from "@/test/chaos/memory-outbox";

import { createNoteSync } from "./note-sync";

const HOUR = 3_600_000;

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// A device clock on virtual time, `skewMs` off the server's; an abort clears the timer.
const deviceClock = (skewMs = 0): Clock => ({
  now: () => Date.now() + skewMs,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("sleep aborted"));
      });
    }),
});

// Write ids are unique across devices, as real ones (UUIDs) are; the server dedupes on them.
let devices = 0;

// One device: its own disk and outbox faults, talking to `server`. start() is a process (re)start.
const device = (server: ReturnType<typeof faultServer>, { faults = {}, skewMs = 0 }: { faults?: OutboxFaults; skewMs?: number } = {}) => {
  const disk = newDisk();
  const name = `d${++devices}`;
  let ids = 0;
  const start = () =>
    createNoteSync({ outbox: memoryOutbox(disk, faults), remote: server.remote, clock: deviceClock(skewMs), newWriteId: () => `${name}-w${++ids}` });
  return { disk, faults, start };
};

// Runs `work` to completion on virtual time; returns how it settled and the virtual ms it took.
const run = async <T>(work: Promise<T>) => {
  const startedAt = Date.now();
  let tookMs = 0;
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void settled.then(() => (tookMs = Date.now() - startedAt));
  await vi.runAllTimersAsync();
  return { ...(await settled), tookMs };
};

// A script that plays `faults` on the first requests, then answers normally.
const first = (...faults: ServerFault[]): FaultScript => (request) => faults[request];

describe("note-sync under fault injection: one test per fault kind", () => {
  it("drop: retries a dropped request, and a write the server applied before the drop applies once", async () => {
    const server = faultServer({ now: Date.now, script: first({ kind: "drop", when: "before-apply" }, { kind: "drop", when: "after-apply" }) });
    const phone = device(server);
    const sync = phone.start();
    await sync.save("n", "hello");
    expect(await run(sync.flush())).toMatchObject({ ok: true, value: { delivered: 1, requeued: 0 } });
    expect([server.note("n")?.text, server.applies(), server.requests(), phone.disk.rows]).toEqual(["hello", 1, 3, []]);
  });

  it("delay: gives up on a hung request at the timeout, retries, and the late answer applies nothing twice", async () => {
    const server = faultServer({ now: Date.now, script: first({ kind: "delay", ms: 10 * 60_000 }) });
    const phone = device(server);
    const sync = phone.start();
    await sync.save("n", "hello");
    const flushed = await run(sync.flush());
    expect(flushed).toMatchObject({ ok: true, value: { delivered: 1 } });
    expect(flushed.tookMs).toBeLessThan(60_000);
    expect([server.note("n")?.text, server.applies(), phone.disk.rows]).toEqual(["hello", 1, []]);
  });

  it("5xx: retries with backoff and delivers; past the attempt budget the write stays queued, not lost", async () => {
    const flaky = faultServer({ now: Date.now, script: first({ kind: "server-error", status: 503 }, { kind: "server-error", status: 502 }) });
    const sync = device(flaky).start();
    await sync.save("n", "hello");
    const flushed = await run(sync.flush());
    expect(flushed).toMatchObject({ ok: true, value: { delivered: 1 } });
    expect([flaky.note("n")?.text, flaky.requests()]).toEqual(["hello", 3]);
    // Two backoffs actually waited: the first step, then double it.
    expect(flushed.tookMs).toBeGreaterThanOrEqual(SYNC_BACKOFF_BASE_MS * (1 + 2));

    const down = faultServer({ now: Date.now, script: () => ({ kind: "server-error", status: 503 }) });
    const phone = device(down);
    const stuck = phone.start();
    await stuck.save("n", "hello");
    expect(await run(stuck.flush())).toMatchObject({ ok: true, value: { delivered: 0, requeued: 1 } });
    expect([down.requests(), phone.disk.rows.map((r) => r.state)]).toEqual([SYNC_MAX_ATTEMPTS, ["pending"]]);
  });

  it("5xx's neighbour, a 4xx: not retried, and parked rather than dropped", async () => {
    const server = faultServer({ now: Date.now, script: first({ kind: "refused", status: 400 }) });
    const phone = device(server);
    const sync = phone.start();
    await sync.save("n", "hello");
    expect(await run(sync.flush())).toMatchObject({ ok: true, value: { refused: 1 } });
    expect([server.requests(), phone.disk.rows.map((r) => r.state)]).toEqual([1, ["parked"]]);
  });

  it.each(["after-claim", "before-remove"] as const)("kill mid-write (%s): the restarted process delivers the write exactly once", async (kill) => {
    const server = faultServer({ now: Date.now });
    const phone = device(server, { faults: { kill } });
    await phone.start().save("n", "hello");
    const killed = await run(phone.start().flush());
    expect(killed.ok ? null : killed.error).toBeInstanceOf(ProcessKilled);

    const restarted = phone.start();
    expect(await run(restarted.flush())).toMatchObject({ ok: true });
    expect([server.note("n")?.text, server.applies(), phone.disk.rows]).toEqual(["hello", 1, []]);
  });

  it("clock skew: a device an hour fast doesn't beat a later statement from an honest one", async () => {
    const server = faultServer({ now: Date.now });
    const fast = device(server, { skewMs: HOUR }).start();
    const honest = device(server).start();
    await fast.save("n", "from the fast clock");
    await run(fast.flush());
    vi.advanceTimersByTime(60_000);
    await honest.save("n", "said a minute later");
    await run(honest.flush());
    expect(server.note("n")?.text).toBe("said a minute later");
  });

  it("clock skew, the other way: a device an hour slow loses its later edit, and is told delivered", async () => {
    // Documents current behavior, not the goal: compose-time last-writer-wins can't tell a slow
    // clock from an old edit. docs/deferred.md → "Compose-time LWW drops a slow clock's later edit".
    // When that entry is taken, this test flips to expect the later edit.
    const server = faultServer({ now: Date.now });
    const honest = device(server).start();
    const slow = device(server, { skewMs: -HOUR }).start();
    await honest.save("n", "said first");
    await run(honest.flush());
    vi.advanceTimersByTime(60_000);
    await slow.save("n", "said a minute later");
    expect(await run(slow.flush())).toMatchObject({ ok: true, value: { delivered: 1 } });
    expect(server.note("n")?.text).toBe("said first");
  });

  it("full disk: the save is refused as storage-full, nothing half-saved or sent; it works once space is back", async () => {
    const server = faultServer({ now: Date.now });
    const phone = device(server, { faults: { full: true } });
    const sync = phone.start();
    expect(await sync.save("n", "hello")).toEqual(err({ kind: "storage-full" }));
    await run(sync.flush());
    expect([phone.disk.rows, server.requests(), server.note("n")]).toEqual([[], 0, undefined]);

    phone.faults.full = false;
    expect(await sync.save("n", "hello")).toMatchObject({ ok: true });
    await run(sync.flush());
    expect(server.note("n")?.text).toBe("hello");
  });
});

describe("note-sync housekeeping", () => {
  it("a quick answer cancels the request timeout, leaving no timer behind", async () => {
    const sync = device(faultServer({ now: Date.now })).start();
    await sync.save("n", "hello");
    await sync.flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("overlapping flushes share one run, so nothing is sent twice", async () => {
    const server = faultServer({ now: Date.now, script: first({ kind: "delay", ms: 1_000 }) });
    const sync = device(server).start();
    await sync.save("n", "hello");
    const a = sync.flush();
    const b = sync.flush();
    expect(b).toBe(a);
    await run(a);
    expect([server.requests(), server.applies()]).toEqual([1, 1]);
    expect(sync.flush()).not.toBe(a);
  });
});

describe("note-sync under a random fault script", () => {
  const anyFault: fc.Arbitrary<ServerFault | undefined> = fc.oneof(
    fc.constant(undefined),
    fc.constantFrom<ServerFault>({ kind: "drop", when: "before-apply" }, { kind: "drop", when: "after-apply" }),
    fc.integer({ min: 1, max: 20_000 }).map((ms): ServerFault => ({ kind: "delay", ms })),
    fc.constantFrom(500, 502, 503).map((status): ServerFault => ({ kind: "server-error", status })),
  );
  const anySave = fc.tuple(fc.constantFrom("a", "b", "c"), fc.string());

  it("every save lands exactly once, and each note ends as its last statement", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyFault, { maxLength: 12 }), fc.array(anySave, { minLength: 1, maxLength: 6 }), async (faults, saves) => {
        const server = faultServer({ now: Date.now, script: (request) => faults[request] });
        const phone = device(server);
        const sync = phone.start();
        for (const [id, text] of saves) {
          await sync.save(id, text);
          vi.advanceTimersByTime(1);
        }
        // Enough flushes to outlast the script: each one gives every write the full attempt budget.
        for (let flush = 0; flush < 5 && phone.disk.rows.length > 0; flush++) await run(sync.flush());
        await vi.runAllTimersAsync();

        expect(phone.disk.rows).toEqual([]);
        expect(server.applies()).toBe(saves.length);
        const last = new Map(saves);
        for (const [id, text] of last) expect(server.note(id)?.text).toBe(text);
      }),
      { numRuns: 60 },
    );
  });
});
