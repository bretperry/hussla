/*
  The companies table: sortable columns, and a checkbox on each row to compare two to four side by side.
  In the app: "/companies".
  Used by: src/app/App.tsx.
  Uses: company-columns.ts for the columns and the sort.
*/
import { useState } from "react";
import { COMPARE_MAX, COMPARE_MIN } from "@/config/ui";
import { api, describeError } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { Link, navigate } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Button } from "@/shared/ui/Button";
import { EmptyState, ErrorLine, LoadingLine } from "@/shared/ui/Feedback";
import { PageHead, Section } from "@/shared/ui/Section";
import { COLUMNS, firstDirection, sortCompanies } from "./company-columns";
import type { SortDirection, SortKey } from "./company-columns";

export const CompaniesPage = () => {
  const companies = useResource((signal) => api.listCompanies({ signal }), []);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "bestScore", direction: "desc" });
  const [picked, setPicked] = useState<string[]>([]);
  const rows = sortCompanies(companies.data ?? [], sort.key, sort.direction);

  const choose = (key: SortKey) =>
    setSort((previous) => (previous.key === key ? { key, direction: previous.direction === "asc" ? "desc" : "asc" } : { key, direction: firstDirection(key) }));
  const toggle = (slug: string) =>
    setPicked((previous) => (previous.includes(slug) ? previous.filter((item) => item !== slug) : previous.length >= COMPARE_MAX ? previous : [...previous, slug]));
  const canCompare = picked.length >= COMPARE_MIN;

  return (
    <>
      <PageHead
        kicker="Companies"
        title="Who is hiring"
        actions={
          <Button variant="primary" disabled={!canCompare} onClick={() => navigate(`/companies/compare?c=${picked.map(encodeURIComponent).join(",")}`)}>
            Compare{picked.length > 0 ? ` (${picked.length})` : ""}
          </Button>
        }
      />
      {companies.error !== null && companies.data === null ? <ErrorLine message={describeError(companies.error)} /> : null}
      {companies.data === null ? (
        companies.error === null ? <LoadingLine /> : null
      ) : companies.data.length === 0 ? (
        <EmptyState title="No companies yet">Companies appear as jobs are added and research agents profile them.</EmptyState>
      ) : (
        <Section kicker="The table" aside={`pick ${COMPARE_MIN}–${COMPARE_MAX} to compare`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl border-collapse text-ui">
              <thead>
                <tr className="text-left">
                  <th className="w-8 p-2"><span className="sr-only">Compare</span></th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className="p-2" aria-sort={sort.key === column.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" className="kicker cursor-pointer" onClick={() => choose(column.key)}>
                        {column.label}
                        {sort.key === column.key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((company) => (
                  <tr key={company.slug} className="border-t border-hairline">
                    <td className="p-2">
                      <input type="checkbox" className="size-5 accent-ink" aria-label={`Compare ${company.name}`} checked={picked.includes(company.slug)} disabled={!picked.includes(company.slug) && picked.length >= COMPARE_MAX} onChange={() => toggle(company.slug)} />
                    </td>
                    {COLUMNS.map((column) => (
                      <td key={column.key} className={cn("p-2", column.key === "name" && "font-display text-row font-bold")}>
                        {column.key === "name" ? <Link to={`/companies/${encodeURIComponent(company.slug)}`} className="no-underline">{company.name}</Link> : column.text(company)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </>
  );
};
