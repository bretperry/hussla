/*
  The jobs front page, built to mockup 8c with the row 9 type pass: the briefing, the lead story, the pitch slot, and the rail.
  In the app: "/" . Desktop is a 12-column grid with 48px gutters (lead 8 + rail 4, the two rows' rules aligned); a phone stacks briefing, lead, pitch, news, board.
  Used by: src/app/App.tsx.
  Uses: src/features/jobs/front-page.ts for what to show, use-front-page.ts for the data, GET /api/pitches for the billboard, src/shared/ui for the type and rules.

  States: day one (no jobs, no pitches), no lead story (the fact box hides), nothing to sign (the briefing says so, no button).
  The desktop briefing renders into the shell's section bar (BarAside), so it sits beside the nav instead of taking its own band.
  Spec: docs/plans/hussla-v1.md → Phase 5.
*/
import { BarAside } from "@/app/bar-slot";
import { STATUS_LABEL, STATUS_TAG } from "@/config/ui";
import type { CompanyDetail, CompanySummary, JobListItem, PitchList } from "@/shared/api";
import { api, describeError } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { formatLooseDate, payLabel } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { LinkButton } from "@/shared/ui/Button";
import { ErrorLine, LoadingLine, Tag } from "@/shared/ui/Feedback";
import { SectionHead } from "@/shared/ui/Section";
import { awaitingSignature, billboardPitches, boardJobs, glanceFacts, latestNews, leadHeadline, leadKicker, overnightCounts, pickLead } from "./front-page";
import type { FrontPageData } from "./use-front-page";
import { useFrontPage } from "./use-front-page";
import { PitchSlot } from "./PitchSlot";
import type { BillboardPitch } from "./PitchSlot";

// Half a gutter back, with a hairline there: the column rule that sits in the middle of the gutter.
const columnRule = "lg:-ml-half-gutter lg:border-l lg:border-hairline lg:pl-[calc(var(--spacing-half-gutter)-1px)]";

const SENTENCES_IN_LEAD = 3;
const LEAD_BODY_MAX_CHARS = 320;

// The first few sentences of a company's quick take, cut short enough for one reading column.
const leadBody = (text: string): string => {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  const joined = sentences.slice(0, SENTENCES_IN_LEAD).join("").trim();
  return joined.length > LEAD_BODY_MAX_CHARS ? `${joined.slice(0, LEAD_BODY_MAX_CHARS).trimEnd()}…` : joined;
};

type BriefingProps = { count: number; companies: string[]; applied: number; reviews: number; profiles: number };

// What came in overnight, as one line; it links to the agent wire.
const OvernightLine = ({ applied, reviews, profiles, className }: Omit<BriefingProps, "count" | "companies"> & { className?: string }) => (
  <Link to="/activity" aria-label={`Overnight: ${applied} applied, ${reviews} reviews, ${profiles} profiles. Read the agent wire`} className={cn("text-ui text-body no-underline", className)}>
    {/* One inline run, so the spaces survive when a caller makes the link a flex row. */}
    <span>
      Overnight: <b className="text-ink">{applied}</b> applied · <b className="text-ink">{reviews}</b> reviews · <b className="text-ink">{profiles}</b> profiles{" "}
      <span className="underline underline-offset-4">Wire →</span>
    </span>
  </Link>
);

const ReadyCount = ({ count }: { count: number }) =>
  count > 0 ? (
    <>
      <b className="text-accent">{count}</b> follow-up{count === 1 ? "" : "s"} ready
    </>
  ) : (
    "Nothing to sign"
  );

// Desktop: the briefing sits in the section bar, right of the nav; the small button (32px at lg) stays inside the bar's rules.
const BarBriefing = ({ count, applied, reviews, profiles }: BriefingProps) => (
  <BarAside>
    <OvernightLine applied={applied} reviews={reviews} profiles={profiles} />
    <span role="presentation" className="h-6 w-px bg-hairline" />
    <section aria-label="Awaiting your signature" className="flex items-center gap-4">
      <span className="text-ui">
        <ReadyCount count={count} />
      </span>
      {count > 0 ? (
        <LinkButton to="/outbox" variant="primary" size="sm">
          Review &amp; sign
        </LinkButton>
      ) : null}
    </section>
  </BarAside>
);

