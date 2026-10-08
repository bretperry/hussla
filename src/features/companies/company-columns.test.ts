/*
  Tests the companies table sort and the compare view's "best in row" rule.
  In the app: nothing at runtime; guards sort order (empty values last, either direction) and the best marks.
  Used by: pnpm test.
*/
import { describe, expect, it } from "vitest";
import { companySummaries } from "@/test/fixtures";
import { COMPARE_ROWS, bestInRow, firstDirection, sortCompanies } from "./company-columns";

const names = (list: readonly { name: string }[]) => list.map((company) => company.name);

describe("sortCompanies", () => {
  it("sorts a numeric column high to low", () => {
    expect(names(sortCompanies(companySummaries, "bestScore", "desc"))).toEqual(["Northwind Labs", "Fabrikam Cloud", "Contoso Payments", "Tailspin Data"]);
  });

  it("flips direction on the same column", () => {
    expect(names(sortCompanies(companySummaries, "bestScore", "asc"))).toEqual(["Tailspin Data", "Contoso Payments", "Fabrikam Cloud", "Northwind Labs"]);
  });

  it("puts companies with no value last in either direction", () => {
    expect(names(sortCompanies(companySummaries, "valuation", "desc")).at(-1)).toBe("Tailspin Data");
    expect(names(sortCompanies(companySummaries, "valuation", "asc")).at(-1)).toBe("Tailspin Data");
  });

  it("sorts names A to Z, and does not change the input", () => {
    const before = names(companySummaries);
    expect(names(sortCompanies(companySummaries, "name", "asc"))).toEqual(["Contoso Payments", "Fabrikam Cloud", "Northwind Labs", "Tailspin Data"]);
    expect(names(companySummaries)).toEqual(before);
  });

  it("starts names ascending and numbers descending", () => {
    expect([firstDirection("name"), firstDirection("valuation")]).toEqual(["asc", "desc"]);
  });
});

const row = (label: string) => {
  const found = COMPARE_ROWS.find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(label);
  return found;
};

describe("bestInRow", () => {
  it("marks the highest value where higher is better", () => {
    expect([...bestInRow(row("Best fit"), companySummaries.slice(0, 3))]).toEqual(["northwind-labs"]);
  });

  it("marks the lowest where lower is better", () => {
    expect([...bestInRow(row("Layoffs on record"), companySummaries.slice(0, 3))].toSorted()).toEqual(["contoso-payments", "northwind-labs"]);
  });

  it("marks nothing when every company ties or only one has a value", () => {
    expect(bestInRow(row("Open jobs"), companySummaries).size).toBe(0);
    expect(bestInRow(row("Glassdoor"), [companySummaries[0] ?? fail(), companySummaries[3] ?? fail()]).size).toBe(0);
  });
});

const fail = (): never => {
  throw new Error("fixture missing");
};
