/*
  Joins class names, dropping the falsy ones.
  In the app: every component builds its Tailwind class list with it.
  Used by: src/shared/ui/**, src/features/**.
*/
import { clsx } from "clsx";

export const cn = clsx;
