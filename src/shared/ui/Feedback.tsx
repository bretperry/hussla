/*
  Feedback pieces: callouts, status tags, empty states, and the toast line.
  In the app: warnings above a form, a job's status, "nothing here yet", and "Saved" confirmations.
  Used by: src/features/**, src/app/**.
*/
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

type CalloutTone = "note" | "warn";

// A boxed notice. "warn" is the urgent kind and the only one in red.
export const Callout = ({ tone = "note", title, children, role }: { tone?: CalloutTone; title?: string; children: ReactNode; role?: "alert" | "status" }) => (
  <div role={role} className={cn("border p-4 text-ui", tone === "warn" ? "border-accent" : "border-ink")}>
    {title === undefined ? null : <span className={cn("kicker mr-2", tone === "warn" && "text-accent")}>{title}</span>}
    {children}
  </div>
);

// A small boxed label; `strong` doubles the border for the thing that needs attention.
export const Tag = ({ children, strong = false, urgent = false }: { children: ReactNode; strong?: boolean; urgent?: boolean }) => (
  <span className={cn("tag inline-block border px-1 py-px whitespace-nowrap", strong ? "border-2" : "border", urgent ? "border-accent text-accent" : "border-ink")}>{children}</span>
);

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="flex flex-col gap-2 border-t border-hairline py-6">
    <p className="font-display text-title font-bold">{title}</p>
    {children === undefined ? null : <div className="text-muted">{children}</div>}
  </div>
);

export const LoadingLine = ({ label = "Loading" }: { label?: string }) => (
  <p role="status" className="kicker py-6 text-muted">{label}…</p>
);

export const ErrorLine = ({ message }: { message: string }) => (
  <Callout tone="warn" title="Problem" role="alert">{message}</Callout>
);

type ToastApi = { show: (message: string) => void };
const ToastContext = createContext<ToastApi>({ show: () => undefined });

// Hands out `show(message)`; the message sits at the bottom of the screen for a few seconds.
export const useToast = (): ToastApi => useContext(ToastContext);

const TOAST_MS = 4000;

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), TOAST_MS);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className={cn("fixed inset-x-4 bottom-4 z-10 mx-auto max-w-md border border-ink bg-ink p-4 text-ui text-paper", message === "" && "hidden")}>
        {message}
      </div>
    </ToastContext.Provider>
  );
};
