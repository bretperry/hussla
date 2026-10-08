<!-- The agents' guide, served at GET /api/docs. Keep it in step with api/openapi.yaml; the prototype's original is docs/reference/prototype/agents-api.md. -->

# Hussla: guide for agents

Hussla is the source of truth for the owner's job search. Every agent (search, research,
application, follow-up) reads and writes it through this API. The owner reads it on their phone and laptop.

## Connect

- Base URL: `https://hussla.<tailnet>.ts.net` from a device on the owner's tailnet. There is no
  public address: a cloud agent joins the tailnet (as a tagged device) to reach it.
- Auth: `Authorization: Bearer <agent key>` on every request. The owner makes one key per agent or
  computer on the Settings page. Your key name shows up as `agent:<name>` in the activity log. A
  request with a key is always that agent, even from the owner's own computer; a wrong or revoked
  key is `401`, never a fallback to anyone else.
- Don't send an `Origin` header (a foreign one is refused). Requests must use the ts.net host name.
- Bodies are JSON (`content-type: application/json`) except file uploads.
- `GET /api` lists every endpoint. This file is served at `GET /api/docs`.

## Rules (from the owner)

1. **Scam filter.** Verify the employer, apply only on the company's own site or a known ATS
   (Greenhouse, Lever, Ashby, Workday, Workable). Red flags (personal Gmail contacts, payment
   requests, chat-app interviews, no real posting) mean `status: "filtered"` with `scamFlags`.
2. **Never store or enter** SSN, bank details, ID numbers or date of birth. Not in this tracker,
   not on any form before an offer.
3. **Accounts:** the owner creates site accounts themselves. If a form needs a new account, set
   `status: "waiting"` with a `nextAction` saying which site.
4. **Answers:** use `GET /api/answers` for form questions. If a question has no saved answer,
   don't guess: `POST /api/answers {"question": "...", "jobIds": ["<job id>"]}` with no answer,
   set the job to `waiting`, and move on.
5. **Settings:** check `GET /api/config` first. If `paused` is true, only read.
6. **Never invent facts.** Contacts carry `emailStatus` `verified` or `inferred`; reviews only
   record ratings you actually saw. Log what you did on every job you touch.

## Job fields

Job id is a slug like `vanta-senior-software-engineer-ai-product`. `PATCH` merges: send only
what changed. Arrays and objects replace whole, except `followup`, which merges key by key.
Setting a field to `null` clears it. Add `"note": "..."` to any PATCH to log it in the timeline.

| Field | Meaning |
|---|---|
| `company`, `title`, `url`, `location`, `workType` | Basics (`workType`: remote, hybrid, onsite) |
| `status` | `review` `queued` `waiting` `applied` `screening` `interviewing` `offer` `rejected` `withdrawn` `skipped` `filtered` `failed` |
| `score` | Fit score 0-100 |
| `salaryMin`, `salaryMax`, `payText`, `compensation` | Pay as numbers, short text, and the posting's full pay text |
| `resume` | Résumé variant planned (e.g. `owner-resume-staff`); see `GET /api/resumes` |
| `resumeSent` | File actually submitted (e.g. `owner-resume-staff.pdf`) |
| `appliedAt`, `foundAt` | ISO timestamps (`appliedAt` is set automatically on the switch to `applied`) |
| `nextAction`, `nextActionDue` | What happens next and by when |
| `headsUp` | One-line warning shown at the top of the job page |
| `description` | Full job description, markdown |
| `postingStatus` | `open`, `closed` or `unknown` |
| `whyScore`, `reasons[]`, `scamFlags[]` | Scoring notes |
| `contacts[]` | `{priority, name, role, email, emailStatus, phone, linkedin, source, notes}` |
| `bestChannel` | How to reach them, markdown |
| `followup` | `{to, subject, body, linkedin, callNotes, emailSentAt, linkedinSentAt, callMadeAt}` |
| `companyNotes`, `roleNotes` | Cliff notes, markdown |
| `sources[]` | URLs used |
| `notes` | the owner's own notes. Don't overwrite. |

Company reviews live on the company, shared by all its jobs (`companySlug` on the job).

## Common calls

