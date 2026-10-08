/*
  What the front page shows, worked out from the lists the API returns: the lead story, the board, news, signatures and overnight counts.
  In the app: the jobs front page (mockup 8c) calls these on the data it fetched; nothing here touches the network.
  Used by: src/features/jobs/FrontPage.tsx, src/features/jobs/use-front-page.ts.

  Pure on purpose: each rule (which job leads, what counts as overnight) has a unit test.
*/
import { BOARD_ROWS, LEAD_STATUS_ORDER, NEWS_ITEMS, OVERNIGHT_HOURS, STATUS_LABEL } from "@/config/ui";
import type { CompanyDetail, CompanySummary, Email, JobListItem, NewsItem } from "@/shared/api";

const statusRank = (status: string): number => {
  const index = (LEAD_STATUS_ORDER as readonly string[]).indexOf(status);
  return index === -1 ? LEAD_STATUS_ORDER.length : index;
};

const byLeadOrder = (a: JobListItem, b: JobListItem): number =>
  statusRank(a.status) - statusRank(b.status) || (b.score ?? -1) - (a.score ?? -1) || b.updatedAt.localeCompare(a.updatedAt);

// Jobs still in play, best lead first: an offer, then interviews, then the rest by fit.
const openJobs = (jobs: readonly JobListItem[]): JobListItem[] =>
  jobs.filter((job) => statusRank(job.status) < LEAD_STATUS_ORDER.length).toSorted(byLeadOrder);

// The top story, or null when nothing is open.
export const pickLead = (jobs: readonly JobListItem[]): JobListItem | null => openJobs(jobs)[0] ?? null;

export const boardJobs = (jobs: readonly JobListItem[]): JobListItem[] => openJobs(jobs).slice(0, BOARD_ROWS);

// The headline for the lead story, by where the job stands; review is the fallback.
const HEADLINES: Readonly<Record<string, (company: string) => string>> = {
  offer: (company) => `${company} makes you an offer`,
  interviewing: (company) => `${company} has you interviewing`,
  screening: (company) => `${company} is screening your application`,
  applied: (company) => `You applied to ${company}`,
  waiting: (company) => `${company} is waiting on you`,
  queued: (company) => `${company} is queued to apply`,
};

export const leadHeadline = (job: JobListItem): string => (HEADLINES[job.status] ?? ((company) => `${company} is ready for your review`))(job.company);

export const leadKicker = (job: JobListItem): string => `Lead story · ${job.nextAction === "" ? (STATUS_LABEL[job.status] ?? job.status) : job.nextAction}`;

export type Signatures = { count: number; companies: string[] };

// Drafts waiting for the owner, and which companies they are for (each once).
export const awaitingSignature = (drafts: readonly Email[], jobs: readonly JobListItem[], companies: readonly CompanySummary[]): Signatures => {
  const waiting = drafts.filter((email) => email.status === "draft");
  const names = new Set<string>();
  for (const email of waiting) {
    const job = jobs.find((candidate) => candidate.id === email.jobId);
    const slug = email.companySlug ?? job?.companySlug ?? null;
    const name = job?.company ?? companies.find((company) => company.slug === slug)?.name ?? slug;
    if (name !== null) names.add(name);
  }
  return { count: waiting.length, companies: [...names] };
};

export type Overnight = { applied: number; reviews: number; profiles: number };

const withinHours = (iso: string | null, now: Date, hours: number): boolean => {
  if (iso === null) return false;
  const age = now.getTime() - new Date(iso).getTime();
  return age >= 0 && age <= hours * 3_600_000;
};

// What agents did in the last night: applications sent, reviews saved, company profiles updated.
export const overnightCounts = (
  jobs: readonly JobListItem[],
  companies: readonly CompanySummary[],
  details: readonly CompanyDetail[],
  now: Date,
): Overnight => ({
  applied: jobs.filter((job) => withinHours(job.appliedAt, now, OVERNIGHT_HOURS)).length,
  reviews: details.reduce((total, company) => total + company.reviews.filter((review) => withinHours(review.fetchedAt, now, OVERNIGHT_HOURS)).length, 0),
  profiles: companies.filter((company) => withinHours(company.updatedAt, now, OVERNIGHT_HOURS)).length,
});

export type NewsStory = NewsItem & { company: string; slug: string };

// Pads "2026-08" to "2026-08-00" so loose dates sort as text.
const sortableDate = (date: string | undefined): string => {
  const [year = "0000", month = "00", day = "00"] = (date ?? "").split("-");
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
};

// The newest headlines across the companies read, newest first.
export const latestNews = (details: readonly CompanyDetail[]): NewsStory[] =>
  details
    .flatMap((company) => company.news.map((item) => ({ ...item, company: company.name, slug: company.slug })))
    .toSorted((a, b) => sortableDate(b.date).localeCompare(sortableDate(a.date)))
    .slice(0, NEWS_ITEMS);

export type Fact = { label: string; value: string };

// The lead company's money picture plus the job's next event; rows with nothing to say are left out.
export const glanceFacts = (job: JobListItem, company: CompanyDetail | undefined): Fact[] => {
  const money = company?.financials;
  const valuation = money?.valuation ?? "";
  const rows: Fact[] = [
    { label: valuation === "" && (money?.marketCap ?? "") !== "" ? "Market cap" : "Valuation", value: valuation === "" ? (money?.marketCap ?? "") : valuation },
    { label: "Revenue", value: money?.revenue ?? "" },
    { label: "Cash flow", value: money?.profitability ?? "" },
    { label: "Next event", value: job.nextAction },
  ];
  return rows.filter((row) => row.value !== "");
};
