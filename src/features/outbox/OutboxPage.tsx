/*
  The Outbox: every email by status, with the sending pace and a reminder that nothing goes without approval.
  In the app: "/outbox".
  Used by: src/app/App.tsx.
*/
import { MAIL_PACE_FALLBACK, OUTBOX_GROUPS } from "@/config/ui";
import { useStats } from "@/app/stats";
import { api, describeError } from "@/shared/api";
import type { MailStatus } from "@/shared/api";
import { useResource } from "@/shared/lib/use-resource";
import { EmptyState, ErrorLine, LoadingLine } from "@/shared/ui/Feedback";
import { PageHead, Section } from "@/shared/ui/Section";
import { EmailCard } from "./EmailCard";

const sendingNote = (mail: MailStatus | null): string => {
  if (mail === null || !mail.configured) return "Email sending isn't set up yet. Drafts and approvals still work and send once it is.";
  const pace = `${mail.sentToday} of ${mail.dailyLimit || MAIL_PACE_FALLBACK.dailyLimit} sent today, ${mail.hours || MAIL_PACE_FALLBACK.hours}`;
  return `Sending as ${mail.from}: ${pace}${mail.inWindow ? "" : " (outside sending hours now)"}.`;
};

export const OutboxPage = () => {
  const { refresh } = useStats();
  const emails = useResource((signal) => api.listEmails("", { signal }), []);
  const mail = useResource(() => api.mailStatus().catch(() => null), []);
  const changed = () => {
    emails.reload();
    mail.reload();
    refresh();
  };
  return (
    <>
      <PageHead kicker="Outbox" title="Nothing goes out unsigned" />
      <p className="max-w-prose text-muted">
        {sendingNote(mail.data)} Nothing is sent without your approval on that exact message.
      </p>
      {emails.error !== null && emails.data === null ? <ErrorLine message={describeError(emails.error)} /> : null}
      {emails.data === null ? (
        emails.error === null ? <LoadingLine /> : null
      ) : emails.data.length === 0 ? (
        <EmptyState title="No emails yet">Agents draft follow-ups here, and you can write one from a job or company page.</EmptyState>
      ) : (
        OUTBOX_GROUPS.map((group) => {
          const list = (emails.data ?? []).filter((email) => email.status === group.status || (group.status === "approved" && email.status === "sending"));
          return list.length === 0 ? null : (
            <Section key={group.status} kicker={`${group.label} (${list.length})`} urgent={group.status === "draft"}>
              {list.map((email) => (
                <EmailCard key={`${email.id}-${email.version}-${email.status}`} email={email} showJob onChanged={changed} />
              ))}
            </Section>
          );
        })
      )}
    </>
  );
};
