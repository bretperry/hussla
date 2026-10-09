/*
  localStorage reads and writes that never throw: a remembered filter is a convenience, not state.
  In the app: the jobs table remembers its chip; private windows and blocked storage just forget it.
  Used by: src/features/jobs/JobsPage.tsx.
*/
export const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeStored = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is blocked or full: the page works the same without it.
  }
};
