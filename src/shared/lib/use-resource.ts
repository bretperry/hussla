/*
  Loads server data for a page and lets it reload: the one "fetch, don't mirror" hook.
  In the app: every page that reads the API uses it; there is no client cache or store behind it.
  Used by: src/app/**, src/features/**.

  Stale data stays on screen while a reload runs, so a save doesn't flash the page empty; a new
  input (another job id) clears it, so one job never shows under another's address.
*/
import { useCallback, useEffect, useRef, useState } from "react";

export type Resource<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
};

export const useResource = <T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Resource<T> => {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const previousDeps = useRef(deps);

  useEffect(() => {
    const controller = new AbortController();
    const inputsChanged = deps.length !== previousDeps.current.length || deps.some((dep, index) => !Object.is(dep, previousDeps.current[index]));
    previousDeps.current = deps;
    setState((previous) => ({ data: inputsChanged ? null : previous.data, error: null, loading: true }));
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({ data: previous.data, error: error instanceof Error ? error : new Error("Failed to load."), loading: false }));
      },
    );
    return () => controller.abort();
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
};
