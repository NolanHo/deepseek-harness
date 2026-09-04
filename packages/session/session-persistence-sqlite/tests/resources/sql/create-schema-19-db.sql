-- Frozen schema-19 database fixture for the in-place 19-to-20 migration test.
CREATE TABLE persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY,
  session_key      TEXT NOT NULL UNIQUE,
  version          INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  incarnation      TEXT NOT NULL,
  revision         INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              INTEGER NOT NULL,
  data              ANY NOT NULL,
  source_event_seqs ANY,
  surface_op        TEXT,
  is_packed         INTEGER NOT NULL CHECK (is_packed IN (0, 1)),
  PRIMARY KEY (session_id, seq)
) STRICT;

INSERT INTO persistence_state (singleton, store_id)
VALUES (1, '00000000-0000-4000-8000-000000000000');
PRAGMA application_id = 1146308688;
PRAGMA user_version = 19;
