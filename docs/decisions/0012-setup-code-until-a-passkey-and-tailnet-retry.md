# 0012 — The setup code lasts until a passkey is stored; the tailnet join never gives up

`accepted` · 2026-10-08 · from the first-run review (`reviews/first-run-claude.md` items 3, 6, 11, 12, 13, 19) on PR #5

## Context

- On a headless server (a NAS) nobody watches the process. Decision 0011 made the setup code single use (spent by the claim), in memory (a new one each restart), and replaced it after 5 wrong tries.
- So a cancelled Face ID prompt needed a fresh code from the log; a restart made the code already in the log wrong; and any other tailnet user could keep the owner's code stale by guessing wrong.
- The tailnet node joined once: with HTTPS certificates or MagicDNS off, or a failed join, it logged one error and stopped serving the tailnet until a restart.

## Decision

- **The code is spent by the first stored passkey, not by the claim** (the smaller of the two fixes the review offered; a longer register grant would still be spent by `register/begin`). Claim still checks it, and is still refused to anyone who could never be the owner before the code is touched.
- **Only the code's SHA-256 is stored** (settings `auth.setupCode`, no migration: settings is key-value), so it survives a restart. A restart that finds one prints a reminder pointing at the earlier "Setup code (valid until used)" line instead of a new code.
- **Wrong guesses lock out the guesser, not the code.** Each tailnet user (or the local listener as a whole) gets `config.SetupCodeAttempts` wrong tries, then waits `config.SetupCodeLockout`, right code or not. The counts live in memory.
- **The tailnet join retries forever** with backoff (`config.TailnetRetryFirst` doubling to `config.TailnetRetryMax`), logging each new problem once; HTTPS off gets one line naming the admin DNS page. tsnet's login link is logged once per new link and kept, with the join phase, in an `auth.TailnetState` the adapter exposes (`auth.TailnetStatus`) for a later setup page.

## Consequences

- If the log with the code is lost (container recreated before setup finished), the stored hash can't be printed again; see `docs/deferred.md`.
- A leaked backup holds a 60-bit code's plain SHA-256: brute-forceable offline with real effort, and only useful before setup finishes.
- A restart clears lockouts; only someone who can restart the server gets fresh tries, and they hold the data directory anyway.
- Revisit when Phase 6 settles how the first passkey is authorized without the log (review blocker 1).
