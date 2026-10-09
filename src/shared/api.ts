/*
  The typed client over the generated API contract: one request helper, one function per call the UI makes.
  In the app: every page fetches and writes through it; owner-only calls run the passkey step-up first.
  Used by: src/app/**, src/features/**.
  Uses: src/shared/api-types.ts (generated from api/openapi.yaml, never hand-edited), src/shared/lib/webauthn.ts.

  Errors are ApiError with the server's stable `code` ("changed-since-read", "passkey-required" …),
  so a screen branches on the code and never on message text. No Origin or auth header is added here:
  the browser sends the real Origin, and the owner is identified by the connection, never a header.
*/
import type { components } from "./api-types";
import { getPasskeyAssertion } from "./lib/webauthn";

type Schemas = components["schemas"];
export type Me = Schemas["Me"];
export type Stats = Schemas["Stats"];
export type JobListItem = Schemas["JobListItem"];
export type JobDetail = Schemas["JobDetail"];
export type JobPatch = Schemas["JobPatch"];
export type Contact = Schemas["Contact"];
export type Company = Schemas["Company"];
export type CompanyDetail = Schemas["CompanyDetail"];
export type CompanySummary = Schemas["CompanySummary"];
export type Review = Schemas["Review"];
export type NewsItem = Schemas["NewsItem"];
export type Email = Schemas["Email"];
export type EmailEdit = Schemas["EmailEdit"];
export type EmailCreate = Schemas["EmailCreate"];
export type Event = Schemas["Event"];
export type Answer = Schemas["Answer"];
export type MailStatus = Schemas["MailStatus"];
export type AgentKey = Schemas["AgentKey"];
export type AgentKeyCreated = Schemas["AgentKeyCreated"];
export type Passkey = Schemas["Passkey"];
export type Resume = Schemas["Resume"];
export type FileRecord = Schemas["FileRecord"];
export type SearchConfig = Schemas["SearchConfig"];
export type JobStatus = Schemas["JobStatus"];
export type Pitch = Schemas["Pitch"];
export type PitchVersion = Schemas["PitchVersion"];
export type PitchList = Schemas["PitchList"];
export type PitchSettings = Schemas["PitchSettings"];

const JOB_STATUSES: readonly JobStatus[] = ["review", "queued", "waiting", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "skipped", "filtered", "failed"];

