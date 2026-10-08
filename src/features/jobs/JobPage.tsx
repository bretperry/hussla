/*
  One job: header, status actions, and every section (overview, description, contacts, reviews, follow-up, notes, files, activity, sources).
  In the app: "/jobs/:id".
  Used by: src/app/App.tsx.
  Uses: api (jobs, contacts, files, events), EmailEditor and EmailCard for the follow-up, Markdown for agent text.

  A write patches only what the owner changed, then reloads the job; "My notes" saves itself after a pause.
*/
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { NOTES_AUTOSAVE_MS, STATUS_LABEL } from "@/config/ui";
import { useStats } from "@/app/stats";
import { api, describeError, isJobStatus } from "@/shared/api";
import type { JobDetail } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { formText } from "@/shared/lib/form";
import { firstEmail, formatWhen, payLabel, plainFromMarkdown } from "@/shared/lib/format";
import { useResource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { ContactCard, ReviewCard } from "@/shared/ui/Cards";
import { Callout, EmptyState, ErrorLine, LoadingLine, Tag, useToast } from "@/shared/ui/Feedback";
import { Field, FieldRow, SelectInput, TextArea, TextInput } from "@/shared/ui/Form";
import { Markdown, MarkdownInline, isSafeLink } from "@/shared/ui/Markdown";
import { Section } from "@/shared/ui/Section";
import { EmailCard } from "@/features/outbox/EmailCard";
import { EmailEditor } from "@/features/outbox/EmailEditor";
import { ScoreTag } from "./JobsPage";

type FollowupKey = "emailSentAt" | "linkedinSentAt" | "callMadeAt";
const FOLLOW_UPS: ReadonlyArray<{ key: FollowupKey; label: string }> = [
  { key: "emailSentAt", label: "Email sent" },
  { key: "linkedinSentAt", label: "LinkedIn sent" },
  { key: "callMadeAt", label: "Call made" },
];

const NotesBox = ({ job }: { job: JobDetail }) => {
  const [value, setValue] = useState(job.notes);
  const [state, setState] = useState("");
  const saved = useRef(job.notes);
  useEffect(() => {
    if (value === saved.current) return undefined;
    setState("Editing…");
    const timer = setTimeout(() => {
      api.patchJob(job.id, { notes: value }).then(
        () => {
          saved.current = value;
          setState("Saved");
        },
        (failure: unknown) => setState(describeError(failure)),
      );
    }, NOTES_AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [value, job.id]);
  return (
    <Section id="s-notes" kicker="My notes" aside={state}>
      <TextArea aria-label="My notes" className="min-h-32" placeholder="Anything you want to remember about this one" value={value} onChange={(event) => setValue(event.target.value)} />
    </Section>
  );
};

const copyText = async (text: string, toast: { show: (message: string) => void }) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.show("Copied");
  } catch {
    toast.show("Couldn't copy. Select the text and copy it by hand.");
  }
};

const MarkdownSection = ({ id, kicker, source, empty }: { id: string; kicker: string; source: string; empty: string }) => (
  <Section id={id} kicker={kicker}>
    {source === "" ? <p className="text-muted">{empty}</p> : <Markdown source={source} />}
  </Section>
);

const JobView = ({ job, reload }: { job: JobDetail; reload: () => void }) => {
  const toast = useToast();
  const { refresh } = useStats();
  const [composing, setComposing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [problem, setProblem] = useState("");
  const resumes = useResource(() => api.listResumes().catch(() => []), []);
  const followup = job.followup;
  const reviews = job.companyInfo?.reviews ?? [];
  const resumeUrl = (name: string) => (resumes.data ?? []).find((resume) => resume.variant === name.replace(/\.pdf$/i, "") || resume.name === name)?.url;
  const pay = payLabel(job);

  const act = async (work: () => Promise<unknown>, message?: string) => {
    setProblem("");
    try {
      await work();
      if (message !== undefined) toast.show(message);
      reload();
      refresh();
    } catch (failure) {
      setProblem(describeError(failure));
    }
  };

  const submitContact = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const field = (key: string) => formText(data, key);
    void act(async () => {
      await api.saveJobContact(job.id, { name: field("name"), role: field("role"), email: field("email"), phone: field("phone"), source: field("source") });
      setAddingContact(false);
    });
  };
  const submitEvent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const action = formText(new FormData(form), "action");
    if (action === "") return;
    void act(async () => {
      await api.logJobEvent(job.id, { action });
      form.reset();
    });
  };

  const sections: Array<[string, string, number | null]> = [
    ["overview", "Overview", null],
    ["description", "Job description", null],
    ["contacts", "Contacts", job.contacts.length],
    ["reviews", "Reviews", reviews.filter((review) => review.rating !== null).length],
    ["followup", "Follow-up", null],
    ["company", "Company notes", null],
    ["role", "Role notes", null],
    ["docs", "Résumé & files", job.files.length],
    ["notes", "My notes", null],
    ["activity", "Activity", job.events.length],
    ["sources", "Sources", null],
  ];
  const draftEmail = firstEmail(followup.to);
  const datedBody = plainFromMarkdown(followup.body).replace(/\[date\]/g, job.appliedAt === null ? "[date]" : formatWhen(job.appliedAt));

  return (
    <>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <ScoreTag score={job.score} />
        <div className="flex-1">
          <p className="kicker">{job.company}</p>
          <h1 className="font-display text-lead-phone font-black lg:text-page">{job.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <Tag strong>{STATUS_LABEL[job.status] ?? job.status}</Tag>
            {pay === "" ? null : <span><b>Pay</b> {pay}</span>}
            {job.location === "" ? null : <span><b>Where</b> {job.location}</span>}
            {job.source === "" ? null : <span><b>Found on</b> {job.source}</span>}
            {job.appliedAt === null ? null : <span><b>Applied</b> {formatWhen(job.appliedAt)}</span>}
            {job.postingStatus === "closed" ? <Tag urgent>Posting closed</Tag> : null}
          </p>
        </div>
        {job.url !== "" && isSafeLink(job.url) ? <LinkButton to={job.url} external target="_blank" rel="noopener noreferrer">Open posting ↗</LinkButton> : null}
      </div>
      {job.headsUp === "" ? null : <Callout tone="warn" title="Heads-up"><MarkdownInline source={job.headsUp} /></Callout>}
      {job.scamFlags.length === 0 ? null : <Callout tone="warn" title="Scam filter">{job.scamFlags.join("; ")}</Callout>}
      {problem === "" ? null : <ErrorLine message={problem} />}

      <div className="flex flex-wrap items-center gap-2">
        <SelectInput aria-label="Status" className="w-auto" value={job.status} onChange={(event) => { const status = event.target.value; if (isJobStatus(status)) void act(() => api.patchJob(job.id, { status }), "Status updated"); }}>
          {Object.entries(STATUS_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </SelectInput>
        {["review", "queued", "waiting"].includes(job.status) ? (
          <Button size="sm" variant="primary" onClick={() => void act(() => api.patchJob(job.id, { status: "applied", appliedAt: new Date().toISOString(), resumeSent: job.resumeSent !== "" ? job.resumeSent : job.resume === "" ? null : `${job.resume}.pdf`, nextAction: "Send the follow-up email and LinkedIn note" }), "Marked applied")}>
            Mark applied
          </Button>
        ) : null}
        {FOLLOW_UPS.map(({ key, label }) => (
          <Button key={key} size="sm" aria-pressed={followup[key] !== null} onClick={() => void act(() => api.patchJob(job.id, { followup: { [key]: followup[key] === null ? new Date().toISOString() : null }, note: `${followup[key] === null ? "Marked" : "Unmarked"}: ${label}` }))}>
            {followup[key] === null ? "" : "✓ "}{label}{followup[key] === null ? "" : ` ${formatWhen(followup[key])}`}
          </Button>
        ))}
        <span className="flex-1" />
        <LinkButton size="sm" to={`/jobs/${encodeURIComponent(job.id)}/edit`}>Edit details</LinkButton>
      </div>

      <nav aria-label="On this page" className="kicker flex flex-wrap gap-x-4 gap-y-1">
        {sections.map(([key, label, count]) => (
          <a key={key} href={`#s-${key}`} className="no-underline">{label}{count === null || count === 0 ? "" : ` ${count}`}</a>
        ))}
      </nav>

      <Section id="s-overview" kicker="Overview">
        {job.nextAction === "" ? null : <p><b>Next:</b> <MarkdownInline source={job.nextAction} />{job.nextActionDue === "" ? "" : <span className="text-muted"> by {formatWhen(job.nextActionDue)}</span>}</p>}
        {job.statusNote === "" ? null : <p className="text-muted"><MarkdownInline source={job.statusNote} /></p>}
        {job.whyScore === "" ? null : <><p className="kicker">Why it scores {job.score ?? ""}</p><Markdown source={job.whyScore} /></>}
        {job.reasons.length === 0 ? null : <><p className="kicker">Search notes</p><ul className="ml-4 list-disc">{job.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
        {job.compensation === "" ? null : <><p className="kicker">Compensation as posted</p><Markdown source={job.compensation} /></>}
      </Section>

      <Section id="s-description" kicker="Job description" aside={job.descriptionFetchedAt === null ? undefined : `fetched ${formatWhen(job.descriptionFetchedAt)}`}>
        {job.description === "" ? (
          <p className="text-muted">No description saved yet. An agent can add it, or paste it under Edit details.</p>
        ) : (
          <>
            <div className={cn("relative", !expanded && "max-h-64 overflow-hidden")}><Markdown source={job.description} /></div>
            {expanded ? null : <Button size="sm" className="self-start" onClick={() => setExpanded(true)}>Show full description</Button>}
          </>
        )}
      </Section>

      <Section id="s-contacts" kicker="Contacts" aside={<button type="button" className="cursor-pointer uppercase underline underline-offset-4" onClick={() => setAddingContact(!addingContact)}>+ Add</button>}>
        {job.contacts.length === 0 ? <p className="text-muted">No contacts yet.</p> : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{job.contacts.map((contact) => <ContactCard key={contact.name} contact={contact} />)}</div>
        )}
        {job.bestChannel === "" ? null : <p><b>Best channel:</b> <MarkdownInline source={job.bestChannel} /></p>}
        {addingContact ? (
          <form onSubmit={submitContact} className="flex max-w-3xl flex-col gap-4">
            <FieldRow><Field label="Name"><TextInput name="name" required /></Field><Field label="Role"><TextInput name="role" /></Field></FieldRow>
            <FieldRow><Field label="Email"><TextInput name="email" /></Field><Field label="Phone"><TextInput name="phone" /></Field></FieldRow>
            <Field label="Where you found them"><TextInput name="source" /></Field>
            <Button type="submit" variant="primary" className="self-start">Save contact</Button>
          </form>
        ) : null}
      </Section>

      <Section id="s-reviews" kicker={`Reviews of ${job.company}`}>
        {reviews.length === 0 ? <p className="text-muted">No reviews saved yet. Agents add them per company.</p> : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{reviews.map((review) => <ReviewCard key={review.source} review={review} />)}</div>
        )}
      </Section>

      <Section id="s-followup" kicker="Follow-up">
        {followup.subject === "" && followup.body === "" ? <p className="text-muted">No follow-up email drafted yet.</p> : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"><dt className="kicker">To</dt><dd><MarkdownInline source={followup.to} /></dd><dt className="kicker">Subject</dt><dd>{followup.subject}</dd></dl>
            <Markdown source={followup.body} className="border-l-2 border-ink pl-4" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void copyText(plainFromMarkdown(followup.body), toast)}>Copy email</Button>
              <Button size="sm" onClick={() => void copyText(followup.subject, toast)}>Copy subject</Button>
              {draftEmail === "" ? null : <LinkButton size="sm" external to={`mailto:${draftEmail}?subject=${encodeURIComponent(followup.subject)}&body=${encodeURIComponent(plainFromMarkdown(followup.body))}`}>Open in Mail</LinkButton>}
            </div>
          </>
        )}
        {composing ? (
          <EmailEditor
            initial={{ to: draftEmail, cc: "", subject: followup.subject, body: datedBody }}
            contacts={job.contacts}
            submitLabel="Save draft"
            save={(fields) => api.draftJobEmail(job.id, { to: fields.to, ...(fields.cc.trim() === "" ? {} : { cc: fields.cc }), subject: fields.subject, body: fields.body, kind: "follow-up" })}
            onSaved={() => { setComposing(false); reload(); refresh(); }}
            onClose={() => setComposing(false)}
          />
        ) : (
          <Button size="sm" className="self-start" onClick={() => setComposing(true)}>{followup.subject === "" && followup.body === "" ? "Write an email…" : "Write this as an email…"}</Button>
        )}
        {job.emails.length === 0 ? null : (
          <div><p className="kicker">Emails</p>{job.emails.map((email) => <EmailCard key={`${email.id}-${email.version}-${email.status}`} email={email} contacts={job.contacts} onChanged={() => { reload(); refresh(); }} />)}</div>
        )}
        {followup.linkedin === "" ? null : (
          <>
            <p className="kicker">LinkedIn note</p>
            <p className="border border-hairline p-2">{followup.linkedin}</p>
            <div className="flex items-center gap-2"><Button size="sm" onClick={() => void copyText(followup.linkedin, toast)}>Copy note</Button><span className="text-small text-muted">{followup.linkedin.length} characters</span></div>
          </>
        )}
        {followup.callNotes === "" ? null : <><p className="kicker">Call notes</p><Markdown source={followup.callNotes} /></>}
      </Section>

      <MarkdownSection id="s-company" kicker="Company notes" source={job.companyNotes} empty="None yet." />
      <MarkdownSection id="s-role" kicker="Role notes" source={job.roleNotes} empty="None yet." />

      <Section id="s-docs" kicker="Résumé & files">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="kicker">Résumé sent</dt>
          <dd>{job.resumeSent === "" ? <span className="text-muted">Not sent yet</span> : resumeUrl(job.resumeSent) === undefined ? job.resumeSent : <a className="underline" href={resumeUrl(job.resumeSent)} target="_blank" rel="noopener noreferrer">{job.resumeSent}</a>}</dd>
          <dt className="kicker">Planned</dt>
          <dd>{job.resume === "" ? <span className="text-muted">None picked</span> : job.resume}</dd>
        </dl>
        {job.files.length === 0 ? null : (
          <ul className="flex flex-col">{job.files.map((file) => (
            <li key={file.id} className="flex flex-wrap items-baseline gap-2 border-t border-hairline py-2">
              <a className="underline" href={`/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer">{file.name}</a>
              <span className="flex-1 text-small text-muted">{file.kind} · {Math.ceil(file.size / 1024)} KB · {file.actor} · {formatWhen(file.createdAt)}</span>
              <Button size="sm" variant="danger" onClick={() => { if (window.confirm("Remove this file?")) void act(() => api.deleteFile(file.id)); }}>Remove</Button>
            </li>))}
          </ul>
        )}
        <label className="self-start">
          <span className="box-border inline-flex h-touch cursor-pointer items-center border border-ink px-4 font-semibold lg:h-8 lg:text-small">Upload file</span>
          <input type="file" className="sr-only" aria-label="Upload file" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void act(() => api.uploadJobFile(job.id, file)); }} />
        </label>
      </Section>

      <NotesBox job={job} />

      <Section id="s-activity" kicker="Activity">
        <form onSubmit={submitEvent} className="flex gap-2">
          <TextInput name="action" aria-label="Log something" placeholder="Log something (recruiter replied, call Tuesday)" required />
          <Button type="submit">Log</Button>
        </form>
        {job.events.length === 0 ? <p className="text-muted">Nothing yet.</p> : (
          <ul>{job.events.map((entry) => (
            <li key={entry.id} className="grid grid-cols-[auto_1fr] gap-x-4 border-t border-hairline py-2">
              <span className="kicker text-muted">{formatWhen(entry.at, { withTime: true })}</span>
              <span><b>{entry.action}</b>{entry.detail === "" ? null : <> · <MarkdownInline source={entry.detail} /></>} <span className="text-muted">· {entry.actor}</span></span>
            </li>))}
          </ul>
        )}
      </Section>

      <Section id="s-sources" kicker="Sources">
        {job.sources.length === 0 ? <p className="text-muted">None saved.</p> : <ul className="ml-4 list-disc">{job.sources.map((source) => <li key={source}><MarkdownInline source={source} /></li>)}</ul>}
      </Section>
    </>
  );
};

export const JobPage = ({ jobId }: { jobId: string }): ReactNode => {
  const job = useResource((signal) => api.getJob(jobId, { signal }), [jobId]);
  if (job.data === null) {
    return job.error === null ? <LoadingLine /> : (
      <>
        <ErrorLine message={describeError(job.error)} />
        <EmptyState title="That job isn't here">It may have been deleted. <LinkButton to="/jobs" size="sm">All jobs</LinkButton></EmptyState>
      </>
    );
  }
  return <JobView job={job.data} reload={job.reload} />;
};
