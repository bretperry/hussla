/*
  Tests route matching: params decode, lengths must agree, and static parts must match.
  In the app: nothing at runtime; guards the route table's "first match wins" assumptions.
  Used by: pnpm test.
*/
import { describe, expect, it } from "vitest";
import { matchRoute } from "./router";

describe("matchRoute", () => {
  it("returns decoded params", () => {
    expect(matchRoute("/jobs/:id", "/jobs/a%20b")).toEqual({ id: "a b" });
  });
  it("needs the same number of parts and the same static parts", () => {
    expect(matchRoute("/jobs/:id", "/jobs")).toBeNull();
    expect(matchRoute("/jobs/:id/edit", "/jobs/x")).toBeNull();
    expect(matchRoute("/companies/compare", "/companies/other")).toBeNull();
    expect(matchRoute("/", "/")).toEqual({});
  });
});
