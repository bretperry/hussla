# Changelog

What changed for people using Hussla, newest first. The engineering view behind each
entry is in [`CHANGELOG-TECHNICAL.md`](CHANGELOG-TECHNICAL.md).

## [Unreleased]

- **Search now.** A button on the Jobs page starts your Claude job-search routine right away, and links to the run so you can watch it. Set it up once in Settings → Job search routine: paste the routine's API URL and token from claude.ai/code/routines.
- **Easier to read front page.** Headlines and body text use a clearer serif (Source Serif 4); Bodoni stays on the "Hussla." title. Headlines are smaller, labels are plain bold caps instead of typewriter text, and the header takes about half the room it did. The motto no longer runs into the menu, and on a phone the menu scrolls sideways.
- **Install it yourself.** Guides for a Synology NAS (no terminal), a laptop and a cloud server, in `docs/install/`. On a NAS: paste one file into Container Manager, open the NAS's address on port 8484, click **Connect to Tailscale**, then **Make it mine**.
- **Guided setup.** After your passkey, Hussla walks you through email, importing jobs, connecting an agent, your phone, staying signed in, and a spare passkey; skip any step.
- **Lost your phone?** Ask for a new setup code from the setup screen and add a new passkey; remove old ones at `/setup/passkeys`.
