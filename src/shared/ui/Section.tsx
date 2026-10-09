/*
  Newspaper section pieces: the kicker, the 2px-ruled section head, stat blocks and the page head.
  In the app: every section on every page opens with a 2px rule, then a small-caps kicker.
  Used by: src/features/**, src/app/**.

  Gaps are fixed by relationship (rule to kicker 8, kicker to headline 8, headline to body 16, body to buttons 16, section to section 24).
*/
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

const Kicker = ({ children, urgent = false, className }: { children: ReactNode; urgent?: boolean; className?: string }) => (
  <span className={cn("kicker", urgent && "text-accent", className)}>{children}</span>
);

type SectionHeadProps = {
  kicker: ReactNode;
  // Red only for urgent or live items.
  urgent?: boolean;
  aside?: ReactNode;
  className?: string;
};

// The rule and kicker that open a section; data-grid-edge marks it for the grid check in the browser test.
export const SectionHead = ({ kicker, urgent, aside, className }: SectionHeadProps) => (
  <div data-grid-edge className={cn("flex items-baseline justify-between border-t-2 border-ink pt-2", className)}>
    <Kicker urgent={urgent ?? false}>{kicker}</Kicker>
    {aside === undefined ? null : <span className="kicker">{aside}</span>}
  </div>
);

// A section: the head, then its content at the standard 8px rhythm.
export const Section = ({
  kicker,
  urgent,
  aside,
  id,
  children,
  className,
}: SectionHeadProps & { id?: string; children: ReactNode }) => (
  <section id={id} aria-label={typeof kicker === "string" ? kicker : undefined} className={cn("flex scroll-mt-4 flex-col gap-2", className)}>
    <SectionHead kicker={kicker} urgent={urgent ?? false} aside={aside} />
    {children}
  </section>
);

// A big serif number over a kicker label.
export const Stat = ({ value, label }: { value: ReactNode; label: string }) => (
  <div className="flex flex-col">
    <span className="font-display text-stat font-bold">{value}</span>
    <span className="kicker">{label}</span>
  </div>
);

// The headline of an inner page, with its actions on the right.
export const PageHead = ({ kicker, title, actions }: { kicker: string; title: ReactNode; actions?: ReactNode }) => (
  <div className="flex flex-col gap-2">
    <SectionHead kicker={kicker} />
    <div className="flex flex-wrap items-start justify-between gap-4">
      <h1 className="font-display text-lead-phone font-bold lg:text-page">{title}</h1>
      {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  </div>
);
