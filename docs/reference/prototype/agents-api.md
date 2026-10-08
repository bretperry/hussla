<!-- The prototype's agent API guide, kept as the reference for API parity (plan Phase 3). Personal details replaced with neutral words. -->

# Hussla: guide for agents

Hussla is the source of truth for the owner's job search. Every agent (search, research,
application, follow-up) reads and writes it through this API. the owner reads it on his phone and laptop.

## Connect

- Base URL: `https://hussla.<tailnet>.ts.net` from a device on the owner's tailnet, or
  `https://hussla.<tailnet>.ts.net:8443` (API only) when the API is opened with Tailscale Funnel.
- Auth: `Authorization: Bearer <agent key>`. the owner makes one key per agent or computer on the
  Settings page. Your key name shows up as `agent:<name>` in the activity log.
- Bodies are JSON (`content-type: application/json`) except file uploads.
- `GET /api` lists every endpoint. This file is served at `GET /api/docs`.

## Rules (from the owner)

1. **Scam filter.** Verify the employer, apply only on the company's own site or a known ATS
   (Greenhouse, Lever, Ashby, Workday, Workable). Red flags (personal Gmail contacts, payment
   requests, chat-app interviews, no real posting) mean `status: "filtered"` with `scamFlags`.
2. **Never store or enter** SSN, bank details, ID numbers or date of birth. Not in this tracker,
   not on any form before an offer.
3. **Accounts:** the owner creates site accounts himself. If a form needs a new account, set
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

Agent keys can't delete jobs, change settings or manage keys. the owner does those on the site.