// Phone: the same briefing as the page's first section, with the full-size button.
const PhoneBriefing = ({ count, companies, applied, reviews, profiles }: BriefingProps) => (
  <section aria-label="Briefing" className="flex flex-col gap-2 pb-8 lg:hidden">
    <div className="flex items-center justify-between gap-3">
      <span className="text-row">
        <span className="block">
          <ReadyCount count={count} />
        </span>
        <span className="block text-small text-muted">{count > 0 ? companies.slice(0, 3).join(" · ") : "No follow-ups are waiting on you."}</span>
      </span>
      {count > 0 ? (
        <LinkButton to="/outbox" variant="primary">
          Review &amp; sign
        </LinkButton>
      ) : null}
    </div>
    <OvernightLine applied={applied} reviews={reviews} profiles={profiles} className="flex min-h-touch items-center border-t border-hairline" />
  </section>
);

const LeadStory = ({ lead, summary, detail }: { lead: JobListItem | null; summary: CompanySummary | undefined; detail: CompanyDetail | undefined }) => {
  const facts = lead === null ? [] : glanceFacts(lead, detail);
  const quickTake = detail?.quickTake ?? summary?.quickTake ?? "";
  const fallback = lead === null ? "" : [lead.title, lead.location, payLabel(lead)].filter((part) => part !== "").join(" · ");
  const body = lead === null ? "" : quickTake !== "" ? leadBody(quickTake) : lead.headsUp !== "" ? lead.headsUp : fallback;
  return (
    <article data-col="lead" className="grid grid-cols-8 content-start gap-x-12 gap-y-2 pb-8 lg:col-span-8 lg:col-start-1 lg:row-start-1 lg:pb-10">
      {/* 12px more than the usual kicker-to-headline gap: the small caps sat on top of the headline. */}
      <SectionHead className="col-span-8 pb-3" kicker={lead === null ? "Lead story" : leadKicker(lead)} urgent={lead !== null} />
      <h1 className="col-span-8 font-display text-lead-phone font-bold lg:text-lead">
        {lead === null ? "Your first story starts with one job" : leadHeadline(lead)}
      </h1>
      <div className="col-span-8 mt-2 flex flex-col gap-4 lg:col-span-5">
        <p className="font-display text-prose text-body">
          {lead === null
            ? "Hussla fills this page as agents find jobs and research companies. Add the first job yourself, or give an agent a key."
            : body}
        </p>
        <div className="flex flex-wrap gap-2">
          {lead === null ? (
            <>
              <LinkButton to="/jobs/new">Add a job</LinkButton>
              <LinkButton to="/settings">Set up an agent</LinkButton>
            </>
          ) : (
            <>
              <LinkButton to={`/jobs/${encodeURIComponent(lead.id)}`}>Open {lead.company}</LinkButton>
              <LinkButton to={`/companies/${encodeURIComponent(lead.companySlug)}`}>Prep notes</LinkButton>
            </>
          )}
        </div>
      </div>
      {lead !== null && facts.length > 0 ? (
        <div className={cn("hidden lg:col-span-3 lg:mt-2 lg:block", columnRule)}>
          <div className="flex flex-col gap-2" aria-label={`${lead.company} at a glance`} role="group">
            <SectionHead kicker={`${lead.company} at a glance`} />
            <div>
              {facts.map((fact) => (
                <div key={fact.label} className="flex items-baseline justify-between gap-4 border-t border-hairline py-1.5 text-small">
                  <span className="text-muted">{fact.label}</span>
                  <span className="text-right font-semibold">{fact.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
};

const NewsRail = ({ details }: { details: readonly CompanyDetail[] }) => {
  const stories = latestNews(details);
  return (
    <section data-col="rail" aria-label="Latest news" className={cn("flex flex-col gap-3 pb-8 lg:col-span-4 lg:col-start-9 lg:row-start-1", columnRule)}>
      <SectionHead kicker="Latest news" />
      {stories.length === 0 ? (
        <p className="text-small text-muted">No news yet. Research agents add headlines as they read about the companies you track.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {stories.map((story, index) => (
            <div key={`${story.slug}-${story.url ?? story.headline}`} className={cn(index > 0 && "border-t border-hairline pt-3")}>
              <h3 className="font-display text-news-phone font-semibold lg:text-news">
                {story.url !== undefined && /^https?:/i.test(story.url) ? (
                  <a href={story.url} target="_blank" rel="noopener noreferrer" className="no-underline">
                    {story.headline}
                  </a>
                ) : (
                  <Link to={`/companies/${encodeURIComponent(story.slug)}`} className="no-underline">
                    {story.headline}
                  </Link>
                )}
              </h3>
              <div className="mt-1 text-small text-muted">
                {[story.summary === undefined || story.summary === "" ? story.company : story.summary, story.date === undefined ? "" : formatLooseDate(story.date)]
                  .filter((part) => part !== "")
                  .join(" · ")}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const Board = ({ jobs, signing }: { jobs: readonly JobListItem[]; signing: ReadonlySet<string> }) => {
  const rows = boardJobs(jobs);
  return (
    <section data-col="rail" aria-label="On the board" className={cn("flex flex-col gap-2 lg:col-span-4 lg:col-start-9 lg:row-start-2", columnRule)}>
      <SectionHead kicker="On the board" aside={`${jobs.length} tracked`} />
      <div className="flex flex-1 flex-col">
        {rows.length === 0 ? <p className="border-t border-hairline py-2 text-small text-muted">Nothing is open right now.</p> : null}
        {rows.map((job) => (
          <Link key={job.id} to={`/jobs/${encodeURIComponent(job.id)}`} className="grid grid-cols-[1fr_var(--spacing-tag-column)] items-baseline gap-4 border-t border-hairline py-2 no-underline hover:text-ink">
            <span>
              <span className="block font-display text-row font-semibold">{job.company}</span>
              <span className="block text-small text-muted">{job.nextAction === "" ? job.title : job.nextAction}</span>
            </span>
            <span className="tag text-right">{signing.has(job.id) ? <Tag strong>To sign</Tag> : (STATUS_TAG[job.status] ?? STATUS_LABEL[job.status] ?? job.status)}</span>
          </Link>
        ))}
        <Link to="/jobs" className="mt-auto flex h-touch items-center border-t border-hairline text-ui font-semibold underline underline-offset-4">
          {jobs.length === 0 ? "Add a job →" : `All ${jobs.length} jobs →`}
        </Link>
      </div>
    </section>
  );
};

type FrontPageViewProps = { data: FrontPageData; now?: Date; pitches?: readonly BillboardPitch[]; rotateSeconds?: number };

// Until GET /api/pitches answers (or if it fails) the billboard is empty; this only paces an empty board.
const NO_ROTATION = 0;

// The page for data already in hand; FrontPage fetches it, tests hand it fixtures.
export const FrontPageView = ({ data, now = new Date(), pitches = [], rotateSeconds = NO_ROTATION }: FrontPageViewProps) => {
  const { jobs, companies, drafts, details } = data;
  const lead = pickLead(jobs);
  const signatures = awaitingSignature(drafts, jobs, companies);
  const overnight = overnightCounts(jobs, companies, details, now);
  const signing = new Set(drafts.filter((email) => email.status === "draft" && email.jobId !== null).map((email) => email.jobId ?? ""));
  const leadDetail = lead === null ? undefined : details.find((company) => company.slug === lead.companySlug);
  const leadSummary = lead === null ? undefined : companies.find((company) => company.slug === lead.companySlug);
  return (
    <>
      <BarBriefing count={signatures.count} companies={signatures.companies} {...overnight} />
      <PhoneBriefing count={signatures.count} companies={signatures.companies} {...overnight} />
      <div data-m="body" className="grid grid-cols-1 lg:grid-cols-12 lg:gap-x-12">
        <LeadStory lead={lead} summary={leadSummary} detail={leadDetail} />
        {/* Keyed by the count so the billboard picks its starting pitch again once the list arrives. */}
        <PitchSlot key={pitches.length} pitches={pitches} rotateSeconds={rotateSeconds} now={now} />
        <NewsRail details={details} />
        <Board jobs={jobs} signing={signing} />
      </div>
    </>
  );
};

export const FrontPage = () => {
  const { data, error } = useFrontPage();
  // Pitches load on their own: a failure leaves the billboard empty instead of blanking the page.
  const pitches = useResource((signal): Promise<PitchList> => api.listPitches({ signal }), []);
  if (data === null) {
    return error === null ? <LoadingLine label="Setting the type" /> : <ErrorLine message={describeError(error)} />;
  }
  return (
    <FrontPageView
      data={data}
      pitches={pitches.data === null ? [] : billboardPitches(pitches.data.pitches)}
      rotateSeconds={pitches.data?.settings.rotateSeconds ?? NO_ROTATION}
    />
  );
};
