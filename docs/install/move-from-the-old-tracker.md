# Move your data from the old tracker

Brings your jobs, companies, answers, activity and search settings from the old Job Tracker
into Hussla. Do it once Hussla is set up and you can open it. It's safe to repeat: anything
already in Hussla stays as it is, so a second import adds nothing.

## 1. Download the backup from the old tracker

1. Open the old tracker (`https://jobs.<your tailnet>.ts.net`).
2. Go to **Settings**.
3. In **Backup & look**, click **Download backup (JSON)**.
4. A file named `job-tracker-backup.json` lands in your Downloads folder.

## 2. Import it into Hussla

1. Open Hussla and go to **Settings**.
2. Scroll to **Import from the old tracker**.
3. Click **Choose the backup file** and pick `job-tracker-backup.json`.
4. Tap your passkey when asked (Face ID, Touch ID or your security key).
5. Hussla shows what it added, then a short list of what it didn't bring over.

That's it. Check the Jobs page: your jobs are there with their statuses and dates.

## Optional: bring over the old outbox too

The old tracker's backup file doesn't include its emails. Your sent follow-ups are still in each
job's activity and follow-up dates; this step only adds the emails themselves.

1. In the browser where the old tracker works, open `https://jobs.<your tailnet>.ts.net/api/emails`.
2. Save the page as a file (File → Save Page As, or ⌘S / Ctrl+S), named `emails.json`.
3. In Hussla, **Settings → Import from the old tracker**, pick `emails.json`.

Sent emails come over as history. Every email that wasn't sent yet arrives **unapproved**: nothing
goes out until you open the Outbox and approve it again. One that was caught mid-send arrives
marked "may have been sent": check your Sent folder before approving it.

## What doesn't come over

- **Agent keys.** Make new ones in Hussla's Settings and give each agent its new key.
- **Your mail password** (the app-specific password). Set up email in Hussla's Settings.
- **Attached files' contents** (cover letters and such). The backup lists them by name only; the
  files are still in the old tracker's `data` folder. Attach them again from each job's page.
- **A status Hussla doesn't know.** Both use the same statuses today, so you shouldn't see this;
  if you do, the job arrives as "review" and the import result names it so you can fix it.
- **Search settings, when Hussla already has some.** Hussla keeps its own; the result says so.

## On a laptop, from a terminal (instead of step 2)

With Hussla stopped, from the folder Hussla runs in:

```bash
hussla import ~/Downloads/job-tracker-backup.json
```

If Hussla is running, this stops and says to use the Settings page instead.
