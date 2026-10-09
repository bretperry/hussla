/*
  The page frame: dateline with the nav, then the page. Inner pages get a compact nameplate; the front page draws its own.
  In the app: wraps every route; the dateline is the same on a phone, reflowed into two rows.
  Used by: src/app/App.tsx.
  Uses: src/app/stats.tsx for the badges and issue number, src/config/ui.ts for the nav and motto, the setup status's key expiry for the banner.
*/
import type { ReactNode } from "react";
import { TAILSCALE_ADMIN_MACHINES } from "@/config/setup";
import { MOTTO, NAV_ITEMS } from "@/config/ui";
import type { KeyExpiry } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { formatDateline } from "@/shared/lib/format";
import { Link, useLocation } from "@/shared/lib/router";
import { Callout } from "@/shared/ui/Feedback";
import { Nameplate, NameplateRule } from "@/shared/ui/Nameplate";
import { useStats } from "./stats";

const navBadge = (path: string, drafts: number, unanswered: number): number => {
  if (path === "/outbox") return drafts;
  return path === "/answers" ? unanswered : 0;
};

const Nav = ({ className, linkClassName }: { className?: string; linkClassName?: string }) => {
  const { path } = useLocation();
  const { stats } = useStats();
  return (
    <nav aria-label="Sections" className={cn("kicker flex gap-4", className)}>
      {NAV_ITEMS.map((item) => {
        const current = item.path === "/jobs" ? path === "/" || path.startsWith("/jobs") : path.startsWith(item.path);
        const badge = navBadge(item.path, stats?.drafts ?? 0, stats?.unanswered ?? 0);
        return (
          <Link
            key={item.path}
            to={item.path}
            {...(current ? { "aria-current": "page" as const } : {})}
            className={cn("no-underline", current && "underline underline-offset-4", linkClassName)}
          >
            {item.label}
            {badge > 0 ? <span className="ml-1 text-accent">{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
};

// Issue number, date and motto, with the nav on the right (desktop) or on its own row (phone).
const Dateline = () => {
  const { stats } = useStats();
  const today = new Date();
  const issue = Math.max(1, stats?.total ?? 1);
  return (
    <div className="grid grid-cols-12 items-baseline gap-x-6">
      <span className="kicker col-span-6 lg:col-span-4">
        No. {issue}
        <span className="hidden lg:inline"> · {formatDateline(today)}</span>
      </span>
      <span className="col-span-4 hidden text-center font-display text-row italic lg:block">“{MOTTO}”</span>
      <time dateTime={today.toISOString()} className="kicker col-span-6 text-right lg:hidden">
        {today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
      </time>
      <Nav className="col-span-12 mt-4 justify-between lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:mt-0 lg:justify-end" linkClassName="inline-flex h-touch items-center lg:h-auto" />
    </div>
  );
};

// Before this machine's Tailscale sign-in runs out, every page says so (once it has, nothing loads over the tailnet at all).
const KeyExpiryBanner = ({ keyExpiry }: { keyExpiry: KeyExpiry | undefined }) => {
  if (keyExpiry === undefined || !keyExpiry.warn) return null;
  return (
    <div className="mt-4">
      <Callout tone="warn" title={keyExpiry.expired ? "Tailscale signed this Hussla out" : `Tailscale signs this Hussla out in ${keyExpiry.daysLeft} days`} role="status">
        Open <a href={TAILSCALE_ADMIN_MACHINES}>Tailscale's Machines page</a>, find this Hussla, and choose “Disable key expiry” in its ⋯ menu.
      </Callout>
    </div>
  );
};

type ShellProps = { appName: string; children: ReactNode; front?: boolean; keyExpiry?: KeyExpiry | undefined };

export const Shell = ({ appName, children, front = false, keyExpiry }: ShellProps) => (
  <div className="mx-auto flex min-h-screen max-w-page flex-col px-4 pt-4 pb-8 sm:px-8 lg:px-16 lg:pt-6">
    <Dateline />
    <KeyExpiryBanner keyExpiry={keyExpiry} />
    {front ? null : (
      <>
        <Link to="/" className="mt-4 self-start no-underline hover:text-ink lg:mt-6" aria-label={`${appName}: front page`}>
          <Nameplate name={appName} size="inner" />
        </Link>
        <NameplateRule className="mt-2" />
      </>
    )}
    <main className={cn("flex flex-1 flex-col", front ? "" : "mt-6 gap-6")}>{children}</main>
    <footer className="kicker mt-8 flex justify-between border-t border-hairline pt-2 text-muted">
      <Link to="/activity">The agent wire</Link>
      <a href="/api/docs">Agent guide</a>
    </footer>
  </div>
);
