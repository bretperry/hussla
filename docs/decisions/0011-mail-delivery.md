# 0011 — Mail delivery: classified failures, one dispatcher, secrets in a key-file store

`accepted` · 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 4

## Context

- The security model fixes the outcomes (retry only before SMTP DATA or before an HTTP request is written; "may have been sent" otherwise; pacing from sent rows; `failed → approved` only by the owner) but not how an adapter tells the dispatcher which case it hit, where the credential lives, or what the API providers can do about duplicates.
- Providers differ: only Resend documents an idempotency key; personal Outlook.com dropped password login on 2024-09-16; Microsoft 365 turns SMTP AUTH off by default from late December 2026.

## Decision

- **Failures are classified by the adapter, fail-safe by default.** `mailsetup.DeliveryError{Delivery, Reason}` with `DeliveryMaybeSent` as the zero value: any error that isn't one counts as "may have been sent". `NotSentRetry` → back to approved (until `config.MailMaxAttempts`), `NotSentRefused` (bad password, refused recipient, 4xx) → failed at once, `MaybeSent` → failed with `domain.UncertainSendError`.
- **SMTP:** `net/smtp` with our own dialing, STARTTLS required (a server without it is refused), AUTH PLAIN or LOGIN, never plaintext. A 5xx answer to the final dot is a refusal (failed, not retried); a 4xx or no answer after DATA is "may have been sent". The context can stop a send only before DATA.
- **HTTP APIs:** "written" means the request headers reached the wire (`httptrace.WroteHeaders`). 429, 503 and 408 are retried; 401/403 and other 3xx/4xx are refusals; other 5xx are "may have been sent". Redirects are never followed (Go forwards custom headers such as Postmark's token). Base URLs must be https (http only to loopback, for tests).
- **Message-ID** `hussla.<emailId>.v<version>@<from domain>` is set on SMTP mail; a re-approved resend of the same version carries the same id. The API adapters don't override the provider's Message-ID (undocumented for all four); they send `X-Hussla-Message-Id` instead, and Resend gets `Idempotency-Key: hussla-<emailId>-v<version>` (kept 24 h by Resend).
- **Dispatcher:** claim (approved → sending, compare-and-swap) and record (outcome + activity line) are separate units of work; the network call sits between them. The record runs even after shutdown starts. `RecoverInterrupted` at startup moves `sending` rows to failed. Every wait is capped at `config.MailPollInterval` because Go timers stop while the machine sleeps. The daily cap is the smaller of `config.MailDailyLimit` and the provider's published limit. A sent follow-up stamps the job's `followup.emailSentAt` as the owner (the owner approved that exact email).
- **Secrets:** `internal/adapters/secretfile`: AES-256-GCM, a 32-byte key in `<DATA_DIR>/secret.key` (0600, created once, never replaced), values in `<DATA_DIR>/secrets.json` sealed with their name as additional data. Open refuses to mint a key when `secrets.json` exists without one. `mailsetup.Secret` prints, marshals and logs as `[redacted]` and holds its value behind a pointer so even an unexported field can't print it. Provider text is passed through `mailsetup.Redact` (raw and base64 forms) before it is stored, returned or logged.
- **Settings:** the non-secret mail settings are JSON under the `mail` settings key; a provider change requires a new credential.

## Consequences

- A new adapter must return `DeliveryError`s or every failure of it becomes "may have been sent" (safe, but noisy for the owner).
- A personal Outlook.com account can't send through Hussla until an OAuth2 sign-in exists (`docs/deferred.md`).
- Losing `secret.key` makes the stored credential unreadable; the owner re-enters it. Backups must include the key file to restore the credential, which is also why encryption protects a leaked database or log, not the whole volume.
- Retry delays and the current jitter live in memory; a restart forgets them (pacing itself never does).
