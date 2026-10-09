/*
  One company: quick take, stat tiles, money, facts, anecdotes, news, reviews, contacts with call and email links, jobs, and its emails.
  In the app: "/companies/:slug".
  Used by: src/app/App.tsx.
  Uses: api.getCompany / patchCompany / draftCompanyEmail, EmailEditor and EmailCard, Markdown for agent text.
*/
import { useState } from "react";
import { STATUS_LABEL } from "@/config/ui";
import { useStats } from "@/app/stats";
import { api, describeError } from "@/shared/api";
import type { CompanyDetail } from "@/shared/api";
import { dialable, formatLooseDate, formatWhen, payLabel } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { ContactCard, ReviewCard } from "@/shared/ui/Cards";
import { EmptyState, ErrorLine, LoadingLine, Tag, useToast } from "@/shared/ui/Feedback";
import { Field, SelectInput, TextArea } from "@/shared/ui/Form";
import { Markdown, MarkdownInline, isSafeLink } from "@/shared/ui/Markdown";
import { PageHead, Section, Stat } from "@/shared/ui/Section";
import { EmailCard } from "@/features/outbox/EmailCard";
import { EmailEditor } from "@/features/outbox/EmailEditor";
import { ScoreTag } from "@/features/jobs/JobsPage";

type Row = [string, string];

const Rows = ({ rows }: { rows: Row[] }) => {
  const shown = rows.filter(([, value]) => value !== "");
  return shown.length === 0 ? <p className="text-muted">Nothing recorded yet.</p> : (
    <dl>{shown.map(([label, value]) => (
      <div key={label} className="flex items-baseline justify-between gap-4 border-t border-hairline py-2">
        <dt className="kicker">{label}</dt>
        <dd className="text-right font-semibold">{value}</dd>
      </div>))}
    </dl>
  );
};

