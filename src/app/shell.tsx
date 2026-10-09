/*
  The page frame: the masthead (date, nameplate, motto), the section bar with the nav, then the page.
  In the app: wraps every route; the front page's nameplate is a step bigger, and it fills the bar's right-hand slot.
  Used by: src/app/App.tsx.
  Uses: src/app/stats.tsx for the badges and issue number, src/app/bar-slot.tsx, src/config/ui.ts for the nav and motto, the setup status's key expiry for the banner.
*/
import { useState } from "react";
import type { ReactNode } from "react";
import { TAILSCALE_ADMIN_MACHINES } from "@/config/setup";
import { MOTTO, NAV_ITEMS } from "@/config/ui";
import type { KeyExpiry } from "@/shared/api";
import { cn } from "@/shared/lib/cn";
import { formatDateline } from "@/shared/lib/format";
import { Link, useLocation } from "@/shared/lib/router";
import { Callout } from "@/shared/ui/Feedback";
import { Nameplate, NameplateRule } from "@/shared/ui/Nameplate";
import { BarSlotContext } from "./bar-slot";
import { useStats } from "./stats";

const navBadge = (path: string, drafts: number, unanswered: number): number => {
  if (path === "/outbox") return drafts;
  return path === "/answers" ? unanswered : 0;
};

const Nav = ({ className, linkClassName }: { className?: string; linkClassName?: string }) => {
  const { path } = useLocation();
  const { stats } = useStats();
  return (
    <nav aria-label="Sections" className={cn("flex", className)}>
      {NAV_ITEMS.map((item) => {
        const current = item.path === "/jobs" ? path === "/" || path.startsWith("/jobs") : path.startsWith(item.path);
        const badge = navBadge(item.path, stats?.drafts ?? 0, stats?.unanswered ?? 0);
        return (
          <Link
            key={item.path}
            to={item.path}
            {...(current ? { "aria-current": "page" as const } : {})}
            className={cn("no-underline", current && "underline decoration-2 underline-offset-[6px]", linkClassName)}
          >
            {item.label}
            {badge > 0 ? <span className="ml-1 text-accent">{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
};

// Issue number and date on the left, the nameplate in the middle, the motto on the right; a phone puts the nameplate first and stacks the date over the motto.
const Masthead = ({ appName, front }: { appName: string; front: boolean }) => {
  const { stats } = useStats();
  const today = new Date();
  const issue = Math.max(1, stats?.total ?? 1);
  return (
    <header data-m="masthead" className="flex items-center justify-between gap-4 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:gap-6">
      <div className="hidden flex-col gap-0.5 lg:flex">
        <span className="kicker">No. {issue}</span>
        <time dateTime={today.toISOString()} className="text-ui text-body">
          {formatDateline(today)}
        </time>
      </div>
      <Link to="/" className="no-underline hover:text-ink" aria-label={`${appName}: front page`}>
        <Nameplate name={appName} size={front ? "front" : "inner"} />
      </Link>
      <div className="flex flex-col items-end gap-0.5 text-right">
        <span className="kicker lg:hidden">
          No. {issue} · {today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </span>
        {/* Its own column, never the nav's row: sharing one row with the nav made them collide at in-between widths. */}
        <p className="font-display text-ui text-body italic lg:text-prose">“{MOTTO}”</p>
      </div>
    </header>
  );
};

// The nav, and on the right a slot a page can fill (BarAside). A phone scrolls the nav sideways instead of wrapping it.
const SectionBar = ({ onSlot }: { onSlot: (element: HTMLElement | null) => void }) => (
  <div data-m="section-bar" className="flex items-center justify-between gap-6 border-b border-hairline lg:mt-1.5 lg:h-bar">
    <Nav
      className="-mx-4 gap-5 overflow-x-auto px-4 text-ui font-semibold whitespace-nowrap sm:-mx-8 sm:px-8 lg:mx-0 lg:gap-6 lg:px-0"
      linkClassName="inline-flex h-touch shrink-0 items-center"
    />
    <div ref={onSlot} className="hidden lg:flex lg:items-center lg:gap-6" />
  </div>
);

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

export const Shell = ({ appName, children, front = false, keyExpiry }: ShellProps) => {
  // The section bar's slot, held in state so pages re-render into it once it has mounted.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="mx-auto flex min-h-screen max-w-page flex-col px-4 pt-3 pb-8 sm:px-8 lg:px-16 lg:pt-4">
      <Masthead appName={appName} front={front} />
      <NameplateRule className="mt-2" />
      <SectionBar onSlot={setBarSlot} />
      <KeyExpiryBanner keyExpiry={keyExpiry} />
      <BarSlotContext.Provider value={barSlot}>
        <main className={cn("flex flex-1 flex-col", front ? "mt-3 lg:mt-4" : "mt-6 gap-6")}>{children}</main>
      </BarSlotContext.Provider>
      <footer className="kicker mt-8 flex justify-between border-t border-hairline pt-2 text-muted">
        <Link to="/activity">The agent wire</Link>
        <a href="/api/docs">Agent guide</a>
      </footer>
    </div>
  );
};
