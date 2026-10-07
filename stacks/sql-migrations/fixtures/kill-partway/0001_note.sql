-- Fixture: the table that already holds rows when 0002 and 0003 run.
BEGIN;
CREATE TABLE note (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL DEFAULT ''
);
INSERT INTO note (title, body) VALUES ('groceries', 'eggs'), ('call mum', ''), ('call dad', 'sunday');
COMMIT;
