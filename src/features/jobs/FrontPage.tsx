/*
  The jobs front page, built to mockup 8c: masthead with two ears, the lead story, the pitch slot, and the rail.
  In the app: "/" . Desktop is a 12-column grid (lead 8 + rail 4, the two rows' rules aligned); a phone stacks ear, lead, pitch, news, board.
  Used by: src/app/App.tsx.
  Uses: src/features/jobs/front-page.ts for what to show, use-front-page.ts for the data, GET /api/pitches for the billboard, src/shared/ui for the type and rules.

  States: day one (no jobs, no pitches), no lead story (the fact box hides), nothing to sign (the ear says so, no button).
  Spec: docs/plans/hussla-v1.md → Phase 5.
*/
import { STATUS_LABEL, STATUS_TAG } from "@/config/ui";
import type { CompanyDetail, CompanySummary, JobListItem, PitchList } from "@/shared/api";
import { api, describeError } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { formatLooseDate, payLabel } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { LinkButton } from "@/shared/ui/Button";
import { ErrorLine, LoadingLine, Tag } from "@/shared/ui/Feedback";
import { Nameplate, NameplateRule } from "@/shared/ui/Nameplate";
import { SectionHead, Stat } from "@/shared/ui/Section";
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

const SignatureEar = ({ count, companies }: { count: number; companies: string[] }) => (
  <section aria-label="Awaiting your signature" className="mt-6 flex flex-col gap-2 lg:col-span-3 lg:col-start-1 lg:row-start-1 lg:mt-0 lg:h-ear">
    <SectionHead kicker="Awaiting your signature" urgent={count > 0} />
    <h2 className="font-display text-title font-bold">{count > 0 ? `${count} follow-up${count === 1 ? "" : "s"} ready` : "Nothing to sign"}</h2>
    {count > 0 ? (
      <div className="flex items-center gap-4">
        <LinkButton to="/outbox" variant="primary">
          Review &amp; sign
        </LinkButton>
        <span className="text-small text-muted">
          {companies.slice(0, 3).map((name) => (
            <span key={name} className="block">
              {name}
            </span>
          ))}
        </span>
      </div>
    ) : (
      <p className="text-small text-muted">No follow-ups are waiting on you.</p>
    )}
  </section>
);

const OvernightEar = ({ applied, reviews, profiles }: { applied: number; reviews: number; profiles: number }) => (
  <section aria-label="Overnight" className="mt-6 flex flex-col gap-2 lg:col-span-3 lg:col-start-10 lg:row-start-1 lg:mt-0 lg:h-ear">
    <SectionHead
      kicker="Overnight · agents"
      aside={
        <Link to="/activity" className="underline underline-offset-4 lg:hidden">
          Wire →
        </Link>
      }
    />
    <div className="grid grid-cols-3 gap-4">
      <Stat value={applied} label="Applied" />
      <Stat value={reviews} label="Reviews" />
      <Stat value={profiles} label="Profiles" />
    </div>
    <Link to="/activity" className="kicker mt-auto hidden underline underline-offset-4 lg:block">
      Read the agent wire →
    </Link>
  </section>
);

