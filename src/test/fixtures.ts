/*
  Synthetic data for tests and the browser evidence run: fictional companies, people, pitches and addresses on example.com.
  In the app: nothing at runtime; component tests, the front-page tests and src/test/ui-evidence.mjs read it.
  Used by: the component tests (*.test.tsx), src/test/ui-evidence.mjs (imported straight as TypeScript by Node).

  The repository is public: every name below is invented. Never paste real jobs, contacts, pitches or résumé text here.
*/
import type { CompanyDetail, CompanySummary, Contact, Email, Event, JobDetail, JobListItem, MailStatus, Pitch, PitchList, PitchVersion } from "@/shared/api";
import type { components } from "@/shared/api-types";

type Job = components["schemas"]["Job"];

// Builds dates relative to a fixed "now" so fixtures never drift with the clock.
export const FIXTURE_NOW = new Date("2026-10-08T14:00:00.000Z");
const hoursAgo = (hours: number): string => new Date(FIXTURE_NOW.getTime() - hours * 3_600_000).toISOString();

const emptyFollowup = { emailSentAt: null, linkedinSentAt: null, callMadeAt: null };

export const makeJobItem = (overrides: Partial<JobListItem> & Pick<JobListItem, "id" | "company" | "companySlug" | "title">): JobListItem => ({
  createdAt: hoursAgo(200),
  updatedAt: hoursAgo(5),
  status: "review",
  score: 80,
  url: "https://jobs.example.com/posting",
  location: "Remote, US",
  workType: "remote",
  salaryMin: 170000,
  salaryMax: 210000,
  payText: "",
  source: "Greenhouse",
  resume: "",
  resumeSent: "",
  foundAt: hoursAgo(190),
  appliedAt: null,
  nextAction: "",
  nextActionDue: "",
  headsUp: "",
  followup: emptyFollowup,
  primaryContact: null,
  ...overrides,
});

export const jobItems: JobListItem[] = [
  makeJobItem({ id: "northwind-staff-engineer-platform", company: "Northwind Labs", companySlug: "northwind-labs", title: "Staff Engineer, Platform", status: "interviewing", score: 93, nextAction: "Final round, Thu 2 pm", appliedAt: hoursAgo(120), payText: "$215k–$260k", followup: { emailSentAt: hoursAgo(90), linkedinSentAt: null, callMadeAt: null } }),
  makeJobItem({ id: "fabrikam-principal-engineer", company: "Fabrikam Cloud", companySlug: "fabrikam-cloud", title: "Principal Engineer, Edge", status: "applied", score: 88, appliedAt: hoursAgo(10), resumeSent: "sample-resume-staff.pdf", primaryContact: { name: "Riley Example", role: "Recruiter", email: "riley@fabrikam.example.com", emailStatus: "verified" } }),
  makeJobItem({ id: "contoso-product-engineer", company: "Contoso Payments", companySlug: "contoso-payments", title: "Product Engineer", status: "waiting", score: 84, nextAction: "Needs a work-authorization answer", location: "New York, NY", workType: "hybrid" }),
  makeJobItem({ id: "tailspin-senior-frontend", company: "Tailspin Data", companySlug: "tailspin-data", title: "Senior Frontend Engineer", status: "review", score: 79 }),
  makeJobItem({ id: "globex-staff-ui", company: "Globex Robotics", companySlug: "globex-robotics", title: "Staff UI Engineer", status: "review", score: 76, location: "Austin, TX", workType: "onsite" }),
  makeJobItem({ id: "initech-lead-engineer", company: "Initech Systems", companySlug: "initech-systems", title: "Lead Engineer", status: "queued", score: 71 }),
  makeJobItem({ id: "northwind-design-engineer", company: "Northwind Labs", companySlug: "northwind-labs", title: "Design Engineer", status: "screening", score: 86, appliedAt: hoursAgo(60) }),
  makeJobItem({ id: "fabrikam-engineering-manager", company: "Fabrikam Cloud", companySlug: "fabrikam-cloud", title: "Engineering Manager", status: "rejected", score: 69 }),
  makeJobItem({ id: "contoso-support-lead", company: "Contoso Payments", companySlug: "contoso-payments", title: "Support Engineering Lead", status: "skipped", score: 55 }),
  makeJobItem({ id: "shady-remote-clerk", company: "Quick Cash Staffing", companySlug: "quick-cash-staffing", title: "Remote Data Clerk", status: "filtered", score: null }),
];

