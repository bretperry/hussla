# Install Hussla on a rented cloud server

About 10 minutes. Hussla is reachable only over your Tailscale network: the server publishes no
port, so nothing faces the internet. Do the steps in order.

**You need:** a small Linux server (1 GB of memory is plenty; amd64 or arm64) with Docker
installed, Tailscale on your phone and computer (<https://tailscale.com/download>), signed in and
turned **on**.

## 1. Make a Tailscale auth key

A cloud server has no home network to show the setup page on, so it signs in with a key.

1. Open <https://login.tailscale.com/admin/settings/keys> → **Generate auth key**.
2. Settings: **Reusable off, Ephemeral off, no tags** (a tagged machine has no owner, and an
   ephemeral one forgets itself on restart).
3. **Copy it before you close the dialog**: it is shown once. Missed it? Revoke it and make another.

## 2. Start Hussla

In the provider's web console (or SSH), paste this one line. It asks for the key without showing
it, then downloads and starts Hussla:

```bash
read -rsp "Tailscale auth key: " TS_AUTHKEY && export TS_AUTHKEY && curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/bretperry/hussla/main/deploy/docker-compose.cloud.yml && docker compose up -d; unset TS_AUTHKEY
```

The key is used once; after that the server remembers its sign-in in the `hussla-data` volume.

## 3. Get your address

Paste this line; it prints your Hussla address once the server is ready (up to a minute):

```bash
docker logs hussla 2>&1 | grep -m1 "Hussla is running"
```

If it says **HTTPS certificates or MagicDNS turned off** instead, open
<https://login.tailscale.com/admin/dns>, turn on **MagicDNS** and **HTTPS Certificates**, and paste
the line again in a minute.

## 4. Make it yours

1. Print the setup code: `docker logs hussla 2>&1 | grep -m1 "Setup code"`.
2. On your phone or computer, with Tailscale **on**, open the address from step 3.
3. Type the setup code and make your passkey. The setup steps follow; each can be skipped.

The owner is the Tailscale account that made the auth key.

## Check that it worked

- `docker inspect --format "{{.State.Health.Status}}" hussla` says `healthy`.
- The address opens the job board on your phone with Tailscale on.
- From a computer **without** Tailscale, nothing answers: the server has no open Hussla port.

If something is wrong, paste the output of `docker logs --tail 20 hussla` to whoever helps you.

## Firewall

Leave the provider's firewall closed except SSH (or close SSH too and use the provider's web
console). Hussla and Tailscale need no inbound port.

## Keep a copy off the server

Once a week: Hussla → **Settings → Download backup**, and keep the file somewhere else. A deleted
server takes its own backups with it. That file holds your jobs, companies, emails and answers,
not uploaded files and résumés; for everything, `docker cp hussla:/data ./hussla-backup` on the
server, then download that folder.

## Reinstalling from scratch

Only if the `hussla-data` volume is gone: first remove the old hussla machine at
<https://login.tailscale.com/admin/machines>, or the new one comes up as `hussla-1` with a different
address. Then make a new auth key and start again at step 1.
