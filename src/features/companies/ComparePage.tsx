/*
  Compare two to four companies side by side, with the best value in each row marked.
  In the app: "/companies/compare?c=slug,slug".
  Used by: src/app/App.tsx.
  Uses: company-columns.ts for the rows and the "best" rule.
*/
import { COMPARE_MAX, COMPARE_MIN } from "@/config/ui";
import { api, describeError } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { Link, useLocation } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { LinkButton } from "@/shared/ui/Button";
import { EmptyState, ErrorLine, LoadingLine } from "@/shared/ui/Feedback";
import { PageHead, Section } from "@/shared/ui/Section";
import { COMPARE_ROWS, bestInRow } from "./company-columns";

export const ComparePage = () => {
  const { search } = useLocation();
  const slugs = (search.get("c") ?? "").split(",").filter(Boolean).slice(0, COMPARE_MAX);
  const companies = useResource((signal) => api.listCompanies({ signal }), []);
  const chosen = (companies.data ?? []).filter((company) => slugs.includes(company.slug));
  const back = <LinkButton to="/companies">← All companies</LinkButton>;

  if (companies.data === null) return companies.error === null ? <LoadingLine /> : <ErrorLine message={describeError(companies.error)} />;
  if (chosen.length < COMPARE_MIN) {
    return (
      <>
        <PageHead kicker="Compare" title="Pick companies to compare" actions={back} />
        <EmptyState title={`Choose at least ${COMPARE_MIN}`}>Tick two to four companies in the table, then press Compare.</EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHead kicker="Compare" title={chosen.map((company) => company.name).join(" vs ")} actions={back} />
      <Section kicker="Side by side" aside="best in row is underlined">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-small sm:text-ui">
            <thead>
              <tr>
                <th className="p-1 sm:p-2" />
                {chosen.map((company) => (
                  <th key={company.slug} scope="col" className="p-1 text-left font-display text-row font-bold sm:p-2">
                    <Link to={`/companies/${encodeURIComponent(company.slug)}`} className="no-underline">{company.name}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => {
                const best = bestInRow(row, chosen);
                return (
                  <tr key={row.label} className="border-t border-hairline">
                    <th scope="row" className="kicker p-1 text-left font-medium sm:p-2">{row.label}</th>
                    {chosen.map((company) => (
                      <td key={company.slug} className={cn("p-1 sm:p-2", best.has(company.slug) && "font-bold underline underline-offset-4")}>{row.text(company)}</td>
                    ))}
                  </tr>
                );
              })}
              <tr className="border-t border-hairline align-top">
                <th scope="row" className="kicker p-1 text-left font-medium sm:p-2">Quick take</th>
                {chosen.map((company) => <td key={company.slug} className="p-1 text-small sm:p-2">{company.quickTake === "" ? "–" : company.quickTake}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
};
