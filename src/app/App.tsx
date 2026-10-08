/*
  The app root: who is calling, the setup gate, and the route table.
  In the app: renders for every address; the Go server answers any path with index.html and this picks the page.
  Used by: src/main.tsx.
  Uses: GET /api/me for the product name, src/shared/lib/router.tsx for matching.
*/
import type { ReactNode } from "react";
import { ApiError, api, describeError } from "@/shared/api";
import type { Me } from "@/shared/api";
import { matchRoute, useLocation } from "@/shared/lib/router";
import type { AppLocation } from "@/shared/lib/router";
import { useResource } from "@/shared/lib/use-resource";
import { Callout, EmptyState, LoadingLine, ToastProvider } from "@/shared/ui/Feedback";
import { ActivityPage } from "@/features/activity/ActivityPage";
import { AnswersPage } from "@/features/answers/AnswersPage";
import { CompaniesPage } from "@/features/companies/CompaniesPage";
import { CompanyPage } from "@/features/companies/CompanyPage";
import { ComparePage } from "@/features/companies/ComparePage";
import { FrontPage } from "@/features/jobs/FrontPage";
import { AddJobPage, EditJobPage } from "@/features/jobs/JobForms";
import { JobPage } from "@/features/jobs/JobPage";
import { JobsPage } from "@/features/jobs/JobsPage";
import { OutboxPage } from "@/features/outbox/OutboxPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { Shell } from "./shell";
import { StatsProvider } from "./stats";

type RouteContext = { params: Record<string, string>; location: AppLocation; me: Me };
type RouteEntry = { pattern: string; render: (context: RouteContext) => ReactNode };

// First match wins, so "/companies/compare" sits before "/companies/:slug".
const param = (context: RouteContext, key: string): string => context.params[key] ?? "";

const ROUTES: RouteEntry[] = [
  { pattern: "/", render: ({ me }) => <FrontPage appName={me.appName} /> },
  { pattern: "/jobs", render: () => <JobsPage /> },
  { pattern: "/jobs/new", render: () => <AddJobPage /> },
  { pattern: "/jobs/:id", render: (context) => <JobPage jobId={param(context, "id")} /> },
  { pattern: "/jobs/:id/edit", render: (context) => <EditJobPage jobId={param(context, "id")} /> },
  { pattern: "/companies", render: () => <CompaniesPage /> },
  { pattern: "/companies/compare", render: () => <ComparePage /> },
  { pattern: "/companies/:slug", render: (context) => <CompanyPage slug={param(context, "slug")} /> },
  { pattern: "/outbox", render: () => <OutboxPage /> },
  { pattern: "/answers", render: () => <AnswersPage /> },
  { pattern: "/activity", render: () => <ActivityPage /> },
  { pattern: "/settings", render: ({ me }) => <SettingsPage me={me} /> },
];

const NotFound = () => (
  <EmptyState title="No such page">The address doesn't match anything here. Use the sections at the top.</EmptyState>
);

// Shown when the server refuses before an owner exists, or when nobody is signed in.
const Gate = ({ error }: { error: Error }) => {
  const setupRequired = error instanceof ApiError && error.code === "setup-required";
  return (
    <div className="mx-auto flex max-w-page flex-col gap-4 px-4 py-8 sm:px-8 lg:px-16">
      <Callout tone="warn" title={setupRequired ? "Setup needed" : "Can't open Hussla"} role="alert">
        {setupRequired
          ? "This Hussla has no owner yet. Finish setup with the code in the server log, then reload."
          : describeError(error)}
      </Callout>
    </div>
  );
};

const Routes = ({ me }: { me: Me }) => {
  const appName = me.appName;
  const location = useLocation();
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, location.path);
    if (params !== null) {
      return (
        <Shell appName={appName} front={route.pattern === "/"}>
          {route.render({ params, location, me })}
        </Shell>
      );
    }
  }
  return (
    <Shell appName={appName}>
      <NotFound />
    </Shell>
  );
};

export const App = () => {
  const me = useResource(() => api.me(), []);
  if (me.error !== null) return <Gate error={me.error} />;
  if (me.data === null) return <LoadingLine />;
  document.title = me.data.appName;
  return (
    <ToastProvider>
      <StatsProvider>
        <Routes me={me.data} />
      </StatsProvider>
    </ToastProvider>
  );
};
