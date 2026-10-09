# 0015 — The first passkey: a 15-minute, once-per-install first-run button for the node's owner, and the setup code as the override

`accepted` · 2026-10-08, revised 2026-10-09 · from Phase 6 (`docs/plans/hussla-v1.md`), Bret's pick "Both" on the first-run review's blocker 1; revised after the ship dynamite test (PR #12)

## Context

- On a headless NAS the setup code sits in a container log that a non-technical owner never opens (`reviews/first-run-claude.md` blocker 1). The plan's bar is "no terminal and no log reading".
- Before a passkey exists, the only proof of ownership is the Tailscale identity of whoever signed the node in (`WhoIs`, decision 0007). That person may not be the one who will use Hussla (a family tailnet), and a neighbor on the home network may open the page first.
- The setup code (decision 0013) stays the fallback for anyone who can read the log, and for recovery when every passkey is lost.
- Revision (2026-10-09): the first version put the link in the home page's GET HTML, so any process on a device that is on the home network and signed in as the node's owner could read it, claim, and register its own passkey; and every restart reopened the window. Both are fixed below.

## Decision

- **First-run window, once per install.** It opens when the node's owner is first adopted on an install that has **never** stored a passkey, and lasts `config.FirstRunWindow` (15 minutes). Its start is stored (`auth.firstRunStartedAt`), so a restart doesn't reopen it. It closes for good once a passkey exists (marker `auth.firstPasskeyAt`, or any passkey).
- **No link in any GET.** The home-network page shows a **Make it mine** button. Its form POST (checked for this page's own Origin and Host, like Start over) mints a random one-use secret, kept only in memory, and redirects to `<ts.net address>/setup?link=<secret>`. A newer press replaces an older link, and a claim spends it. Claiming needs the request to come from the **node's owner over the tailnet** (`WhoIs`), and goes through the same per-caller guess limit as the code.
- **The setup code is the override.** The code in the log works in or out of the window. The owner (by tailnet identity) can ask for a **new** code from the setup screen (`POST /api/setup/code`, at most once per `config.SetupCodeReissueGap`). A passkey added through the link (or with a tap of such a passkey) is marked `FirstRun`. A `FirstRun` passkey can't authorize removing one added with the code, and a code passkey can remove any. So whoever can read the container log can always take a raced install back. A new code doesn't lift a caller's wrong-guess lockout.
- **Start over** on the home-network page releases the recorded owner and signs the node out of Tailscale, only while no passkey was ever stored. It checks that, writes the release, and logs out in one unit of work. The owner record is marked released, not deleted.
- **Someone else's account.** Once an owner is recorded, a node logged in to Tailscale as a different user fails closed: the tailnet door answers only "belongs to someone else". The home-network page offers **Sign out of that account** (only in that state) so the owner can sign in again from the home network.
- The LAN page itself never grants identity. It shows state, the address and the owner's login.

## Consequences

- A non-technical owner never needs the log if they connect, then press Make it mine within 15 minutes. After that, or after a restart past it, the code from the log is the way in.
- **Residual risk:** an agent on a device that is both on the home network and signed in to Tailscale as the node's owner can, during that first window, POST the form itself, claim, and register its own passkey before the owner does. The POST and the one-use link keep the secret out of anything that only reads pages; they don't stop a local program that submits forms. The recovery is the log code: print a new one, claim, add a passkey, and remove the agent's from `/setup/passkeys`.
- A tagged node has no owning user, so "someone else's account" can't be detected there (no mismatch is reported).
- Revisit if Hussla gains more than one owner, or if Tailscale identity stops being the root of ownership.
