/*
  What the companies table and the compare view show per company, and how the table sorts.
  In the app: sorting a column header on "/companies"; the rows and "best value" marks on "/companies/compare".
  Used by: src/features/companies/CompaniesPage.tsx, src/features/companies/ComparePage.tsx.

  Pure on purpose, so sort order (empty values always last) and "best in row" have unit tests.
*/
import type { CompanySummary } from "@/shared/api";
import { payLabel } from "@/shared/lib/format";

export type SortKey = "name" | "jobs" | "bestScore" | "pay" | "rating" | "health" | "funding" | "valuation" | "founded";
export type SortDirection = "asc" | "desc";

type SortValue = number | string | null;

type ColumnDef = { key: SortKey; label: string; value: (company: CompanySummary) => SortValue; text: (company: CompanySummary) => string; startsDescending: boolean };

const orDash = (value: string): string => (value === "" ? "–" : value);

export const COLUMNS: readonly ColumnDef[] = [
  { key: "name", label: "Company", value: (c) => c.name.toLowerCase(), text: (c) => c.name, startsDescending: false },
  { key: "jobs", label: "Jobs", value: (c) => c.jobs.length, text: (c) => String(c.jobs.length), startsDescending: true },
  { key: "bestScore", label: "Best fit", value: (c) => c.bestScore, text: (c) => String(c.bestScore ?? "–"), startsDescending: true },
  { key: "pay", label: "Pay", value: (c) => c.payMax, text: (c) => payLabel({ payText: "", salaryMin: c.payMin, salaryMax: c.payMax }) || "–", startsDescending: true },
  { key: "rating", label: "Rating", value: (c) => c.avgRating, text: (c) => String(c.avgRating ?? "–"), startsDescending: true },
  { key: "health", label: "Health", value: (c) => (c.healthRank === 0 ? null : c.healthRank), text: (c) => orDash(c.healthSignal), startsDescending: true },
  { key: "funding", label: "Funding", value: (c) => c.totalFundingUsd, text: (c) => orDash(c.totalFunding), startsDescending: true },
  { key: "valuation", label: "Valuation", value: (c) => c.valuationUsd, text: (c) => orDash(c.valuation), startsDescending: true },
  { key: "founded", label: "Founded", value: (c) => c.founded, text: (c) => String(c.founded ?? "–"), startsDescending: false },
];

export const firstDirection = (key: SortKey): SortDirection => (COLUMNS.find((column) => column.key === key)?.startsDescending === true ? "desc" : "asc");

// A sorted copy; companies with no value for the column go last in either direction.
export const sortCompanies = (companies: readonly CompanySummary[], key: SortKey, direction: SortDirection): CompanySummary[] => {
  const column = COLUMNS.find((candidate) => candidate.key === key);
  if (column === undefined) return [...companies];
  const sign = direction === "asc" ? 1 : -1;
  return companies.toSorted((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return a.name.localeCompare(b.name);
    return (left < right ? -1 : 1) * sign;
  });
};

export type CompareRow = { label: string; text: (company: CompanySummary) => string; score?: (company: CompanySummary) => number | null; best?: "high" | "low" };

export const COMPARE_ROWS: readonly CompareRow[] = [
  { label: "Open jobs", text: (c) => String(c.jobs.length) },
  { label: "Best fit", text: (c) => String(c.bestScore ?? "–"), score: (c) => c.bestScore, best: "high" },
  { label: "Pay", text: (c) => payLabel({ payText: "", salaryMin: c.payMin, salaryMax: c.payMax }) || "–", score: (c) => c.payMax, best: "high" },
  { label: "Employee rating", text: (c) => String(c.avgRating ?? "–"), score: (c) => c.avgRating, best: "high" },
  { label: "Glassdoor", text: (c) => (c.glassdoor === null ? "–" : `${c.glassdoor}${c.glassdoorCount === null ? "" : ` (${c.glassdoorCount})`}`), score: (c) => c.glassdoor, best: "high" },
  { label: "Health", text: (c) => orDash(c.healthSignal), score: (c) => (c.healthRank === 0 ? null : c.healthRank), best: "high" },
  { label: "Health note", text: (c) => orDash(c.healthNote) },
  { label: "Total funding", text: (c) => orDash(c.totalFunding), score: (c) => c.totalFundingUsd, best: "high" },
  { label: "Valuation", text: (c) => orDash(c.valuation), score: (c) => c.valuationUsd, best: "high" },
  { label: "Revenue", text: (c) => orDash(c.revenue) },
  { label: "Layoffs on record", text: (c) => String(c.layoffs), score: (c) => c.layoffs, best: "low" },
  { label: "Employees", text: (c) => orDash(c.employees) },
  { label: "Stage", text: (c) => orDash(c.stage) },
  { label: "Founded", text: (c) => String(c.founded ?? "–") },
  { label: "HQ", text: (c) => orDash(c.hq) },
  { label: "Remote policy", text: (c) => orDash(c.remotePolicy) },
];

// The slugs that hold the best value in a row; empty when fewer than two companies have a value or all tie.
export const bestInRow = (row: CompareRow, companies: readonly CompanySummary[]): Set<string> => {
  const score = row.score;
  if (score === undefined || row.best === undefined) return new Set();
  const scored = companies.flatMap((company) => {
    const value = score(company);
    return value === null ? [] : [{ slug: company.slug, value }];
  });
  if (scored.length < 2) return new Set();
  const target = row.best === "high" ? Math.max(...scored.map((entry) => entry.value)) : Math.min(...scored.map((entry) => entry.value));
  const winners = scored.filter((entry) => entry.value === target);
  return winners.length === scored.length ? new Set() : new Set(winners.map((entry) => entry.slug));
};
