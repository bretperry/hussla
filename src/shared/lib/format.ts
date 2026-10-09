/*
  Display helpers: pay, dates, addresses, phone numbers, and markdown-to-plain-text.
  In the app: the jobs table, job and company pages, and the email editor show these values.
  Used by: src/features/**.

  Pure functions over plain values, so each has a unit test and no component repeats the rule.
*/

// $185k for 185000, $950 below a thousand.
const shortMoney = (amount: number): string =>
  amount >= 1000 ? `$${Math.round(amount / 1000)}k` : `$${amount}`;

type PaySource = { payText: string; salaryMin: number | null; salaryMax: number | null };

// The pay as the owner reads it: checked posting text first, else the search's numbers, else "".
export const payLabel = (job: PaySource): string => {
  const text = job.payText.trim();
  if (text.startsWith("$")) return text.replace(/\s*\(.*$/, "").replace(/\s+base.*$/i, "").trim();
  if (job.salaryMin !== null && job.salaryMax !== null) return `${shortMoney(job.salaryMin)}–${shortMoney(job.salaryMax)}`;
  const only = job.salaryMin ?? job.salaryMax;
  return only === null ? "" : shortMoney(only);
};

type WhenOptions = { withTime?: boolean; now?: Date };

// "Oct 8" (with the year when it isn't this year), plus the time on request; "" for an empty value.
export const formatWhen = (iso: string | null | undefined, options: WhenOptions = {}): string => {
  if (iso === null || iso === undefined || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = options.now ?? new Date();
  const format: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) format.year = "numeric";
  if (options.withTime === true) {
    format.hour = "numeric";
    format.minute = "2-digit";
  }
  return date.toLocaleString(undefined, format);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// News and funding dates are as precise as their source: "2026", "2026-08", "2026-08-28". Anything else prints as given.
export const formatLooseDate = (value: string): string => {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(value.trim());
  if (match === null) return value;
  const [, year, month, day] = match;
  const monthName = month === undefined ? undefined : MONTHS[Number(month) - 1];
  if (monthName === undefined) return year ?? value;
  return day === undefined ? `${monthName} ${year}` : `${monthName} ${Number(day)}, ${year}`;
};

// "Thursday, October 8, 2026" for the dateline.
export const formatDateline = (date: Date): string =>
  date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

// The first email address inside free text ("Jane <jane@acme.com> (recruiter)"), or "".
export const firstEmail = (text: string): string => /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0] ?? "";

// The first US-style phone number inside free text, or "".
export const firstPhone = (text: string): string =>
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(text)?.[0] ?? "";

// Digits and a leading plus only, for a tel: link.
export const dialable = (phone: string): string => phone.replace(/[^\d+]/g, "");

// Drafts may arrive as markdown; strip the markers so a pasted email reads cleanly.
export const plainFromMarkdown = (text: string): string =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

// Splits "a@b.c, d@e.f; g@h.i" into addresses.
export const splitAddresses = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

// "[date]" or "[Hiring manager name]": a placeholder an agent left in a draft.
export const hasPlaceholder = (...texts: string[]): boolean => texts.some((text) => /\[[a-z][a-z ]*\]/i.test(text));

export type ScoreTier = "high" | "mid" | "low" | "none";

// Fit score bands: 85 and up is high, 75 and up is mid.
export const scoreTier = (score: number | null): ScoreTier => {
  if (score === null) return "none";
  if (score >= 85) return "high";
  return score >= 75 ? "mid" : "low";
};
