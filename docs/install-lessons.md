# Install lessons

What the first real installs of Hussla taught us (the prototype on a Synology NAS, 2026-10-08
and 09), kept here because they are about this app, not the template. The general rules (never
bake a `ts.net` name in, named volumes, one-line commands, no placeholders) live in whippletree's
`docs/mom-proof-setup/README.md`; this file is what a Hussla session needs on top of them.
Phase 6 of `docs/plans/hussla-v1.md` is where most of these land.

## Synology

- **Run as uid 1000 on a named volume.** The prototype ran as `node` (uid 1000). A `./data` bind
  mount failed twice: Synology won't create a missing bind folder, and after `mkdir` and
  `chown 1000:1000` its ACLs still gave `EACCES mkdir /data/files`. The named volume
  `hussla-data` fixed it, because Docker seeds it from the image's own `/data`. v1's distroless
  non-root image depends on the same behavior, so never switch it back to a bind mount.
- **Container Manager is the main path.** The owner's NAS had `docker compose` v2 over SSH, but
  the guide's target is Container Manager → Project → Create with no terminal (Phase 6).
- **Never build on the NAS.** The first `docker compose up -d --build` built, then failed to start
  on the bind mount; the error scrolled past and `compose ps` was empty. v1's compose uses the
  prebuilt image only.

## Sign-in and owner

- **The owner is the node owner, never a typed login.** The prototype's `ALLOWED_USERS` was
  guessed from the owner's email, but their Tailscale login was a GitHub login
  (`<name>@github`), so the site said "Not signed in". v1 takes the owner from `WhoIs`
  (decision 0007). `HUSSLA_OWNER_LOGIN` is an optional pin; a wrong pin must log both logins.
- **First passkey: the window and the log code ("Both").** The owner picked both on 2026-10-08:
  a never-owned server opens a short window for the node owner on the home-network page, and the
  log code is the fallback. The code is stored as a hash and stays valid until a passkey is saved,
  so a cancelled Face ID retries without a new code (PR #5).
- **HTTPS certificates or MagicDNS off is not fatal.** The app retries and says which switch to
  flip, with no restart (PR #5). Keep that retry loop.
- **Tailscale on the viewing device first.** Safari and Firefox "can't find" the `ts.net` name
  when the Mac's own Tailscale is off. Firefox's DNS-over-HTTPS can cause the same error.
  The guide says "turn Tailscale on" before "open the link", and has a phone step.

## Names

- **The tailnet name can change.** It did on 2026-10-09; bookmarks and agent notes broke, and the
  app was fine only because nothing in Hussla stores the address. Keep it that way: show the
  current name from tsnet, never save it.
- **v1 installs next to the prototype, then takes over.** The prototype's machine is `jobs`; v1
  joins as its own machine, the owner imports their data, checks it (Phase 7), points agents at
  the new address with new keys, then stops the prototype and keeps its folder as a backup.
- **Removing an old machine first avoids `hussla-1`.** A node that loses its state rejoins with a
  `-1` suffix and orphans the address and passkeys (first-run review #14).

## Agents and the job search

- **Key-only `/mcp` does not work as a claude.ai connector.** claude.ai custom connectors need an
  OAuth sign-in and a public address. Hussla's `/mcp` takes agent keys only (2026-10-08 decision),
  so it works from Claude Code and Cursor, not the claude.ai connector screen. Revisit if the owner
  wants the connector.
- **Funnel is for the agent API only.** The prototype exposed only the key-protected API port on
  Funnel (`:8443`) and kept the site tailnet-only. Funnel must be allowed in the tailnet policy;
  until it is, the address just resets connections.
- **Scheduled searches run as a Claude routine, not inside Hussla.** The routine runs in a cloud
  environment whose network allowlist must include the Funnel host and whose env holds the agent
  key (`HUSSLA_KEY`). The project's default environment blocks the host. The Claude plan pays for
  the routine; the agent key only unlocks Hussla's API, and the owner asked which was which.
- **Keys never go in chat.** "Add an agent" in Settings shows the key once, with a snippet to
  paste into the client or the environment.

## Not Hussla's, but seen on the same NAS

- Mojodojo's read-only container had no writable home folder, so its built-in Claude couldn't make
  a scratch dir (mojodojo-source PR #128). If Hussla ever runs a tool inside its container, give it
  a writable `$HOME`.
