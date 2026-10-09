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

Pick the guide for where Hussla will live. Each is one path, start to finish, and ends with a
check that it's running.

- **Synology NAS**, no terminal: [docs/install/nas.md](docs/install/nas.md) (other always-on Linux boxes and Raspberry Pi too)
- **Laptop or desktop** with Docker Desktop, or the plain binary: [docs/install/laptop.md](docs/install/laptop.md)
- **Rented cloud server**, no open port: [docs/install/cloud.md](docs/install/cloud.md)

You'll need a free Tailscale account and the Tailscale app on your phone.

## For developers

Go server (`cmd/hussla`, `internal/`) and a React + TypeScript UI (`src/`), built on the
[whippletree](https://github.com/bretperry/whippletree) template. Agent rules: `AGENTS.md`.

```bash
pnpm install
pnpm check
```