const Composer = ({ company, reload }: { company: CompanyDetail; reload: () => void }) => {
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState("");
  const { refresh } = useStats();
  const contacts = company.jobContacts;
  const first = contacts.find((contact) => (contact.email ?? "") !== "");
  if (!open) return <Button size="sm" className="self-start" onClick={() => setOpen(true)}>Write an email…</Button>;
  return (
    <div className="flex flex-col gap-4">
      {company.jobs.length === 0 ? null : (
        <Field label="About which job (optional)">
          <SelectInput value={jobId} onChange={(event) => setJobId(event.target.value)}>
            <option value="">Not tied to a job</option>
            {company.jobs.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
          </SelectInput>
        </Field>
      )}
      <EmailEditor
        initial={{ to: first?.email ?? "", cc: "", subject: "", body: "" }}
        contacts={contacts}
        submitLabel="Save draft"
        save={(fields) => api.draftCompanyEmail(company.slug, { to: fields.to, ...(fields.cc.trim() === "" ? {} : { cc: fields.cc }), subject: fields.subject, body: fields.body, kind: "note", ...(jobId === "" ? {} : { jobId }) })}
        onSaved={() => { setOpen(false); reload(); refresh(); }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
};

const NotesEditor = ({ company, reload }: { company: CompanyDetail; reload: () => void }) => {
  const [value, setValue] = useState(company.notes);
  const toast = useToast();
  const save = async () => {
    try {
      await api.patchCompany(company.slug, { notes: value });
      toast.show("Saved");
      reload();
    } catch (failure) {
      toast.show(describeError(failure));
    }
  };
  return (
    <>
      <TextArea aria-label="My notes" className="min-h-32" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Your own notes on this company" />
      <Button size="sm" className="self-start" disabled={value === company.notes} onClick={() => void save()}>Save notes</Button>
    </>
  );
};

const CompanyView = ({ company, reload }: { company: CompanyDetail; reload: () => void }) => {
  const { refresh } = useStats();
  const { profile, financials, summary } = company;
  const phone = profile.phone ?? "";
  const website = profile.website ?? "";
  const lastRound = financials.lastRound;
  return (
    <>
      <PageHead
        kicker="Company"
        title={company.name}
        actions={
          <>
            {phone === "" ? null : <LinkButton external to={`tel:${dialable(phone)}`} variant="primary">Call {profile.phoneLabel === undefined || profile.phoneLabel === "" ? phone : profile.phoneLabel}</LinkButton>}
            {website !== "" && isSafeLink(website) ? <LinkButton external to={website} target="_blank" rel="noopener noreferrer">Website ↗</LinkButton> : null}
          </>
        }
      />
      <Section kicker="Quick take">
        {company.quickTake === "" ? <p className="text-muted">No quick take yet. A research agent writes it.</p> : <p className="max-w-3xl font-display text-prose text-body">{company.quickTake}</p>}
      </Section>

      <div className="grid grid-cols-2 gap-4 border-t border-hairline pt-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat value={summary.jobs.length} label="Jobs" />
        <Stat value={summary.bestScore ?? "–"} label="Best fit" />
        <Stat value={summary.avgRating ?? "–"} label="Rating" />
        <Stat value={financials.healthSignal === undefined || financials.healthSignal === "" ? "–" : financials.healthSignal} label="Health" />
        <Stat value={profile.employees === undefined || profile.employees === "" ? "–" : profile.employees.replace(/\s*\(.*$/, "")} label="Employees" />
        <Stat value={profile.founded ?? "–"} label="Founded" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section kicker="Money" aside={financials.healthNote === undefined ? undefined : financials.healthNote}>
          <Rows rows={[
            ["Total funding", financials.totalFunding ?? ""],
            ["Last round", lastRound === null || lastRound === undefined ? "" : [lastRound.type, lastRound.amount, lastRound.date].filter((part) => part !== undefined && part !== "").join(" · ")],
            ["Valuation", financials.valuation ?? ""],
            ["Market cap", financials.marketCap ?? ""],
            ["Revenue", financials.revenue ?? ""],
            ["Growth", financials.growth ?? ""],
            ["Cash flow", financials.profitability ?? ""],
            ["Stock", financials.stockNote ?? ""],
            ["Investors", (financials.investors ?? []).join(", ")],
          ]} />
          {(financials.layoffs ?? []).length === 0 ? null : <p className="text-small text-accent">Layoffs on record: {(financials.layoffs ?? []).map((layoff) => [layoff.date, layoff.detail].filter(Boolean).join(" ")).join("; ")}</p>}
        </Section>
        <Section kicker="Profile">
          <Rows rows={[["HQ", profile.hq ?? ""], ["Type", profile.type ?? ""], ["Stage", profile.stage ?? ""], ["Ticker", profile.ticker ?? ""], ["CEO", profile.ceo ?? ""], ["Remote policy", profile.remotePolicy ?? ""], ["Employees", profile.employees ?? ""]]} />
        </Section>
      </div>

      <Section kicker="Jobs here" aside={`${company.jobs.length}`}>
        {company.jobs.length === 0 ? <p className="text-muted">No jobs tracked here.</p> : company.jobs.map((job) => (
          <Link key={job.id} to={`/jobs/${encodeURIComponent(job.id)}`} className="flex items-baseline gap-4 border-t border-hairline py-2 no-underline hover:text-ink">
            <ScoreTag score={job.score} />
            <span className="flex-1"><span className="block font-display text-row font-bold">{job.title}</span><span className="text-small text-muted">{payLabel(job)}</span></span>
            <Tag>{STATUS_LABEL[job.status] ?? job.status}</Tag>
          </Link>))}
      </Section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section kicker="Facts">{company.facts.length === 0 ? <p className="text-muted">None yet.</p> : <ul className="ml-4 list-disc">{company.facts.map((fact) => <li key={fact}><MarkdownInline source={fact} /></li>)}</ul>}</Section>
        <Section kicker="Anecdotes">
          {company.anecdotes.length === 0 ? <p className="text-muted">None yet.</p> : company.anecdotes.map((anecdote) => (
            <blockquote key={anecdote.text} className="border-l-2 border-ink pl-4 italic">
              <MarkdownInline source={anecdote.text} />
              {anecdote.source === undefined || anecdote.source === "" ? null : <span className="not-italic text-small text-muted"> · {anecdote.url !== undefined && isSafeLink(anecdote.url) ? <a className="underline" href={anecdote.url} target="_blank" rel="noopener noreferrer">{anecdote.source}</a> : anecdote.source}</span>}
            </blockquote>))}
        </Section>
      </div>

      <Section kicker="News" aside={`${company.news.length}`}>
        {company.news.length === 0 ? <p className="text-muted">No news yet.</p> : company.news.map((item) => (
          <div key={item.url ?? item.headline} className="border-t border-hairline py-2">
            <h3 className="font-display text-news font-bold">{item.url !== undefined && isSafeLink(item.url) ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="no-underline">{item.headline}</a> : item.headline}</h3>
            <p className="text-small text-muted">{[item.summary ?? "", item.source ?? "", item.date === undefined ? "" : formatLooseDate(item.date)].filter(Boolean).join(" · ")}</p>
          </div>))}
      </Section>

      <Section kicker="Reviews">
        {company.reviews.length === 0 ? <p className="text-muted">No reviews saved yet.</p> : <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{company.reviews.map((review) => <ReviewCard key={review.source} review={review} />)}</div>}
      </Section>

      <Section kicker="Contacts">
        {company.jobContacts.length === 0 ? <p className="text-muted">No contacts yet. They come from each job's page.</p> : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{company.jobContacts.map((contact) => <ContactCard key={`${contact.jobId}-${contact.name}`} contact={contact} extra={`for ${contact.jobTitle}`} />)}</div>
        )}
      </Section>

      <Section kicker="Emails" aside={`${company.emails.length}`}>
        <Composer company={company} reload={reload} />
        {company.emails.map((email) => <EmailCard key={`${email.id}-${email.version}-${email.status}`} email={email} contacts={company.jobContacts} showJob onChanged={() => { reload(); refresh(); }} />)}
      </Section>

      {company.interview === "" ? null : <Section kicker="Interview process"><Markdown source={company.interview} /></Section>}
      <Section kicker="My notes"><NotesEditor key={company.updatedAt} company={company} reload={reload} /></Section>
      {company.sources.length === 0 ? null : <Section kicker="Sources" aside={`updated ${formatWhen(company.updatedAt)}`}><ul className="ml-4 list-disc">{company.sources.map((source) => <li key={source}><MarkdownInline source={source} /></li>)}</ul></Section>}
    </>
  );
};

export const CompanyPage = ({ slug }: { slug: string }) => {
  const company = useResource((signal) => api.getCompany(slug, { signal }), [slug]);
  if (company.data === null) {
    return company.error === null ? <LoadingLine /> : (
      <>
        <ErrorLine message={describeError(company.error)} />
        <EmptyState title="That company isn't here"><LinkButton to="/companies" size="sm">All companies</LinkButton></EmptyState>
      </>
    );
  }
  return <CompanyView company={company.data} reload={company.reload} />;
};
