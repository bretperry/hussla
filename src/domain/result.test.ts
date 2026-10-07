/*
  Property tests for the Result helpers: the laws callers rely on when chaining steps.
  In the app: nothing at runtime; runs in `pnpm test`.
  Used by: vitest.
  Uses: fast-check to generate values instead of hand-picking a few.

  Also the template's worked example of a property test for pure domain code (testing.mdc).
*/
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { andThen, err, map, ok, unwrapOr, type Result } from "./result";

// Arbitrary Result<number, string>: both branches, so every law is checked on each.
const anyResult = fc.oneof(fc.integer().map(ok), fc.string().map(err)) as fc.Arbitrary<
  Result<number, string>
>;

// A step that can fail, for the chaining laws.
const half = (value: number): Result<number, "odd"> => (value % 2 === 0 ? ok(value / 2) : err("odd"));

describe("Result", () => {
  it("map with identity changes nothing", () => {
    fc.assert(fc.property(anyResult, (result) => {
      expect(map(result, (value) => value)).toEqual(result);
    }));
  });

  it("map leaves a failure untouched", () => {
    fc.assert(fc.property(fc.string(), (message) => {
      expect(map(err(message), (value: number) => value + 1)).toEqual(err(message));
    }));
  });

  it("andThen on a success is the next step applied to its value", () => {
    fc.assert(fc.property(fc.integer(), (value) => {
      expect(andThen(ok(value), half)).toEqual(half(value));
    }));
  });

  it("andThen short-circuits on the first failure", () => {
    fc.assert(fc.property(fc.string(), (message) => {
      let ran = false;
      andThen(err(message), () => {
        ran = true;
        return ok(1);
      });
      expect(ran).toBe(false);
    }));
  });

  it("unwrapOr returns the value on success and the fallback on failure", () => {
    fc.assert(fc.property(fc.integer(), fc.integer(), (value, fallback) => {
      expect(unwrapOr(ok(value), fallback)).toBe(value);
      expect(unwrapOr(err("no"), fallback)).toBe(fallback);
    }));
  });
});
