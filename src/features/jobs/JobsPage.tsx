/*
  The jobs table: five counts, a search box, status chips, and every job as a row.
  In the app: "/jobs"; the front page's "All N jobs" lands here.
  Used by: src/app/App.tsx.
  Uses: src/config/ui.ts for the chips, localStorage (via storage.ts) to remember the chip.
*/
import { useState } from "react";
import { DEFAULT_JOB_GROUP, FOLLOW_UP_DUE_STATUSES, JOB_GROUPS, STATUS_LABEL, STORAGE_KEYS } from "@/config/ui";
import { api, describeError } from "@/shared/api";
import type { JobListItem } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { payLabel, scoreTier } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { readStored, writeStored } from "@/shared/lib/storage";
import { useResource } from "@/shared/lib/use-resource";
import { LinkButton } from "@/shared/ui/Button";
import { EmptyState, ErrorLine, LoadingLine, Tag } from "@/shared/ui/Feedback";
import { TextInput } from "@/shared/ui/Form";
import { PageHead, Section, Stat } from "@/shared/ui/Section";

const countIn = (jobs: readonly JobListItem[], statuses: readonly string[]): number => jobs.filter((job) => statuses.includes(job.status)).length;

export const ScoreTag = ({ score }: { score: number | null }) => {
  const tier = scoreTier(score);
  return (
    <span className={cn("tag inline-block min-w-8 border px-1 py-px text-center", tier === "high" ? "border-2 border-ink font-medium" : tier === "mid" ? "border-ink" : "border-hairline text-muted")} title="Fit score">
      {score ?? "–"}
    </span>
  );
};

const FollowUpDots = ({ job }: { job: JobListItem }) => (
  <span className="flex gap-1" title="Email · LinkedIn · Call">
    {[job.followup.emailSentAt, job.followup.linkedinSentAt, job.followup.callMadeAt].map((done, index) => (
      <i key={index} className={cn("inline-block size-2 border border-ink", done !== null && "bg-ink")} />
    ))}
  </span>
);

const JobRow = ({ job }: { job: JobListItem }) => (
  <Link
    to={`/jobs/${encodeURIComponent(job.id)}`}
    className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 border-t border-hairline py-2 no-underline hover:text-ink lg:grid-cols-12 lg:gap-x-6"
  >
    <span className="lg:col-span-1"><ScoreTag score={job.score} /></span>
    <span className="lg:col-span-4">
      <span className="block font-display text-row font-bold">{job.company}</span>
      <span className="block text-small text-muted">{job.title}</span>
    </span>
    <span className="col-start-2 text-small lg:col-span-2 lg:col-start-auto">{payLabel(job) || <span className="text-muted">not listed</span>}</span>
    <span className="col-start-2 text-small text-muted lg:col-span-2 lg:col-start-auto">{job.location}</span>
    <span className="col-start-2 lg:col-span-1 lg:col-start-auto"><FollowUpDots job={job} /></span>
    <span className="col-start-2 lg:col-span-2 lg:col-start-auto"><Tag>{STATUS_LABEL[job.status] ?? job.status}</Tag></span>
  </Link>
);

export const JobsPage = () => {
  const jobs = useResource((signal) => api.listJobs({ signal }), []);
  const [group, setGroup] = useState(() => readStored(STORAGE_KEYS.jobGroup) ?? DEFAULT_JOB_GROUP);
  const [query, setQuery] = useState("");
  const chosen = JOB_GROUPS.find((candidate) => candidate.key === group) ?? JOB_GROUPS[0];
  const all = jobs.data ?? [];
  const needle = query.trim().toLowerCase();
  const rows = all.filter(
    (job) =>
      (chosen?.statuses === null || chosen?.statuses.includes(job.status) === true) &&
      (needle === "" || `${job.company} ${job.title} ${job.location} ${job.primaryContact?.name ?? ""}`.toLowerCase().includes(needle)),
  );
  const followUpsDue = all.filter((job) => (FOLLOW_UP_DUE_STATUSES as readonly string[]).includes(job.status) && job.followup.emailSentAt === null).length;

  return (
    <>
      <PageHead kicker="Jobs" title="Every job on the board" actions={<LinkButton to="/jobs/new" variant="primary">+ Add job</LinkButton>} />
      {jobs.error !== null && jobs.data === null ? <ErrorLine message={describeError(jobs.error)} /> : null}
      {jobs.data === null ? (
        jobs.error === null ? <LoadingLine /> : null
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat value={countIn(all, ["review", "queued"])} label="To review" />
            <Stat value={countIn(all, ["waiting"])} label="Waiting on you" />
            <Stat value={countIn(all, ["applied", "screening"])} label="Applied" />
            <Stat value={followUpsDue} label="Follow-ups to send" />
            <Stat value={countIn(all, ["interviewing", "offer"])} label="Interviewing" />
          </div>
          <Section kicker="The list" aside={`${rows.length} shown`}>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
              <TextInput type="search" className="lg:max-w-xs" placeholder="Search company, title, contact…" aria-label="Search jobs" value={query} onChange={(event) => setQuery(event.target.value)} />
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
                {JOB_GROUPS.map((candidate) => (
                  <button
                    key={candidate.key}
                    type="button"
                    aria-pressed={candidate.key === group}
                    onClick={() => {
                      setGroup(candidate.key);
                      writeStored(STORAGE_KEYS.jobGroup, candidate.key);
                    }}
                    className={cn("kicker h-touch cursor-pointer border border-ink px-2 lg:h-8", candidate.key === group ? "bg-ink text-paper" : "bg-transparent")}
                  >
                    {candidate.label} {candidate.statuses === null ? all.length : countIn(all, candidate.statuses)}
                  </button>
                ))}
              </div>
            </div>
            {rows.length === 0 ? (
              <EmptyState title="No jobs here">{all.length === 0 ? "Add one, or give an agent a key under Settings." : "Try another filter or search."}</EmptyState>
            ) : (
              <div>
                <div className="kicker hidden grid-cols-12 gap-x-6 pb-2 text-muted lg:grid">
                  <span className="col-span-1">Fit</span>
                  <span className="col-span-4">Job</span>
                  <span className="col-span-2">Pay</span>
                  <span className="col-span-2">Location</span>
                  <span className="col-span-1">Follow-up</span>
                  <span className="col-span-2">Status</span>
                </div>
                {rows.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
};