const LeadStory = ({ lead, summary, detail }: { lead: JobListItem | null; summary: CompanySummary | undefined; detail: CompanyDetail | undefined }) => {
  const facts = lead === null ? [] : glanceFacts(lead, detail);
  const quickTake = detail?.quickTake ?? summary?.quickTake ?? "";
  const fallback = lead === null ? "" : [lead.title, lead.location, payLabel(lead)].filter((part) => part !== "").join(" · ");
  const body = lead === null ? "" : quickTake !== "" ? leadBody(quickTake) : lead.headsUp !== "" ? lead.headsUp : fallback;
  return (
    <article data-col="lead" className="grid grid-cols-8 gap-x-6 gap-y-2 pb-6 lg:col-span-8 lg:col-start-1 lg:row-start-1">
      <SectionHead className="col-span-8" kicker={lead === null ? "Lead story" : leadKicker(lead)} urgent={lead !== null} />
      <h1 className="col-span-8 font-display text-lead-phone font-black lg:text-lead">
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
                <div key={fact.label} className="flex items-baseline justify-between gap-4 border-t border-hairline py-2">
                  <span className="kicker">{fact.label}</span>
                  <span className="text-right text-ui font-semibold">{fact.value}</span>
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
    <section data-col="rail" aria-label="Latest news" className={cn("flex flex-col gap-2 pb-6 lg:col-span-4 lg:col-start-9 lg:row-start-1", columnRule)}>
      <SectionHead kicker="Latest news" />
      {stories.length === 0 ? (
        <p className="text-small text-muted">No news yet. Research agents add headlines as they read about the companies you track.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {stories.map((story, index) => (
            <div key={`${story.slug}-${story.url ?? story.headline}`} className={cn(index > 0 && "border-t border-hairline pt-2")}>
              <h3 className="font-display text-news-phone font-bold lg:text-news">
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
              <div className="mt-2 text-small text-muted">
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
              <span className="block font-display text-row font-bold">{job.company}</span>
              <span className="block text-small text-muted">{job.nextAction === "" ? job.title : job.nextAction}</span>
            </span>
            <span className="tag text-right">{signing.has(job.id) ? <Tag strong>To sign</Tag> : (STATUS_TAG[job.status] ?? STATUS_LABEL[job.status] ?? job.status)}</span>
          </Link>
        ))}
        <Link to="/jobs" className="kicker mt-auto flex h-touch items-end border-t border-hairline underline underline-offset-4">
          {jobs.length === 0 ? "Add a job →" : `All ${jobs.length} jobs →`}
        </Link>
      </div>
    </section>
  );
};

type FrontPageViewProps = { appName: string; data: FrontPageData; now?: Date; pitches?: readonly BillboardPitch[]; rotateSeconds?: number };

// Until GET /api/pitches answers (or if it fails) the billboard is empty; this only paces an empty board.
const NO_ROTATION = 0;

// The page for data already in hand; FrontPage fetches it, tests hand it fixtures.
export const FrontPageView = ({ appName, data, now = new Date(), pitches = [], rotateSeconds = NO_ROTATION }: FrontPageViewProps) => {
  const { jobs, companies, drafts, details } = data;
  const lead = pickLead(jobs);
  const signatures = awaitingSignature(drafts, jobs, companies);
  const overnight = overnightCounts(jobs, companies, details, now);
  const signing = new Set(drafts.filter((email) => email.status === "draft" && email.jobId !== null).map((email) => email.jobId ?? ""));
  const leadDetail = lead === null ? undefined : details.find((company) => company.slug === lead.companySlug);
  const leadSummary = lead === null ? undefined : companies.find((company) => company.slug === lead.companySlug);
  return (
    <>
      <header data-m="masthead" className="mt-4 flex flex-col lg:mt-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6">
        <Nameplate name={appName} size="front" className="-mb-4 lg:col-span-6 lg:col-start-4 lg:row-start-1 lg:-mt-nameplate-trim-top lg:-mb-nameplate-trim-bottom" />
        <NameplateRule className="lg:col-span-12 lg:row-start-2 lg:mt-4" />
        <SignatureEar count={signatures.count} companies={signatures.companies} />
        <OvernightEar applied={overnight.applied} reviews={overnight.reviews} profiles={overnight.profiles} />
      </header>
      <div data-m="body" className="mt-6 grid grid-cols-1 lg:grid-cols-12 lg:gap-x-6">
        <LeadStory lead={lead} summary={leadSummary} detail={leadDetail} />
        {/* Keyed by the count so the billboard picks its starting pitch again once the list arrives. */}
        <PitchSlot key={pitches.length} pitches={pitches} rotateSeconds={rotateSeconds} now={now} />
        <NewsRail details={details} />
        <Board jobs={jobs} signing={signing} />
      </div>
    </>
  );
};

export const FrontPage = ({ appName }: { appName: string }) => {
  const { data, error } = useFrontPage();
  // Pitches load on their own: a failure leaves the billboard empty instead of blanking the page.
  const pitches = useResource((signal): Promise<PitchList> => api.listPitches({ signal }), []);
  if (data === null) {
    return error === null ? <LoadingLine label="Setting the type" /> : <ErrorLine message={describeError(error)} />;
  }
  return (
    <FrontPageView
      appName={appName}
      data={data}
      pitches={pitches.data === null ? [] : billboardPitches(pitches.data.pitches)}
      rotateSeconds={pitches.data?.settings.rotateSeconds ?? NO_ROTATION}
    />
  );
};
