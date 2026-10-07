/*
  Property tests for the note merge rule: the laws a retried, reordered, or skewed write relies on.
  In the app: nothing at runtime; runs in `pnpm test` (tier 1, testing.mdc).
  Used by: vitest.
  Uses: fast-check.
*/
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_COMPOSE_SKEW_AHEAD_MS } from "@/config/sync";

import { acceptWrite, clampComposedAt, mergeNote, type Note } from "./note";

const anyNote: fc.Arbitrary<Note> = fc.record({
  id: fc.constant("n"),
  text: fc.string(),
  composedAt: fc.integer({ min: 0, max: 1_000_000 }),
});

describe("mergeNote", () => {
  it("applying the same write twice is the same as once (a retry is a no-op)", () => {
    fc.assert(fc.property(fc.option(anyNote, { nil: undefined }), anyNote, (stored, incoming) => {
      expect(mergeNote(mergeNote(stored, incoming), incoming)).toEqual(mergeNote(stored, incoming));
    }));
  });

  it("with distinct stamps, arrival order doesn't matter: the later statement wins", () => {
    fc.assert(fc.property(fc.array(anyNote, { minLength: 1 }), (writes) => {
      const distinct = writes.filter((w, i) => writes.findIndex((o) => o.composedAt === w.composedAt) === i);
      const latest = distinct.reduce((a, b) => (b.composedAt > a.composedAt ? b : a));
      expect(distinct.reduce<Note | undefined>(mergeNote, undefined)).toEqual(latest);
      expect(distinct.toReversed().reduce<Note | undefined>(mergeNote, undefined)).toEqual(latest);
    }));
  });
});

describe("clampComposedAt", () => {
  it("never lets a stamp sit more than the tolerance ahead of the server, and leaves honest stamps alone", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 1e9 }), (composedAt, serverNow) => {
      const honest = composedAt <= serverNow + MAX_COMPOSE_SKEW_AHEAD_MS;
      expect(clampComposedAt(composedAt, serverNow)).toBe(honest ? composedAt : serverNow);
    }));
  });

  it("acceptWrite clamps before it merges", () => {
    const stored: Note = { id: "n", text: "honest", composedAt: 1_000 };
    const fast: Note = { id: "n", text: "fast clock", composedAt: 1_000 + 3_600_000 };
    expect(acceptWrite(stored, fast, 900)).toEqual(stored);
    expect(acceptWrite(undefined, fast, 900)).toEqual({ ...fast, composedAt: 900 });
  });
});
