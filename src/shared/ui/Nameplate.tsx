/*
  The nameplate: the product name in black Bodoni with a red period, and the rules under it.
  In the app: the top of every page; huge on the front page, smaller on inner pages.
  Used by: src/app/shell.tsx, src/features/jobs/FrontPage.tsx.
*/
import { cn } from "../lib/cn";

type NameplateProps = {
  name: string;
  // "front" is the 112px masthead centerpiece; "inner" is the compact one that links home.
  size: "front" | "inner";
  className?: string;
};

export const Nameplate = ({ name, size, className }: NameplateProps) => (
  <div
    data-nameplate
    className={cn(
      "font-display font-black",
      size === "front" && "text-center text-nameplate-phone lg:text-nameplate",
      size === "inner" && "text-nameplate-inner",
      className,
    )}
  >
    {name}
    <span className="text-accent">.</span>
  </div>
);

// The 8px black rule, a 3px gap, then a 1px rule (12px in all) under the nameplate.
export const NameplateRule = ({ className }: { className?: string }) => (
  <div role="presentation" className={cn("h-3 border-t-8 border-b border-ink", className)} />
);
