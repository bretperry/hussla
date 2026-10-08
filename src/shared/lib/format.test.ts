/*
  Tests the display helpers: pay, loose dates, placeholders, addresses.
  In the app: nothing at runtime; pins the rules the tables and the email editor rely on.
  Used by: pnpm test.
*/
import { describe, expect, it } from "vitest";
import { firstEmail, formatLooseDate, hasPlaceholder, payLabel, plainFromMarkdown, scoreTier, splitAddresses } from "./format";

describe("payLabel", () => {
  it("prefers checked posting text over the search numbers", () => {
    expect(payLabel({ payText: "$215k–$260k (base)", salaryMin: 1, salaryMax: 2 })).toBe("$215k–$260k");
  });
  it("falls back to numbers, then to nothing", () => {
    expect(payLabel({ payText: "", salaryMin: 170000, salaryMax: 210000 })).toBe("$170k–$210k");
    expect(payLabel({ payText: "", salaryMin: null, salaryMax: 90000 })).toBe("$90k");
    expect(payLabel({ payText: "", salaryMin: null, salaryMax: null })).toBe("");
  });
});

describe("formatLooseDate", () => {
  it("is as precise as its source", () => {
    expect(formatLooseDate("2026")).toBe("2026");
    expect(formatLooseDate("2026-08")).toBe("Aug 2026");
    expect(formatLooseDate("2026-08-28")).toBe("Aug 28, 2026");
    expect(formatLooseDate("last spring")).toBe("last spring");
  });
});

describe("drafts", () => {
  it("spots a [placeholder] but not a normal bracket", () => {
    expect(hasPlaceholder("Hi [Hiring manager name]")).toBe(true);
    expect(hasPlaceholder("see [1]")).toBe(false);
  });
  it("splits addresses on commas, semicolons and spaces", () => {
    expect(splitAddresses("a@b.co, c@d.co; e@f.co")).toEqual(["a@b.co", "c@d.co", "e@f.co"]);
    expect(firstEmail("Jane <jane@acme.example.com> (recruiter)")).toBe("jane@acme.example.com");
  });
  it("strips markdown markers from a pasted email", () => {
    expect(plainFromMarkdown("**Hi** [site](https://x.example)")).toBe("Hi site (https://x.example)");
  });
});

describe("scoreTier", () => {
  it("bands the fit score", () => {
    expect([scoreTier(90), scoreTier(80), scoreTier(60), scoreTier(null)]).toEqual(["high", "mid", "low", "none"]);
  });
});