export const makeSummary = (overrides: Partial<CompanySummary> & Pick<CompanySummary, "slug" | "name">): CompanySummary => ({
  quickTake: "",
  jobs: [],
  bestScore: null,
  payMin: null,
  payMax: null,
  glassdoor: null,
  glassdoorCount: null,
  avgRating: null,
  healthSignal: "",
  healthRank: 0,
  healthNote: "",
  totalFunding: "",
  totalFundingUsd: null,
  valuation: "",
  valuationUsd: null,
  revenue: "",
  employees: "",
  hq: "",
  founded: null,
  stage: "",
  remotePolicy: "",
  phone: "",
  layoffs: 0,
  newsCount: 0,
  updatedAt: hoursAgo(30),
  ...overrides,
});

export const companySummaries: CompanySummary[] = [
  makeSummary({ slug: "northwind-labs", name: "Northwind Labs", quickTake: "Northwind builds observability tooling for platform teams. Revenue is past $400M a year and the company is cash-flow positive. Engineers describe a calm, writing-heavy culture. The one thing to know: the platform org was reorganized in the spring.", jobs: [{ id: "northwind-staff-engineer-platform", title: "Staff Engineer, Platform", status: "interviewing", score: 93, payText: "$215k–$260k", salaryMin: 215000, salaryMax: 260000 }, { id: "northwind-design-engineer", title: "Design Engineer", status: "screening", score: 86, payText: "", salaryMin: 170000, salaryMax: 210000 }], bestScore: 93, payMin: 170000, payMax: 260000, glassdoor: 4.3, glassdoorCount: 812, avgRating: 4.2, healthSignal: "strong", healthRank: 4, healthNote: "Profitable and growing", totalFunding: "$310M", totalFundingUsd: 310000000, valuation: "$6.2B", valuationUsd: 6200000000, revenue: "$420M", employees: "about 1,400", hq: "Portland, OR", founded: 2016, stage: "Series D", remotePolicy: "Remote-first", phone: "+1 555 010 0100", newsCount: 2, updatedAt: hoursAgo(3) }),
  makeSummary({ slug: "fabrikam-cloud", name: "Fabrikam Cloud", quickTake: "Fabrikam sells edge hosting to retailers.", jobs: [{ id: "fabrikam-principal-engineer", title: "Principal Engineer, Edge", status: "applied", score: 88, payText: "", salaryMin: 190000, salaryMax: 240000 }, { id: "fabrikam-engineering-manager", title: "Engineering Manager", status: "rejected", score: 69, payText: "", salaryMin: 170000, salaryMax: 210000 }], bestScore: 88, payMin: 170000, payMax: 240000, glassdoor: 3.9, glassdoorCount: 240, avgRating: 3.8, healthSignal: "steady", healthRank: 3, healthNote: "Steady, slower growth", totalFunding: "$120M", totalFundingUsd: 120000000, valuation: "$1.1B", valuationUsd: 1100000000, revenue: "$95M", employees: "about 600", hq: "Denver, CO", founded: 2014, stage: "Series C", remotePolicy: "Hybrid", phone: "", layoffs: 1, newsCount: 1, updatedAt: hoursAgo(12) }),
  makeSummary({ slug: "contoso-payments", name: "Contoso Payments", quickTake: "Contoso moves money for small marketplaces.", jobs: [{ id: "contoso-product-engineer", title: "Product Engineer", status: "waiting", score: 84, payText: "", salaryMin: 175000, salaryMax: 205000 }], bestScore: 84, payMin: 175000, payMax: 205000, glassdoor: 4.0, glassdoorCount: 95, avgRating: 4.0, healthSignal: "watch", healthRank: 2, healthNote: "Burning cash, raised recently", totalFunding: "$60M", totalFundingUsd: 60000000, valuation: "$400M", valuationUsd: 400000000, revenue: "$22M", employees: "about 180", hq: "New York, NY", founded: 2019, stage: "Series B", remotePolicy: "Hybrid, 3 days", phone: "+1 555 010 0199", newsCount: 1, updatedAt: hoursAgo(40) }),
  makeSummary({ slug: "tailspin-data", name: "Tailspin Data", jobs: [{ id: "tailspin-senior-frontend", title: "Senior Frontend Engineer", status: "review", score: 79, payText: "", salaryMin: 160000, salaryMax: 190000 }], bestScore: 79, payMin: 160000, payMax: 190000, healthSignal: "risky", healthRank: 1, employees: "about 70", founded: 2021, stage: "Seed", updatedAt: hoursAgo(70) }),
];

