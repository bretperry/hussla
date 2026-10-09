# 0015 — The first passkey: a 15-minute first-run link for the node's owner, and the setup code as a fallback

`accepted` · 2026-10-08 · from Phase 6 (`docs/plans/hussla-v1.md`), Bret's pick "Both" on the first-run review's blocker 1

## Context

- On a headless NAS the setup code sits in a container log that a non-technical owner never opens (`reviews/first-run-claude.md` blocker 1). The plan's bar is "no terminal and no log reading".
- Before a passkey exists, the only proof of ownership is the Tailscale identity of whoever signed the node in (`WhoIs`, decision 0007). That person may not be the one who will use Hussla (a family tailnet), and a neighbor on the home network may open the page first.
- The setup code (decision 0013) stays the fallback for anyone who can read the log, and for recovery when every passkey is lost.

## Decision

- **First-run window.** For `config.FirstRunWindow` (15 minutes) after a start, on an install that has **never** stored a passkey (marker `auth.firstPasskeyAt`, or any passkey), the home-network page offers **Make it mine**: a link to `<ts.net address>/setup?link=<secret>`. The secret is random per process start and never stored. Claiming with it needs the request to come from the **node's owner over the tailnet** (`WhoIs`, never the LAN page) and goes through the same per-caller guess limit as the code. A restart opens a new window with a new secret, until a passkey exists.
- **Setup code, both ways.** The code in the log still works, in or out of the window. A tailnet owner (or, with no owner yet, an eligible peer) can ask for a **new** code from the setup screen (`POST /api/setup/code`, at most once per `config.SetupCodeReissueGap`); it replaces the old hash. The owner uses the same route as a **recovery code** to add a passkey after losing every one, then removes old ones (never the last).
- **Start over** on the home-network page releases the recorded owner and signs the node out of Tailscale, only while no passkey was ever stored. The owner record is marked released, not deleted.
- The LAN page itself never grants identity; it shows state, the address, the owner's login and the link.

## Consequences

- A non-technical owner never needs the log: Connect, then Make it mine, within 15 minutes; a restart from Container Manager brings the link back.
- Anyone who can restart the container and is the node's Tailscale owner can open the window again before the first passkey; they already control the node, so this grants nothing new.
- The link is in the LAN page's HTML for the window's length: a device on the home network can read it, but only the node's owner over the tailnet can use it.
- Revisit if Hussla gains more than one owner, or if Tailscale identity stops being the root of ownership.
