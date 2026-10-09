/*
  The app root: who is calling, the setup gate, and the route table.
  In the app: renders for every address; the Go server answers any path with index.html and this picks the page.
  Used by: src/main.tsx.
  Uses: GET /api/setup for the gate (src/features/setup/setup-steps.ts), GET /api/me for the product name, src/shared/lib/router.tsx for matching.
*/
import type { ReactNode } from "react";
import { api, describeError } from "@/shared/api";
import type { Me, SetupStatus } from "@/shared/api";
import { matchRoute, navigate, useLocation } from "@/shared/lib/router";
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
import { PitchesPage } from "@/features/pitches/PitchesPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { MailStep } from "@/features/setup/MailStep";
import { PasskeysPage } from "@/features/setup/PasskeysPage";
import { NotYoursPage, SetupPage } from "@/features/setup/SetupPage";
import { gateFor } from "@/features/setup/setup-steps";
import { Shell } from "./shell";
import { StatsProvider } from "./stats";

type RouteContext = { params: Record<string, string>; location: AppLocation; me: Me; status: SetupStatus; reloadStatus: () => void };
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
  { pattern: "/pitches", render: () => <PitchesPage /> },
  { pattern: "/activity", render: () => <ActivityPage /> },
  { pattern: "/settings", render: ({ me }) => <SettingsPage me={me} /> },
  { pattern: "/setup/passkeys", render: ({ status, reloadStatus }) => <PasskeysPage status={status} onChange={reloadStatus} /> },
  { pattern: "/setup/mail", render: () => <MailStep onDone={() => navigate("/settings")} /> },
];

const NotFound = () => (
  <EmptyState title="No such page">The address doesn't match anything here. Use the sections at the top.</EmptyState>
);

// Shown when there is no identity at all, or the server can't be read.
const Gate = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mx-auto flex max-w-page flex-col gap-4 px-4 py-8 sm:px-8 lg:px-16">
    <Callout tone="warn" title={title} role="alert">
      {children}
    </Callout>
  </div>
);

const Routes = ({ me, status, reloadStatus }: { me: Me; status: SetupStatus; reloadStatus: () => void }) => {
  const appName = me.appName;
  const location = useLocation();
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, location.path);
    if (params !== null) {
      return (
        <Shell appName={appName} front={route.pattern === "/"} keyExpiry={status.keyExpiry}>
          {route.render({ params, location, me, status, reloadStatus })}
        </Shell>
      );
    }
  }
  return (
    <Shell appName={appName} keyExpiry={status.keyExpiry}>
      <NotFound />
    </Shell>
  );
};

// The signed-in app: the product name from /api/me, then the routes.
const SignedIn = ({ status, reloadStatus }: { status: SetupStatus; reloadStatus: () => void }) => {
  const me = useResource(() => api.me(), []);
  if (me.error !== null) return <Gate title="Can't open Hussla">{describeError(me.error)}</Gate>;
  if (me.data === null) return <LoadingLine />;
  document.title = me.data.appName;
  return (
    <StatsProvider>
      <Routes me={me.data} status={status} reloadStatus={reloadStatus} />
    </StatsProvider>
  );
};

export const App = () => {
  const status = useResource(() => api.setupStatus(), []);
  if (status.error !== null) return <Gate title="Can't open Hussla">{describeError(status.error)}</Gate>;
  if (status.data === null) return <LoadingLine />;
  const gate = gateFor(status.data);
  if (gate.kind === "sign-in") {
    return (
      <Gate title="Sign in first">
        Open Hussla from its Tailscale address, or on this computer run <code>hussla open</code> to get a sign-in link.
      </Gate>
    );
  }
  if (gate.kind === "not-owner") return <NotYoursPage ownerLogin={gate.ownerLogin} seenLogin={gate.seenLogin} />;
  return (
    <ToastProvider>
      {gate.kind === "setup" ? <SetupPage status={status.data} onChange={status.reload} /> : <SignedIn status={status.data} reloadStatus={status.reload} />}
    </ToastProvider>
  );
};
