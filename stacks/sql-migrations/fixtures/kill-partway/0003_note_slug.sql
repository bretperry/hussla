-- Fixture: a migration that fails partway. Its backfill collides on rows 0001 wrote ('call mum'
-- and 'call dad' share a slug), so the INSERT errors after the new table exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE note_slug (
  note_id bigint PRIMARY KEY REFERENCES note (id),
  slug text NOT NULL UNIQUE
);
INSERT INTO note_slug (note_id, slug) SELECT id, lower(left(title, 4)) FROM note;
COMMIT;
