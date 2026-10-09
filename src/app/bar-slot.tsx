/*
  A slot on the right of the section bar, so a page can put its own line next to the nav.
  In the app: the front page puts the overnight counts and "Review & sign" there on desktop; other pages leave it empty.
  Used by: src/app/shell.tsx (provides the slot), src/features/jobs/FrontPage.tsx (fills it).
*/
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export const BarSlotContext = createContext<HTMLElement | null>(null);

// Renders its children into the section bar; nothing until the shell has mounted the slot.
export const BarAside = ({ children }: { children: ReactNode }) => {
  const target = useContext(BarSlotContext);
  return target === null ? null : createPortal(children, target);
};
