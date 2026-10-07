# Hussla

Your job search, in one place. Hussla runs on your own NAS and keeps every job you're chasing
on its own page: the description, contacts, reviews, the résumé you sent, and the follow-up
email. Each company gets a page too, with a quick take, pay and money facts, news, reviews, a
call button, and editable emails that go out from your own address once you approve them.

Agents (AI helpers on your other computers) search, research and draft through Hussla's API.
You stay in charge: nothing is emailed until you approve that exact message.

- **Private.** Reachable only from your own devices through Tailscale; no public website.
- **No passwords to remember.** Your devices are signed in automatically.
- **Any email provider.** iCloud, Gmail, Outlook, Yahoo, Fastmail, Zoho, any SMTP server, or
  Resend, Postmark, SendGrid and Mailgun.

## Install

Status: in development; the install guide (`docs/install.md`) lands with the build plan's setup
phase (`docs/plans/hussla-v1.md`).

## For developers

Go server (`cmd/hussla`, `internal/`) and a React + TypeScript UI (`src/`), built on the
[whippletree](https://github.com/bretperry/whippletree) template. Agent rules: `AGENTS.md`.

```bash
pnpm install
pnpm check
```
