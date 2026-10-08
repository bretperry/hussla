/*
  The email form: To, Cc, Subject and Message, with warnings, for a new draft or an edit of an existing one.
  In the app: the job's Follow-up section, the company page's composer, and the Outbox's Edit button.
  Used by: src/features/outbox/EmailCard.tsx, src/features/jobs/JobPage.tsx, src/features/companies/CompanyPage.tsx.

  It only saves (a draft). Approving is a separate, confirmed step on the saved version (ApprovePanel),
  so what the owner approves is exactly what they read.
*/
import { useState } from "react";
import type { FormEvent } from "react";
import { describeError } from "@/shared/api";
import type { Contact, Email } from "@/shared/api";
import { Button } from "@/shared/ui/Button";
import { Callout, useToast } from "@/shared/ui/Feedback";
import { Field, FieldRow, TextArea, TextInput } from "@/shared/ui/Form";
import { emailWarnings } from "./email-warnings";

export type EmailFields = { to: string; cc: string; subject: string; body: string };

type EmailEditorProps = {
  initial: EmailFields;
  contacts: readonly Contact[];
  submitLabel: string;
  save: (fields: EmailFields) => Promise<Email>;
  onSaved: (email: Email) => void;
  onClose: () => void;
};

export const EmailEditor = ({ initial, contacts, submitLabel, save, onSaved, onClose }: EmailEditorProps) => {
  const [fields, setFields] = useState<EmailFields>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const warnings = emailWarnings(fields, contacts);
  const set = (key: keyof EmailFields) => (value: string) => setFields((previous) => ({ ...previous, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const saved = await save(fields);
      toast.show("Saved. Review and approve it to send.");
      onSaved(saved);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <FieldRow>
        <Field label="To">
          <TextInput value={fields.to} onChange={(event) => set("to")(event.target.value)} required />
        </Field>
        <Field label="Cc">
          <TextInput value={fields.cc} onChange={(event) => set("cc")(event.target.value)} />
        </Field>
      </FieldRow>
      <Field label="Subject">
        <TextInput value={fields.subject} onChange={(event) => set("subject")(event.target.value)} required />
      </Field>
      <Field label="Message">
        <TextArea className="min-h-64" value={fields.body} onChange={(event) => set("body")(event.target.value)} required />
      </Field>
      {warnings.map((warning) => (
        <Callout key={warning} tone="warn" title="Check" role="status">
          {warning}
        </Callout>
      ))}
      {error === "" ? null : <Callout tone="warn" title="Not saved" role="alert">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={saving}>
          {submitLabel}
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </form>
  );
};
