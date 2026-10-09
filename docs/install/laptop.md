# Install Hussla on a laptop or desktop

About 5 minutes with Docker Desktop. Hussla runs while the computer is awake; for always-on, use
a NAS (`nas.md`) or a cloud server (`cloud.md`). Do the steps in order.

**You need:** Docker Desktop (<https://www.docker.com/products/docker-desktop/>) installed and
running, and Tailscale on this computer and on your phone (<https://tailscale.com/download>),
signed in to the **same account** on both and turned **on**.

## 1. Start Hussla

Open Terminal (Mac) or PowerShell (Windows) and paste this one line:

```bash
docker run -d --name hussla --restart unless-stopped -p 127.0.0.1:8484:8484 -v hussla-data:/data ghcr.io/bretperry/hussla:latest
```

It downloads Hussla and starts it. The page it serves answers this computer only.
(`deploy/docker-compose.laptop.yml` is the same thing as a compose file.)

## 2. Connect it to Tailscale

1. Open <http://localhost:8484>.
2. Click **Connect to Tailscale** and sign in with the **same account as on your phone**.
3. Back on the Hussla tab, it moves on by itself. If it says **One switch to flip**, follow its
   link, turn on **HTTPS Certificates**, and come back.

## 3. Make it yours

1. Click **Make it mine** (it works for 15 minutes after Hussla starts; if it timed out, run
   `docker restart hussla` and reload).
2. Make your passkey with Touch ID, Windows Hello or your phone.
3. Follow the setup steps; each can be skipped.

## Check that it worked

Paste this line; it should say `healthy`:

```bash
docker inspect --format "{{.State.Health.Status}}" hussla
```

Then open the `https://hussla.….ts.net` address the page shows, on your phone with Tailscale on.
If something is wrong, paste the output of `docker logs --tail 20 hussla` to whoever helps you.

## Keep a copy off this computer

Once a week: Hussla → **Settings → Download backup**, and keep the file somewhere else (cloud
storage, a USB drive). Removing Docker Desktop's data removes Hussla's.

That file holds your jobs, companies, emails and answers, not uploaded files and résumés. To keep
everything, copy the whole data folder (this makes `hussla-backup` in the current folder):

```bash
docker cp hussla:/data ./hussla-backup
```

## Without Docker

For people at home in a terminal. Download the file for your computer from the latest release
(<https://github.com/bretperry/hussla/releases>): `hussla-darwin-arm64` (Apple silicon Mac),
`hussla-darwin-amd64` (Intel Mac), `hussla-windows-amd64.exe`, or `hussla-linux-amd64`. On a Mac,
the first time: right-click it → **Open** (it isn't signed yet). Run it in a terminal with
`./hussla-darwin-arm64 serve`; it prints a Tailscale sign-in link and a setup code. Then, in a
second terminal, `./hussla-darwin-arm64 open` opens it in your browser. Data goes in `./data`
next to where you ran it; copy that whole folder to keep a backup.
