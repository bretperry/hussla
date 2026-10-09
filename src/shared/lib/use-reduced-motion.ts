/*
  Whether the viewer asked for less motion (the OS "reduce motion" setting), kept current while the page is open.
  In the app: the front page billboard switches pitches without its cross-fade when this is true.
  Used by: src/features/jobs/PitchSlot.tsx.

  CSS alone (tokens.css turns animations off under the same query) would hide the fade but still
  render the outgoing pitch for its duration; reading it here lets the billboard skip that layer.
*/
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// matchMedia is missing in some test environments and very old browsers: no preference then.
const mediaQuery = (): MediaQueryList | null => (typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

const subscribe = (listener: () => void): (() => void) => {
  const query = mediaQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};

export const useReducedMotion = (): boolean => useSyncExternalStore(subscribe, () => mediaQuery()?.matches ?? false);
