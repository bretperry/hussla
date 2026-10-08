/*
  The approve step: shows exactly what will be sent, asks for a passkey tap, and approves that version.
  In the app: opens from "Review & approve" on an email card; nothing is queued until the owner confirms here.
  Used by: src/features/outbox/EmailCard.tsx.
  Uses: api.approveEmail (passkey step-up, compare-and-swap on the email's version).

  If an agent edited the draft after the owner looked, the server answers "changed-since-read";
  the panel says so and offers the latest version instead of approving anything.
*/
import { useState } from "react";
import { ApiError, api, describeError } from "@/shared/api";
import type { Contact, Email } from "@/shared/api";
import { Button } from "@/shared/ui/Button";
import { Callout, useToast } from "@/shared/ui/Feedback";
import { emailWarnings } from "./email-warnings";

type ApprovePanelProps = {
  email: Email;
  contacts: readonly Contact[];
  onApproved: (email: Email) => void;
  onShowLatest: () => void;
  onBack: () => void;
};

export const ApprovePanel = ({ email, contacts, onApproved, onShowLatest, onBack }: ApprovePanelProps) => {
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const warnings = emailWarnings({ to: email.to.join(" "), subject: email.subject, body: email.body }, contacts);

  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      const approved = await api.approveEmail(email.id, email.version);
      toast.show("Approved. It goes out at the next send slot.");
      onApproved(approved);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "changed-since-read") setStale(true);
      else setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 border border-ink p-4" role="group" aria-label="Approve this email">
      <p className="kicker">Approve exactly this (version {email.version})</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="kicker">To</dt>
        <dd>{email.to.join(", ")}</dd>
        {email.cc.length > 0 ? (
          <>
            <dt className="kicker">Cc</dt>
            <dd>{email.cc.join(", ")}</dd>
          </>
        ) : null}
        <dt className="kicker">Subject</dt>
        <dd>{email.subject}</dd>
      </dl>
      <pre className="max-h-64 overflow-auto border border-hairline p-2 font-ui text-ui whitespace-pre-wrap">{email.body}</pre>
      {email.status === "failed" ? (
        <Callout tone="warn" title="Failed before" role="status">
          {email.error ?? "The last send failed."} It may have been sent before the failure. Approving sends it again.
        </Callout>
      ) : null}
      {warnings.map((warning) => (
        <Callout key={warning} tone="warn" title="Check" role="status">
          {warning}
        </Callout>
      ))}
      {stale ? (
        <Callout tone="warn" title="Changed" role="alert">
          This email changed since you read it, so nothing was approved. Read the latest version first.
        </Callout>
      ) : null}
      {error === "" ? null : <Callout tone="warn" title="Not approved" role="alert">{error}</Callout>}
      <div className="flex flex-wrap gap-2">
        {stale ? (
          <Button variant="primary" onClick={onShowLatest}>
            Show the latest
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void approve()}>
            Approve &amp; queue
          </Button>
        )}
        <Button onClick={onBack}>Back</Button>
      </div>
      <p className="text-small text-muted">Approving asks for your passkey (Face ID, Touch ID or your phone).</p>
    </div>
  );
};