export const makeContact = (overrides: Partial<Contact> & Pick<Contact, "name">): Contact => ({
  priority: "Primary",
  role: "Recruiter",
  email: "",
  emailStatus: "",
  phone: "",
  linkedin: "",
  source: "",
  notes: "",
  ...overrides,
});

export const makeJob = (overrides: Partial<Job> = {}): Job => ({
  writers: {},
  id: "northwind-staff-engineer-platform",
  companySlug: "northwind-labs",
  createdAt: hoursAgo(200),
  updatedAt: hoursAgo(5),
  company: "Northwind Labs",
  title: "Staff Engineer, Platform",
  status: "interviewing",
  statusNote: "",
  score: 93,
  url: "https://jobs.example.com/northwind/staff-platform",
  location: "Remote, US",
  workType: "remote",
  salaryMin: 215000,
  salaryMax: 260000,
  payText: "$215k–$260k",
  compensation: "Base $215k–$260k plus equity.",
  source: "Greenhouse",
  resume: "sample-resume-staff",
  resumeSent: "sample-resume-staff.pdf",
  foundAt: hoursAgo(190),
  appliedAt: hoursAgo(120),
  nextAction: "Final round, Thu 2 pm",
  nextActionDue: "2026-10-08",
  headsUp: "",
  description: "## About the role\n\nLead the platform team's **reliability** work.\n\n- Own the paging rotation\n- Mentor four engineers\n\nMore at https://jobs.example.com/northwind.",
  descriptionFetchedAt: hoursAgo(180),
  postingStatus: "open",
  whyScore: "Strong match on platform and mentoring.",
  reasons: ["Remote-first", "Profitable"],
  scamFlags: [],
  contacts: [],
  bestChannel: "",
  followup: { to: "", subject: "", body: "", linkedin: "", callNotes: "", emailSentAt: null, linkedinSentAt: null, callMadeAt: null },
  companyNotes: "",
  roleNotes: "",
  sources: ["https://jobs.example.com/northwind/staff-platform"],
  notes: "",
  ...overrides,
});

export const makeEmail = (overrides: Partial<Email> = {}): Email => ({
  id: "email-1",
  jobId: "northwind-staff-engineer-platform",
  companySlug: "northwind-labs",
  to: ["riley@northwind.example.com"],
  cc: [],
  subject: "Following up on the Staff Engineer role",
  body: "Hi Riley,\n\nI applied last week and wanted to follow up.\n\nThanks,\nJordan",
  kind: "follow-up",
  status: "draft",
  createdBy: "agent:laptop",
  createdAt: hoursAgo(6),
  approvedBy: null,
  approvedAt: null,
  sentAt: null,
  messageId: null,
  error: null,
  attempts: 0,
  version: 1,
  ...overrides,
});

export const emails: Email[] = [
  makeEmail({ id: "email-1", jobId: "fabrikam-principal-engineer", companySlug: "fabrikam-cloud", to: ["riley@fabrikam.example.com"], subject: "Principal Engineer, Edge: a short follow-up" }),
  makeEmail({ id: "email-2", jobId: "contoso-product-engineer", companySlug: "contoso-payments", to: ["sam@contoso.example.com"], subject: "Product Engineer: checking in", createdAt: hoursAgo(8) }),
  makeEmail({ id: "email-3", jobId: "northwind-staff-engineer-platform", status: "approved", approvedBy: "Jordan Example", approvedAt: hoursAgo(1), subject: "Thank you for the conversation", version: 2 }),
  makeEmail({ id: "email-4", jobId: "northwind-design-engineer", status: "sent", approvedBy: "Jordan Example", approvedAt: hoursAgo(50), sentAt: hoursAgo(49), subject: "Design Engineer: following up", createdAt: hoursAgo(55) }),
];