// Narrows a string (a select's value) to a status the API accepts.
export const isJobStatus = (value: string): value is JobStatus => (JOB_STATUSES as readonly string[]).includes(value);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly fields: readonly string[];
  constructor(message: string, status: number, code?: string, fields: readonly string[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

type RequestOptions = {
  body?: unknown;
  // Raw bytes (a file upload); sent as-is with its own content type.
  file?: File;
  // Run the passkey tap first and send the one-use token the server asked for.
  stepUp?: boolean;
  signal?: AbortSignal;
};

const STEP_UP_HEADER = "X-Hussla-Step-Up";

const failureFrom = async (response: Response): Promise<ApiError> => {
  let message = `The server said ${response.status}.`;
  let code: string | undefined;
  let fields: string[] = [];
  try {
    const body: Partial<Schemas["Error"]> = await response.json();
    if (typeof body.error === "string") message = body.error;
    code = body.code;
    fields = body.fields ?? [];
  } catch {
    // Not JSON (a proxy page, say): keep the status message.
  }
  return new ApiError(message, response.status, code, fields);
};

const send = async <T>(method: string, path: string, options: RequestOptions = {}): Promise<T> => {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.file !== undefined) {
    body = options.file;
    headers["content-type"] = options.file.type === "" ? "application/octet-stream" : options.file.type;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  if (options.stepUp === true) headers[STEP_UP_HEADER] = await requestStepUpToken(method, path.split("?")[0] ?? path);
  let response: Response;
  try {
    response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("Can't reach Hussla. Check the connection and try again.", 0);
  }
  if (!response.ok) throw await failureFrom(response);
  const isJson = response.headers.get("content-type")?.includes("json") ?? false;
  // The generated contract types each route; the cast is the one place the wire becomes T.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON boundary, typed by the OpenAPI contract
  return (isJson ? await response.json() : await response.text()) as T;
};

// One passkey tap, good for exactly this method and path.
const requestStepUpToken = async (method: string, path: string): Promise<string> => {
  const challenge = await send<Schemas["PasskeyChallenge"]>("POST", "/api/stepup/begin", { body: { method, path } });
  const credential = await getPasskeyAssertion(challenge.options);
  const { token } = await send<Schemas["StepUpToken"]>("POST", "/api/stepup/finish", {
    body: { challengeId: challenge.challengeId, credential },
  });
  return token;
};

const id = encodeURIComponent;
type Signal = { signal?: AbortSignal };
const withSignal = (signal: AbortSignal | undefined): RequestOptions => (signal === undefined ? {} : { signal });

export const api = {
  me: (): Promise<Me> => send("GET", "/api/me"),
  stats: (): Promise<Stats> => send("GET", "/api/stats"),

  listJobs: (extra: Signal = {}): Promise<JobListItem[]> => send("GET", "/api/jobs", withSignal(extra.signal)),
  getJob: (jobId: string, extra: Signal = {}): Promise<JobDetail> => send("GET", `/api/jobs/${id(jobId)}`, withSignal(extra.signal)),
  createJob: (body: JobPatch & { company: string; title: string }): Promise<Schemas["Job"]> => send("POST", "/api/jobs", { body }),
  patchJob: (jobId: string, body: JobPatch): Promise<Schemas["Job"]> => send("PATCH", `/api/jobs/${id(jobId)}`, { body }),
  deleteJob: (jobId: string): Promise<Schemas["Ok"]> => send("DELETE", `/api/jobs/${id(jobId)}`, { stepUp: true }),
  logJobEvent: (jobId: string, body: Schemas["JobEventCreate"]): Promise<Schemas["Created"]> => send("POST", `/api/jobs/${id(jobId)}/events`, { body }),
  saveJobContact: (jobId: string, body: Contact): Promise<Schemas["Job"]> => send("POST", `/api/jobs/${id(jobId)}/contacts`, { body }),
  uploadJobFile: (jobId: string, file: File): Promise<FileRecord> =>
    send("POST", `/api/jobs/${id(jobId)}/files?name=${id(file.name)}&kind=file`, { file }),
  deleteFile: (fileId: string): Promise<Schemas["Ok"]> => send("DELETE", `/api/files/${id(fileId)}`, { stepUp: true }),
  listResumes: (): Promise<Resume[]> => send("GET", "/api/resumes"),

  listCompanies: (extra: Signal = {}): Promise<CompanySummary[]> => send("GET", "/api/companies", withSignal(extra.signal)),
  getCompany: (slug: string, extra: Signal = {}): Promise<CompanyDetail> => send("GET", `/api/companies/${id(slug)}`, withSignal(extra.signal)),
  patchCompany: (slug: string, body: Schemas["CompanyPatch"]): Promise<Company> => send("PATCH", `/api/companies/${id(slug)}`, { body }),

  listEmails: (query = "", extra: Signal = {}): Promise<Email[]> => send("GET", `/api/emails${query}`, withSignal(extra.signal)),
  draftJobEmail: (jobId: string, body: EmailCreate): Promise<Email> => send("POST", `/api/jobs/${id(jobId)}/emails`, { body }),
  draftCompanyEmail: (slug: string, body: EmailCreate & { jobId?: string }): Promise<Email> => send("POST", `/api/companies/${id(slug)}/emails`, { body }),
  editEmail: (emailId: string, body: EmailEdit): Promise<Email> => send("PATCH", `/api/emails/${id(emailId)}`, { body }),
  approveEmail: (emailId: string, version: number): Promise<Email> =>
    send("POST", `/api/emails/${id(emailId)}/approve`, { body: { version }, stepUp: true }),
  cancelEmail: (emailId: string): Promise<Email> => send("POST", `/api/emails/${id(emailId)}/cancel`),
  mailStatus: (): Promise<MailStatus> => send("GET", "/api/mail"),
  sendTestEmail: (): Promise<Schemas["MailTestResult"]> => send("POST", "/api/mail/test", { stepUp: true }),

  listEvents: (limit: number, extra: Signal = {}): Promise<Event[]> => send("GET", `/api/events?limit=${limit}`, withSignal(extra.signal)),

  listAnswers: (): Promise<Answer[]> => send("GET", "/api/answers"),
  saveAnswer: (question: string): Promise<Answer> => send("POST", "/api/answers", { body: { question } }),
  patchAnswer: (answerId: string, answer: string): Promise<Answer> => send("PATCH", `/api/answers/${id(answerId)}`, { body: { answer } }),
  deleteAnswer: (answerId: string): Promise<Schemas["Ok"]> => send("DELETE", `/api/answers/${id(answerId)}`, { stepUp: true }),

  listPitches: (extra: Signal = {}): Promise<PitchList> => send("GET", "/api/pitches", withSignal(extra.signal)),
  createPitch: (body: Schemas["PitchCreate"]): Promise<Pitch> => send("POST", "/api/pitches", { body }),
  patchPitch: (slot: number, body: Schemas["PitchPatch"]): Promise<Pitch> => send("PATCH", `/api/pitches/${slot}`, { body }),
  addPitchVersion: (slot: number, body: Schemas["PitchVersionCreate"]): Promise<Pitch> => send("POST", `/api/pitches/${slot}/versions`, { body }),
  setLivePitch: (slot: number, version: number): Promise<Pitch> => send("POST", `/api/pitches/${slot}/live`, { body: { version }, stepUp: true }),
  deletePitchVersion: (slot: number, version: number): Promise<Schemas["Ok"]> => send("DELETE", `/api/pitches/${slot}/versions/${version}`, { stepUp: true }),
  deletePitch: (slot: number): Promise<Schemas["Ok"]> => send("DELETE", `/api/pitches/${slot}`, { stepUp: true }),

  getSearchConfig: (): Promise<SearchConfig> => send("GET", "/api/config"),
  setPaused: (paused: boolean): Promise<SearchConfig> => send("PATCH", "/api/config", { body: { paused }, stepUp: true }),

  listAgentKeys: (): Promise<AgentKey[]> => send("GET", "/api/tokens"),
  createAgentKey: (name: string): Promise<AgentKeyCreated> => send("POST", "/api/tokens", { body: { name }, stepUp: true }),
  revokeAgentKey: (keyId: string): Promise<Schemas["Ok"]> => send("DELETE", `/api/tokens/${id(keyId)}`, { stepUp: true }),
  listPasskeys: (): Promise<Passkey[]> => send("GET", "/api/passkeys"),
  signOutEverywhere: (): Promise<Schemas["Ok"]> => send("POST", "/api/sessions/revoke-all", { stepUp: true }),
};

// A message for a failed call that a person can act on.
export const describeError = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");