```bash
JT=https://hussla.<tailnet>.ts.net; H="Authorization: Bearer $JT_KEY"; C='content-type: application/json'

# What needs doing
curl -s -H "$H" "$JT/api/jobs?status=review,queued"
curl -s -H "$H" "$JT/api/jobs/<id>"                     # full job + reviews + files + activity

# New job from a search (409 if the id exists; use PUT to upsert)
curl -s -X POST -H "$H" -H "$C" "$JT/api/jobs" -d '{
  "company":"Acme","title":"Senior Full Stack Engineer","url":"https://job-boards.greenhouse.io/acme/jobs/1",
  "location":"Remote, US","workType":"remote","salaryMin":180000,"salaryMax":220000,"score":82,
  "source":"Greenhouse","resume":"owner-resume-fullstack","reasons":["TS/React/Node match"]}'

# Submitted an application
curl -s -X PATCH -H "$H" -H "$C" "$JT/api/jobs/<id>" \
  -d '{"status":"applied","resumeSent":"owner-resume-fullstack.pdf","note":"Submitted on Greenhouse"}'

# Attach the confirmation email, cover letter or a screenshot
curl -s -X POST -H "$H" -H 'content-type: application/pdf' --data-binary @cover.pdf \
  "$JT/api/jobs/<id>/files?name=cover-letter.pdf&kind=cover-letter"

# Save or update one contact (matched by name)
curl -s -X POST -H "$H" -H "$C" "$JT/api/jobs/<id>/contacts" \
  -d '{"name":"Jane Doe","role":"Recruiter","email":"jane@acme.com","emailStatus":"verified","source":"https://..."}'

# Save a review (one per source per company; posting again replaces it)
curl -s -X POST -H "$H" -H "$C" "$JT/api/companies/acme/reviews" \
  -d '{"source":"Glassdoor","rating":4.1,"ratingScale":5,"reviewCount":230,"summary":"...","pros":["..."],"cons":["..."],"url":"https://..."}'

# Follow-up sent
curl -s -X PATCH -H "$H" -H "$C" "$JT/api/jobs/<id>" -d '{"followup":{"emailSentAt":"2026-10-08T15:00:00Z"},"note":"Follow-up emailed to Jane"}'

# Log anything else
curl -s -X POST -H "$H" -H "$C" "$JT/api/jobs/<id>/events" -d '{"action":"Recruiter replied","detail":"Wants a call Tuesday"}'
curl -s -X POST -H "$H" -H "$C" "$JT/api/events" -d '{"action":"Ran search","detail":"12 new, 3 filtered"}'
```

## Email (sent from the owner's own address)

Agents can only **draft** emails. the owner approves each one on the site (Outbox, or the job's
Follow-up section); the NAS then sends approved mail one at a time, several minutes apart,
during business hours, under a daily cap. Never try to send mail any other way.

```bash
# Draft a follow-up for the owner to approve (plain text body; no markdown)
curl -s -X POST -H "$H" -H "$C" "$JT/api/jobs/<id>/emails" \
  -d '{"to":"recruiting@acme.com","subject":"Senior Full Stack Engineer: Jane Applicant","body":"Hi ...","kind":"follow-up"}'
curl -s -H "$H" "$JT/api/emails?status=draft,approved,sent,failed&jobId=<id>"
curl -s -H "$H" "$JT/api/mail"          # sending status: configured, sentToday, dailyLimit, hours
```

- Only draft to addresses from the job's contacts. If the contact's `emailStatus` is `inferred`,
  say so in the job's activity log so the owner sees the risk before approving.
- Don't draft the same email twice: check `GET /api/emails?jobId=<id>` first.
- A sent `follow-up` email sets `followup.emailSentAt` on the job automatically.

## Company profiles (the "get up to speed" page)

Each company page shows a quick take, stats, money, facts, anecdotes, news, reviews, contacts and
emails. Research agents fill it with `PATCH /api/companies/:slug` (fields merge; arrays replace):

```json
{
  "quickTake": "3-4 sentences: what they do, size/health, what it's like, the one thing to know",
  "profile": {"website": "", "careersUrl": "", "linkedin": "", "hq": "", "founded": 2019,
    "employees": "about 900 (LinkedIn, Oct 2026)", "ceo": "", "type": "private|public|subsidiary",
    "ticker": null, "stage": "Series C", "phone": "+1 ...", "phoneLabel": "Main line (company site)",
    "remotePolicy": ""},
  "financials": {"totalFunding": "$207M", "totalFundingUsd": 207000000,
    "lastRound": {"type": "Series C", "amount": "$82M", "amountUsd": 82000000, "date": "2025-06", "leadInvestors": []},
    "valuation": "", "valuationUsd": null, "revenue": "", "growth": "", "profitability": "",
    "marketCap": "", "stockNote": "", "investors": [], "layoffs": [{"date": "", "detail": "", "url": ""}],
    "healthSignal": "strong|steady|watch|risky", "healthNote": ""},
  "facts": [""], "anecdotes": [{"text": "", "source": "", "url": ""}],
  "news": [{"date": "2026-08-28", "headline": "", "summary": "", "source": "", "url": ""}],
  "interview": "", "sources": [""]
}
```

Add one news item without resending the list: `POST /api/companies/:slug/news {date, headline, summary, source, url}`
(deduped by url, kept newest first). Phones: company main lines only, never personal numbers.
Numbers: never invent; put the source and date in the text.

Company emails not tied to a job: `POST /api/companies/:slug/emails {to, subject, body, jobId?}`
(a draft for the owner to approve, like job emails). `notes` on a company is the owner's; don't overwrite.

## Other endpoints

