/*
  The shared counts (unanswered questions, email drafts, jobs tracked) the nav badges and dateline show.
  In the app: loaded once by the shell; a page that changes a count calls `refresh` so the badges follow.
  Used by: src/app/shell.tsx, src/features/** (refresh after a write).
*/
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { api } from "@/shared/api";
import type { Stats } from "@/shared/api";
import { useResource } from "@/shared/lib/use-resource";

type StatsApi = { stats: Stats | null; refresh: () => void };
const StatsContext = createContext<StatsApi>({ stats: null, refresh: () => undefined });

export const useStats = (): StatsApi => useContext(StatsContext);

export const StatsProvider = ({ children }: { children: ReactNode }) => {
  const { data, reload } = useResource(() => api.stats(), []);
  const value = useMemo(() => ({ stats: data, refresh: reload }), [data, reload]);
  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
};
