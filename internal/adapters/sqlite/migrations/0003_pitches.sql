-- Pitches (Phase 5b): the owner's ten short answers, each with its versions and one live version.
--   slot:        the pitch's identity, 1..config.PitchSlots (the upper bound is a knob, so the domain keeps it)
--   whenToUse:   the "when to use it" cue
--   liveVersion: the version on the billboard; the domain keeps it naming a stored version
--   lastVersion: the highest version number ever given, so a deleted number is never reused
--   writer:      'owner' or 'agent', who wrote that version; author is the activity log's name for them
-- Deleting a pitch takes its versions with it (owner only, with a passkey tap).
CREATE TABLE pitches (
  slot INTEGER PRIMARY KEY CHECK (slot >= 1),
  title TEXT NOT NULL,
  whenToUse TEXT NOT NULL DEFAULT '',
  liveVersion INTEGER NOT NULL,
  lastVersion INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE pitch_versions (
  slot INTEGER NOT NULL REFERENCES pitches(slot) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  writer TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (slot, version)
);
