/*
  A throwaway HTTP server: the built UI from dist/ plus the API answered from synthetic fixtures.
  In the app: nothing at runtime; src/test/ui-evidence.mjs starts it so Playwright can drive the real bundle without the Go server.
  Used by: src/test/ui-evidence.mjs.
  Uses: src/test/fixtures.ts (Node strips the types), node:http.

  Only reads are modelled (plus a 200 for writes), because the evidence run looks at pages, not at server rules.
  `state.mode` switches the data set: "full", "empty" (day one), "nothing-to-sign" or "no-lead".
*/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import {
  companyDetails,
  companySummaries,
  emails,
  events,
  jobDetail,
  jobItems,
  mailStatus,
  makeContact,
  makeJob,
  pitchList,
} from "./fixtures.ts";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };

const dataFor = (mode) => {
  if (mode === "empty") return { jobs: [], companies: [], details: [], emails: [], events: [], answers: [] };
  if (mode === "no-lead") {
    const closed = jobItems.map((job) => ({ ...job, status: "rejected" }));
    return { jobs: closed, companies: companySummaries, details: companyDetails, emails: [], events, answers: [] };
  }
  const drafts = mode === "nothing-to-sign" ? emails.filter((email) => email.status !== "draft") : emails;
  return {
    jobs: jobItems,
    companies: companySummaries,
    details: companyDetails,
    emails: drafts,
    events,
    answers: [
      { id: "work-authorization", question: "Are you legally authorized to work in the US?", answer: "", jobIds: ["contoso-product-engineer"], createdAt: "2026-10-07T12:00:00.000Z", answeredAt: null, writers: {} },
      { id: "start-date", question: "When could you start?", answer: "Two weeks after an offer.", jobIds: [], createdAt: "2026-10-01T12:00:00.000Z", answeredAt: "2026-10-02T12:00:00.000Z", writers: {} },
    ],
  };
};

const detailOfJob = (data, id) => {
  const item = data.jobs.find((job) => job.id === id);
  if (item === undefined) return null;
  const company = data.details.find((candidate) => candidate.slug === item.companySlug) ?? null;
  return jobDetail({
    ...makeJob({
      id: item.id, company: item.company, companySlug: item.companySlug, title: item.title, status: item.status, score: item.score,
      nextAction: item.nextAction, payText: item.payText, location: item.location, appliedAt: item.appliedAt,
      contacts: [makeContact({ name: "Riley Example", email: "riley@northwind.example.com", emailStatus: "inferred", phone: "+1 555 010 0142" })],
      followup: { to: "riley@northwind.example.com", subject: "Staff Engineer: following up", body: "Hi Riley,\n\nI applied last week and wanted to follow up on the [role].\n\nThanks,\nJordan", linkedin: "", callNotes: "", emailSentAt: null, linkedinSentAt: null, callMadeAt: null },
    }),
    companyInfo: company,
    events: data.events,
    emails: data.emails.filter((email) => email.jobId === id),
  });
};

export const startFixtureServer = async ({ distDir, port = 0 }) => {
  const state = { mode: "full" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const data = dataFor(state.mode);
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") return json({ ok: true });
      const path = url.pathname;
      // The setup gate: an owner who has finished setup, so every page renders.
      if (path === "/api/setup") {
        const steps = { mail: "done", import: "done", agent: "done", phone: "done", expiry: "done", "second-passkey": "done" };
        return json({ enrolled: true, passkeys: 1, codeInLog: false, listener: "tailnet", isOwner: true, ownerLogin: "jordan@example.com", canStartOver: false, seenLogin: "jordan@example.com", firstRunOpen: false, address: "https://hussla.example.ts.net", wizard: { steps, finished: true } });
      }
      if (path === "/api/me") return json({ kind: "user", name: "Jordan Example", login: "jordan@example.com", appName: "Hussla" });
      if (path === "/api/stats") return json({ total: data.jobs.length, byStatus: {}, unanswered: data.answers.filter((a) => a.answer === "").length, drafts: data.emails.filter((e) => e.status === "draft").length });
      if (path === "/api/jobs") return json(data.jobs);
      if (path.startsWith("/api/jobs/")) {
        const detail = detailOfJob(data, decodeURIComponent(path.split("/")[3] ?? ""));
        return detail === null ? json({ error: "No such job." }, 404) : json(detail);
      }
      if (path === "/api/companies") return json(data.companies);
      if (path.startsWith("/api/companies/")) {
        const slug = decodeURIComponent(path.split("/")[3] ?? "");
        const detail = data.details.find((candidate) => candidate.slug === slug);
        return detail === undefined ? json({ error: "No such company." }, 404) : json(detail);
      }
      if (path === "/api/emails") {
        const wanted = url.searchParams.get("status")?.split(",");
        return json(wanted === undefined ? data.emails : data.emails.filter((email) => wanted.includes(email.status)));
      }
      if (path === "/api/mail") return json(mailStatus);
      if (path === "/api/events") return json(data.events);
      if (path === "/api/answers") return json(data.answers);
      if (path === "/api/pitches") return json(state.mode === "empty" ? { ...pitchList, pitches: [] } : pitchList);
      if (path === "/api/config") return json({ paused: false, homeMetro: "Remote, US", minScore: 70 });
      if (path === "/api/tokens") return json([{ id: "k1", name: "Laptop agent", createdAt: "2026-09-20T12:00:00.000Z", lastUsedAt: "2026-10-08T11:00:00.000Z", revokedAt: null }, { id: "k2", name: "Old script", createdAt: "2026-08-01T12:00:00.000Z", lastUsedAt: null, revokedAt: "2026-09-01T12:00:00.000Z" }]);
      if (path === "/api/passkeys") return json([{ id: "p1", name: "Phone", rpId: "hussla.example.ts.net", createdAt: "2026-09-20T12:00:00.000Z", lastUsedAt: "2026-10-08T11:00:00.000Z" }]);
      if (path === "/api/resumes") return json([{ name: "sample-resume-staff.pdf", variant: "sample-resume-staff", url: "/resumes/sample-resume-staff.pdf", size: 120000 }]);
      return json({ error: "Not modelled by the fixture server." }, 404);
    }
    const requested = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(distDir, requested);
    let body;
    try {
      body = await readFile(extname(file) === "" ? join(distDir, "index.html") : file);
      if (extname(file) === "") file = join(distDir, "index.html");
    } catch {
      body = await readFile(join(distDir, "index.html"));
      file = join(distDir, "index.html");
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return { state, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};
