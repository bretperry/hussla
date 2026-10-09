# Install Hussla on a Synology NAS

About 5 minutes. No terminal, no key to copy, no folders to make. Do the steps in order.

**You need:** a Synology with DSM 7.2 or later and Container Manager (Package Center → Container
Manager → Install), a computer or phone on the same home network, and a phone you'll use Hussla on.

## 1. Get Tailscale on your phone

Tailscale is what lets your phone reach Hussla from anywhere, and nobody else.

1. Install Tailscale on your phone: <https://tailscale.com/download>.
2. Open it and sign in. Note which account you used (Google, Apple, GitHub, Microsoft…): you'll
   use the **same one** in step 3.
3. Turn Tailscale **on** in the app.

## 2. Start Hussla in Container Manager

1. Open **Container Manager → Project → Create**.
2. **Project name:** `hussla`.
3. **Path:** click **Set Path**, open the `docker` folder, click **Create folder**, name it `hussla`, select it.
4. **Source:** **Create docker-compose.yml**, and paste this exactly, with no changes:

   ```yaml
   services:
     hussla:
       image: ghcr.io/bretperry/hussla:latest
       container_name: hussla
       restart: unless-stopped
       ports:
         - "0.0.0.0:8484:8484"
       volumes:
         - hussla-data:/data
       environment:
         TS_AUTHKEY: ${TS_AUTHKEY:-}

   volumes:
     hussla-data:
   ```

5. **Next**, **Next**, **Done**. Container Manager downloads Hussla and starts it (a minute or two).

   `:latest` is fine for a first install. To update later you'll pin a version instead
   (see [Updating](#updating)): Container Manager never re-downloads a tag it already has.

## 3. Connect it to Tailscale

1. On a computer or phone **on your home Wi-Fi**, open `http://<your NAS's address>:8484`.
   The address is the one you use for DSM, without `:5000`: for example `http://192.168.1.20:8484`,
   or `http://diskstation.local:8484`.
2. You'll see **Step 1 · Connect to Tailscale**. The person who will use Hussla clicks
   **Connect to Tailscale** and signs in with the **same account as on the phone** (step 1).
   Whoever signs in here owns this Hussla.
3. Go back to the Hussla tab. It moves on by itself in a few seconds.
4. If it says **One switch to flip**: click the link, turn on **MagicDNS** (if off) and
   **HTTPS Certificates**, and come back. No restart needed.
5. If it says **Waiting for approval**: your tailnet approves new machines; click the link and
   choose **Approve**.

## 4. Make it yours

1. The page shows your Hussla address (`https://hussla.<something>.ts.net`) and a **Make it mine**
   button. It names the owner: if that's not you, press **Start over** and let the right person
   click Connect. They get a fresh 15 minutes for the button.
2. Click **Make it mine**. It works for 15 minutes after Hussla connects to Tailscale, until a
   passkey exists; a restart doesn't bring it back (Start over does). If it timed out, use the
   setup code below.
3. Make your passkey with Face ID, Touch ID or your phone.
4. The setup steps follow: email, importing jobs, an agent key, your phone, staying signed in,
   and a spare passkey. Each can be skipped and done later.

Can't use the button (it timed out)? The setup screen also takes the **setup code** from the
log: Container Manager → Container → hussla → **Log**, the newest line that starts with
`Setup code`. Lost it? **Print a new code** on the setup screen; codes printed earlier keep
working too, until your passkey exists. The code also takes the install
back if someone else pressed Make it mine first: add your passkey with it, then remove theirs on
`https://hussla.<something>.ts.net/setup/passkeys`.

## 5. Open it on your phone

With Tailscale **on** on the phone, open the address from step 4 (the setup's phone step shows a
QR code to scan). Add it to your home screen.

## Check that it worked

- Container Manager → Container: **hussla** is **Running** and its health is **healthy**.
- `http://<your NAS's address>:8484` says **Hussla is ready** and shows your address.
- Your address opens the job board on your phone, with Tailscale on.

If any of these is wrong: Container Manager → Container → hussla → **Log**, copy the last 20
lines, and paste them to whoever helps you. The log never holds a password; it can hold the setup
code, which stops working once your passkey exists, so don't post it publicly before then.

## Keep a copy off the NAS

Hussla makes a backup every day, but it lives on the NAS. Once a week, open Hussla →
**Settings → Download backup** and keep the file on your computer or in cloud storage. A NAS
that dies takes its own backups with it.

That file holds your jobs, companies, emails and answers, not uploaded files and résumés. To keep
everything (if you use SSH on the NAS), copy the whole data folder, then move it off the NAS:
`sudo docker cp hussla:/data ./hussla-backup`.

## Updating

Container Manager's **Build** does not re-pull a tag it already has: with `:latest` it rebuilds
from the copy on the NAS and you stay on the old version. Pin the exact version instead, and bump
it to update:

1. Find the newest version on <https://github.com/bretperry/hussla/pkgs/container/hussla>
   (for example `0.1.1`; a new one is published by itself each time a change ships). **Settings** in Hussla shows the one you run, at the bottom.
2. Container Manager → Project → hussla → **Action → Stop**.
3. **YAML**: change the `image:` line to that version, for example
   `image: ghcr.io/bretperry/hussla:0.1.1` (no `v`), and save.
4. **Action → Build**, then **Action → Start**. Your data stays in the `hussla-data` volume.

A build fetches a new image, not a new `docker-compose.yml`: yours stays as you pasted it. If its
`ports:` line reads `"8484:8484"`, change it to `"0.0.0.0:8484:8484"` (Project → hussla →
**YAML**) before the build, so the setup page answers IPv4 only, as in step 2.

## Reinstalling from scratch

Only if you deleted the `hussla-data` volume: first open <https://login.tailscale.com/admin/machines>
and **remove the old hussla machine**, or the new one comes up as `hussla-1` with a different
address. Then follow this guide from step 2.

## Not a Synology?

Any always-on Linux box with Docker works the same way: save the file above as
`docker-compose.yml` in an empty folder and run `docker compose up -d` there, then continue at
step 3. A Raspberry Pi needs the **64-bit** Raspberry Pi OS (`uname -m` prints `aarch64`).
