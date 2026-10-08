/*
  A small History API router: Link, navigate, the current location, and route matching.
  In the app: every in-app link and every page switch goes through it; the Go server answers any path with index.html.
  Used by: src/app/**, src/features/**, src/shared/ui/**.

  Why not a router library: the app has a dozen routes and no nested layouts, so a library would be
  more code to learn than this file (react.mdc: compose, don't add a UI library).
*/
import { useMemo, useSyncExternalStore } from "react";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
};

const currentHref = (): string => window.location.pathname + window.location.search;

// Goes to another in-app address and tells every subscriber; a new page starts at the top.
export const navigate = (to: string, options: { replace?: boolean } = {}): void => {
  if (options.replace === true) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  for (const listener of listeners) listener();
  window.scrollTo(0, 0);
};

export type AppLocation = { path: string; search: URLSearchParams };

export const useLocation = (): AppLocation => {
  const href = useSyncExternalStore(subscribe, currentHref);
  return useMemo(() => {
    const [path = "/", query = ""] = href.split("?");
    return { path, search: new URLSearchParams(query) };
  }, [href]);
};

// Matches "/jobs/:id" against a path; returns the decoded params, or null when it doesn't fit.
export const matchRoute = (pattern: string, path: string): Record<string, string> | null => {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    const actual = pathParts[index] ?? "";
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(actual);
    else if (part !== actual) return null;
  }
  return params;
};

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

export const Link = ({ to, onClick, ...rest }: LinkProps) => {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const plainLeftClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plainLeftClick || rest.target === "_blank") return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={handleClick} />;
};
