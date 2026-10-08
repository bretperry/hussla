-- What the Phase 1 domain carries beyond the prototype's columns.
--   writers:   who last wrote each field (owner entries only; '{}' = nothing owner-written, the safe default)
--   version:   an email's content version, so an approval names the exact text the owner read
--   dedupeKey: the caller's identity for an event, so importing the same bundle twice adds nothing
ALTER TABLE jobs ADD COLUMN writers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN writers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE answers ADD COLUMN writers TEXT NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN dedupeKey TEXT;
CREATE UNIQUE INDEX events_dedupe ON events(dedupeKey) WHERE dedupeKey IS NOT NULL;
CREATE INDEX events_at ON events(at, id);
CREATE INDEX jobs_created ON jobs(createdAt, id);
CREATE INDEX jobs_status ON jobs(status);
CREATE INDEX jobs_company ON jobs(companySlug);
CREATE INDEX emails_status ON emails(status);
CREATE INDEX emails_job ON emails(jobId);
CREATE INDEX emails_sent ON emails(sentAt) WHERE status = 'sent';
