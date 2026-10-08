# 0010 — SQLite storage: prototype-shaped rows, two migrations, one data directory

`accepted` · 2026-10-08 · from `docs/plans/hussla-v1.md` Phase 2

## Context

- The prototype's database must open and upgrade without loss, and the domain (decision 0009) carries more than the prototype's columns: per-field writers, extras, an email `version`.
- The plan fixes the driver (pure Go), WAL with `synchronous=FULL`, forward-only embedded migrations, backups by `VACUUM INTO`, and a refusal to serve a corrupt or newer database. It leaves the row shape, numbering and file layout open.

## Decision

- **Rows keep the prototype's shape.** A job or company is the columns the pages sort and filter on (jobs: id, company, slug, title, status, score, url, location, workType, salary, pay text, source, résumé, found/applied times, next action; companies: slug, name, updatedAt) plus one `data` cell of API-named JSON (nested objects and extras) built by `internal/app/wire`. A new `writers` cell holds the owner-written field names. On read the columns win over `data`. Emails, answers, files, tokens and events are plain columns; the prototype's `config` table is the settings store.
- **Migrations:** `0001_baseline.sql` is the prototype's schema with `IF NOT EXISTS` (a prototype file that predates `emails.companySlug` gets it first); `0002_domain.sql` adds `writers` (jobs, companies, answers), `emails.version`, `events.dedupeKey` (unique, for idempotent import) and indexes. Applied versions go in `schema_migrations(version, name, appliedAt, appVersion)`; they must be an unbroken run from 1, and a version above this binary's is refused naming the `appVersion` that wrote it. Never edit a released file; add the next number.
- **Data directory:** `<DATA_DIR>/hussla.db` (plus WAL files) and `<DATA_DIR>/backups/hussla-<UTC time>-<reason>.db`. Seven newest kept (`config.BackupsKept`); a daily backup is due after `config.BackupInterval`; one is made before any migration of a database that holds data.
- **Stored times** are `domain.FormatTimestamp` text; a time the prototype wrote as a bare date still reads (UTC midnight).
- **One connection, `BEGIN IMMEDIATE`:** units of work run one at a time (what `store.Store` promises), which is all one person's traffic needs.
- **Decoding stored rows is lenient** (`wire.Decoder{Lenient: true}`): a value that no longer reads (wrong type, an enum spelling we don't know) is skipped with a warning instead of making the row unopenable. The API decodes strictly.
- **Seed import adds, never overwrites:** a record whose id is already stored is left as is, so a second import adds nothing and an import after the owner's edits keeps them. A record that breaks a rule is salvaged (the bad review or contact dropped) or skipped, and named in the report.

## Consequences

- A field the pages want to sort or filter on later needs a column and a migration; everything else is a `data` change with no migration.
- A skipped unreadable value is rewritten without it the next time the row is saved. Warnings are returned by `wire.DecodeJob`/`DecodeCompany`; the adapter drops them today (revisit if a bad row shows up in practice).
- Numbers in `data` pass through JSON floats: whole numbers above 2^53 would lose precision (no field comes near).
- Re-importing a corrected seed does not update existing records; the owner edits them in the app.
