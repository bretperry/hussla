/*
  The agent wire: the activity log across every job, newest first.
  In the app: "/activity", reached from "Read the agent wire" on the front page and the footer.
  Used by: src/app/App.tsx.
*/
import { ACTIVITY_LIMIT } from "@/config/ui";
import { api, describeError } from "@/shared/api";
import { formatWhen } from "@/shared/lib/format";
import { Link } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { EmptyState, ErrorLine, LoadingLine } from "@/shared/ui/Feedback";
import { MarkdownInline } from "@/shared/ui/Markdown";
import { PageHead, Section } from "@/shared/ui/Section";

export const ActivityPage = () => {
  const events = useResource((signal) => api.listEvents(ACTIVITY_LIMIT, { signal }), []);
  if (events.data === null) return events.error === null ? <LoadingLine /> : <ErrorLine message={describeError(events.error)} />;
  return (
    <>
      <PageHead kicker="Activity" title="The agent wire" />
      <Section kicker="Newest first" aside={`${events.data.length} entries`}>
        {events.data.length === 0 ? <EmptyState title="Nothing yet">Everything agents and you do shows up here.</EmptyState> : (
          <ul>
            {events.data.map((entry) => (
              <li key={entry.id} className="grid grid-cols-1 gap-x-4 border-t border-hairline py-2 sm:grid-cols-[10rem_1fr]">
                <span className="kicker text-muted">{formatWhen(entry.at, { withTime: true })}</span>
                <span>
                  <b>{entry.action}</b>
                  {entry.jobId === null ? null : <> · <Link to={`/jobs/${encodeURIComponent(entry.jobId)}`} className="underline">{entry.company === null || entry.company === undefined ? entry.jobId : `${entry.company}: ${entry.title ?? ""}`}</Link></>}
                  {entry.detail === "" ? null : <> · <MarkdownInline source={entry.detail} /></>}
                  <span className="text-muted"> · {entry.actor}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
};
