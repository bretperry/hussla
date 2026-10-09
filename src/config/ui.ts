/*
  UI knobs: copy that is tuned, catalogs (nav, status groups), and the limits the pages use.
  In the app: every page reads these; change a number or a word here, not in a component.
  Used by: src/features/**, src/shared/**, src/app/**.

  Visual tokens (colors, type, spacing) are not here: they live in src/shared/ui/tokens.css.
*/

// The motto under the dateline; customer-facing copy.
export const MOTTO = "All the leads fit to chase.";

// The nav, left to right. "Pitches" joins in Phase 5b. Activity is reached from the agent wire link.
export const NAV_ITEMS = [
  { path: "/jobs", label: "Jobs" },
  { path: "/companies", label: "Companies" },
  { path: "/outbox", label: "Outbox" },
  { path: "/answers", label: "Answers" },
  { path: "/settings", label: "Settings" },
] as const;

// What a job's status is called on screen.
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  review: "To review",
  queued: "Queued",
  waiting: "Waiting on you",
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  skipped: "Skipped",
  filtered: "Filtered out",
  failed: "Failed",
};

// The short tag beside a job on the front page board (mono, 10px, so short).
export const STATUS_TAG: Readonly<Record<string, string>> = {
  review: "Review",
  queued: "Queued",
  waiting: "Waiting",
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  skipped: "Skipped",
  filtered: "Filtered",
  failed: "Failed",
};

// The filter chips on the jobs table; `statuses: null` means every status.
export const JOB_GROUPS: ReadonlyArray<{ key: string; label: string; statuses: readonly string[] | null }> = [
  { key: "open", label: "Open", statuses: ["review", "queued", "waiting", "applied", "screening", "interviewing", "offer"] },
  { key: "todo", label: "To review", statuses: ["review", "queued", "waiting"] },
  { key: "applied", label: "Applied", statuses: ["applied", "screening", "interviewing", "offer"] },
  { key: "closed", label: "Closed", statuses: ["rejected", "withdrawn", "skipped", "failed"] },
  { key: "filtered", label: "Filtered out", statuses: ["filtered"] },
  { key: "all", label: "All", statuses: null },
];
export const DEFAULT_JOB_GROUP = "open";

// Statuses that rank a job as the lead story, best first; the first job in the first matching status wins.
export const LEAD_STATUS_ORDER = ["offer", "interviewing", "screening", "applied", "waiting", "queued", "review"] as const;

// Statuses that count as "open" for the board and for follow-ups still to send.
export const FOLLOW_UP_DUE_STATUSES = ["applied", "screening"] as const;

// How many jobs the front page board lists before "All N jobs".
export const BOARD_ROWS = 4;
// How many news headlines the front page rail shows.
export const NEWS_ITEMS = 4;
// How many companies the front page reads details from, for news and the overnight review count.
export const FRONT_PAGE_COMPANY_DETAILS = 24;
// "Overnight" means this many hours back.
export const OVERNIGHT_HOURS = 24;
// Events the activity page asks for.
export const ACTIVITY_LIMIT = 300;

// Pause after the last keystroke before "My notes" saves itself.
export const NOTES_AUTOSAVE_MS = 700;

// Companies the compare view takes.
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

// How the email statuses read to the owner, and the pill each uses.
export const EMAIL_LABEL: Readonly<Record<string, string>> = {
  draft: "Needs your OK",
  approved: "Queued to send",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  canceled: "Canceled",
};

// Outbox sections in reading order; `sending` shows with the queued ones.
export const OUTBOX_GROUPS: ReadonlyArray<{ status: string; label: string }> = [
  { status: "draft", label: "Needs your OK" },
  { status: "approved", label: "Queued" },
  { status: "failed", label: "Failed" },
  { status: "sent", label: "Sent" },
  { status: "canceled", label: "Canceled" },
];

// Shown when the mail provider reports nothing, so the sending note still reads sensibly.
export const MAIL_PACE_FALLBACK = { minGapMinutes: 4, dailyLimit: 25, hours: "business hours" } as const;

// localStorage keys (per-viewer conveniences only; every read is wrapped, none is required).
export const STORAGE_KEYS = { jobGroup: "hussla.jobGroup" } as const;
