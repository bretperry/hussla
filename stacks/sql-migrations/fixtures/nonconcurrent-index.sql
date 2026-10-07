-- Fixture: red on purpose. A plain CREATE INDEX on a table that already exists holds a SHARE lock
-- for the whole build, blocking every write to it; the lint must fail this file.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX note_title_idx ON note (title);
COMMIT;
