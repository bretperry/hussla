/*
  Fetches everything the front page needs in two waves: the lists, then company details for news, reviews and the lead's money.
  In the app: the jobs front page calls it once per visit; there is no client cache.
  Used by: src/features/jobs/FrontPage.tsx.

  The details wave is one request per company, capped by FRONT_PAGE_COMPANY_DETAILS and newest
  first. A company whose detail fails is skipped, so one bad record never blanks the page.
  A single "overview" endpoint would replace the second wave; docs/deferred.md tracks it.
*/
import { FRONT_PAGE_COMPANY_DETAILS } from "@/config/ui";
import { api } from "@/shared/api";
import type { CompanyDetail, CompanySummary, Email, JobListItem } from "@/shared/api";
import { useResource } from "@/shared/lib/use-resource";
import type { Resource } from "@/shared/lib/use-resource";
import { pickLead } from "./front-page";

export type FrontPageData = {
  jobs: JobListItem[];
  companies: CompanySummary[];
  drafts: Email[];
  details: CompanyDetail[];
};

const loadFrontPage = async (signal: AbortSignal): Promise<FrontPageData> => {
  const [jobs, companies, drafts] = await Promise.all([
    api.listJobs({ signal }),
    api.listCompanies({ signal }),
    api.listEmails("?status=draft", { signal }),
  ]);
  const lead = pickLead(jobs);
  const newest = companies.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((company) => company.slug);
  const slugs = [...new Set([...(lead === null ? [] : [lead.companySlug]), ...newest])].slice(0, FRONT_PAGE_COMPANY_DETAILS);
  const fetched = await Promise.all(slugs.map((slug) => api.getCompany(slug, { signal }).catch(() => null)));
  return { jobs, companies, drafts, details: fetched.filter((detail): detail is CompanyDetail => detail !== null) };
};

export const useFrontPage = (): Resource<FrontPageData> => useResource(loadFrontPage, []);
