/*
  Buttons and button-looking links: a solid black primary, a 1px outline secondary, square corners.
  In the app: every action on every page; the front page keeps one solid button (Review & sign).
  Used by: src/features/**, src/app/**.
  Uses: src/shared/lib/router.tsx for in-app links.
*/
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Link } from "../lib/router";

type ButtonVariant = "primary" | "secondary" | "danger";
type ButtonSize = "md" | "sm";

// 44px tall for a thumb; "sm" drops to 32px where a mouse is the likely pointer (lg and up).
const buttonClass = (variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string =>
  cn(
    "box-border inline-flex cursor-pointer items-center justify-center border px-4 font-ui text-ui font-semibold whitespace-nowrap no-underline",
    "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
    size === "md" ? "h-touch" : "h-touch lg:h-8 lg:text-small",
    variant === "primary" && "border-ink bg-ink text-paper hover:bg-body hover:text-paper",
    variant === "secondary" && "border-ink bg-transparent text-ink hover:bg-ink hover:text-paper",
    variant === "danger" && "border-accent bg-transparent text-accent hover:bg-accent hover:text-paper",
    extra,
  );

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export const Button = ({ variant, size, className, type = "button", ...rest }: ButtonProps) => (
  <button type={type} className={buttonClass(variant, size, className)} {...rest} />
);

type LinkButtonProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  // An address outside the app (a posting, a mailto:) opens as a plain link.
  external?: boolean;
};

export const LinkButton = ({ to, variant, size, className, external = false, ...rest }: LinkButtonProps) =>
  external ? (
    <a href={to} className={buttonClass(variant, size, className)} {...rest} />
  ) : (
    <Link to={to} className={buttonClass(variant, size, className)} {...rest} />
  );