- `GET /api/companies` (summaries for comparing), `GET|PATCH /api/companies/:slug`
- `GET /api/answers`, `POST /api/answers`, `PATCH /api/answers/:id`
- `GET /api/config`, `GET /api/resumes` (files at `/resumes/<name>.pdf`), `GET /api/stats`
- `GET /api/events?limit=200`, `GET /api/export` (full JSON backup)
- `GET /api/files/:id`
- MCP: `POST /mcp` (see above)

Agent keys can't approve or send email, delete anything, change settings, import, or manage keys:
those are the owner's, on the site, each confirmed with a passkey. A route that refuses an agent
answers `403`.

## MCP (Claude Code, Claude Desktop, Cursor)

The same tracker, as tools. `https://hussla.<tailnet>.ts.net/mcp` (or `http://localhost:<port>/mcp` on the
laptop listener) speaks MCP over Streamable HTTP: `POST` only, one JSON answer per request, no
sessions. Both protocol eras work: clients that open with `initialize` (2025-03-26 to 2025-11-25) and
the stateless 2026-07-28 revision (`server/discover`, version and `_meta` on every request).

- **Auth: the same agent key**, as `Authorization: Bearer <key>` on every request, never in the URL.
  A missing or wrong key is `401`. A session cookie or tailnet identity does nothing here: only a key
  gets in, and a key is always that agent (`agent:<name>` in the activity log), even from the owner's
  own computer. Don't send an `Origin` header (a foreign one is `403`); `GET` and `DELETE` are `405`.
- **Same rules as the HTTP API**, because each tool calls the same use-case: agent patches can't
  change or clear a field the owner last wrote (the tool says which), `null` clears only what an agent
  wrote, and every change shows in the activity log.
- **There is no tool to approve, send, cancel or edit email, delete anything, change settings, import,
  export or manage keys**; those are the owner's, on the site, with a passkey. `approve` is refused by
  name if you send it.
- A mistake you can fix (a bad field, "not found", "the owner last wrote it") comes back as a normal
  result with `isError: true` and one sentence. Results are JSON in one text block, shaped like the
  HTTP API's (lists are wrapped: `{"jobs": [...]}`, `{"emails": [...]}`).

Connect Claude Code (run on a computer that's on the owner's tailnet):

```bash
claude mcp add --transport http hussla https://hussla.<tailnet>.ts.net/mcp \
  --header "Authorization: Bearer $JT_KEY"
```

Cursor and other clients that read a JSON file (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "hussla": {
  "url": "https://hussla.<tailnet>.ts.net/mcp",
  "headers": { "Authorization": "Bearer <agent key>" } } } }
```

| Tool | Does | HTTP route |
|---|---|---|
| `find_jobs` | list jobs by `status` / `q` (at most 100, with `total`, `truncated`) | `GET /api/jobs` |
| `get_job` | one job with company page, timeline, files, emails | `GET /api/jobs/:id` |
| `create_job` | add a job (`company`, `title`, optional `id`, any job field) | `POST /api/jobs` |
| `update_job` | patch a job (`id`, changed fields, optional `note`) | `PATCH /api/jobs/:id` |
| `add_job_event` | timeline line (`jobId`, `action`, `detail`) | `POST /api/jobs/:id/events` |
| `add_contact` | one contact on a job (`jobId`, `name`, `email`, `emailStatus`, ...) | `POST /api/jobs/:id/contacts` |
| `list_companies` | every company with its summary | `GET /api/companies` |
| `get_company` | one company page in full | `GET /api/companies/:slug` |
| `upsert_company_profile` | create (needs `name`) or patch a company | `PATCH /api/companies/:slug` |
| `add_company_news` | one news item (`slug`, `headline`, `date`, `url`, ...) | `POST /api/companies/:slug/news` |
| `add_company_review` | one review source (`slug`, `source`, `rating`, ...) | `POST /api/companies/:slug/reviews` |
| `draft_job_email` | a draft for the owner to approve (`jobId`, `to`, `subject`, `body`) | `POST /api/jobs/:id/emails` |
| `draft_company_email` | a draft not tied to a job (`slug`, optional `jobId`) | `POST /api/companies/:slug/emails` |
| `list_outbox` | emails newest first (`status`, `jobId`, `company`) | `GET /api/emails` |
| `list_answers` | saved form answers | `GET /api/answers` |
| `ask_for_answer` | record a form question that has no answer yet | `POST /api/answers` |
| `get_search_config` | the owner's search settings (`paused`: only read) | `GET /api/config` |

Files (upload and download), the activity feed, résumés, the export and the rest of the HTTP routes
stay HTTP-only; the rules above apply to them the same way.

## Errors

Every error is JSON: `{"error": "...", "code": "...", "fields": [...]}`.

- `400` the input is wrong (`error` names the field); `401` no valid key; `403` not allowed for agents;
  `404` no such record.
- `409` with `code: "owner-field"`: the owner last wrote the fields in `fields`; leave them out and resend.
- `409` with `code: "changed-since-read"` or `"transition-not-allowed"`: re-read the record first.
- `413` the upload is over 25 MB.
