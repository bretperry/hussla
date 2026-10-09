/*
  The nameplate: the product name in black Bodoni with a red period, and the rules under it.
  In the app: the middle of the masthead on every page; a touch bigger on the front page.
  Used by: src/app/shell.tsx.
*/
import { cn } from "../lib/cn";

type NameplateProps = {
  name: string;
  // "front" is 64px on the front page; "inner" is 44px everywhere else. Both are 44px on a phone.
  size: "front" | "inner";
  className?: string;
};

export const Nameplate = ({ name, size, className }: NameplateProps) => (
  <div
    data-nameplate
    className={cn(
      "font-nameplate font-black text-nameplate-phone",
      size === "front" && "lg:text-nameplate",
      size === "inner" && "lg:text-nameplate-inner",
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