export const makeCompanyDetail = (overrides: Partial<CompanyDetail> & { summary: CompanySummary }): CompanyDetail => ({
  slug: overrides.summary.slug,
  name: overrides.summary.name,
  updatedAt: overrides.summary.updatedAt,
  quickTake: overrides.summary.quickTake,
  profile: {},
  financials: {},
  facts: [],
  anecdotes: [],
  news: [],
  reviews: [],
  interview: "",
  sources: [],
  notes: "",
  profileFetchedAt: null,
  reviewsFetchedAt: null,
  writers: {},
  jobs: [],
  emails: [],
  jobContacts: [],
  ...overrides,
});

// Looks up a fixture summary by slug; a typo fails loudly instead of yielding undefined.
const summaryOf = (slug: string): CompanySummary => {
  const found = companySummaries.find((summary) => summary.slug === slug);
  if (found === undefined) throw new Error(`no fixture company ${slug}`);
  return found;
};
const northwind = summaryOf("northwind-labs");
const fabrikam = summaryOf("fabrikam-cloud");
const contoso = summaryOf("contoso-payments");
const tailspin = summaryOf("tailspin-data");

export const companyDetails: CompanyDetail[] = [
  makeCompanyDetail({
    summary: northwind,
    profile: { website: "https://northwind.example.com", careersUrl: "https://northwind.example.com/careers", hq: "Portland, OR", founded: 2016, employees: "about 1,400 (company site, Oct 2026)", ceo: "Casey Example", type: "private", stage: "Series D", phone: "+1 555 010 0100", phoneLabel: "Main line (company site)", remotePolicy: "Remote-first" },
    financials: { totalFunding: "$310M", valuation: "$6.2B", revenue: "$420M annualized", profitability: "Cash-flow positive", growth: "Up 38% year over year", healthSignal: "strong", healthNote: "Profitable and growing", investors: ["Example Ventures", "Sample Capital"], layoffs: [] },
    facts: ["Writes a design doc for every project", "Four-day on-call rotation"],
    anecdotes: [{ text: "An engineer says reviews are quick and kind.", source: "Blind", url: "https://blind.example.com/post/1" }],
    news: [
      { date: "2026-08-28", headline: "Northwind Labs passes $400M in annual revenue", summary: "Up from $290M a year ago", source: "Example Wire", url: "https://news.example.com/northwind-400m" },
      { date: "2026-06", headline: "Northwind reorganizes its platform group", summary: "Two teams become one", source: "Example Wire", url: "https://news.example.com/northwind-platform" },
    ],
    reviews: [
      { source: "Glassdoor", rating: 4.3, ratingScale: 5, reviewCount: 812, summary: "Thoughtful engineering culture; promotions are slow.", pros: ["Calm pace", "Strong mentors"], cons: ["Slow promotions"], url: "https://glassdoor.example.com/northwind", fetchedAt: hoursAgo(4) },
      { source: "Blind", rating: 4.1, ratingScale: 5, reviewCount: 96, summary: "Good pay, steady hours.", pros: ["Pay"], cons: [], url: "https://blind.example.com/northwind", fetchedAt: hoursAgo(30) },
    ],
    interview: "Four rounds: recruiter, system design, a pairing session, a values conversation.",
    sources: ["https://northwind.example.com/about"],
    jobContacts: [{ name: "Riley Example", role: "Recruiter", email: "riley@northwind.example.com", emailStatus: "inferred", phone: "+1 555 010 0142", linkedin: "https://www.linkedin.com/in/example", source: "Company site", notes: "", priority: "Primary", jobId: "northwind-staff-engineer-platform", jobTitle: "Staff Engineer, Platform" }],
  }),
  makeCompanyDetail({
    summary: fabrikam,
    financials: { valuation: "$1.1B", revenue: "$95M", profitability: "Near break-even", healthSignal: "steady" },
    news: [{ date: "2026-09-12", headline: "Fabrikam Cloud opens two new edge regions", summary: "Frankfurt and Singapore", source: "Example Wire", url: "https://news.example.com/fabrikam-regions" }],
    reviews: [{ source: "Glassdoor", rating: 3.9, ratingScale: 5, reviewCount: 240, summary: "Fine place; reorganizations are frequent.", pros: [], cons: ["Reorgs"], url: "", fetchedAt: hoursAgo(20) }],
  }),
  makeCompanyDetail({
    summary: contoso,
    financials: { valuation: "$400M", revenue: "$22M", profitability: "Burning cash", healthSignal: "watch" },
    news: [{ date: "2026-09-02", headline: "Contoso Payments raises $40M Series B", summary: "Led by Sample Capital", source: "Example Wire", url: "https://news.example.com/contoso-b" }],
  }),
  makeCompanyDetail({ summary: tailspin }),
];

