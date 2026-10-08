/*
  Form controls: a labeled field, text input, textarea and select, square and 1px ink.
  In the app: every form (add job, edit job, contacts, emails, answers, keys).
  Used by: src/features/**.

  16px text so a phone browser doesn't zoom on focus; a field wraps its control in the label, so
  a click on the label focuses it and a test can find it by label text.
*/
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

const control = "box-border w-full border border-ink bg-paper px-2 font-ui text-form text-ink placeholder:text-muted";

export const TextInput = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(control, "h-touch", className)} {...rest} />
);

export const TextArea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(control, "min-h-24 py-2", className)} {...rest} />
);

export const SelectInput = ({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn(control.replace("w-full ", ""), "h-touch max-w-full", className)} {...rest} />
);

export const Field = ({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) => (
  <label className={cn("flex flex-col gap-1", className)}>
    <span className="kicker">{label}</span>
    {children}
    {hint === undefined ? null : <span className="text-small text-muted">{hint}</span>}
  </label>
);

// Two fields side by side from the tablet width up.
export const FieldRow = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
