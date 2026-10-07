-- Fixture: the migration killed partway. Several statements in one transaction: a new table, a
-- new column on a table with rows, a backfill of those rows, and the constraints the app relies on
-- (NOT VALID, so adding them doesn't scan the table; a later migration validates them on its own).
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE tag (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);
INSERT INTO tag (name) VALUES ('inbox');
ALTER TABLE note ADD COLUMN tag_id bigint;
UPDATE note SET tag_id = (SELECT id FROM tag WHERE name = 'inbox') WHERE tag_id IS NULL;
ALTER TABLE note ADD CONSTRAINT note_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tag (id) NOT VALID;
ALTER TABLE note ADD CONSTRAINT note_tag_id_present CHECK (tag_id IS NOT NULL) NOT VALID;
COMMIT;
