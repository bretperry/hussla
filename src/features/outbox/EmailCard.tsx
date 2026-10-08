/*
  One email in a list: its status, recipients and body, with edit, approve and cancel.
  In the app: the Outbox, a job's Follow-up section and a company's email history.
  Used by: src/features/outbox/OutboxPage.tsx, src/features/jobs/JobPage.tsx, src/features/companies/CompanyPage.tsx.
  Uses: EmailEditor (edit), ApprovePanel (confirm), api.cancelEmail.
*/
import { useState } from "react";
import { api, describeError } from "@/shared/api";
import type { Contact, Email } from "@/shared/api";
import { EMAIL_LABEL } from "@/config/ui";
import { formatWhen } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { Button } from "@/shared/ui/Button";
import { Tag, useToast } from "@/shared/ui/Feedback";
import { ApprovePanel } from "./ApprovePanel";
import { EmailEditor } from "./EmailEditor";

type Mode = "view" | "edit" | "approve";

type EmailCardProps = {
  email: Email;
  contacts?: readonly Contact[];
  showJob?: boolean;
  // Called after any change so the parent reloads the list.
  onChanged: () => void;
};

export const EmailCard = ({ email, contacts = [], showJob = false, onChanged }: EmailCardProps) => {
  const [mode, setMode] = useState<Mode>("view");
  const toast = useToast();
  const canApprove = email.status === "draft" || email.status === "failed";
  const canEdit = canApprove || email.status === "approved";

  const cancel = async () => {
    try {
      await api.cancelEmail(email.id);
      onChanged();
    } catch (failure) {
      toast.show(describeError(failure));
    }
  };

  return (
    <article data-email={email.id} className="flex flex-col gap-2 border-t border-hairline py-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Tag strong={email.status === "draft"} urgent={email.status === "failed"}>{EMAIL_LABEL[email.status] ?? email.status}</Tag>
        <h4 className="font-display text-row font-bold">{email.subject}</h4>
      </div>
      <p className="text-small text-muted">
        To {email.to.join(", ")}
        {email.cc.length > 0 ? ` · Cc ${email.cc.join(", ")}` : ""} · by {email.createdBy} ·{" "}
        {email.sentAt === null ? `created ${formatWhen(email.createdAt, { withTime: true })}` : `sent ${formatWhen(email.sentAt, { withTime: true })}`}
        {showJob && email.jobId !== null ? (
          <>
            {" · "}
            <Link to={`/jobs/${encodeURIComponent(email.jobId)}`} className="underline">
              {email.jobId}
            </Link>
          </>
        ) : null}
      </p>
      {email.error === null ? null : <p className="text-small text-accent">{email.error}</p>}
      {mode === "edit" ? (
        <EmailEditor
          initial={{ to: email.to.join(", "), cc: email.cc.join(", "), subject: email.subject, body: email.body }}
          contacts={contacts}
          submitLabel="Save changes"
          save={(fields) => api.editEmail(email.id, fields)}
          onSaved={() => {
            setMode("view");
            onChanged();
          }}
          onClose={() => setMode("view")}
        />
      ) : (
        <details>
          <summary className="cursor-pointer text-small">Show email</summary>
          <pre className="mt-2 border border-hairline p-2 font-ui text-ui whitespace-pre-wrap">{email.body}</pre>
        </details>
      )}
      {mode === "approve" ? (
        <ApprovePanel
          email={email}
          contacts={contacts}
          onApproved={() => {
            setMode("view");
            onChanged();
          }}
          onShowLatest={() => {
            setMode("view");
            onChanged();
          }}
          onBack={() => setMode("view")}
        />
      ) : null}
      {mode === "view" && canEdit ? (
        <div className="flex flex-wrap gap-2">
          {canApprove ? (
            <Button size="sm" variant="primary" onClick={() => setMode("approve")}>
              Review &amp; approve
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setMode("edit")}>
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => void cancel()}>
            {email.status === "approved" ? "Don't send" : "Cancel"}
          </Button>
        </div>
      ) : null}
    </article>
  );
};