export const events: Event[] = [
  { id: 5, jobId: "northwind-staff-engineer-platform", at: hoursAgo(2), actor: "agent:laptop", action: "Final round scheduled", detail: "Thursday at 2 pm, four interviewers", company: "Northwind Labs", title: "Staff Engineer, Platform" },
  { id: 4, jobId: "fabrikam-principal-engineer", at: hoursAgo(10), actor: "agent:cloud-search", action: "Applied", detail: "Submitted on the company site", company: "Fabrikam Cloud", title: "Principal Engineer, Edge" },
  { id: 3, jobId: null, at: hoursAgo(12), actor: "agent:cloud-search", action: "Ran search", detail: "12 new, 3 filtered", company: null, title: null },
  { id: 2, jobId: "contoso-product-engineer", at: hoursAgo(26), actor: "Jordan Example", action: "Status changed", detail: "waiting", company: "Contoso Payments", title: "Product Engineer" },
];

export const jobDetail = (overrides: Partial<JobDetail> = {}): JobDetail => ({
  ...makeJob(),
  companyInfo: null,
  events: [],
  files: [],
  emails: [],
  ...overrides,
});

export const mailStatus: MailStatus = {
  configured: true,
  from: "jordan@example.com",
  fromName: "Jordan Example",
  provider: "smtp",
  dailyLimit: 25,
  sentToday: 2,
  minGapMinutes: 4,
  hours: "8:00–18:00 America/New_York",
  inWindow: true,
  lastSentAt: hoursAgo(1),
  nextSendAt: null,
  queued: 1,
  bccSelf: true,
};

// Pitches: invented wording for an invented person. The fourth is near the server's character limit, to size the billboard box.
export const makePitchVersion = (overrides: Partial<PitchVersion> & Pick<PitchVersion, "version" | "text">): PitchVersion => ({
  note: "",
  author: "Jordan Example",
  writer: "owner",
  createdAt: hoursAgo(72),
  ...overrides,
});

export const makePitch = (overrides: Partial<Pitch> & Pick<Pitch, "slot" | "title" | "versions">): Pitch => ({
  when: "",
  liveVersion: 1,
  createdAt: hoursAgo(96),
  updatedAt: hoursAgo(2),
  ...overrides,
});

const LONGEST_PITCH =
  "I came up through support, so I learned to read a product from the angry end first. Since then I have led small teams that turned " +
  "noisy queues into calm ones: we cut first-reply time by two thirds, wrote the playbooks newcomers still use, and built the tools " +
  "that let one person do the work of three. I want to do that again somewhere the problem is bigger than the team. That is the job I want next, and soon.";

export const pitches: Pitch[] = [
  makePitch({
    slot: 1,
    title: "Who I am",
    when: "Opening a call, or “tell me about yourself”",
    liveVersion: 2,
    versions: [
      makePitchVersion({ version: 1, text: "I build calm tools for busy support teams, and I like the messy first version best." }),
      makePitchVersion({ version: 2, text: "I build calm tools for busy teams. I like the messy first version, and I stay for the boring tenth.", note: "warmer ending", createdAt: hoursAgo(30) }),
      makePitchVersion({ version: 3, text: "I build calm, fast tools for busy teams. I like the messy first version and I stay for the tenth.", note: "tighter", author: "agent:laptop", writer: "agent", createdAt: hoursAgo(3) }),
    ],
  }),
  makePitch({
    slot: 2,
    title: "Why now",
    when: "When they ask about timing",
    versions: [makePitchVersion({ version: 1, text: "The team I built runs itself now. That is the best moment to go find the next hard problem." })],
  }),
  makePitch({
    slot: 4,
    title: "Why me",
    when: "Comparing me to other candidates",
    versions: [makePitchVersion({ version: 1, text: "You need someone who has shipped this exact kind of tool twice and still likes talking to the people who use it." })],
  }),
  makePitch({ slot: 7, title: "The long story", when: "A friendly interviewer with time", versions: [makePitchVersion({ version: 1, text: LONGEST_PITCH })] }),
];

export const pitchList: PitchList = {
  pitches,
  settings: { slots: 10, maxCharacters: 420, rotateSeconds: 180, wordsPerMinute: 150 },
};
