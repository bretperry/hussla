/*
  Add a job and edit a job: the two forms, and delete (with a passkey tap).
  In the app: "/jobs/new" and "/jobs/:id/edit".
  Used by: src/app/App.tsx.
  Uses: api.createJob, api.patchJob, api.deleteJob (owner-only, passkey).

  Edits send only what the form shows; a cleared number goes as null, which the server reads as "clear it".
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "@/shared/api";
import type { JobDetail } from "@/shared/api";
import { formText } from "@/shared/lib/form";
import { navigate } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Button, LinkButton } from "@/shared/ui/Button";
import { Callout, ErrorLine, LoadingLine, useToast } from "@/shared/ui/Feedback";
import { Field, FieldRow, SelectInput, TextArea, TextInput } from "@/shared/ui/Form";
import { PageHead } from "@/shared/ui/Section";

const text = formText;

const numberOrNull = (data: FormData, key: string): number | null => {
  const value = text(data, key);
  return value === "" ? null : Number(value);
};

export const AddJobPage = () => {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const job = await api.createJob({
        company: text(data, "company"),
        title: text(data, "title"),
        url: text(data, "url"),
        location: text(data, "location"),
        payText: text(data, "payText"),
        description: text(data, "description"),
      });
      navigate(`/jobs/${encodeURIComponent(job.id)}`);
    } catch (failure) {
      setError(describeError(failure));
    }
  };
  return (
    <>
      <PageHead kicker="Jobs" title="Add a job" />
      <form onSubmit={(event) => void submit(event)} className="flex max-w-3xl flex-col gap-4">
        <FieldRow>
          <Field label="Company"><TextInput name="company" required /></Field>
          <Field label="Title"><TextInput name="title" required /></Field>
        </FieldRow>
        <Field label="Posting URL"><TextInput name="url" type="url" /></Field>
        <FieldRow>
          <Field label="Location"><TextInput name="location" /></Field>
          <Field label="Pay"><TextInput name="payText" placeholder="$180k–$220k" /></Field>
        </FieldRow>
        <Field label="Description" hint="Paste the job description. Markdown is fine."><TextArea name="description" className="min-h-48" /></Field>
        {error === "" ? null : <ErrorLine message={error} />}
        <div className="flex gap-2">
          <Button type="submit" variant="primary">Add job</Button>
          <LinkButton to="/jobs">Cancel</LinkButton>
        </div>
      </form>
    </>
  );
};

const EditForm = ({ job }: { job: JobDetail }) => {
  const resumes = useResource(() => api.listResumes().catch(() => []), []);
  const [error, setError] = useState("");
  const toast = useToast();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api.patchJob(job.id, {
        company: text(data, "company"),
        title: text(data, "title"),
        url: text(data, "url"),
        location: text(data, "location"),
        payText: text(data, "payText"),
        salaryMin: numberOrNull(data, "salaryMin"),
        salaryMax: numberOrNull(data, "salaryMax"),
        score: numberOrNull(data, "score"),
        resume: text(data, "resume"),
        nextAction: text(data, "nextAction"),
        nextActionDue: text(data, "nextActionDue"),
        headsUp: text(data, "headsUp"),
        description: text(data, "description"),
      });
      toast.show("Saved");
      navigate(`/jobs/${encodeURIComponent(job.id)}`);
    } catch (failure) {
      setError(describeError(failure));
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${job.company}: ${job.title}? This can't be undone.`)) return;
    try {
      await api.deleteJob(job.id);
      navigate("/jobs");
    } catch (failure) {
      setError(describeError(failure));
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-3xl flex-col gap-4">
      <FieldRow>
        <Field label="Company"><TextInput name="company" defaultValue={job.company} /></Field>
        <Field label="Title"><TextInput name="title" defaultValue={job.title} /></Field>
      </FieldRow>
      <Field label="Posting URL"><TextInput name="url" type="url" defaultValue={job.url} /></Field>
      <FieldRow>
        <Field label="Location"><TextInput name="location" defaultValue={job.location} /></Field>
        <Field label="Pay (text)"><TextInput name="payText" defaultValue={job.payText} /></Field>
      </FieldRow>
      <FieldRow>
        <Field label="Pay min"><TextInput name="salaryMin" type="number" defaultValue={job.salaryMin ?? ""} /></Field>
        <Field label="Pay max"><TextInput name="salaryMax" type="number" defaultValue={job.salaryMax ?? ""} /></Field>
      </FieldRow>
      <FieldRow>
        <Field label="Fit score"><TextInput name="score" type="number" min={0} max={100} defaultValue={job.score ?? ""} /></Field>
        <Field label="Résumé to use">
          <SelectInput name="resume" defaultValue={job.resume}>
            <option value="">None</option>
            {(resumes.data ?? []).map((resume) => (
              <option key={resume.variant} value={resume.variant}>{resume.variant}</option>
            ))}
          </SelectInput>
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Next action"><TextInput name="nextAction" defaultValue={job.nextAction} /></Field>
        <Field label="Due"><TextInput name="nextActionDue" type="date" defaultValue={job.nextActionDue.slice(0, 10)} /></Field>
      </FieldRow>
      <Field label="Heads-up"><TextInput name="headsUp" defaultValue={job.headsUp} /></Field>
      <Field label="Job description (markdown)"><TextArea name="description" className="min-h-64" defaultValue={job.description} /></Field>
      {error === "" ? null : <ErrorLine message={error} />}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary">Save</Button>
        <LinkButton to={`/jobs/${encodeURIComponent(job.id)}`}>Cancel</LinkButton>
        <span className="flex-1" />
        <Button variant="danger" onClick={() => void remove()}>Delete job</Button>
      </div>
      <Callout title="Delete">Deleting asks for your passkey and can't be undone.</Callout>
    </form>
  );
};

export const EditJobPage = ({ jobId }: { jobId: string }) => {
  const job = useResource((signal) => api.getJob(jobId, { signal }), [jobId]);
  if (job.data === null) return job.error === null ? <LoadingLine /> : <ErrorLine message={describeError(job.error)} />;
  return (
    <>
      <PageHead kicker="Edit" title={`${job.data.company}: ${job.data.title}`} />
      <EditForm job={job.data} />
    </>
  );
};
